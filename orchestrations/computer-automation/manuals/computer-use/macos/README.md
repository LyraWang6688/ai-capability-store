# macOS 桌面操作（系统级） — 文件夹索引

## 这个文件夹是干什么的

收录**这个软件**下的功能文档：今天给它做这个功能、明天做那个功能，
每做一件事就按功能名建一篇。文件夹 = 这个软件，文件名 = 那个功能。

## 现状

**还没有文档。** 下面的功能都未实测，所以不建空文件——空文档只会让 Agent
以为"这里有答案"。

| 功能文档 | 用途 | 状态 |
|---|---|---|
| `system-permissions.md` | 屏幕录制 / 辅助功能 / 自动化的授予与排查 | 待建 |
| `ax-tree.md` | 辅助功能树怎么读、哪些控件拿得到 | 待建 |
| `cgevent-input.md` | CGEvent 模拟鼠标键盘及其限制 | 待建 |

## 建新文档时

1. 文件名 = 功能（`window-capture` / `ax-tree`），不要 `basic-operation` / `misc` 这类说了等于没说的名字。
2. 走 [`new_doc.py`](../../../../../skills/computer-automation-log/scripts/new_doc.py) 生成骨架，
   写完过 [`check_doc.py`](../../../../../skills/computer-automation-log/scripts/check_doc.py) 门禁。
3. 建好后回到这里，把上表那一行改成链接。

## 参考

- 已完成的样板：[doubao-work/](../doubao-work/README.md)
- 文档规则：[`../../README.md`](../../README.md) 与
  [`doc-contract.md`](../../../../../skills/computer-automation-log/references/doc-contract.md)
