#!/usr/bin/env python3
"""Render validated layered/flow JSON to PNG, SVG or standalone HTML."""
import argparse
import html
import json
from pathlib import Path
from check_spec import validate

THEMES = {
    'light': dict(bg='#ffffff', panel='#f5f6f7', card='#ffffff', group='#eff5fd', border='#b9d2f1', ink='#24292f', muted='#70757a', blue='#0866e8', green='#00a63c', success='#eff9f2'),
    'dark': dict(bg='#17191d', panel='#25282e', card='#30343b', group='#1e2a3c', border='#45658b', ink='#ededed', muted='#b5bac2', blue='#75adff', green='#65d68a', success='#20392a'),
}

# Normalized line icons are shared by all output formats; no external assets.
ICONS = {
 'user': [[(6,20),(6,16),(9,13),(15,13),(18,16),(18,20)],[(8,6),(9,3),(15,3),(16,6),(15,10),(9,10),(8,6)]],
 'brain': [[(12,3),(8,2),(5,5),(5,9),(3,11),(5,14),(5,18),(8,21),(12,20),(12,3)],[(12,4),(16,2),(19,5),(19,9),(21,11),(19,14),(19,18),(16,21),(12,20)],[(5,9),(9,10),(8,15)]],
 'book': [[(12,6),(7,3),(2,3),(2,19),(7,19),(12,22),(17,19),(22,19),(22,3),(17,3),(12,6),(12,22)]],
 'tools': [[(14,3),(14,8),(18,10),(22,7),(21,13),(16,15),(7,22),(2,17),(11,10),(10,5),(14,3)]],
 'loop': [[(3,10),(5,5),(11,3),(17,5),(20,8),(15,8)],[(20,3),(20,8)],[(21,14),(19,19),(13,21),(7,19),(4,16),(9,16)],[(4,21),(4,16)]],
 'shield': [[(12,2),(21,6),(20,15),(16,20),(12,22),(8,20),(4,15),(3,6),(12,2)],[(8,12),(11,15),(16,9)]],
 'clipboard': [[(8,4),(3,4),(3,22),(21,22),(21,4),(16,4)],[(8,2),(16,2),(16,7),(8,7),(8,2)],[(7,14),(10,17),(17,10)]],
 'database': [[(3,5),(7,2),(17,2),(21,5),(17,8),(7,8),(3,5),(3,19),(7,22),(17,22),(21,19),(21,5)],[(3,12),(7,15),(17,15),(21,12)]],
 'check': [[(3,12),(9,18),(21,5)]],
 'arrow': [[(12,3),(12,21)],[(5,14),(12,21),(19,14)]],
}


