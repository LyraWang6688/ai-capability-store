#!/usr/bin/env python3
"""按 computer-automation/ 的约定生成一篇新文档，并补上对应子目录的索引表。

规则来自 computer-automation/README.md。本脚本只做确定性动作：
建文件、写抬头与小节骨架、往索引表加一行。正文由执行者填写。

用法：
    python3 scripts/new_doc.py --kind browser --slug chrome-devtools-mcp \
        --title "Chrome DevTools MCP 连接操作者自己的 Chrome"

    python3 scripts/new_doc.py --kind computer --slug macos-permissions \
        --title "macOS 权限清单" --store ~/Documents/workplace/ai-capability-store

退出码：0 已创建 / 1 参数或环境错误 / 2 目标文档已存在（改用编辑，不要覆盖）
"""
from __future__ import annotations

import argparse
import datetime
import os
import pathlib
import re
import sys

KIND_DIRS = {"browser": "browser-use", "computer": "computer-use"}
# 文档区位于 Automation 域内：automations/computer-automation/<kind>/
DOC_ROOT = pathlib.Path("automations") / "computer-automation"
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
INDEX_HEADING = "## 文档索引"

SECTIONS = {
    "browser": [
        ("入口", "MCP server / CLI / 直接 CDP？宿主怎么接上（命令、参数、端口）。"),
        ("浏览器会话", "独立实例，还是复用操作者已登录的 Chrome？会不会碰到真实账号数据？"),
        ("如何验证", "拿什么证据证明这一步真的生效（页面快照 / DOM 断言 / 截图）。"),
        ("何时别用", "反例：什么情况下这条路不合适，该走哪条替代路径。"),
        ("已知坑", "实际踩到的触发条件；没踩到就写「暂无」。"),
    ],
    "computer": [
        ("权限前提", "辅助功能 / 屏幕录制 / 自动化，缺哪个会静默失败。"),
        ("操作手段", "screencapture / AX API / CGEvent / AppleScript，以及为什么选它。"),
        ("如何验证", "证明操作真的发生：截图、AX 属性、剪贴板内容。"),
        ("回退", "做坏了怎么撤（撤销键、备份、重开窗口）。"),
        ("何时别用", "有 CLI / API 时的优先路径；GUI 是最后手段。"),
    ],
}


def fail(msg: str) -> "NoReturn":  # pragma: no cover - thin wrapper
    print(f"[FAIL] {msg}")
    raise SystemExit(1)


def looks_like_store(root: pathlib.Path) -> bool:
    return (root / DOC_ROOT).is_dir() and (
        root / "skills" / "registry.yaml"
    ).is_file()


def find_store(arg: str | None) -> pathlib.Path:
    """定位 Store 根目录：--store > $AI_CAPABILITY_STORE > 脚本路径反推。

    显式给出的位置（参数或环境变量）不成立时**直接失败**，绝不静默回退 ——
    否则一个写错的 --store 会把文档写进另一个仓库。
    """
    if arg:
        root = pathlib.Path(arg).expanduser().resolve()
        if not looks_like_store(root):
            fail(
                f"--store 指向的不是 Store 根目录：{root}\n"
                "需要同时存在 automations/computer-automation/ 与 skills/registry.yaml。"
            )
        return root

    env = os.environ.get("AI_CAPABILITY_STORE")
    if env:
        root = pathlib.Path(env).expanduser().resolve()
        if not looks_like_store(root):
            fail(
                f"$AI_CAPABILITY_STORE 指向的不是 Store 根目录：{root}\n"
                "需要同时存在 automations/computer-automation/ 与 skills/registry.yaml。"
            )
        return root

    here = pathlib.Path(__file__).resolve()
    # <store>/skills/computer-automation-log/scripts/new_doc.py
    if len(here.parents) >= 4:
        root = here.parents[3].resolve()
        if looks_like_store(root):
            return root
        fail(
            f"脚本路径反推的仓库根目录不是 Store：{root}\n"
            "用 --store 或 $AI_CAPABILITY_STORE 指定 ai-capability-store 的根目录。"
        )

    fail("找不到 ai-capability-store 检出：用 --store 或 $AI_CAPABILITY_STORE 指定根目录。")


def render(kind: str, title: str, date: str) -> str:
    lines = [
        f"# {title}",
        "",
        "> 环境：<待填写：OS / 宿主 / 关键版本>",
        f"> 实测日期：{date}",
        "> 验证方式：<待填写：截图 / 页面快照 / DOM 断言 / 剪贴板>",
        "> 结论：<待填写：已验证或未验证 + 一句话>",
        "",
    ]
    for name, hint in SECTIONS[kind]:
        lines += [f"## {name}", "", f"_待填写：{hint}_", ""]
    return "\n".join(lines)


def update_index(readme: pathlib.Path, filename: str, title: str, date: str) -> None:
    """把文档加进子目录 README 的索引表（替换占位行，或追加一行）。"""
    text = readme.read_text(encoding="utf-8")
    lines = text.splitlines()
    if INDEX_HEADING not in lines:
        fail(f"{readme} 缺少「{INDEX_HEADING}」小节，无法登记索引。")

    head = lines.index(INDEX_HEADING)
    start = next(
        (i for i in range(head, len(lines)) if lines[i].lstrip().startswith("|")), None
    )
    if start is None:
        fail(f"{readme} 的「{INDEX_HEADING}」下面没有表格。")
    end = start
    while end + 1 < len(lines) and lines[end + 1].lstrip().startswith("|"):
        end += 1

    safe_title = title.replace("|", "/")
    row = f"| [{filename}](./{filename}) | {safe_title} | 未验证 | {date} |"
    placeholders = [i for i in range(start, end + 1) if "_待填充_" in lines[i]]
    if placeholders:
        lines[placeholders[0]] = row
    else:
        lines.insert(end + 1, row)
    readme.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 computer-automation 文档骨架")
    parser.add_argument("--kind", required=True, choices=sorted(KIND_DIRS))
    parser.add_argument("--slug", required=True, help="kebab-case 主题名，例如 chrome-devtools-mcp")
    parser.add_argument("--title", required=True, help="文档标题（中文或英文均可）")
    parser.add_argument("--date", default=None, help="实测日期，默认今天（YYYY-MM-DD）")
    parser.add_argument("--store", default=None, help="ai-capability-store 根目录")
    args = parser.parse_args()

    if not SLUG_RE.match(args.slug):
        fail(f"slug 必须是 kebab-case（小写字母/数字/连字符）：{args.slug!r}")
    if args.slug in {"readme", "index"}:
        fail(f"slug 不能叫 {args.slug!r}")
    date = args.date or datetime.date.today().isoformat()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        fail(f"--date 必须是 YYYY-MM-DD：{date!r}")

    root = find_store(args.store)
    subdir = root / DOC_ROOT / KIND_DIRS[args.kind]
    doc = subdir / f"{args.slug}.md"
    readme = subdir / "README.md"
    if not subdir.is_dir():
        fail(f"缺少目录 {subdir} —— 先确认 automations/computer-automation 文档区存在。")
    if not readme.is_file():
        fail(f"缺少索引文件 {readme}。")
    if doc.exists():
        print(f"[SKIP] {doc} 已存在：改这篇，不要覆盖。")
        return 2

    doc.write_text(render(args.kind, args.title, date), encoding="utf-8")
    update_index(readme, doc.name, args.title, date)

    print(f"[OK] 已创建 {doc.relative_to(root)}")
    print(f"[OK] 已登记索引 {readme.relative_to(root)}")
    print(f"下一步：填四处抬头与五个必答小节 → python3 scripts/check_doc.py {doc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
