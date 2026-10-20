#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_gif.py — 生成公众号动图（720x540 / 12.5fps / 暖白底）

用法:
    python3 render_gif.py <spec.json> <out.gif>

spec.json 的 type 决定模板：bar | line | flow
示例见 skills/animated-chart-gif/assets/examples/*.json
规格与坑位见 references/spec.md
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ---- 规格常量：对齐实测目标（见 references/spec.md） ----
W, H = 720, 540
FPS = 12.5
FRAME_MS = int(1000 / FPS)  # 80ms
BG = (249, 248, 245)
INK = (28, 27, 26)
MUTED = (138, 135, 130)
LINE = (224, 222, 217)
TRACK = (240, 238, 234)
ACCENT = (168, 78, 60)
BAR_FILL = (176, 163, 156)
ARROW = (190, 187, 182)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def _font_path():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                ImageFont.truetype(p, 12)
                return p
            except OSError:
                continue
    raise RuntimeError(
        "找不到可用中文字体，请安装 Hiragino Sans GB 或在 spec 中指定 font_path"
    )


_FP = None


def font(size):
    global _FP
    if _FP is None:
        _FP = _font_path()
    return ImageFont.truetype(_FP, size)


def new_frame():
    im = Image.new("RGB", (W, H), BG)
    return im, ImageDraw.Draw(im)


def draw_header(d, title, subtitle=None):
    d.text((40, 30), title, font=font(26), fill=INK)
    if subtitle:
        d.text((40, 72), subtitle, font=font(18), fill=ACCENT)


def draw_conclusion(d, text):
    if text:
        d.text((40, H - 96), text, font=font(18), fill=INK)


def draw_footer(d, text):
    if text:
        d.text((40, H - 32), text, font=font(11), fill=MUTED)


def easing(p):
    """ease-out cubic：先快后慢，贴近真实图表动画手感"""
    p = max(0.0, min(1.0, p))
    return 1 - (1 - p) ** 3


def save_gif(frames, path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    frames[0].save(
        path,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_MS,
        loop=0,
        optimize=True,
    )
    kb = os.path.getsize(path) / 1024
    print(f"OK {path} frames={len(frames)} ~{len(frames) * FRAME_MS / 1000:.2f}s {kb:.0f}KB")


def _tail(frames, spec, n=26):
    """末尾追加带结论句的静帧"""
    if not spec.get("conclusion"):
        return frames
    base = frames[-1].copy()
    draw_conclusion(ImageDraw.Draw(base), spec["conclusion"])
    frames.extend([base] * n)
    return frames


# ---------------- bar ----------------
def render_bar(spec):
    frames = []
    rows = spec["rows"]
    x0, x1 = 40, W - 40
    track_h = 34
    row_top0 = 200
    row_gap = 120
    n_anim = 40
    n_hold = 12

    def draw_row(d, row, y, progress):
        d.text((x0, y - 28), row["label"], font=font(15),
               fill=INK if progress > 0.99 else MUTED)
        d.rounded_rectangle([x0, y, x1, y + track_h], radius=3, fill=TRACK)
        val = row.get("from_value", 0) + (row["to_value"] - row.get("from_value", 0)) * progress
        mx = row.get("max_value") or 0
        ratio = 0 if mx == 0 else val / mx
        w = max(0, int((x1 - x0) * ratio))
        if w > 0:
            d.rounded_rectangle([x0, y, x0 + w, y + track_h], radius=3, fill=BAR_FILL)
        txt = f"{int(val):,}{row.get('unit', '')}"
        d.text((x1, y + track_h + 4), txt, font=font(15),
               fill=ACCENT if progress > 0.99 else MUTED, anchor="ra")

    for i, row in enumerate(rows):
        for f in range(n_anim + n_hold):
            im, d = new_frame()
            draw_header(d, spec["title"], spec.get("subtitle"))
            draw_footer(d, spec.get("footer", ""))
            for j, prev in enumerate(rows[:i]):
                draw_row(d, prev, row_top0 + j * row_gap, 1.0)
            p = easing(f / n_anim) if f < n_anim else 1.0
            draw_row(d, row, row_top0 + i * row_gap, p)
            frames.append(im)

    frames.extend([frames[-1].copy()] * 10)
    return _tail(frames, spec)


# ---------------- line ----------------
def render_line(spec):
    frames = []
    pts = [tuple(p) for p in spec["points"]]
    readouts = spec["readouts"]
    x0, y0 = 80, 150
    x1, y1 = W - 60, H - 120
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    seg_anim, pause = 26, 14

    def to_px(x, y):
        px = x0 + (x - xmin) / (xmax - xmin) * (x1 - x0)
        py = y1 - (y - ymin) / (ymax - ymin) * (y1 - y0)
        return px, py

    for s in range(len(readouts) - 1):
        a, b = readouts[s], readouts[s + 1]
        for f in range(seg_anim + pause):
            p = easing(f / seg_anim) if f < seg_anim else 1.0
            im, d = new_frame()
            draw_header(d, spec["title"], spec.get("subtitle"))

            d.line([x0, y0, x0, y1], fill=LINE, width=1)
            d.line([x0, y1, x1, y1], fill=LINE, width=1)
            d.text(((x0 + x1) / 2, y1 + 46), spec.get("x_label", ""),
                   font=font(11), fill=MUTED, anchor="mm")
            d.text((x0, y0 - 26), spec.get("y_label", ""),
                   font=font(11), fill=MUTED, anchor="la")

            cur = a["at"] + (b["at"] - a["at"]) * p
            drawn = [to_px(*pts[i]) for i in range(len(pts)) if i <= cur]
            if drawn and len(drawn) < len(pts):
                i = len(drawn) - 1
                t = cur - i
                nx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t
                ny = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t
                drawn.append(to_px(nx, ny))
            if len(drawn) >= 2:
                d.line(drawn, fill=(200, 196, 190), width=3, joint="curve")
            for i in range(len(pts)):
                if i <= cur:
                    px, py = to_px(*pts[i])
                    d.ellipse([px - 4, py - 4, px + 4, py + 4], fill=(210, 206, 200))
            if drawn:
                cx, cy = drawn[-1]
                d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=ACCENT)

            v = int(a["value"] + (b["value"] - a["value"]) * p)
            label = (a if p < 0.5 else b)["text"].format(v=v)
            note = a["note"] if p < 0.5 else b["note"]
            d.text((W - 40, 30), label, font=font(18), fill=ACCENT, anchor="ra")
            d.text((W - 40, 58), note, font=font(15), fill=MUTED, anchor="ra")
            draw_footer(d, spec.get("footer", ""))
            frames.append(im)

    frames.extend([frames[-1].copy()] * 14)
    return _tail(frames, spec)


# ---------------- flow ----------------
def render_flow(spec):
    frames = []
    steps = spec["steps"]
    n = len(steps)
    box_w = (W - 80 - (n - 1) * 18) // n
    box_h = 84
    box_y = 200
    per_step = 20

    for active in range(n):
        for _ in range(per_step):
            im, d = new_frame()
            draw_header(d, spec["title"], spec.get("subtitle"))
            for i, st in enumerate(steps):
                bx = 40 + i * (box_w + 18)
                on = i <= active
                cur = i == active
                border = ACCENT if cur else (LINE if not on else (200, 196, 190))
                d.rounded_rectangle(
                    [bx, box_y, bx + box_w, box_y + box_h],
                    radius=6,
                    fill=(255, 255, 255) if on else (246, 244, 240),
                    outline=border,
                    width=2,
                )
                d.text((bx + box_w // 2, box_y + 28), st["label"], font=font(15),
                       fill=INK if on else MUTED, anchor="mm")
                d.text((bx + box_w // 2, box_y + 56), st.get("note", ""), font=font(11),
                       fill=MUTED, anchor="mm")
                if i < n - 1:
                    ax, ay = bx + box_w + 4, box_y + box_h // 2
                    d.line([ax, ay, ax + 10, ay], fill=ARROW, width=1)
                    d.polygon([(ax + 10, ay - 4), (ax + 10, ay + 4), (ax + 16, ay)], fill=ARROW)
            notes = spec.get("notes", [])
            if active < len(notes):
                d.text((40, box_y + box_h + 40), notes[active], font=font(15), fill=ACCENT)
            draw_footer(d, spec.get("footer", ""))
            frames.append(im)
        frames.extend([frames[-1].copy()] * 16)

    return _tail(frames, spec)


RENDERERS = {"bar": render_bar, "line": render_line, "flow": render_flow}


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    spec_path, out_path = sys.argv[1], sys.argv[2]
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    kind = spec.get("type")
    if kind not in RENDERERS:
        print(f"unknown type: {kind!r} (expected one of {list(RENDERERS)})", file=sys.stderr)
        return 2
    save_gif(RENDERERS[kind](spec), out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
