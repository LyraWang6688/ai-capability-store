#!/usr/bin/env python3
"""读 evidence.json（见 references/evidence-sources.md 第 4 节）画 AI 工具足迹时间线。

用法: python3 draw_timeline.py evidence.json --out footprint.png
图例: 深色块=文件变动痕迹 · 蓝色块=浏览器访问 · 实心¥=已确认付费 · 空心¥=付费页访问 · 三角=安装/更新
"""
import argparse
import json
import math
import os

from PIL import Image, ImageDraw, ImageFont

C_BG, C_BROWSER, C_FILES = (243, 244, 246), (56, 130, 246), (13, 148, 136)
C_INSTALL, C_PAID, C_TEXT, C_DIM = (249, 115, 22), (202, 138, 4), (17, 24, 39), (107, 114, 128)


def load_font(size):
    for path, idx in (("/System/Library/Fonts/PingFang.ttc", 1),
                      ("/System/Library/Fonts/PingFang.ttc", 0),
                      ("/System/Library/Fonts/Songti.ttc", 0),
                      ("/System/Library/Fonts/Supplemental/Songti.ttc", 0)):
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()


def rot_label(text, fnt, fill, angle=55):
    tmp = Image.new("RGBA", (260, 52), (255, 255, 255, 0))
    ImageDraw.Draw(tmp).text((0, 0), text, fill=fill, font=fnt)
    bbox = tmp.getbbox()
    if bbox:
        tmp = tmp.crop(bbox)
    return tmp.rotate(angle, expand=True, resample=Image.BICUBIC)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evidence")
    ap.add_argument("--out", default="ai-tool-footprint.png")
    ap.add_argument("--title", default="我的 AI 工具足迹 · 时间线")
    args = ap.parse_args()

    data = json.load(open(args.evidence, encoding="utf-8"))
    tools = data["tools"]
    months = data.get("months") or []
    if not months:
        s = set()
        for t in tools:
            s |= set(t.get("files", {})) | set(t.get("browser", {}))
            for k in ("install", "billing", "paid", "confirmed_paid", "paid_visit"):
                s |= set(t.get(k, []))
        months = sorted(s)

    cw, ch, gap, left, top = 46, 34, 6, 300, 150
    w = max(1280, left + len(months) * cw + 40)
    h = top + len(tools) * (ch + gap) + 130
    img = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(img)
    f_title, f_label, f_small, f_tiny = load_font(30), load_font(19), load_font(15), load_font(12)

    d.text((40, 30), args.title, fill=C_TEXT, font=f_title)
    d.text((40, 66), "证据：本机 App 数据分布 · 浏览器访问 · 安装记录 · 邮箱订阅与发票（只读采集）",
           fill=C_DIM, font=f_tiny)

    for i, m in enumerate(months):
        lab = rot_label(f"{m[2:4]}/{m[5:7]}", f_tiny, C_DIM)
        img.paste(lab, (left + i * cw + (cw - 8 - lab.width) // 2, top - 14 - lab.height), lab)
        if m.endswith("-01"):
            x = left + i * cw - 3
            d.line([(x, top - 8), (x, top + len(tools) * (ch + gap) - gap + 8)], fill=(209, 213, 219), width=2)

    max_files = max([max(t.get("files", {}).values() or [1]) for t in tools] + [1])
    max_browser = max([max(t.get("browser", {}).values() or [1]) for t in tools] + [1])

    for r, t in enumerate(tools):
        y = top + r * (ch + gap)
        d.text((40, y + 6), t["name"], fill=C_TEXT, font=f_label)
        for i, m in enumerate(months):
            x = left + i * cw
            d.rounded_rectangle([x, y, x + cw - 8, y + ch], radius=5, fill=C_BG)
            nf = t.get("files", {}).get(m, 0)
            nb = t.get("browser", {}).get(m, 0)
            if nb:
                a = 0.25 + 0.75 * math.log1p(nb) / math.log1p(max_browser)
                d.rounded_rectangle([x, y, x + cw - 8, y + ch], radius=5,
                                    fill=tuple(int(255 - (255 - c) * a) for c in C_BROWSER))
            if nf:
                a = 0.3 + 0.7 * math.log1p(nf) / math.log1p(max_files)
                d.rounded_rectangle([x + 4, y + 4, x + cw - 12, y + ch - 4], radius=4,
                                    fill=tuple(int(255 - (255 - c) * a) for c in C_FILES))
            cx, cy = x + cw - 17, y + 8
            if m in t.get("confirmed_paid", []):
                d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=C_PAID)
                d.text((cx - 4, cy - 7), "¥", fill=(255, 255, 255), font=f_tiny)
            elif m in t.get("paid_visit", []):
                d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], outline=C_PAID, width=2)
                d.text((cx - 4, cy - 7), "¥", fill=C_PAID, font=f_tiny)
            if m in t.get("install", []):
                ix, iy = x + 10, y + 8
                d.polygon([(ix - 6, iy + 6), (ix + 6, iy + 6), (ix, iy - 4)], fill=C_INSTALL)
            label = nf if (nf and nf > nb) else (nb if nb else 0)
            if label:
                d.text((x + 8, y + ch - 16), str(label), fill=(255, 255, 255), font=f_tiny)

    ly = top + len(tools) * (ch + gap) + 18
    d.rounded_rectangle([40, ly + 2, 62, ly + 20], radius=5, fill=C_FILES)
    d.text((72, ly), "文件变动痕迹", fill=C_TEXT, font=f_small)
    d.rounded_rectangle([220, ly + 2, 242, ly + 20], radius=5, fill=C_BROWSER)
    d.text((252, ly), "浏览器访问", fill=C_TEXT, font=f_small)
    d.ellipse([400, ly + 1, 416, ly + 17], fill=C_PAID)
    d.text((424, ly), "¥ 核验付款（confirmed_paid）", fill=C_TEXT, font=f_small)
    d.ellipse([640, ly + 1, 656, ly + 17], outline=C_PAID, width=2)
    d.text((664, ly), "¥ 付费页/发票页访问", fill=C_TEXT, font=f_small)
    d.polygon([(880, ly + 18), (896, ly + 18), (888, ly + 2)], fill=C_INSTALL)
    d.text((904, ly), "安装 / 版本更新", fill=C_TEXT, font=f_small)
    d.text((40, ly + 34), "⚠️ 这是「留下的痕迹」而非完整使用记录：浏览器历史有覆盖起点；文件变动含缓存/同步；空白不代表零使用；文件时间 ≠ 使用时间。",
           fill=C_DIM, font=f_small)

    img.save(args.out)
    print(f"已生成: {os.path.abspath(args.out)} {img.size}")


if __name__ == "__main__":
    main()
