#!/usr/bin/env python3
"""只读采集本机（macOS）AI 工具使用痕迹 → evidence.json（供 draw_timeline.py 使用）。

铁律：只读、不联网、邮件/浏览器先复制再读、只提取账单命中邮件的必要字段。
用法: python3 collect_evidence.py --out evidence.json [--max-files 40000]
"""
import argparse
import collections
import glob
import gzip
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import zlib

HOME = os.path.expanduser("~")
NOW = time.time()

TOOLS = [
    dict(name="ChatGPT", dirs=["Library/Application Support/com.openai.chat"],
         domains=["chatgpt.com", "chat.openai.com"], apps=["ChatGPT"]),
    dict(name="Codex（OpenAI）", dirs=["Library/Application Support/com.openai.codex", ".codex"],
         domains=[], apps=[]),
    dict(name="Trae（国内 / 国际 + SOLO）", dirs=[],
         domains=["trae.cn", "trae.ai", "trae.com"], apps=["Trae"]),
    dict(name="Coze 扣子", dirs=["Library/Application Support/Coze"],
         domains=["coze.cn", "coze.com"], apps=["Coze"]),
    dict(name="豆包（桌面客户端）", dirs=["Library/Application Support/Doubao"],
         domains=["doubao.com"], apps=["Doubao"]),
    dict(name="豆包工作（DoubaoWork）", dirs=["Library/Application Support/DoubaoWork"],
         domains=[], apps=["DoubaoWork"]),
    dict(name="Kimi（月之暗面）", dirs=[], domains=["kimi.com", "moonshot.cn"], apps=["Kimi"]),
    dict(name="DeepSeek（API / 网页）", dirs=[], domains=["deepseek.com"], apps=["DeepSeek"]),
    dict(name="DSH（DeepSeek Harness）", dirs=[".dsh/sessions"], domains=[],
         apps=["DeepSeek Harness"]),
    dict(name="腾讯 WorkBuddy", dirs=["Library/Application Support/com.tencent.workbuddy.mac"],
         domains=["workbuddy"], apps=["WorkBuddy"]),
    dict(name="Claude", dirs=[], domains=["claude.ai", "anthropic"], apps=["Claude"]),
    dict(name="千问办公（QwenWork）", dirs=[], domains=["qwen", "tongyi"], apps=["QwenWorkCN"]),
    dict(name="飞书 / Lark（工作底座）", dirs=[], domains=["feishu.cn", "larksuite.com"],
         apps=["Lark", "Feishu"]),
]

BILL_WORDS = ["订阅", "会员", "付费", "付款", "支付", "订单", "收据", "发票", "充值", "续费", "扣款",
              "资源包", "开通", "退订", "过期", "到期", "subscription", "invoice", "receipt",
              "payment", "renew", "billing", "upgrade"]
PAY_URL_WORDS = ["pricing", "checkout", "billing", "subscribe", "subscription", "invoice",
                 "receipt", "payment", "upgrade", "paywall", "member", "vip", "plan"]
BODY_TOOL_KEYS = {
    "Trae": ["trae"], "Coze 扣子": ["扣子", "coze"], "豆包（桌面客户端）": ["豆包", "doubao"],
    "豆包工作（DoubaoWork）": ["豆包工作", "doubaowork"], "Kimi（月之暗面）": ["kimi", "moonshot"],
    "ChatGPT": ["chatgpt", "openai"], "Codex（OpenAI）": ["codex"], "DeepSeek（API / 网页）": ["deepseek"],
    "腾讯 WorkBuddy": ["workbuddy"], "Claude": ["claude", "anthropic"],
}
BODY_DATE_RE = re.compile(r"(?:发送时间|开票日期|服务开通时间|到期时间|扣费时间)\s*[：:]?\s*(\d{4})-(\d{2})")


def month(ts):
    return time.strftime("%Y-%m", time.localtime(ts))


def plausible(ts):
    return 1577836800 < ts <= NOW + 86400


def dir_hist(path, max_files):
    hist, n = collections.Counter(), 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            if n >= max_files:
                return hist, n, True
            try:
                ts = os.path.getmtime(os.path.join(root, f))
            except OSError:
                continue
            n += 1
            if plausible(ts):
                hist[month(ts)] += 1
    return hist, n, False


