#!/usr/bin/env python3
"""platform-intel —— 阶段 1：采集。

抓 sources.yaml 里的地址，存原文快照摘要，产出一份可达性报告。
**不做字段提取**：提取是阶段 2，要用固定页面快照做夹具断言，见 README。

为什么不在这里直接提取：
    提取要读 prose（"个人可以上传吗"），那一步会调模型。把"抓"和"读"分开，
    是为了让"哪些源其实抓不到"先变成一个可回答的问题 —— 现在源清单里有一半
    url: null，跑一遍才能把 no_source（不知道去哪看）和 failed（知道但抓不到）
    分开。这两件的处置完全不同。

退出码：
    0  全部可达或已跳过（单个源失败不改退出码，记在报告里）
    2  配置错误（schemas.yaml / sources.yaml 读不出来）
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

# 报告里 status 的封闭集合：ok / http_<code> / unreachable / timeout / no_source
STATUS_OK = "ok"
STATUS_NO_SOURCE = "no_source"


def load_yaml(path):
    import yaml  # 延迟导入：没有 PyYAML 时给出清晰的错误
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def fetch(url, timeout=TIMEOUT):
    """返回 (status, body_bytes)。status 是封闭集合里的一个值。"""
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


def collect(sources, fetcher=fetch, only=None):
    """从源清单产出报告。fetcher 可注入，测试用它避免联网。"""
    report = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "platforms": {},
        "summary": {"ok": 0, "failed": 0, "no_source": 0},
    }
    platforms = (sources or {}).get("platforms") or {}
    for platform_id, layers in platforms.items():
        if only and platform_id != only:
            continue
        platform_report = {}
        for layer_id, entries in (layers or {}).items():
            cells = []
            for entry in entries or []:
                entry = entry or {}
                url = entry.get("url")
                cell = {"id": entry.get("id"), "url": url}
                if entry.get("note"):
                    cell["note"] = entry["note"]
                if not url:
                    cell["status"] = STATUS_NO_SOURCE
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
                cells.append(cell)
            platform_report[layer_id] = cells
        report["platforms"][platform_id] = platform_report
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="platform-intel 采集（阶段 1）")
    parser.add_argument("--sources", default=os.path.join(HERE, "sources.yaml"))
    parser.add_argument("--schemas", default=os.path.join(HERE, "schemas.yaml"))
    parser.add_argument("--out", default="")
    parser.add_argument("--only", default="")
    args = parser.parse_args(argv)

    try:
        sources = load_yaml(args.sources)
        load_yaml(args.schemas)  # 只为在配置坏掉时立刻失败，不参与采集
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"配置读取失败: {exc}\n")
        return 2

    report = collect(sources, only=args.only or None)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    summary = report["summary"]
    sys.stderr.write(
        f"ok={summary['ok']} failed={summary['failed']} no_source={summary['no_source']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
