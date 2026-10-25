#!/usr/bin/env python3
"""weread-reading-sync —— 微信读书 → 飞书多维表格确定性同步。

判定口径（固化，不接受模型临场判断）：
  读完 = progress == 100 且 finishTime 存在
  在读 = finishTime 不存在 且 readUpdateTime 落在最近 N 天内

幂等：一律以「微信读书ID」为键 upsert，重复运行结果不变。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

GATEWAY = "https://i.weread.qq.com/api/agent/gateway"
SKILL_VERSION = "1.0.5"
TZ = timezone(timedelta(hours=8))

DEFAULT_BASE = os.environ.get("WEREAD_BASE_TOKEN", "")   # 飞书 Base token，走环境变量，不入库
DEFAULT_FINISHED_TABLE = "tblgcQ3l7bejHhwS"   # 已读书籍
DEFAULT_READING_TABLE = "tblwkzfwOrFw1Mdz"    # 在读书籍
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")


# ---------------- 纯逻辑（可测，无 IO） ----------------

def is_finished(progress: dict | None) -> bool:
    """读完判定：progress 恰为 100 且存在 finishTime。"""
    if not progress:
        return False
    return progress.get("progress") == 100 and bool(progress.get("finishTime"))


def is_reading(progress: dict | None, now_ts: float, days: int) -> bool:
    """在读判定：未读完，且最近一次阅读在窗口内。"""
    if is_finished(progress):
        return False
    ts = (progress or {}).get("lastReadTime") or 0
    if not ts:
        return False
    return (now_ts - ts) <= days * 86400


def fmt_date(ts: int | None) -> str | None:
    return datetime.fromtimestamp(ts, TZ).date().isoformat() if ts else None


def ms_of_date(iso: str) -> int:
    dt = datetime.strptime(iso, "%Y-%m-%d").replace(tzinfo=TZ)
    return int(dt.timestamp() * 1000)


def build_finished_record(info: dict, finish_ts: int) -> dict:
    return {
        "中文书名": info.get("title"),
        "作者": info.get("author"),
        "分类": [info["category"]] if info.get("category") else None,
        "简介": (info.get("intro") or "")[:1500],
        "微信读书ID": info["bookId"],
        "读完时间": ms_of_date(fmt_date(finish_ts)),
    }


def build_reading_record(info: dict, progress: dict) -> dict:
    return {
        "中文书名": info.get("title"),
        "作者": info.get("author"),
        "分类": [info["category"]] if info.get("category") else None,
        "阅读进度": progress.get("progress"),
        "最近阅读时间": progress.get("lastReadTime"),
        "微信读书ID": info["bookId"],
        "简介": (info.get("intro") or "")[:1200],
    }


DATETIME_FIELDS = ("读完时间", "最近阅读时间")
HUE_CYCLE = ["Red", "Orange", "Yellow", "Lime", "Green", "Turquoise",
             "Wathet", "Blue", "Carmine", "Purple", "Gray"]


INFO_TTL_DAYS = 30            # 书名/作者/分类/简介基本不变，30 天重查一次
CACHE_TTL_HOURS = 168          # 7 天兜底重查（覆盖"只在笔记表里"的书）


def cache_is_stale(entry: dict | None, shelf_read_ts: int | None,
                   now_ts: float, ttl_hours: float = CACHE_TTL_HOURS) -> bool:
    """缓存是否需要重查。

    三条判据，任一成立就重查：
      1) 没有缓存 / 旧格式（缺 cachedAt）—— 一次性自愈
      2) 书架的最近阅读时间变了 —— 说明这本书有新动作，进度可能变
      3) 缓存超过 TTL —— 兜底，覆盖不在书架、拿不到信号的书
    """
    if not entry or "cachedAt" not in entry:
        return True
    if shelf_read_ts and shelf_read_ts != entry.get("shelfSeen"):
        return True
    return (now_ts - entry.get("cachedAt", 0)) > ttl_hours * 3600


def info_is_stale(entry: dict | None, now_ts: float, ttl_days: float = INFO_TTL_DAYS) -> bool:
    """书籍元数据缓存是否过期（元数据几乎不变，所以 TTL 比进度长得多）。"""
    if not entry or "cachedAt" not in entry or "info" not in entry:
        return True
    return (now_ts - entry["cachedAt"]) > ttl_days * 86400


def missing_options(existing: set[str], desired_categories: list[str]) -> list[str]:
    """desired 里出现、但下拉选项里没有的分类（需要先补选项再写入）。"""
    out = []
    for cat in desired_categories:
        if cat and cat not in existing and cat not in out:
            out.append(cat)
    return out


def books_to_leave_reading(reading_records: dict[str, dict], progress_of) -> list[dict]:
    """已读完、但仍留在「在读书籍」里的记录（带 record_id 和书名，便于审计）。

    不在最近窗口内但没读完的书不迁出 —— 那是"读了一半放着"，不是状态变化。
    """
    out = []
    for bid, rec in reading_records.items():
        if is_finished(progress_of(bid)):
            out.append({"record_id": rec["record_id"], "title": rec.get("中文书名")})
    return out


def _epoch_of(value) -> int | None:
    """把飞书 ISO 时间串或毫秒/秒时间戳统一成【秒级】epoch，供比较用。"""
    if isinstance(value, str):
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    if isinstance(value, (int, float)):
        return int(value / 1000) if value > 1e11 else int(value)
    return None


def plan(existing: dict[str, dict], desired: list[dict], key: str = "微信读书ID") -> dict:
    """对比现状与目标，产出 create / update / skip 计划（幂等核心）。

    existing: {bookId: 记录}; desired: [记录]。只比较 desired 里的字段，
    已有记录里的人工字段不会被覆盖。
    """
    creates, updates, skips = [], {}, []
    for rec in desired:
        bid = str(rec.get(key) or "").strip()
        if not bid:
            continue
        cur = existing.get(bid)
        if cur is None:
            creates.append(rec)
            continue
        changed = {}
        for field, want in rec.items():
            have = cur.get(field)
            if field == "分类":
                have = have[0] if isinstance(have, list) and have else have
                want = want[0] if isinstance(want, list) and want else want
            if field in DATETIME_FIELDS:
                have, want = _epoch_of(have), _epoch_of(want)
            if field == "简介":
                continue          # 正文只在创建时写入，后续不参与比较，避免无意义重写
            if have != want:
                changed[field] = rec[field]
        if changed:
            updates[cur["record_id"]] = changed
        else:
            skips.append(bid)
    return {"create": creates, "update": updates, "skip": skips}


# ---------------- 微信读书客户端 ----------------

class WeRead:
    def __init__(self, key: str):
        self.key = key

    def call(self, api: str, params: dict | None = None, retries: int = 3) -> dict:
        body = {"api_name": api, "skill_version": SKILL_VERSION}
        if params:
            body.update(params)
        last = None
        for attempt in range(retries):
            try:
                req = urllib.request.Request(
                    GATEWAY, data=json.dumps(body).encode(),
                    headers={"Authorization": f"Bearer {self.key}",
                             "Content-Type": "application/json"})
                return json.load(urllib.request.urlopen(req, timeout=30))
            except Exception as exc:  # noqa: BLE001
                last = exc
                time.sleep(1.0 + attempt)
        raise RuntimeError(f"{api} 调用失败: {last}")

    def shelf_books(self) -> list[dict]:
        return self.call("/shelf/sync").get("books") or []

    def progress(self, book_id: str) -> dict:
        book = (self.call("/book/getprogress", {"bookId": book_id}).get("book") or {})
        return {"progress": book.get("progress"),
                "finishTime": book.get("finishTime"),
                "lastReadTime": book.get("updateTime")}

    def notebook_books(self) -> list[dict]:
        """所有有笔记的书；用于补充"已从书架移除但笔记里还留着"的读完书。"""
        out, last = [], None
        for _ in range(60):
            params = {"count": 100}
            if last:
                params["lastSort"] = last
            data = self.call("/user/notebooks", params)
            rows = data.get("books") or []
            out += rows
            if not data.get("hasMore") or not rows:
                break
            last = rows[-1].get("sort")
        return out

    def info(self, book_id: str) -> dict:
        data = self.call("/book/info", {"bookId": book_id})
        return data.get("book") or data


# ---------------- 飞书多维表格客户端（走 lark-cli） ----------------

def _tmp_path(suffix: str) -> str:
    """lark-cli 的 --output 只允许写到当前工作目录，不能用系统临时目录。"""
    return os.path.join(os.getcwd(), f".lark-tmp-{os.getpid()}-{time.time_ns()}{suffix}")


class Base:
    def __init__(self, token: str, lark: str = "lark-cli"):
        self.token, self.lark = token, lark

    def _run(self, args: list[str], payload: dict | None = None) -> dict:
        cmd = [self.lark, "base"] + args + ["--base-token", self.token, "--as", "user"]
        tmp = None
        if payload is not None:
            tmp = _tmp_path(".json")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            cmd += ["--json", f"@{tmp}"]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        finally:
            if tmp:
                os.unlink(tmp)
        try:
            data = json.loads(out.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"lark-cli 输出无法解析: {out.stdout[:300]}{out.stderr[:300]}") from exc
        if data.get("ok") is False:   # ndjson 模式的 stdout 是摘要，没有 ok 字段
            raise RuntimeError(f"lark-cli 失败: {(data.get('error') or {}).get('message')}")
        return data

    def records(self, table: str) -> dict[str, dict]:
        path = _tmp_path(".ndjson")
        try:
            self._run(["+record-list", "--table-id", table, "--limit", "2000",
                       "--format", "ndjson", "--output", path])
            rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
        finally:
            os.unlink(path)
        return {str(r.get("微信读书ID") or "").strip(): r for r in rows if r.get("微信读书ID")}

    def field_options(self, table: str, field: str) -> dict:
        data = self._run(["+field-get", "--table-id", table, "--field-id", field])
        return (data.get("data") or {}).get("field") or {}

    def ensure_options(self, table: str, field: str, names: list[str]) -> list[str]:
        """把缺失的单选选项补进字段定义（PUT 全量覆盖，保留原有选项）。"""
        if not names:
            return []
        current = self.field_options(table, field)
        opts = current.get("options") or []
        have = {o["name"] for o in opts}
        missing = [n for n in names if n not in have]
        if not missing:
            return []
        body = {"name": field, "type": "select", "multiple": bool(current.get("multiple")),
                "options": opts + [{"name": n,
                                    "hue": HUE_CYCLE[(len(opts) + i) % len(HUE_CYCLE)],
                                    "lightness": "Lighter"}
                                   for i, n in enumerate(missing)]}
        if current.get("description"):
            body["description"] = current["description"]
        self._run(["+field-update", "--table-id", table, "--field-id", field, "--yes"], body)
        return missing

    def delete(self, table: str, record_ids: list[str]) -> int:
        if not record_ids:
            return 0
        args = ["+record-delete", "--table-id", table, "--yes"]
        for rid in record_ids:
            args += ["--record-id", rid]
        self._run(args)
        return len(record_ids)

    def create(self, table: str, recs: list[dict]) -> int:
        if not recs:
            return 0
        self._run(["+record-batch-create", "--table-id", table],
                  {"create_records": recs})
        return len(recs)

    def update(self, table: str, mapping: dict[str, dict]) -> int:
        if not mapping:
            return 0
        self._run(["+record-batch-update", "--table-id", table],
                  {"update_records": mapping})
        return len(mapping)


# ---------------- 编排 ----------------

def load_state(path: str) -> dict:
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {}


def save_state(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False)


def resolve(candidates: list[str], ww: WeRead, cache: dict, now_ts: float,
            days: int, shelf_signal: dict[str, int] | None = None,
            ttl_hours: float = CACHE_TTL_HOURS) -> tuple[list, list, int]:
    """把候选 bookId 分流成 读完 / 在读 两组；只重查"变旧了"的书。

    返回 (finished, reading, refreshed_count)。
    """
    shelf_signal = shelf_signal or {}
    finished, reading, refreshed = [], [], 0
    for bid in candidates:
        seen = shelf_signal.get(bid)
        if cache_is_stale(cache.get(bid), seen, now_ts, ttl_hours):
            prog = ww.progress(bid)
            prog.update({"cachedAt": int(now_ts), "shelfSeen": seen})
            cache[bid] = prog
            refreshed += 1
        prog = cache[bid]
        if is_finished(prog):
            finished.append((bid, prog))
        elif is_reading(prog, now_ts, days):
            reading.append((bid, prog))
    return finished, reading, refreshed


def info_getter(ww: "WeRead", cache: dict, now_ts: float, ttl_days: float = INFO_TTL_DAYS):
    """取书籍元数据的可调用对象；命中缓存就不调 /book/info。"""
    def get(bid: str) -> dict:
        if info_is_stale(cache.get(bid), now_ts, ttl_days):
            info = ww.info(bid)
            cache[bid] = {"cachedAt": int(now_ts), "info": {
                "bookId": info.get("bookId") or bid,
                "title": info.get("title"),
                "author": info.get("author"),
                "category": info.get("category"),
                "intro": (info.get("intro") or "")[:1500],
            }}
        return cache[bid]["info"]
    return get


def progress_getter(ww: "WeRead", cache: dict, now_ts: float | None = None,
                    shelf_signal: dict[str, int] | None = None):
    """取进度的可调用对象；会按缓存新鲜度自动重查。"""
    now_ts = now_ts or time.time()
    shelf_signal = shelf_signal or {}

    def get(bid: str) -> dict:
        seen = shelf_signal.get(bid)
        if cache_is_stale(cache.get(bid), seen, now_ts):
            prog = ww.progress(bid)
            prog.update({"cachedAt": int(now_ts), "shelfSeen": seen})
            cache[bid] = prog
        return cache[bid]
    return get


def collect(args) -> dict:
    key = os.environ.get("WEREAD_API_KEY")
    if not key:
        sys.exit("缺少环境变量 WEREAD_API_KEY（格式 wrk-xxxxxxxx）")
    ww, base = WeRead(key), Base(args.base_token, args.lark_cli)
    cache_path = os.path.join(STATE_DIR, "progress-cache.json")
    info_cache_path = os.path.join(STATE_DIR, "book-info-cache.json")
    cache = load_state(cache_path)
    info_cache = load_state(info_cache_path)
    now_ts = time.time()
    get_info = info_getter(ww, info_cache, now_ts)
    report = {"finished": {}, "reading": {}}

    shelf_books: list[dict] = []
    shelf_signal: dict[str, int] = {}
    if args.mode in ("finished", "all"):
        books = ww.shelf_books()
        shelf_books = books
        shelf_signal = {b["bookId"]: b.get("readUpdateTime") or 0 for b in books}
        cands = [b["bookId"] for b in books
                 if b.get("finishReading") == 1 or b.get("readUpdateTime")]
        # 补：不在书架、但笔记表里标了读完（或进度 100）的书 —— 少这一路会漏 4 本
        for n in ww.notebook_books():
            book = n.get("book") or {}
            bid = book.get("bookId")
            if bid and (n.get("markedStatus") == 4 or n.get("readingProgress") == 100):
                if bid not in cands:
                    cands.append(bid)
        fin, _, refreshed = resolve(cands, ww, cache, now_ts, args.days, shelf_signal)
        leaving = books_to_leave_reading(
            base.records(args.reading_table),
            progress_getter(ww, cache, now_ts, shelf_signal))
        desired = []
        if not args.dry_run:
            for bid, prog in fin:
                desired.append(build_finished_record(get_info(bid), prog["finishTime"]))
        existing = {} if args.dry_run else base.records(args.finished_table)
        plan_ = plan(existing, desired) if desired else {"create": [], "update": {}, "skip": []}
        if not args.dry_run:
            cats = [r["分类"][0] for r in desired if r.get("分类")]
            added = base.ensure_options(args.finished_table, "分类", cats)
            if added:
                time.sleep(4)   # Base 字段变更异步生效，等一拍再写记录
            created = base.create(args.finished_table, plan_["create"])
            updated = base.update(args.finished_table, plan_["update"])
            removed = base.delete(args.reading_table, [r["record_id"] for r in leaving])
            report["finished"] = {
                "candidates": len(fin),
                "create": created,
                "update": updated,
                "skip": len(plan_["skip"]),
                "options_added": added,
                "left_reading_table": removed,
                "left_reading_titles": [r["title"] for r in leaving],
                "refreshed": refreshed,
            }
        else:
            report["finished"] = {"candidates": len(fin), "refreshed": refreshed,
                                  "would_leave_reading": [r["title"] for r in leaving]}

    if args.mode in ("reading", "all"):
        books = ww.shelf_books()
        cands = [b["bookId"] for b in books
                 if b.get("readUpdateTime") and b.get("finishReading") != 1]
        _, rd, refreshed = resolve(cands, ww, cache, now_ts, args.days,
                                   {b["bookId"]: b.get("readUpdateTime") or 0 for b in books})
        desired = [build_reading_record(get_info(bid), prog) for bid, prog in rd] if not args.dry_run else []
        existing = {} if args.dry_run else base.records(args.reading_table)
        plan_ = plan(existing, desired) if desired else {"create": [], "update": {}, "skip": []}
        if not args.dry_run:
            cats = [r["分类"][0] for r in desired if r.get("分类")]
            added = base.ensure_options(args.reading_table, "分类", cats)
            if added:
                time.sleep(4)   # 同上
            report["reading"] = {
                "candidates": len(rd),
                "create": base.create(args.reading_table, plan_["create"]),
                "update": base.update(args.reading_table, plan_["update"]),
                "skip": len(plan_["skip"]),
                "options_added": added,
                "refreshed": refreshed,
            }
        else:
            report["reading"] = {"candidates": len(rd)}

    if not args.dry_run:
        save_state(cache_path, cache)
        save_state(info_cache_path, info_cache)
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="微信读书 → 飞书多维表格确定性同步")
    ap.add_argument("--mode", choices=["finished", "reading", "all"], default="all")
    # 窗口默认 60 天：30 天会把"上个月打开、还没读完"的书漏掉一大半（实测 39 → 82）
    ap.add_argument("--days", type=int, default=60, help="在读窗口天数（默认 60）")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写库")
    ap.add_argument("--base-token", default=DEFAULT_BASE)
    ap.add_argument("--finished-table", default=DEFAULT_FINISHED_TABLE)
    ap.add_argument("--reading-table", default=DEFAULT_READING_TABLE)
    ap.add_argument("--lark-cli", default="lark-cli")
    args = ap.parse_args()
    if not args.base_token:
        sys.exit("缺少飞书 Base token：设置环境变量 WEREAD_BASE_TOKEN 或传 --base-token")
    started = time.time()
    report = collect(args)
    print(json.dumps({"mode": args.mode, "days": args.days,
                      "dry_run": args.dry_run, "report": report,
                      "elapsed_s": round(time.time() - started, 1)},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