class Diagram:
    def __init__(self, width):
        self.width = width
        self.items = []

    def rect(self, x,y,w,h,role='panel',border=None):
        self.items.append(('rect', (x,y,w,h), role, border))

    def text(self, text,x,y,size=20,role='ink',anchor='middle'):
        self.items.append(('text',(str(text),x,y,size,anchor),role,None))

    def line(self, points,role='muted'):
        self.items.append(('line',points,role,None))

    def icon(self,name,x,y,role='muted',size=24):
        for points in ICONS.get(name,[]):
            self.line([(x+a*size/24,y+b*size/24) for a,b in points],role)

    def arrow(self,y):
        self.icon('arrow',self.width/2-10,y,size=20)

    def box(self,node,y,result=False):
        self.rect(24,y,self.width-48,106,'success' if result else 'panel')
        if node.get('icon'): self.icon(node['icon'],self.width/2-12,y+10,'green' if result else 'muted')
        self.text(node.get('title',''),self.width/2,y+57,22)
        self.text(node.get('sub',''),self.width/2,y+85,17,'muted')
        return y+106

    def build(self,s):
        w=self.width
        self.text(s.get('title',''),24,38,26,anchor='start')
        y=64
        if s['type']=='layered':
            if s.get('top'):
                y=self.box(s['top'],y);self.arrow(y+10);y+=44
            group=s['group'];cards=group['cards'];cols=1 if w<600 else 2
            rows=(len(cards)+cols-1)//cols;gh=112+rows*112
            self.rect(24,y,w-48,gh,'group','border')
            if group.get('icon'):self.icon(group['icon'],w/2-12,y+12,'blue')
            self.text(group['title'],w/2,y+61,22)
            self.text(group.get('label',''),w/2,y+91,18,'muted')
            cw=(w-96-(cols-1)*16)/cols
            for i,c in enumerate(cards):
                x=48+(i%cols)*(cw+16);cy=y+110+(i//cols)*112
                self.rect(x,cy,cw,96,'card')
                if c.get('icon'):self.icon(c['icon'],x+cw/2-12,cy+9)
                self.text(c.get('en',''),x+cw/2,cy+53,19)
                self.text(c.get('cn',''),x+cw/2,cy+79,18,'muted')
            y+=gh
            if s.get('bottom'):
                self.arrow(y+10);y=self.box(s['bottom'],y+44,True)
        else:
            if s.get('start'):
                self.rect(w/2-110,y,220,54)
                self.text(s['start'],w/2,y+35,22);self.arrow(y+65);y+=100
            steps=s['steps'];gh=len(steps)*112+24+(52 if s.get('loopback') else 0)
            self.rect(24,y,w-48,gh,'group','border')
            for i,step in enumerate(steps):
                cy=y+24+i*112
                self.rect(44,cy,w-88,80,'card')
                self.text(str(step.get('n',i+1)),66,cy+31,18,'muted')
                self.text(step['title'],92,cy+31,20,anchor='start')
                self.text(step.get('desc',''),64,cy+61,18,'muted',anchor='start')
                if i<len(steps)-1:self.arrow(cy+86)
            if s.get('loopback'):
                self.icon('loop',48,y+gh-45,'blue')
                self.text(s['loopback'],84,y+gh-24,18,anchor='start')
            y+=gh
            if s.get('end'):
                self.arrow(y+10);y=self.box(dict(title=s['end'],icon='check'),y+44,True)
        self.height=y+24
        return self

    def svg(self,theme):
        colors=THEMES[theme]
        parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}" role="img"><title>结构图解</title>',f'<rect width="100%" height="100%" fill="{colors["bg"]}" class="fill-bg"/>']
        for kind,args,role,border in self.items:
            color=colors[role]
            if kind=='rect':
                x,y,w,h=args;stroke=f' stroke="{colors[border]}" class="fill-{role} stroke-{border}"' if border else f' class="fill-{role}"'
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{color}"{stroke}/>')
            elif kind=='text':
                text,x,y,size,anchor=args
                parts.append(f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" fill="{color}" class="fill-{role}">{html.escape(text)}</text>')
            else:
                points=' '.join(f'{x},{y}' for x,y in args)
                parts.append(f'<polyline points="{points}" fill="none" stroke="{color}" class="stroke-{role}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
        return ''.join(parts)+'</svg>'

    def png(self,path,theme,scale,font_path):
        from PIL import Image,ImageDraw,ImageFont
        candidates=[font_path,'/System/Library/Fonts/Hiragino Sans GB.ttc','/System/Library/Fonts/STHeiti Light.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']
        font_path=next((f for f in candidates if f and Path(f).is_file()),None)
        if not font_path:raise ValueError('PNG requires a CJK font; supply --font')
        colors=THEMES[theme];im=Image.new('RGB',(self.width*scale,self.height*scale),colors['bg']);d=ImageDraw.Draw(im)
        for kind,args,role,border in self.items:
            color=colors[role]
            if kind=='rect':
                x,y,w,h=args;d.rounded_rectangle(tuple(v*scale for v in (x,y,x+w,y+h)),radius=16*scale,fill=color,outline=colors[border] if border else None,width=scale)
            elif kind=='text':
                text,x,y,size,anchor=args;f=ImageFont.truetype(font_path,size*scale)
                if anchor=='middle':x-=d.textlength(text,font=f)/(2*scale)
                # baseline agrees with SVG rather than Pillow's default top anchor.
                d.text((x*scale,y*scale),text,font=f,fill=color,anchor='ls')
            else:d.line([(x*scale,y*scale) for x,y in args],fill=color,width=2*scale,joint='curve')
        im.save(path)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('spec',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--theme',choices=['light','dark','auto'],default='auto')
    p.add_argument('--width',type=int,default=900);p.add_argument('--scale',type=int,choices=[1,2,3],default=2);p.add_argument('--font')
    a=p.parse_args()
    try:
        if not 360<=a.width<=1600:raise ValueError('--width must be 360–1600')
        s=json.loads(a.spec.read_text(encoding='utf-8'));errors=validate(s)
        if errors:raise ValueError('; '.join(errors))
        # Reject text that cannot fit the selected width; never silently crop labels.
        diagram=Diagram(a.width).build(s)
        for kind,args,_,_ in diagram.items:
            if kind=='text':
                text,x,_,size,anchor=args
                estimate=sum(1 if ord(c)>255 else .58 for c in text)*size
                available=a.width-48 if anchor=='middle' else a.width-x-44
                if estimate>available:raise ValueError('text too wide for requested canvas; shorten labels or increase --width')
        theme='light' if s['type']=='flow' or a.theme=='auto' else a.theme
        suffix=a.output.suffix.lower()
        if suffix not in ('.png','.svg','.html'):raise ValueError('output must be .png, .svg or .html')
        a.output.parent.mkdir(parents=True,exist_ok=True)
        if suffix=='.png':diagram.png(a.output,theme,a.scale,a.font)
        elif suffix=='.svg':a.output.write_text(diagram.svg(theme),encoding='utf-8')
        else:
            css=''.join(f'.fill-{k}{{fill:{v}}}.stroke-{k}{{stroke:{v}}}' for k,v in THEMES['dark'].items())
            responsive=f'@media(prefers-color-scheme:dark){{{css}body{{background:{THEMES["dark"]["bg"]}}}}}' if a.theme=='auto' and s['type']!='flow' else ''
            a.output.write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html.escape(s.get('title','结构图解'))+'</title><style>body{margin:0;background:'+THEMES[theme]['bg']+';font-family:system-ui,"Hiragino Sans GB","Microsoft YaHei",sans-serif}main{overflow-x:auto}svg{display:block;margin:auto;max-width:none}'+responsive+'</style><main>'+diagram.svg(theme)+'</main></html>',encoding='utf-8')
        print(f'OK {a.output} ({diagram.width} × {diagram.height})')
    except (ValueError,TypeError,KeyError,OSError,ImportError) as exc:p.exit(2,f'error: {exc}\n')


if __name__=='__main__':main()
