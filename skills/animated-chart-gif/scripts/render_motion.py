#!/usr/bin/env python3
"""Render an explicit event sequence to animated HTML or GIF; no network access."""
import argparse
import html
import json
import math
from pathlib import Path

COLORS = dict(bg="#ffffff", ink="#24292f", muted="#70757a", panel="#f5f6f7",
              blue="#0866e8", pale="#eff5fd", border="#b9d2f1", line="#d4d8dd",
              green="#00a63c", green_bg="#eff9f2", red="#c44242", red_bg="#fff1f1")


def normalize(spec):
    nodes = spec.get("nodes", [])
    events = spec.get("events", [])
    if not 2 <= len(nodes) <= 10:
        raise ValueError("nodes must contain 2–10 nodes; split larger processes into scenes")
    ids = [n["id"] for n in nodes]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("node ids must be unique nonempty strings")
    if not 2 <= len(events) <= 40:
        raise ValueError("events must contain 2–40 explicit steps")
    if len({e.get("node") for e in events}) < 2:
        raise ValueError("animation must visit at least two nodes")
    for event in events:
        if event.get("node") not in ids:
            raise ValueError("event references an unknown node")
        duration = event.get("duration", 1.6)
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not .6 <= duration <= 12:
            raise ValueError("event duration must be between 0.6 and 12 seconds")
        if event.get("status", "active") not in ("active", "failed", "complete"):
            raise ValueError("event status must be active, failed or complete")
    for node in nodes:
        if not isinstance(node.get("label"), str) or not node["label"].strip():
            raise ValueError("every node needs a label")
    for key in ("title", "source"):
        if not isinstance(spec.get(key), str) or not spec[key].strip():
            raise ValueError(f"{key} is required; identify illustrative sequences as examples")
    result = dict(spec)
    result["events"] = [dict(e, duration=e.get("duration", 1.6), status=e.get("status", "active")) for e in events]
    return result


def geometry(spec):
    return 960, 190 + len(spec["nodes"]) * 112 + 160


def route(a, b):
    ya, yb = 216 + a * 112, 216 + b * 112
    if b == a + 1:
        return [(460, ya + 43), (460, yb - 43)]
    if b == a:
        return []
    return [(840, ya), (888, ya), (888, yb), (840, yb)]


def point_on(points, progress):
    lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
    remaining = sum(lengths) * progress
    for a, b, length in zip(points, points[1:], lengths):
        if remaining <= length:
            t = remaining / length if length else 0
            return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
        remaining -= length
    return points[-1]


def lines(text, limit=42):
    # CJK counts twice; explicit newlines are also respected.
    result = []
    for paragraph in str(text).split("\n"):
        line, size = "", 0
        for char in paragraph:
            weight = 2 if ord(char) > 255 else 1
            if size + weight > limit:
                result.append(line)
                line, size = "", 0
            line += char
            size += weight
        result.append(line)
    return result


def validate_text(spec):
    if len(lines(spec["title"], 62)) > 2:
        raise ValueError("title too long; shorten it")
    for n in spec["nodes"]:
        if len(lines(n["label"], 48)) > 1 or len(lines(n.get("note", ""), 70)) > 1:
            raise ValueError("node text too long; shorten label/note or split the scene")
    for e in spec["events"]:
        if len(lines(e.get("caption", ""), 80)) > 2:
            raise ValueError("caption too long; split the event")
    if len(lines(spec["source"], 100)) > 2:
        raise ValueError("source too long; use a short source reference")


def render_html(spec, output):
    w, h = geometry(spec)
    esc = html.escape
    parts = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-labelledby="title desc"><title id="title">{esc(spec["title"])}</title><desc id="desc">按事件顺序播放的过程图，可暂停、回放和拖动进度。</desc>']
    for j, text in enumerate(lines(spec["title"], 62)):
        parts.append(f'<text x="36" y="{48+j*36}" class="heading">{esc(text)}</text>')
    parts.append(f'<rect x="24" y="138" width="912" height="{len(spec["nodes"])*112+20}" rx="24" fill="#eff5fd" stroke="#b9d2f1"/>')
    for i in range(len(spec["nodes"])-1):
        pts = route(i, i+1)
        parts.append(f'<path d="M {pts[0][0]} {pts[0][1]} L {pts[1][0]} {pts[1][1]}" class="connector" marker-end="url(#arrow)"/>')
    parts.append('<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10" fill="#92989f"/></marker></defs><path id="travel" fill="none" stroke="#0866e8" stroke-width="3" marker-end="url(#arrow)"/><circle id="dot" r="6" fill="#0866e8"/>')
    for i, n in enumerate(spec["nodes"]):
        y = 216+i*112
        parts.append(f'<g id="node-{i}"><rect x="64" y="{y-43}" width="776" height="86" rx="18" fill="white" stroke="white" stroke-width="2"/><circle cx="102" cy="{y}" r="20" fill="#f5f6f7"/><text x="102" y="{y+7}" text-anchor="middle" class="number">{i+1}</text><text x="140" y="{y-6}" class="label">{esc(n["label"])}</text><text x="140" y="{y+24}" class="note">{esc(n.get("note", ""))}</text></g>')
    parts.append(f'<text id="caption" x="36" y="{h-116}" class="caption"></text>')
    for j, text in enumerate(lines(spec["source"], 100)):
        parts.append(f'<text x="36" y="{h-42+j*20}" class="source">{esc(text)}</text>')
    parts.append('</svg>')
    payload = json.dumps(spec, ensure_ascii=False).replace("<", r"\u003c").replace(">", r"\u003e").replace("&", r"\u0026")
    page = r"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>动态过程图解</title>
