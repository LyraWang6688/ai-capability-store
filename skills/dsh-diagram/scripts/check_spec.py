#!/usr/bin/env python3
"""Validate a dsh-diagram spec before sending it.

The plugin parses the code block with JSON.parse and renders nothing on failure —
the reader then sees the raw JSON. This script catches the cases that would make
that happen, plus the ones that render badly but silently: unknown icon names,
too many cards, over-long labels.

Usage:
    python3 check_spec.py spec.json
    cat spec.json | python3 check_spec.py -

Exit codes:
    0  valid
    1  invalid (每个问题一行)
    2  usage error / unreadable file
"""

import json
import sys

ICONS = {
    "user", "brain", "book", "tools", "loop",
    "shield", "clipboard", "database", "check", "arrow",
}

LIMITS = {
    "title": 24,
    "node.title": 12,
    "node.sub": 18,
    "group.title": 16,
    "group.label": 14,
    "card.en": 14,
    "card.cn": 10,
    "step.title": 22,
    "step.desc": 18,
    "pill": 24,
}

TOP_KEYS = {"type", "title", "top", "group", "bottom", "start", "steps", "loopback", "end"}
LAYERED_KEYS = {"type", "title", "top", "group", "bottom"}
FLOW_KEYS = {"type", "title", "start", "steps", "loopback", "end"}
NODE_KEYS = {"icon", "title", "sub"}
GROUP_KEYS = {"icon", "title", "label", "cards"}
CARD_KEYS = {"icon", "en", "cn"}
STEP_KEYS = {"n", "title", "desc"}


def length_problem(where, value, key):
    if not isinstance(value, str):
        return f"{where}: 必须是字符串，实际是 {type(value).__name__}"
    limit = LIMITS[key]
    if len(value) > limit:
        return f"{where}: {len(value)} 字符，超过上限 {limit}（{value[:20]}…）"
    return None


def check_icon(where, value, problems):
    if value is None:
        return
    if not isinstance(value, str):
        problems.append(f"{where}.icon: 必须是字符串")
    elif value not in ICONS:
        problems.append(
            f"{where}.icon = {value!r} 不在清单里（会静默消失）；可用：{', '.join(sorted(ICONS))}"
        )


def check_unknown(where, obj, allowed, problems):
    for key in obj:
        if key not in allowed:
            problems.append(f"{where}: 未知字段 {key!r}（会被忽略，是不是拼错了？）")


def check_node(where, node, problems):
    if not isinstance(node, dict):
        problems.append(f"{where}: 必须是对象")
        return
    check_unknown(where, node, NODE_KEYS, problems)
    check_icon(where, node.get("icon"), problems)
    if "title" not in node:
        problems.append(f"{where}.title: 必填")
    else:
        p = length_problem(f"{where}.title", node["title"], "node.title")
        if p:
            problems.append(p)
    if "sub" in node:
        p = length_problem(f"{where}.sub", node["sub"], "node.sub")
        if p:
            problems.append(p)


def check_layered(spec, problems):
    if "group" not in spec:
        problems.append("layered: 缺少 group")
        return
    group = spec["group"]
    if not isinstance(group, dict):
        problems.append("group: 必须是对象")
        return
    check_unknown("group", group, GROUP_KEYS, problems)
    check_icon("group", group.get("icon"), problems)
    if "title" not in group:
        problems.append("group.title: 必填")
    else:
        p = length_problem("group.title", group["title"], "group.title")
        if p:
            problems.append(p)
    if "label" in group:
        p = length_problem("group.label", group["label"], "group.label")
        if p:
            problems.append(p)

    cards = group.get("cards")
    if not isinstance(cards, list):
        problems.append("group.cards: 必须是数组")
        return
    if not 2 <= len(cards) <= 6:
        problems.append(f"group.cards: 有 {len(cards)} 张，应为 2~6 张（超过 6 会挤）")
    for i, card in enumerate(cards):
        where = f"group.cards[{i}]"
        if not isinstance(card, dict):
            problems.append(f"{where}: 必须是对象")
            continue
        check_unknown(where, card, CARD_KEYS, problems)
        check_icon(where, card.get("icon"), problems)
        if not card.get("en") and not card.get("cn"):
            problems.append(f"{where}: en 与 cn 至少写一个")
        for key, limit_key in (("en", "card.en"), ("cn", "card.cn")):
            if key in card:
                p = length_problem(f"{where}.{key}", card[key], limit_key)
                if p:
                    problems.append(p)

    for key in ("top", "bottom"):
        if key in spec:
            check_node(key, spec[key], problems)


def check_flow(spec, problems):
    steps = spec.get("steps")
    if not isinstance(steps, list):
        problems.append("flow: 缺少 steps 数组")
        return
    if not 2 <= len(steps) <= 8:
        problems.append(f"steps: 有 {len(steps)} 步，应为 2~8 步")
    for i, step in enumerate(steps):
        where = f"steps[{i}]"
        if not isinstance(step, dict):
            problems.append(f"{where}: 必须是对象")
            continue
        check_unknown(where, step, STEP_KEYS, problems)
        if "title" not in step:
            problems.append(f"{where}.title: 必填")
        else:
            p = length_problem(f"{where}.title", step["title"], "step.title")
            if p:
                problems.append(p)
        if "desc" in step:
            p = length_problem(f"{where}.desc", step["desc"], "step.desc")
            if p:
                problems.append(p)
        if "n" in step and not isinstance(step["n"], int):
            problems.append(f"{where}.n: 必须是整数")

    for key in ("start", "loopback", "end"):
        if key in spec:
            p = length_problem(key, spec[key], "pill")
            if p:
                problems.append(p)


def validate(spec):
    problems = []
    if not isinstance(spec, dict):
        return ["顶层必须是 JSON 对象"]

    check_unknown("top", spec, TOP_KEYS, problems)

    kind = spec.get("type")
    if kind not in ("layered", "flow"):
        problems.append(f"type 必须是 'layered' 或 'flow'，实际是 {kind!r}")
        return problems

    if "title" in spec:
        p = length_problem("title", spec["title"], "title")
        if p:
            problems.append(p)

    allowed = LAYERED_KEYS if kind == "layered" else FLOW_KEYS
    for key in spec:
        if key in TOP_KEYS and key not in allowed and key != "type":
            problems.append(f"{kind}: 不接受字段 {key!r}（这是另一个模板的字段）")

    if kind == "layered":
        check_layered(spec, problems)
    else:
        check_flow(spec, problems)

    return problems


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: check_spec.py <spec.json|->\n")
        return 2
    source = argv[1]
    try:
        text = sys.stdin.read() if source == "-" else open(source, encoding="utf-8").read()
    except OSError as exc:
        sys.stderr.write(f"无法读取 {source}: {exc}\n")
        return 2
    try:
        spec = json.loads(text)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"JSON 解析失败：第 {exc.lineno} 行第 {exc.colno} 列 — {exc.msg}\n")
        sys.stderr.write("插件遇到这个会直接不渲染（读者看到原始代码块）。\n")
        return 1

    problems = validate(spec)
    if problems:
        for item in problems:
            sys.stderr.write(f"✗ {item}\n")
        sys.stderr.write(f"\n{len(problems)} 个问题 — 修完再发。\n")
        return 1

    kind = spec.get("type")
    if kind == "layered":
        summary = f"{len(spec.get('group', {}).get('cards', []))} 张卡片"
    else:
        summary = f"{len(spec.get('steps', []))} 步"
    print(f"✓ 通过（{kind}，{summary}）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
