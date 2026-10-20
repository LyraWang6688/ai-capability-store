#!/usr/bin/env python3
"""一键收录：owner/repo → 事实 → 查重 → 猜类型 → 校验 → 写表 → 回读。

和「agent 跑一遍 skill」的区别：这里没有 agent。选中什么就收什么，
不做语义判断。所以只有两类字段能填：

  FACT     从 GitHub API 拿（禁止凭记忆填）
  DERIVED  从 FACT 算（URL、日期）
  GUESS    猜的 —— 「项目类型」。猜错不丢数据，表里改一个字段就行，
           但【必须把依据说出来】，否则就是静默错误。

其余需要人写的字段（核心亮点 / 参考价值 / 主题标签）留空。

用法：
    python3 collect_one.py <owner/repo> [--dry-run]
退出码：0 成功 / 10 已收录 / 2 拿不到事实 / 1 校验失败或写入失败
"""
import datetime
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = json.load(open(os.path.join(HERE, "target.json"), encoding="utf-8"))

PROJECT_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

# 类型猜测规则：命中第一个就停。顺序 = 从最具体到最宽泛。
TYPE_RULES = [
    (("mcp",), "MCP 服务"),
    (("registry",), "注册中心"),
    (("skill",), "个人 Skill 库"),
    (("plugin", "extension"), "插件集"),
    (("cli", "command"), "CLI 工具"),
    (("protocol", "spec"), "规范协议"),
    (("macos", "desktop", "app"), "桌面工具"),
    (("proxy", "vpn", "network", "tunnel"), "网络工具"),
]


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def fail(code, message):
    print(json.dumps({"ok": False, "code": code, "message": message}, ensure_ascii=False))
    sys.exit(code)


def guess_type(meta):
    """返回 (类型, 依据)。依据会原样带进结果，让人知道这是猜的。"""
    topics = [str(t).lower() for t in (meta.get("topics") or [])]
    name = str(meta.get("project", "")).split("/")[-1].lower()
    blob = " ".join(topics) + " " + name
    for keys, kind in TYPE_RULES:
        for key in keys:
            if key in blob:
                return kind, f"项目名或 topics 里出现 “{key}”"
    return "综合实验", "没有命中任何线索，按默认填"


def build_record(meta, kind, why, desc):
    today = datetime.datetime.now(datetime.timezone.utc).astimezone()
    midnight = today.replace(hour=0, minute=0, second=0, microsecond=0)
    record = {
        "Project": meta["project"],
        "Repository URL": f"[{meta['project']}]({meta['html_url']})",
        "Owner/组织": meta.get("owner") or "",
        "项目简介": desc,
        "项目类型": [kind],
        "跟进状态": ["待深入"],
        # 门禁要 ISO-8601 字符串；飞书接口要毫秒时间戳 —— 写之前再转
        "收录日期": midnight.isoformat(),
    }
    if isinstance(meta.get("stars"), int):
        record["Stars"] = meta["stars"]
    # 前端网页：只有真实外部网页才填；指向 GitHub 内部的留空
    home = (meta.get("homepage") or "").strip()
    if home and "github.com" not in home:
        record["前端网页"] = f"[{home}]({home})"
    return record


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if len(args) != 1:
        fail(1, "用法：collect_one.py <owner/repo> [--dry-run]")
    project = args[0].strip().strip("`\"'").rstrip(".,;")
    if not PROJECT_RE.match(project):
        fail(1, f"“{project}” 不是 owner/repo 形式。选中一个 GitHub 仓库全名再点收录。")

    # ① 查重 —— 先问"已经有吗"，比先拉事实便宜，而且重复写入会拆散唯一真相源
    dup = run([sys.executable, os.path.join(HERE, "check_duplicate.py"), project])
    if dup.returncode == 10:
        fail(10, f"{project} 已经收录过了。要更新请在表里改那条记录，不要插第二行。")
    if dup.returncode == 2:
        fail(2, f"读不到目标表，先别写：{dup.stderr.strip()[:300]}")

    # ② 拉事实
    meta_out = run([sys.executable, os.path.join(HERE, "repo_meta.py"), project])
    if meta_out.returncode != 0:
        fail(2, f"拉 GitHub 事实失败（退出码 {meta_out.returncode}）：{meta_out.stderr.strip()[:300]}")
    try:
        metas = json.loads(meta_out.stdout)
    except ValueError:
        fail(2, "repo_meta.py 输出不是 JSON")
    if not metas:
        fail(2, "GitHub 没有返回这个仓库")
    meta = metas[0]

    # ③ 项目简介：优先 GitHub description。
    #
    # 很多 AI 仓库的 description 是空的（DeepSeek-V3 就是）。原来这里直接拒绝，
    # 但那样一键收录在高频场景下根本用不了 —— 而「拒绝」不会让人更相信这条记录，
    # 只会让人不用这个按钮。
    #
    # 改成填一个【会自我标记的占位】：写进去的是事实（"GitHub 上没有描述"），
    # 而且它在表面上就叫你补。不编内容，也不假装完整。
    desc = (meta.get("description") or "").strip()
    desc_missing = not desc
    if desc_missing:
        desc = "（待补：GitHub 上没有描述）"

    # ④ 猜类型 + 拼记录
    kind, why = guess_type(meta)
    record = build_record(meta, kind, why, desc)

    # ⑤ 门禁
    rec_path = os.path.join(HERE, ".record.tmp.json")
    # 门禁要的是【平铺】的一条记录，不是 {"fields": {...}} —— 第一次写错时
    # validate_record.py 直接报 "unknown field(s) not in table schema: ['fields']"，
    # 这正是那个脚本存在的意义：形状错了它拦住，而不是等写进表里才发现。
    with open(rec_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    try:
        val = run([sys.executable, os.path.join(HERE, "validate_record.py"), rec_path])
        if val.returncode != 0:
            fail(1, f"记录没通过门禁：{(val.stdout + val.stderr).strip()[:400]}")
    finally:
        try:
            os.remove(rec_path)
        except OSError:
            pass

    if dry:
        print(json.dumps({"ok": True, "dry_run": True, "record": record,
                          "type_reason": why}, ensure_ascii=False, indent=2))
        return 0

    # ⑥ 写
    # 门禁通过的是 ISO 字符串，而飞书接口吃毫秒时间戳 —— 只在这一步转。
    # 两套格式各管一段：人/门禁看得懂 ISO，接口只认数字。
    wire = dict(record)
    try:
        wire["收录日期"] = int(datetime.datetime.fromisoformat(wire["收录日期"]).timestamp() * 1000)
    except (KeyError, ValueError):
        pass
    payload = {"create_records": [wire]}
    write = run(["lark-cli", "base", "+record-batch-create",
                 "--base-token", TARGET["base_token"],
                 "--table-id", TARGET["table_id"],
                 "--as", TARGET.get("identity", "user"),
                 "--json", json.dumps(payload, ensure_ascii=False)])
    if write.returncode != 0:
        fail(1, f"写入失败：{(write.stderr or write.stdout).strip()[:400]}")

    print(json.dumps({
        "ok": True,
        "project": project,
        "stars": meta.get("stars"),
        "type": kind,
        "type_reason": why,
        "description_missing": desc_missing,
        "message": (f"已收录 {project}（{kind}）") + (f" ⭐{meta['stars']}" if meta.get("stars") else "") + (" · 简介待补" if desc_missing else ""),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