<style>*{box-sizing:border-box}body{margin:0;background:white;color:#24292f;font-family:system-ui,-apple-system,'Hiragino Sans GB','Microsoft YaHei',sans-serif}main{max-width:960px;margin:auto}.scene{overflow-x:auto}svg{display:block;width:100%;min-width:720px;height:auto}.mobile-hint{display:none}@media(max-width:600px){.mobile-hint{display:block;padding:8px 24px;color:#70757a;font-size:14px}}.heading{font-size:28px;font-weight:650}.label{font-size:24px;font-weight:600}.note{font-size:19px;fill:#70757a}.number{font-size:20px}.caption{font-size:22px;fill:#24292f}.source{font-size:15px;fill:#70757a}.connector{fill:none;stroke:#d4d8dd;stroke-width:2}.controls{display:flex;gap:12px;align-items:center;padding:12px 24px;flex-wrap:wrap;position:sticky;bottom:0;background:#fffffff5;border-top:1px solid #eee}button,select{font:inherit;padding:8px 12px;background:#f5f6f7;border:1px solid #d4d8dd;border-radius:8px}input{flex:1;min-width:100px;accent-color:#0866e8}#status{font-size:14px;color:#70757a}</style><main><p class="mobile-hint">左右滑动查看完整流程；可暂停后阅读。</p><div class="scene">""" + ''.join(parts) + r"""</div><div class="controls"><button id="play">暂停</button><button id="replay">重播</button><input id="seek" aria-label="播放进度" type="range" min="0" step="0.01" value="0"><select id="speed" aria-label="播放速度"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><span id="status"></span></div></main><script>
const spec=PAYLOAD;
const ids=spec.nodes.map(n=>n.id), events=spec.events, starts=[];let total=0;
events.forEach(e=>{starts.push(total);total+=e.duration});
const seek=document.getElementById('seek'),play=document.getElementById('play'),status=document.getElementById('status'),travel=document.getElementById('travel'),dot=document.getElementById('dot');seek.max=total;
let time=0, paused=matchMedia('(prefers-reduced-motion: reduce)').matches,last=null;
function route(a,b){const ya=216+a*112,yb=216+b*112;if(b===a+1)return [[460,ya+43],[460,yb-43]];if(a===b)return [];return [[840,ya],[888,ya],[888,yb],[840,yb]]}
function draw(){let k=events.length-1;for(let i=0;i<events.length;i++)if(time<starts[i]+events[i].duration){k=i;break}
 const e=events[k],current=ids.indexOf(e.node),seen=new Set(events.slice(0,k).map(e=>e.node));
 spec.nodes.forEach((n,i)=>{const r=document.querySelector('#node-'+i+' rect');let fill='white',stroke='white';if(seen.has(n.id))stroke='#b9d2f1';if(i===current){stroke=e.status==='complete'?'#00a63c':e.status==='failed'?'#c44242':'#0866e8';fill=e.status==='complete'?'#eff9f2':e.status==='failed'?'#fff1f1':'#eff5fd'}r.setAttribute('fill',fill);r.setAttribute('stroke',stroke)});
 const pts=k?route(ids.indexOf(events[k-1].node),current):[];travel.setAttribute('d',pts.length?'M '+pts.map(p=>p.join(' ')).join(' L '):'');dot.style.display=pts.length?'':'none';if(pts.length){const length=travel.getTotalLength(),p=travel.getPointAtLength(length*Math.min(1,(time-starts[k])/.5));dot.setAttribute('cx',p.x);dot.setAttribute('cy',p.y)}
 const caption=document.getElementById('caption');caption.replaceChildren();const text=e.caption||'', chunks=[];let line='',width=0;for(const c of text){let weight=c.codePointAt(0)>255?2:1;if(c==='\n'||width+weight>80){chunks.push(line);line='';width=0;if(c==='\n')continue}line+=c;width+=weight}chunks.push(line);chunks.forEach((s,i)=>{const t=document.createElementNS('http://www.w3.org/2000/svg','tspan');t.setAttribute('x','36');t.setAttribute('dy',i?'30':'0');t.textContent=s;caption.append(t)});
 seek.value=time;status.textContent=(k+1)+' / '+events.length;play.textContent=paused?'播放':'暂停';}
play.onclick=()=>{if(time>=total)time=0;paused=!paused;draw()};document.getElementById('replay').onclick=()=>{time=0;paused=false;draw()};seek.oninput=()=>{time=Number(seek.value);paused=true;draw()};
function tick(now){if(last!==null&&!paused){time=Math.min(total,time+(now-last)/1000*Number(document.getElementById('speed').value));if(time>=total)paused=true;draw()}last=now;requestAnimationFrame(tick)}draw();requestAnimationFrame(tick);
</script></html>""".replace('PAYLOAD', payload)
    output.write_text(page, encoding="utf-8")


def render_gif(spec, output):
    from PIL import Image, ImageDraw, ImageFont
    fonts = [spec.get("font_path", ""), "/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Light.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
    selected = next((f for f in fonts if f and Path(f).is_file()), None)
    if not selected:
        raise ValueError("GIF needs a CJK font; set font_path to an installed font")
    font = lambda size: ImageFont.truetype(selected, size)
    w, h = geometry(spec)
    ids = [n["id"] for n in spec["nodes"]]
    frames, seen = [], set()
    durations = []
    for k, event in enumerate(spec["events"]):
        active = ids.index(event["node"])
        count = round(event["duration"]*10)
        for frame in range(count):
            im = Image.new("RGB", (w, h), COLORS["bg"])
            d = ImageDraw.Draw(im)
            for j, text in enumerate(lines(spec["title"], 62)):
                d.text((36, 22+j*36), text, font=font(28), fill=COLORS["ink"])
            d.rounded_rectangle((24,138,936,158+len(ids)*112),24,fill=COLORS["pale"],outline=COLORS["border"],width=2)
            for i in range(len(ids)-1):
                pts = route(i, i+1)
                d.line(pts,fill=COLORS["line"],width=2)
                x,y = pts[-1];d.line([(x-5,y-7),(x,y),(x+5,y-7)],fill=COLORS["muted"],width=2)
            pts = route(ids.index(spec["events"][k-1]["node"]),active) if k else []
            if pts:
                d.line(pts,fill=COLORS["blue"],width=3)
                x,y=pts[-1];dx=x-pts[-2][0];dy=y-pts[-2][1];length=math.hypot(dx,dy);ux,uy=dx/length,dy/length
                d.polygon([(x,y),(x-10*ux+5*uy,y-10*uy-5*ux),(x-10*ux-5*uy,y-10*uy+5*ux)],fill=COLORS["blue"])
                x,y=point_on(pts,min(1,frame/5));d.ellipse((x-6,y-6,x+6,y+6),fill=COLORS["blue"])
            for i,node in enumerate(spec["nodes"]):
                y=216+i*112
                fill,stroke="#ffffff",COLORS["border"] if node["id"] in seen else "#ffffff"
                if i==active:
                    tone={"active":("pale","blue"),"complete":("green_bg","green"),"failed":("red_bg","red")}[event["status"]]
                    fill,stroke=(COLORS[t] for t in tone)
                d.rounded_rectangle((64,y-43,840,y+43),18,fill=fill,outline=stroke,width=2)
                d.ellipse((82,y-20,122,y+20),fill=COLORS["panel"])
                d.text((102,y),str(i+1),font=font(20),fill=COLORS["ink"],anchor="mm")
                d.text((140,y-31),node["label"],font=font(24),fill=COLORS["ink"])
                d.text((140,y+1),node.get("note",""),font=font(19),fill=COLORS["muted"])
            for j,text in enumerate(lines(event.get("caption",""),80)):
                d.text((36,h-140+j*30),text,font=font(22),fill=COLORS["ink"])
            for j,text in enumerate(lines(spec["source"],100)):
                d.text((36,h-60+j*20),text,font=font(15),fill=COLORS["muted"])
            frames.append(im.quantize(colors=96))
            durations.append(100)
        seen.add(event["node"])
    # A final reading pause belongs to the final event; read actual frame durations.
    durations[-1] += 1200
    frames[0].save(output,save_all=True,append_images=frames[1:],duration=durations,loop=0,optimize=True,disposal=2)
    print(f"GIF: {len(frames)} input frames, {sum(durations)/1000:.1f}s, {output.stat().st_size/1024:.0f} KiB")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec",type=Path)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    try:
        spec=normalize(json.loads(args.spec.read_text(encoding="utf-8")))
        validate_text(spec)
        if args.output.suffix.lower() not in (".html", ".gif"):
            raise ValueError("output must be animated .html or .gif")
        args.output.parent.mkdir(parents=True,exist_ok=True)
        (render_html if args.output.suffix.lower()==".html" else render_gif)(spec,args.output)
    except (ValueError,KeyError,TypeError,ImportError,OSError) as exc:
        parser.exit(2,f"error: {exc}\n")


if __name__ == "__main__":
    main()
