#!/usr/bin/env python3
"""computer-automation 文档门禁。

按 computer-automation/README.md 与 references/doc-contract.md 检查一篇文档：
抬头四条、必答小节、凭据泄漏、本机绝对路径、索引表登记。

用法：
    python3 scripts/check_doc.py <doc.md>

退出码：0 通过 / 1 不通过 / 2 用法错误
"""
from __future__ import annotations

import datetime
import pathlib
import re
import sys

HEADER_KEYS = ("环境", "实测日期", "验证方式", "结论")
HEADER_RE = re.compile(r"^>\s*(环境|实测日期|验证方式|结论)\s*[：:]\s*(.*)$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

REQUIRED_SECTIONS = {
    # 只留三样核心 + 两个护栏。操作手段 / 如何验证 / 回退 已并入
    # 「可复现步骤」（每步的观察点就是验证，最后一步就是收尾）。
    "browser-use": ["入口", "浏览器会话", "工具清单", "可复现步骤", "踩坑实录", "何时别用"],
    "computer-use": ["权限前提", "工具清单", "可复现步骤", "踩坑实录", "何时别用"],
}

# 凭据形态（只报明确形态，避免把普通词误判成泄漏）
SECRET_PATTERNS = [
    (re.compile(r"(?i)\b(token|cookie|password|passwd|secret|api[_-]?key|authorization)\b\s*[:=]\s*\S{6,}"),
     "疑似凭据赋值（token / cookie / password / secret / api key / authorization）"),
    (re.compile(r"(?i)bearer\s+[a-z0-9._\-]{20,}"), "疑似 Bearer token"),
    (re.compile(r"(?i)https?://[^\s)]*[?&](token|key|sign|signature|code|session|auth)=[^\s&)]*"),
     "URL 携带凭据类查询参数"),
]
ABS_PATH_PATTERNS = [
    (re.compile(r"(?<![\w`])~/"), "本机绝对路径 ~/"),
    (re.compile(r"(?<![\w`])/Users/"), "本机绝对路径 /Users/"),
    (re.compile(r"file:///"), "本机文件 URL file:///"),
]

PLACEHOLDER = "待填写"


class Report:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.warnings: list[str] = []
        self.checked = 0

    def check(self, ok: bool, msg: str, detail: str = "") -> bool:
        self.checked += 1
        if not ok:
            self.failures.append(f"{msg}{('：' + detail) if detail else ''}")
        return ok

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def section_body(lines: list[str], name: str) -> str | None:
    """返回 `## name` 到下一个二级标题之间的正文；没有该小节返回 None。"""
    for i, line in enumerate(lines):
        if line.strip() == f"## {name}":
            body: list[str] = []
            for nxt in lines[i + 1:]:
                if nxt.startswith("## "):
                    break
                body.append(nxt)
            return "\n".join(body).strip()
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("用法：python3 scripts/check_doc.py <doc.md>")
        return 2
    path = pathlib.Path(argv[1]).expanduser()
    rep = Report()

    if not rep.check(path.is_file(), "文档不存在", str(path)):
        return finish(rep)
    if not rep.check(path.suffix == ".md", "文档必须是 .md", path.suffix):
        return finish(rep)
    parts = path.parts
    if "computer-automation" not in parts:
        rep.check(False, "文档必须位于 computer-automation/{browser-use,computer-use}/ 下", str(path.parent))
        return finish(rep)
    ca = len(parts) - 1 - parts[::-1].index("computer-automation")
    kind = parts[ca + 1] if len(parts) > ca + 1 else ""
    # 1 = 扁平：<kind>/<topic>.md；2 = 文件夹：<kind>/<app>/<topic>.md
    depth = len(parts) - (ca + 2)
    if not rep.check(
        kind in REQUIRED_SECTIONS,
        "文档必须位于 computer-automation/{browser-use,computer-use}/ 下",
        str(path.parent),
    ):
        return finish(rep)
    if not rep.check(depth in (1, 2), "文档层级过深：最多一层 App 子目录", str(path.parent)):
        return finish(rep)
    if not rep.check(path.name != "README.md", "README.md 不是文档，不要对它跑门禁"):
        return finish(rep)
    if not rep.check(
        bool(SLUG_RE.match(path.stem)), "文件名必须是 kebab-case", path.stem
    ):
        return finish(rep)

    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    section_names = REQUIRED_SECTIONS[kind]

    # ---- 抬头四条（第一个二级标题之前）----
    first_section = next((i for i, l in enumerate(lines) if l.startswith("## ")), len(lines))
    header: dict[str, str] = {}
    for line in lines[:first_section]:
        m = HEADER_RE.match(line.strip())
        if m:
            header[m.group(1)] = m.group(2).strip()
    for key in HEADER_KEYS:
        value = header.get(key, "")
        rep.check(bool(value), f"抬头缺少「{key}」", "写成 `> " + key + "：…`")
        if value:
            rep.check(PLACEHOLDER not in value, f"抬头「{key}」仍是占位", value)
    date = header.get("实测日期", "")
    if date and DATE_RE.match(date):
        try:
            if datetime.date.fromisoformat(date) > datetime.date.today():
                rep.failures.append(f"抬头「实测日期」在未来：{date}")
        except ValueError:
            rep.failures.append(f"抬头「实测日期」不是合法日期：{date}")
    elif date:
        rep.failures.append(f"抬头「实测日期」格式不是 YYYY-MM-DD：{date}")

    # ---- 必答小节 ----
    for name in section_names:
        body = section_body(lines, name)
        if body is None:
            rep.check(False, f"缺少必答小节「## {name}」")
            continue
        rep.check(PLACEHOLDER not in body, f"「## {name}」还没填", "仍是占位文本")
        rep.check(len(body) >= 10, f"「## {name}」内容太短", f"{len(body)} 字符")

    # ---- 凭据 / 绝对路径 ----
    for pattern, label in SECRET_PATTERNS:
        hit = pattern.search(text)
        rep.check(hit is None, f"疑似泄漏：{label}", hit.group(0)[:60] if hit else "")
    for pattern, label in ABS_PATH_PATTERNS:
        hit = pattern.search(text)
        rep.check(hit is None, f"含{label}", hit.group(0) if hit else "")

    # ---- 索引表 ----
    readme = path.parent / "README.md"
    if not rep.check(
        readme.is_file(),
        "缺少 README.md，无法核对索引",
        "App 子目录和 browser-use / computer-use 都应有自己的 README.md",
    ):
        return finish(rep)
    index = readme.read_text(encoding="utf-8")
    rep.check(
        f"](./{path.name})" in index,
        "索引表里没有这篇文档",
        f"在 {readme.name} 的「## 文档索引」里补一行",
    )
    if depth == 2:
        # App 子目录本身也要登记在上级索引里，否则没有任何入口能找到它
        kind_readme = (path.parent.parent / "README.md")
        entry = f"./{path.parent.name}/README.md"
        rep.check(
            kind_readme.is_file() and entry in kind_readme.read_text(encoding="utf-8"),
            "App 子目录没有登记在上级索引里",
            f"在 {kind_readme.name} 的「## 文档索引」里补 {entry}",
        )
    rep.check(
        not re.search(r"_待填充_", index),
        "索引表还有「_待填充_」占位行",
        "替换成真实文档行",
    )

    # ---- 提示（不阻断）----
    conclusion = header.get("结论", "")
    if "未验证" in conclusion and "已验证" in conclusion:
        rep.warn("结论同时出现「已验证」和「未验证」，确认口径")
    if re.search(r"https?://[^\s)]*\?", text) and not any(
        p.search(text) for p, _ in SECRET_PATTERNS
    ):
        rep.warn("文档里有带 query 的 URL：默认应只留域名 + 路径")

    return finish(rep)


def finish(rep: Report) -> int:
    for msg in rep.warnings:
        print(f"[WARN] {msg}")
    for msg in rep.failures:
        print(f"[FAIL] {msg}")
    if rep.failures:
        print(f"{rep.checked} checks, {len(rep.failures)} failures")
        return 1
    print(f"[OK] {rep.checked} checks, 0 failures")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
