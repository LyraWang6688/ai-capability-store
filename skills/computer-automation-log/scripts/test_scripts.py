#!/usr/bin/env python3
"""离线自测：在临时目录里造一个 Store 夹具，跑 new_doc.py / check_doc.py 的正反例。

不碰真实文档、不联网、不改仓库。

用法：
    python3 scripts/test_scripts.py

退出码：0 全绿 / 1 有失败
"""
from __future__ import annotations

import datetime
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
NEW_DOC = HERE / "new_doc.py"
CHECK_DOC = HERE / "check_doc.py"
TODAY = datetime.date.today().isoformat()

INDEX_README = """# {title}

## 文档索引

| 文档 | 说明 | 状态 | 实测日期 |
|---|---|---|---|
| _待填充_ | | | |
"""

BROWSER_BODY = """# Demo Topic

> 环境：macOS 15 / DSH 桌面端 / Chrome 已登录
> 实测日期：{today}
> 验证方式：list_pages 返回真实标签页；导航后取快照核对标题
> 结论：已验证 —— 能读到操作者已登录的会话

## 入口

宿主以 dsh-mcp-client 插入，stdio，命令为 npx chrome-devtools-mcp --autoConnect。

## 浏览器会话

复用操作者自己的 Chrome（--autoConnect），携带登录态；代价是 Chrome 必须运行。

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| chrome-devtools-mcp | MCP | 列标签页、导航、取快照 | Chrome 已开远端调试 |

## 可复现步骤

先 list_pages 确认连上，再 navigate_page 到目标地址，最后 take_snapshot 取结构；
每步之后检查返回里是否出现期望的标题或元素。

## 何时别用

需要干净环境做回归时改用 Playwright MCP 独立实例；只读内容用 web_fetch。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| MCP 已注册但调用失败 | Chrome 侧远端调试被关 | 重新打开调试开关 |
"""

COMPUTER_BODY = """# Demo Desktop Topic

> 环境：macOS 15 / DSH 桌面端
> 实测日期：{today}
> 验证方式：screencapture 截图 + 剪贴板内容核对
> 结论：已验证 —— 能截屏并读回内容

## 权限前提

需要屏幕录制权限；缺了 screencapture 会静默失败或产出黑图。

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| screencapture | 系统命令 | 截屏落盘 | 屏幕录制权限 |

## 可复现步骤

先 screencapture -x 写到一个新路径，再读文件大小；为 0 或明显偏小就说明没截到，
换窗口或先确认屏幕录制权限，再重截一次。

## 何时别用

有 CLI 或 API 时优先走它们；GUI 只在前两者都不可用时使用。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 截图是黑图 | 缺屏幕录制权限 | 去系统设置授予后重开进程 |
"""


class Runner:
    def __init__(self, store: pathlib.Path) -> None:
        self.store = store
        self.failures: list[str] = []
        self.passed = 0

    def run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, *args], capture_output=True, text=True, cwd=self.store
        )

    def expect(self, name: str, got: int, want: int, out: str = "") -> None:
        if got == want:
            self.passed += 1
            print(f"[PASS] {name}")
        else:
            self.failures.append(name)
            print(f"[FAIL] {name} —— 退出码 {got}，期望 {want}\n{out.strip()}")