def copy_sqlite(src, tmpdir):
    dst = os.path.join(tmpdir, os.path.basename(src) + str(abs(hash(src)) % 10 ** 6) + ".db")
    # Read-only source + backup includes committed WAL data.
    from pathlib import Path
    with sqlite3.connect(Path(src).resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as source:
        with sqlite3.connect(dst) as target:
            source.backup(target)
    return dst


def chrome_data(domains, tmpdir):
    src = os.path.join(HOME, "Library/Application Support/Google/Chrome/Default/History")
    out, pay_pages, cov = collections.Counter(), [], None
    if not os.path.exists(src):
        return out, pay_pages, cov
    db = copy_sqlite(src, tmpdir)
    try:
        c = sqlite3.connect(db)
        rows = c.execute("SELECT u.url, v.visit_time FROM visits v JOIN urls u ON u.id=v.url").fetchall()
        mn, mx = c.execute("SELECT min(visit_time), max(visit_time) FROM visits").fetchone()
        if mn:
            cov = [month(mn / 1e6 - 11644473600), month(mx / 1e6 - 11644473600)]
        c.close()
    except Exception:
        return out, pay_pages, cov
    finally:
        os.path.exists(db) and os.remove(db)
    for url, vt in rows:
        ul = url.lower()
        if not any(d in ul for d in domains):
            continue
        m = month(vt / 1e6 - 11644473600)
        out[m] += 1
        if any(w in ul for w in PAY_URL_WORDS):
            path = "/" + "/".join(ul.split("//")[-1].split("/")[1:3])
            pay_pages.append({"month": m, "url": path[:70]})
    return out, pay_pages, cov


def mail_scan(tmpdir, max_bodies=6000):
    base = os.path.join(HOME, "Library/Containers/com.netease.macmail/Data/Library/"
                              "Application Support/data")
    hits, coverage, body_dates, body_facts = [], [], [], []
    for db in glob.glob(os.path.join(base, "*", "mail.db")):
        acct = os.path.basename(os.path.dirname(db))
        try:
            dst = copy_sqlite(db, tmpdir)
            m = sqlite3.connect(dst)
            m.text_factory = bytes
            mn, mx, n = m.execute("SELECT min(ReceivedDate), max(ReceivedDate), count(*) FROM MailMeta").fetchone()
            if mn:
                coverage.append({"account": acct.split("_")[0], "mails": n,
                                 "from": month(mn / 1000 if mn > 1e11 else mn),
                                 "to": month(mx / 1000 if mx > 1e11 else mx)})
            for subj, fr, rd in m.execute("SELECT Subject,Froms,ReceivedDate FROM MailMeta"):
                s = (subj or b"").decode("utf-8", "replace")
                f = (fr or b"").decode("utf-8", "replace")
                blob = (s + " " + f).lower()
                if not any(w.lower() in blob for w in BILL_WORDS) or not any(
                    kw in blob for kws in BODY_TOOL_KEYS.values() for kw in kws):
                    continue
                ts = (rd or 0) / 1000 if rd and rd > 1e11 else (rd or 0)
                hits.append({"account": acct.split("_")[0],
                             "date": month(ts) if ts else None, "subject": s[:90],
                             "from": (f.split('"mail":"')[-1].split('"')[0] if '"mail"' in f else f)[:50]})
            m.close()
            os.remove(dst)
        except Exception:
            continue
    for db in glob.glob(os.path.join(base, "*", "content.db")):
        try:
            dst = copy_sqlite(db, tmpdir)
            c = sqlite3.connect(dst)
            c.text_factory = bytes
            for i, (raw,) in enumerate(c.execute("SELECT OrigBody FROM MailContent")):
                if i >= max_bodies:
                    break
                if not isinstance(raw, bytes):
                    raw = str(raw).encode()
                for fn in (zlib.decompress, gzip.decompress):
                    try:
                        raw = fn(raw)
                        break
                    except Exception:
                        pass
                plain = re.sub(r"<[^>]+>", " ", raw.decode("utf-8", "replace"))
                if not any(w in plain for w in BILL_WORDS):
                    continue
                low = plain.lower()
                keys = [name for name, kws in BODY_TOOL_KEYS.items() if any(k in low for k in kws)]
                for y, mo in BODY_DATE_RE.findall(plain):
                    body_dates.append(f"{y}-{mo}")
                    for name in keys:
                        body_facts.append({"tool": name, "date": f"{y}-{mo}"})
            c.close()
            os.remove(dst)
        except Exception:
            continue
    return hits, sorted(set(body_dates)), coverage, body_facts


def appcleaner_records():
    p = os.path.join(HOME, "Library/Application Support/com.nektony.App-Cleaner-SIII/SubdomainAppsSearcher")
    recs = collections.defaultdict(list)
    if not os.path.isdir(p):
        return []
    for fn in os.listdir(p):
        if not fn.endswith(".plist"):
            continue
        base = re.sub(r"\.\d+(\.\d+)*([-.].*)?\.plist$", "", fn) or fn
        recs[base].append(os.path.getmtime(os.path.join(p, fn)))
    return [{"bundle": k, "first": month(min(v)), "last": month(max(v)), "versions": len(v)}
            for k, v in sorted(recs.items(), key=lambda kv: min(kv[1]))]


def apps_list():
    out = []
    for p in sorted(glob.glob("/Applications/*.app")):
        try:
            out.append({"app": os.path.basename(p)[:-4], "mtime": month(os.path.getmtime(p))})
        except OSError:
            pass
    return out


def main():
    ap = argparse.ArgumentParser(description="全量辅助痕迹扫描；不支持增量、会话解析或采集进度管理。账单线索不等于实付。")
    ap.add_argument("--out", default="evidence.json")
    ap.add_argument("--max-files", type=int, default=40000)
    args = ap.parse_args()
    tmpdir = tempfile.mkdtemp(prefix="footprint-")

    apps = apps_list()
    app_mtime = {a["app"]: a["mtime"] for a in apps}
    ac = appcleaner_records()
    mail, body_dates, mail_cov, body_facts = mail_scan(tmpdir)

    tools = []
    for t in TOOLS:
        files, browser, install, paid, paid_visit, notes = {}, {}, [], [], [], []
        for d in t["dirs"]:
            p = os.path.join(HOME, d)
            if os.path.isdir(p):
                hist, n, truncated = dir_hist(p, args.max_files)
                for k, v in hist.items():
                    files[k] = files.get(k, 0) + v
                if truncated:
                    notes.append(f"{d} 超过 {args.max_files} 文件，已截断")
        if t["domains"]:
            browser, pay_pages, cov = chrome_data(t["domains"], tmpdir)
            if cov:
                notes.append(f"Chrome 覆盖 {cov[0]}~{cov[1]}")
            for pp in pay_pages:
                paid_visit.append(pp["month"])
        for a in t["apps"]:
            if a in app_mtime:
                install.append(app_mtime[a])
            bundles = [r for r in ac if a.lower() in r["bundle"].lower()]
            if bundles:
                install.append(bundles[-1]["last"])
                notes.append(f"App Cleaner 记录 {len(bundles)} 个版本，最近 {bundles[-1]['last']}")
        for bf in body_facts:
            if bf["tool"] == t["name"]:
                paid.append(bf["date"])
        key = t["name"].split("（")[0].split(" ")[0].lower()
        for h in mail:
            blob = (h["subject"] + " " + h["from"]).lower()
            if key and key in blob and h["date"]:
                paid.append(h["date"])
                notes.append(f"账单邮件 {h['date']} {h['subject'][:40]}")
        tools.append({"name": t["name"], "files": files, "browser": browser,
                      "install": sorted(set(install)), "billing": sorted(set(paid)),
                      "paid_visit": sorted(set(paid_visit)), "evidence": {"notes": notes}})

    months = sorted({m for t in tools for k in ("files", "browser") for m in t[k]} |
                    {m for t in tools for k in ("install", "paid", "paid_visit") for m in t[k]})
    data = {"collection_mode": "legacy_full_auxiliary", "limitations": ["无来源完整性检查点；失败可能被旧逻辑忽略，不得据此推进增量进度", "文件数不等于使用次数；账单线索不等于付款", "域名候选需复核"], "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "months": months, "tools": tools,
            "raw": {"apps": apps, "appcleaner": ac, "mail_billing": mail,
                    "mail_body_dates": body_dates, "mail_body_facts": body_facts,
                    "mail_coverage": mail_cov}}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    shutil.rmtree(tmpdir, ignore_errors=True)

    print(f"已写出 {args.out}")
    print(f"  月份跨度: {months[0] if months else '-'} → {months[-1] if months else '-'}")
    print(f"  工具数: {len(tools)}  应用: {len(apps)}  App Cleaner 记录: {len(ac)}")
    print(f"  账单类邮件: {len(mail)} 封；正文时间戳: {len(body_dates)} 个")
    for c in mail_cov:
        print(f"  邮箱 {c['account']}: {c['mails']} 封，覆盖 {c['from']} ~ {c['to']}")


if __name__ == "__main__":
    main()
