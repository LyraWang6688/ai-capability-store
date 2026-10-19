#!/usr/bin/env python3
"""投递箱门禁：写入前的字段与质量校验。

用法：
    python3 scripts/validate_entry.py entry.json

退出码：0 通过 / 1 不通过
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
TARGET = json.loads((HERE / "target.json").read_text(encoding="utf-8"))


def fail(msg: str) -> None:
    print(f"[FAIL] {msg}")


def main(path: str) -> int:
    p = pathlib.Path(path)
    if not p.exists():
        print(f"[FAIL] 找不到文件: {path}")
        return 1
    try:
        entry = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[FAIL] JSON 解析失败: {e}")
        return 1

    errors = []
    warnings = []

    # ---- 类型 ----
    t = entry.get("类型")
    if isinstance(t, list):
        t = t[0] if len(t) == 1 else None
    if not t:
        errors.append("缺少「类型」，或传了多个值（select 只能一个）")
    elif t not in TARGET["type_options"]:
        errors.append(f"「类型」不合法：{t!r}；合法值：{TARGET['type_options']}")

    # ---- 内容 ----
    content = entry.get("内容") or ""
    if not isinstance(content, str):
        errors.append("「内容」必须是字符串")
        content = ""
    n = len(content)
    lo, hi = TARGET["min_content_len"], TARGET["max_content_len"]
    if n < lo:
        errors.append(f"「内容」太短（{n} 字，至少 {lo}）。写成一句话的信息量不足以被提炼。")
    if n > hi:
        errors.append(f"「内容」太长（{n} 字，上限 {hi}）。请精简，或拆成多条。")

    # ---- 模板完整性 ----
    def has(*keys):
        return any(k in content for k in keys)

    if not has("观察", "场景"):
        errors.append("「内容」缺少「观察 / 场景」段：你必须在什么场景下看到了什么。")

    if t in TARGET["tech_types"]:
        if not has("现象"):
            errors.append("技术类（踩坑/经验/集成）必须写「现象」：发生了什么。")
        if not has("修法", "原因"):
            errors.append("技术类必须写「原因」或「修法」。不知道原因就写「未定位」，没解决就写「待解决」。")
    elif t in TARGET["cognitive_types"]:
        if not has("原话"):
            errors.append("认知类（偏好/事实/规则）必须写「原话」：用户的原话，不得改写。")
        if not has("解读"):
            warnings.append("没写「解读」——建议补上，并明确标注这是解读而非事实。")

    # ---- 来源可追溯 ----
    src_proj = (entry.get("来源项目") or "").strip()
    src_sess = (entry.get("来源会话") or "").strip()
    if not src_proj and not src_sess:
        errors.append("「来源项目」和「来源会话」至少要填一个——否则这条无法追溯。")

    # ---- 状态：提交者只写「待提炼」 ----
    st = entry.get("状态")
    if isinstance(st, list):
        st = st[0] if len(st) == 1 else None
    if st and st != TARGET["default_status"]:
        errors.append(f"「状态」只能写 {TARGET['default_status']!r}；流转由维护者负责。")

    # ---- 污染「关联准则」 ----
    if (entry.get("关联准则") or "").strip():
        errors.append("「关联准则」由维护者回填，提交者不要填。")

    # ---- 输出 ----
    for e in errors:
        fail(e)
    for w in warnings:
        print(f"[WARN] {w}")

    if errors:
        print(f"\n{len(errors)} 个问题，不许写入。")
        return 1

    print(f"[PASS] 类型={t} · {n} 字 · 来源={src_proj or src_sess}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
