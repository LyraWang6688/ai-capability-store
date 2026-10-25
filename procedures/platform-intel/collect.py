#!/usr/bin/env python3
"""platform-intel —— 阶段 1：采集。

按 sources.yaml 的【信源字典】逐个抓取，产出可达性报告；并按【抓取矩阵】汇总
每个平台每一层的覆盖情况（哪些点已经能抓、哪些点根本还没有信源）。

**不做字段提取**：提取是阶段 2，要用固定页面快照做夹具断言，见 README。

为什么报告要区分 no_source 和 failed：
    "还没找到该看哪一页" 和 "知道看哪儿但抓不到" 需要完全不同的处置
    （前者要去补信源，后者要换手段）。合并成一个"失败"会让报告
    看起来比现实更乐观。

退出码：
    0  抓取完成（单个源失败不改退出码，记在报告里）
    2  配置错误 / 矩阵自相矛盾（悬空引用、点既没有信源也没有 blocked）
"""

import argparse
import datetime
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TIMEOUT = 20
USER_AGENT = "platform-intel/0.1 (+ai-capability-store)"

STATUS_OK = "ok"
STATUS_NO_SOURCE = "no_source"


def load_yaml(path):
    import yaml  # 延迟导入：没有 PyYAML 时给出清晰的错误
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def validate_matrix(doc):
    """矩阵自身的完整性。返回问题列表（空 = 合格）。

    这是本文件最重要的一段：矩阵会持续变长（平台 × 层 × 点），
    人工保证不了每个点引用的信源都还在。把"引用必须落地"变成一条可执行的检查，
    比复核时靠眼睛靠谱。
    """
    problems = []
    sources = (doc or {}).get("sources") or {}
    for platform_id, layers in ((doc or {}).get("platforms") or {}).items():
        for layer_id, points in (layers or {}).items():
            if not isinstance(points, list):
                problems.append(f"{platform_id}/{layer_id}: 不是列表")
                continue
            for point in points or []:
                point = point or {}
                pid = point.get("point") or "<无点名>"
                refs = point.get("from")
                if refs is None:
                    problems.append(f"{platform_id}/{layer_id}/{pid}: 缺 from 字段")
                    continue
                if not refs and not point.get("blocked"):
                    problems.append(
                        f"{platform_id}/{layer_id}/{pid}: 既没有信源也没有 blocked 说明")
                for ref in refs or []:
                    if ref not in sources:
                        problems.append(
                            f"{platform_id}/{layer_id}/{pid}: 引用了不存在的信源 {ref!r}")
    return problems


def fetch(url, timeout=TIMEOUT):
    """返回 (status, body_bytes)。status ∈ {ok, http_<code>, unreachable, timeout}。"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return STATUS_OK, resp.read()
    except urllib.error.HTTPError as exc:
        return f"http_{exc.code}", b""
    except urllib.error.URLError:
        return "unreachable", b""
    except TimeoutError:
        return "timeout", b""
    except OSError:
        return "unreachable", b""


def collect(doc, fetcher=fetch, only=None):
    """产出报告：信源可达性 + 每个平台每层的覆盖情况。fetcher 可注入（测试用）。"""
    doc = doc or {}
    sources = doc.get("sources") or {}
    platforms = doc.get("platforms") or {}
    report = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "sources": {},
        "coverage": {},
        "summary": {"ok": 0, "failed": 0, "no_source": 0, "points_ready": 0, "points_blocked": 0},
    }

    # 1) 抓信源（字典里每个只抓一次，与它服务多少个点无关）
    statuses = {}
    for source_id, spec in sources.items():
        spec = spec or {}
        url = spec.get("url")
        cell = {"url": url, "kind": spec.get("kind")}
        if not url:
            status = STATUS_NO_SOURCE
            cell["status"] = status
            if spec.get("note"):
                cell["note"] = spec["note"]
            report["summary"]["no_source"] += 1
        else:
            status, body = fetcher(url)
            cell["status"] = status
            if status == STATUS_OK:
                cell["bytes"] = len(body)
                cell["sha256"] = hashlib.sha256(body).hexdigest()[:16]
                report["summary"]["ok"] += 1
            else:
                report["summary"]["failed"] += 1
        statuses[source_id] = status
        report["sources"][source_id] = cell

    # 2) 按矩阵汇总覆盖：一个点算 "ready"，当且仅当它引用的所有信源都抓到了
    for platform_id, layers in platforms.items():
        if only and platform_id != only:
            continue
        platform_report = {}
        for layer_id, points in (layers or {}).items():
            rows = []
            for point in points or []:
                point = point or {}
                refs = point.get("from") or []
                if not refs:
                    state = "blocked"  # 有点名，但还没有信源，靠 blocked 说明原因
                    report["summary"]["points_blocked"] += 1
                elif all(statuses.get(r) == STATUS_OK for r in refs):
                    state = "ready"
                    report["summary"]["points_ready"] += 1
                else:
                    state = "source_unavailable"
                row = {"point": point.get("point"), "state": state, "from": refs}
                if point.get("blocked"):
                    row["blocked"] = point["blocked"]
                rows.append(row)
            platform_report[layer_id] = rows
        report["coverage"][platform_id] = platform_report
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="platform-intel 采集（阶段 1）")
    parser.add_argument("--sources", default=os.path.join(HERE, "sources.yaml"))
    parser.add_argument("--schemas", default=os.path.join(HERE, "schemas.yaml"))
    parser.add_argument("--out", default="")
    parser.add_argument("--only", default="")
    args = parser.parse_args(argv)

    try:
        doc = load_yaml(args.sources)
        load_yaml(args.schemas)  # 只为在配置坏掉时立刻失败，不参与采集
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"配置读取失败: {exc}\n")
        return 2

    problems = validate_matrix(doc)
    if problems:
        for problem in problems:
            sys.stderr.write(f"矩阵问题: {problem}\n")
        return 2

    report = collect(doc, only=args.only or None)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    s = report["summary"]
    sys.stderr.write(
        f"sources: ok={s['ok']} failed={s['failed']} no_source={s['no_source']} | "
        f"points: ready={s['points_ready']} blocked={s['points_blocked']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
