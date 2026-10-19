#!/usr/bin/env python3
"""投递箱查重：报告与已有条目相似的记录（**不阻断写入**）。

用法：
    python3 scripts/check_similar.py entry.json [--threshold 0.30]

有相似条目也照样写——重复本身是「这是共性」的证据。
本脚本只负责把「已有几条类似」告诉提交者，由人决定是否补充细节。
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
TARGET = json.loads((HERE / "target.json").read_text(encoding="utf-8"))

CJK = re.compile(r"[\u4e00-\u9fff]")
WORD = re.compile(r"[A-Za-z0-9_./-]{2,}")


def grams(text: str) -> set:
    """中文用二元组，英文/数字用词，做近似匹配。"""
    out = set()
    cjk = "".join(CJK.findall(text))
    for i in range(len(cjk) - 1):
        out.add(cjk[i : i + 2])
    out.update(w.lower() for w in WORD.findall(text))
    return out


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def fetch_existing():
    # ⚠️ lark-cli 的 --output 只允许写到「当前工作目录」内；
    #    写到 /tmp 或 /var/folders 会被安全策略拒绝（unsafe output path）。
    out = pathlib.Path.cwd() / ".context-submit-rec.ndjson"
    try:
        cmd = [
            "lark-cli", "base", "+record-list",
            "--base-token", TARGET["base_token"],
            "--table-id", TARGET["table_id"],
            "--limit", "500",
            "--format", "ndjson",
            "--output", out.name,
            "--overwrite",
            "--as", "user",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not out.exists():
            err = (r.stderr or r.stdout or "").strip()
            if "keychain Set failed" in err:
                print("[WARN] 读表失败：本机沙箱未放行 ~/Library/Application Support/lark-cli/（不是飞书故障）")
            else:
                print(f"[WARN] 读表失败，跳过查重：{err[-300:]}")
            return None
        rows = []
        for line in out.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                rows.append(json.loads(line))
        return rows
    finally:
        # lark-cli 会同时写 .ndjson 和一个同名 manifest（把 .ndjson 换成 .manifest.json）
        for f in (out, out.with_suffix('.manifest.json')):
            f.unlink(missing_ok=True)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    threshold = 0.30
    for a in sys.argv[1:]:
        if a.startswith("--threshold"):
            threshold = float(a.split("=", 1)[1]) if "=" in a else 0.30

    if not args:
        print(__doc__)
        return 1
    entry = json.loads(pathlib.Path(args[0]).read_text(encoding="utf-8"))
    new_text = entry.get("内容") or ""
    new_g = grams(new_text)

    rows = fetch_existing()
    if rows is None:
        print("⚠ 查重未执行（读表失败）。写入不受影响，请自行确认是否重复。")
        return 0
    if not rows:
        print("✓ 投递箱当前没有条目，这条是第一条。")
        return 0

    scored = []
    for r in rows:
        old = r.get("内容") or ""
        s = jaccard(new_g, grams(old))
        if s >= threshold:
            scored.append((s, r.get("自编号") or r.get("record_id", "?"), r.get("类型"), old[:60]))

    scored.sort(reverse=True)
    if not scored:
        print(f"✓ 未发现相似条目（阈值 {threshold}），这条是新的。")
        return 0

    print(f"⚠ 发现 {len(scored)} 条相似（阈值 {threshold}）。**照样可以写**——重复是共性的证据。")
    for s, rid, typ, snippet in scored[:5]:
        print(f"   {s:.2f}  {rid}  [{typ}]  {snippet}…")
    print("\n建议：把这条的新增细节补进去；如果完全重复，可以告诉用户「已投递过」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