def build_store(root: pathlib.Path) -> pathlib.Path:
    store = root / "store"
    (store / "skills").mkdir(parents=True)
    (store / "skills" / "registry.yaml").write_text("skills: {}\n", encoding="utf-8")
    for sub, title in (("browser-use", "browser-use/ — 浏览器操作文档"),
                       ("computer-use", "computer-use/ — 电脑操作文档")):
        d = store / "computer-automation" / sub
        d.mkdir(parents=True)
        (d / "README.md").write_text(INDEX_README.format(title=title), encoding="utf-8")
    return store


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        store = build_store(pathlib.Path(tmp))
        r = Runner(store)

        # 1. 生成骨架
        res = r.run(str(NEW_DOC), "--store", str(store), "--kind", "browser",
                    "--slug", "demo-topic", "--title", "Demo Topic")
        r.expect("new_doc 正常路径", res.returncode, 0, res.stdout + res.stderr)
        doc = store / "computer-automation" / "browser-use" / "demo-topic.md"
        r.expect("骨架文件已创建", 0 if doc.is_file() else 1, 0)
        index = (doc.parent / "README.md").read_text(encoding="utf-8")
        r.expect("索引行已写入", 0 if "](./demo-topic.md)" in index else 1, 0)
        r.expect("索引占位行已替换", 0 if "_待填充_" not in index else 1, 0)

        # 2. 重复创建不许覆盖
        res = r.run(str(NEW_DOC), "--store", str(store), "--kind", "browser",
                    "--slug", "demo-topic", "--title", "Demo Topic")
        r.expect("重复主题返回 2", res.returncode, 2, res.stdout)

        # 3. 未填的骨架必须被门禁拦下
        res = r.run(str(CHECK_DOC), str(doc))
        r.expect("占位骨架被拒", res.returncode, 1, res.stdout)

        # 4. 填满后通过
        doc.write_text(BROWSER_BODY.format(today=TODAY), encoding="utf-8")
        res = r.run(str(CHECK_DOC), str(doc))
        r.expect("合格文档通过", res.returncode, 0, res.stdout)

        # 5. 泄漏凭据被拒
        leaked = BROWSER_BODY.format(today=TODAY) + "\n## 备注\n\ntoken: abcdef1234567890\n"
        doc.write_text(leaked, encoding="utf-8")
        res = r.run(str(CHECK_DOC), str(doc))
        r.expect("凭据泄漏被拒", res.returncode, 1, res.stdout)

        # 6. 本机绝对路径被拒
        doc.write_text(
            BROWSER_BODY.format(today=TODAY) + "\n## 备注\n\n截图在 ~/Desktop/shot.png\n",
            encoding="utf-8",
        )
        res = r.run(str(CHECK_DOC), str(doc))
        r.expect("绝对路径被拒", res.returncode, 1, res.stdout)

        # 7. 索引缺行被拒
        doc.write_text(BROWSER_BODY.format(today=TODAY), encoding="utf-8")
        readme = doc.parent / "README.md"
        readme.write_text(INDEX_README.format(title="browser-use/"), encoding="utf-8")
        res = r.run(str(CHECK_DOC), str(doc))
        r.expect("索引缺行被拒", res.returncode, 1, res.stdout)

        # 8. 桌面类文档正常生成并通过
        readme.write_text(INDEX_README.format(title="browser-use/"), encoding="utf-8")
        res = r.run(str(NEW_DOC), "--store", str(store), "--kind", "computer",
                    "--slug", "demo-desktop", "--title", "Demo Desktop Topic")
        r.expect("computer 类生成", res.returncode, 0, res.stdout + res.stderr)
        desk = store / "computer-automation" / "computer-use" / "demo-desktop.md"
        desk.write_text(COMPUTER_BODY.format(today=TODAY), encoding="utf-8")
        res = r.run(str(CHECK_DOC), str(desk))
        r.expect("computer 类合格文档通过", res.returncode, 0, res.stdout)

        # 9. 非法 slug 被拒
        res = r.run(str(NEW_DOC), "--store", str(store), "--kind", "browser",
                    "--slug", "Bad_Name", "--title", "x")
        r.expect("非法 slug 被拒", res.returncode, 1, res.stdout)

        # 10. 找不到 Store 时明确报错，不猜路径
        res = r.run(str(NEW_DOC), "--store", str(store / "nope"), "--kind", "browser",
                    "--slug", "x", "--title", "x")
        r.expect("找不到 Store 时报错", res.returncode, 1, res.stdout)

    total = r.passed + len(r.failures)
    print(f"\n{total} cases, {len(r.failures)} failures")
    return 1 if r.failures else 0


if __name__ == "__main__":
    sys.exit(main())
