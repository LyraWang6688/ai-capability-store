#!/usr/bin/env python3
"""Link Local Skill — 把 ~/.agents/skills 里的 skill 在 Store 的 skills/ 下露出来。

源码只有一份，在你自己的 Agent Skills 目录里；Store 里只放一个软链，让文件树
看起来是齐的。软链不提交（别处 clone 就是断链），所以脚本顺手维护 .gitignore
里对应的那一行 —— 校验器要求两者必须同时存在。

用法：
    python3 scripts/link_local_skill.py <skill-name>
    python3 scripts/link_local_skill.py <skill-name> --remove
    python3 scripts/link_local_skill.py --list

退出码：0 成功（含「已经是这样」）/ 1 参数或状态错误 / 2 用法错误
"""
from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SKILLS_DIR = ROOT / "skills"
GITIGNORE = ROOT / ".gitignore"
BLOCK_HEADER = "# 本地 skill 软链：源码在 ~/.agents/skills/<name>，软链不提交"
BLOCK_NOTE = "# 由 scripts/link_local_skill.py 维护；校验器要求每个软链都有对应的一行。"
KEBAB = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def fail(msg: str) -> "NoReturn":
    print(f"[FAIL] {msg}")
    raise SystemExit(1)


def ignore_rule(name: str) -> str:
    return f"skills/{name}"


def add_ignore_line(name: str) -> bool:
    """保证 .gitignore 里有 skills/<name>。返回 True 表示这次新加了。"""
    text = GITIGNORE.read_text(encoding="utf-8") if GITIGNORE.exists() else ""
    lines = text.splitlines()
    rule = ignore_rule(name)
    if rule in (line.strip() for line in lines):
        return False

    if BLOCK_HEADER not in lines:
        lines += ["", BLOCK_HEADER, BLOCK_NOTE, rule]
        GITIGNORE.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return True

    start = lines.index(BLOCK_HEADER)
    end = start + 1
    while end < len(lines) and (lines[end].startswith("#") or lines[end].strip()):
        end += 1
    block = [line for line in lines[start + 2:end] if line.strip()]
    block = sorted(set(block + [rule]))
    GITIGNORE.write_text(
        "\n".join(lines[:start + 2] + block + lines[end:]) + "\n", encoding="utf-8"
    )
    return True


def remove_ignore_line(name: str) -> bool:
    if not GITIGNORE.exists():
        return False
    text = GITIGNORE.read_text(encoding="utf-8")
    rule = ignore_rule(name)
    lines = [line for line in text.splitlines() if line.strip() != rule]
    if len(lines) == len(text.splitlines()):
        return False
    GITIGNORE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="在 Store 的 skills/ 下为本地 skill 建软链")
    parser.add_argument("name", nargs="?", help="skill 名（kebab-case，= 目录名）")
    parser.add_argument("--agents-dir", default=str(pathlib.Path.home() / ".agents" / "skills"),
                        help="本地 skill 源码目录（默认 ~/.agents/skills）")
    parser.add_argument("--store", default=str(ROOT), help="Store 根目录（默认本脚本所在仓库）")
    parser.add_argument("--remove", action="store_true", help="删掉软链与 ignore 行")
    parser.add_argument("--list", action="store_true", help="列出 Store 里现有的本地软链")
    args = parser.parse_args()

    store = pathlib.Path(args.store).expanduser().resolve()
    skills = store / "skills"
    agents = pathlib.Path(args.agents_dir).expanduser().resolve()

    if args.list:
        for child in sorted(skills.iterdir()):
            if child.is_symlink():
                print(f"{child.name} -> {os.readlink(child)}")
        return 0
    if not args.name:
        parser.print_usage()
        return 2
    if not KEBAB.match(args.name):
        fail(f"skill 名必须是 kebab-case：{args.name!r}")

    target = skills / args.name
    source = agents / args.name

    if args.remove:
        if not target.is_symlink():
            fail(f"{target} 不是软链；真实的 Store skill 请走 retirement 流程")
        target.unlink()
        removed = remove_ignore_line(args.name)
        print(f"[OK] 已删除软链 {target.relative_to(store)}"
              + ("，并移除 ignore 行" if removed else ""))
        return 0

    if not (source / "SKILL.md").is_file():
        fail(f"源码里没有 SKILL.md：{source}\n先在你的 Agent 里建好这个 skill，再来建软链。")

    if target.exists() or target.is_symlink():
        if target.is_symlink():
            current = pathlib.Path(os.readlink(target))
            current = (skills / current).resolve() if not current.is_absolute() else current
            if current != source:
                fail(f"{target} 已指向 {current}，与 {source} 不一致；先 --remove 再重来")
            added = add_ignore_line(args.name)
            print(f"[OK] 软链已经存在，无需改动" + ("；补上了 ignore 行" if added else ""))
            return 0
        fail(f"{target} 是真实目录（Store 资产），不覆盖；本地 skill 不能占这个名字")

    relative = os.path.relpath(source, skills)
    target.symlink_to(relative)
    add_ignore_line(args.name)
    print(f"[OK] {target.relative_to(store)} -> {relative}")
    print(f"[OK] .gitignore 已包含 {ignore_rule(args.name)}（软链不提交）")
    print(f"下一步：python3 scripts/validate_store.py 确认校验器认这条软链")
    return 0


if __name__ == "__main__":
    sys.exit(main())
