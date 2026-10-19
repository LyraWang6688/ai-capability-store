#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ops-audit —— 每月一次，把「服务器运行状态」和「本机命令用法」做成一份可核验的审计报告。

三条设计原则（也是它能进 AI Capability Store 的前提）：

1. **只读**：所有检查都不修改服务器与本机，唯一的写入是自己的报告目录。
2. **配置与代码分离**：真实主机、域名、路径、GitHub 账号都在 config.local.json；
   仓库里只放 config.example.json（占位符）。
3. **纯函数可测**：解析与判定不碰网络，test_ops_audit.py 用离线夹具验证。

用法：
    python3 ops_audit.py run            # 全部检查 + 生成报告
    python3 ops_audit.py health         # 只做服务器体检
    python3 ops_audit.py projects       # 只做「部署项目 × GitHub 活跃度」审计
    python3 ops_audit.py check          # 校验配置是否完整
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
def _default_config_path():
    """优先 config.local.json（本机开发），其次 config.json（部署到服务器时用）。"""
    for name in ("config.local.json", "config.json"):
        p = os.path.join(HERE, name)
        if os.path.exists(p):
            return p
    return os.path.join(HERE, "config.local.json")


DEFAULT_CONFIG = _default_config_path()
EXAMPLE_CONFIG = os.path.join(HERE, "config.example.json")
SSH_BIN = "/usr/bin/ssh"
CURL_BIN = "/usr/bin/curl"
GH_BIN = "/opt/homebrew/bin/gh" if os.path.exists("/opt/homebrew/bin/gh") else "gh"

# --------------------------------------------------------------------------- 默认配置

SWAP_RATE_WARN_KB = 100  # KB/s：低于这个量的换页属于正常

DEFAULTS = {
    "runtime": {"local": False},
    "server": {"host": "", "ssh_user": "ubuntu", "roots": ["~", "/opt", "/srv", "/var/www"]},
    "domains": {},
    "expect": {"pm2": [], "docker": [], "ports": [5000, 3011]},
    "thresholds": {
        "disk_warn": 85, "disk_crit": 92, "inode_warn": 85,
        "mem_avail_warn_mb": 150, "load_warn_ratio": 1.0,
        "cert_warn_days": 21, "restart_delta_warn": 5, "disk_delta_warn": 5,
    },
    "repos": {"owner": "", "inactive_days": 180},
    "paths": {"data_dir": "data"},
    "outputs": {"local_report": True, "feishu_base": None},
}

# --------------------------------------------------------------------------- 基础工具


def deep_merge(base, override):
    """把 override 合进 base（dict 递归，其余覆盖）。纯函数。"""
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path):
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            cfg = deep_merge(DEFAULTS, json.load(f))
    cfg["_source"] = path if os.path.exists(path) else "(defaults)"
    return cfg


def read_text(path):
    with open(os.path.expanduser(path), encoding="utf-8", errors="replace") as f:
        return f.read()


def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def run(cmd, timeout=120, stdin_text=None):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=stdin_text)
    except Exception as e:  # noqa: BLE001 - 采集层要吞掉所有环境异常
        return None, str(e)
    return p.stdout, (p.stderr if p.returncode != 0 else "")


def sh(cmd, cfg_fallback=""):
    """执行本地命令，失败返回空串。"""
    out, _ = run(cmd)
    return (out or "").strip()


# --------------------------------------------------------------------------- 采集：服务器

REMOTE_SCRIPT = r'''
set -u
echo "HOSTNAME=$(hostname)"
echo "UPTIME_DAYS=$(awk '{print int($1/86400)}' /proc/uptime)"
echo "LOAD1=$(awk '{print $1}' /proc/loadavg)"
echo "NPROC=$(nproc)"
read -r mt ma <<< "$(free -m | awk '/^Mem:/{print $2, $7}')"
echo "MEM_TOTAL_MB=$mt"; echo "MEM_AVAIL_MB=$ma"
read -r st su <<< "$(free -m | awk '/^Swap:/{print $2, $3}')"
echo "SWAP_TOTAL_MB=$st"; echo "SWAP_USED_MB=$su"
read -r si so act <<< "$(vmstat 1 3 | tail -n +3 | awk '{if($7+$8>0)c++; if($7>ms)ms=$7; if($8>mo)mo=$8} END{printf "%d %d %d\n", ms, mo, c}')"
echo "SWAP_SI=$si"; echo "SWAP_SO=$so"; echo "SWAP_ACTIVE=$act"
df -P / | awk 'NR==2{gsub("%","",$5); print "DISK_PCT="$5}'
df -P / | awk 'NR==2{print "DISK_FREE_GB="int($4/1024/1024)}'
df -Pi / | awk 'NR==2{gsub("%","",$5); print "INODE_PCT="$5}'
if sudo -n nginx -t >/dev/null 2>&1; then echo "NGINX_TEST=ok"; else echo "NGINX_TEST=fail"; fi
echo "OOM_COUNT=$(sudo -n dmesg 2>/dev/null | grep -ci 'oom-kill\|out of memory' || true)"
for p in __PORTS__; do
  echo "PORT_$p=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$p/ 2>/dev/null)"
done
pm2 jlist 2>/dev/null | python3 -c '
import sys, json
try:
    for p in json.load(sys.stdin):
        print("PM2=%s|%s|%s" % (p.get("name"), p.get("pm2_env",{}).get("status"), p.get("pm2_env",{}).get("restart_time",0)))
except Exception:
    pass
'
docker ps --format 'DOCKER={{.Names}}|{{.Status}}' 2>/dev/null
sudo -n bash -c '
for dd in /etc/letsencrypt/live/*/; do
  n=$(basename "$dd")
  exp=$(openssl x509 -enddate -noout -in "$dd/cert.pem" 2>/dev/null | cut -d= -f2)
  if [ -n "$exp" ]; then
    echo "CERT=$n|$(( ( $(date -d "$exp" +%s) - $(date +%s) ) / 86400 ))"
  fi
done'
for root in __ROOTS__; do
  sudo -n find "$root" -maxdepth 4 -name .git -type d 2>/dev/null | sed 's|/.git$||' | while read -r p; do
    u=$(git -C "$p" config --get remote.origin.url 2>/dev/null)
    if [ -n "$u" ]; then echo "PROJECT=$p|$u"; fi
  done
done
'''


def parse_server_facts(text):
    """把远端 KEY=VALUE 文本解析成结构化事实。纯函数（可离线测试）。"""
    facts = {
        "kv": {}, "pm2": [], "docker": [], "certs": {}, "projects": [],
    }
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if not k.strip():
            continue
        if k == "PM2":
            parts = v.split("|")
            if len(parts) >= 3:
                facts["pm2"].append({"name": parts[0], "status": parts[1], "restarts": int(parts[2] or 0)})
        elif k == "DOCKER":
            parts = v.split("|", 1)
            facts["docker"].append({"name": parts[0], "status": parts[1] if len(parts) > 1 else ""})
        elif k == "CERT":
            name, _, days = v.partition("|")
            try:
                facts["certs"][name] = int(days)
            except ValueError:
                pass
        elif k == "PROJECT":
            path, _, remote = v.partition("|")
            facts["projects"].append({"path": path, "remote": remote})
        else:
            facts["kv"][k] = v
    return facts


def collect_server(cfg):
    """采集服务器事实。runtime.local=true 时直接在本机执行（用于"跑在服务器上"）。"""
    srv = cfg["server"]
    ports = " ".join(str(p) for p in cfg["expect"].get("ports", []))
    roots = " ".join(srv.get("roots", []))
    script = REMOTE_SCRIPT.replace("__PORTS__", ports).replace("__ROOTS__", roots)

    if cfg.get("runtime", {}).get("local"):
        out, err = run(["/bin/bash", "-s"], timeout=180, stdin_text=script)
        if out is None:
            return None, f"本地执行失败：{err}"
        return parse_server_facts(out), None

    if not srv.get("host"):
        return None, "config.server.host 未配置（或在 runtime.local 里设为 true）"
    target = f"{srv.get('ssh_user','ubuntu')}@{srv['host']}"
    out, err = run([SSH_BIN, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "bash -s"],
                   timeout=180, stdin_text=script)
    if out is None:
        return None, f"ssh 连接失败：{err}"
    return parse_server_facts(out), None


def check_domains(cfg):
    """从本机测公网域名可达性（用户视角）。"""
    codes = {}
    for label, domain in (cfg.get("domains") or {}).items():
        out, _ = run([CURL_BIN, "-s", "-o", "/dev/null", "-w", "%{http_code}",
                      "--max-time", "10", f"https://{domain}/"], timeout=20)
        codes[label] = (out or "000").strip() or "000"
    return codes


# --------------------------------------------------------------------------- 判定：体检


def health_issues(facts, domains_codes, prev, thresholds, domain_hosts=()):
    """根据事实判定问题清单。纯函数：facts/prev/thresholds 全部由参数传入。"""
    issues = []
    kv = facts.get("kv", {})

    def num(key, cast=int, default=0):
        try:
            return cast(kv.get(key, default))
        except (TypeError, ValueError):
            return default

    disk = num("DISK_PCT")
    inode = num("INODE_PCT")
    mem_avail = num("MEM_AVAIL_MB")
    load1 = num("LOAD1", float, 0.0)
    nproc = num("NPROC", int, 1) or 1
    si, so = num("SWAP_SI"), num("SWAP_SO")
    swap_active = num("SWAP_ACTIVE")

    if disk >= thresholds["disk_crit"]:
        issues.append(("🔴", f"磁盘 {disk}%（≥{thresholds['disk_crit']}%）"))
    elif disk >= thresholds["disk_warn"]:
        issues.append(("🟡", f"磁盘 {disk}%（≥{thresholds['disk_warn']}%）"))
    if inode >= thresholds["inode_warn"]:
        issues.append(("🟡", f"inode 使用 {inode}%"))
    if mem_avail and mem_avail < thresholds["mem_avail_warn_mb"]:
        issues.append(("🟡", f"可用内存仅 {mem_avail}MB"))
    # 单次采样偶尔换页是正常的，只有"持续 + 有量"才算压力
    if swap_active >= 2 and (si + so) >= SWAP_RATE_WARN_KB:
        issues.append(("🟡", f"持续换页（si={si}/so={so} KB/s，{swap_active}/3 个采样有换页）"))
    if load1 > nproc * thresholds["load_warn_ratio"]:
        issues.append(("🟡", f"负载 {load1} 超过核数 {nproc}"))

    pm2 = facts.get("pm2", [])
    for p in pm2:
        if p["status"] != "online":
            issues.append(("🔴", f"pm2 进程异常：{p['name']}（{p['status']}）"))

    if kv.get("NGINX_TEST") and kv["NGINX_TEST"] != "ok":
        issues.append(("🔴", "nginx 配置检查失败"))
    oom = num("OOM_COUNT")
    if oom > 0:
        issues.append(("🟡", f"系统日志里有 {oom} 条 OOM 记录（历史）"))

    for label, code in (domains_codes or {}).items():
        if not str(code).startswith(("2", "3")):
            issues.append(("🔴", f"域名 {label} 返回 {code}"))

    unused_certs = []
    for name, days in sorted(facts.get("certs", {}).items()):
        if days < thresholds["cert_warn_days"]:
            issues.append(("🟡", f"证书 {name} 剩余 {days} 天"))
        if name not in set(domain_hosts or ()):
            unused_certs.append(name)

    return issues, unused_certs


def expected_issues(facts, expect, domains_codes):
    """检查「应该存在的东西」是否存在：pm2/容器/端口/域名。纯函数。"""
    issues = []
    pm2_names = {p["name"] for p in facts.get("pm2", []) if p["status"] == "online"}
    for name in expect.get("pm2", []):
        if name not in pm2_names:
            issues.append(("🔴", f"pm2 进程 {name} 不在运行"))
    docker_names = {d["name"] for d in facts.get("docker", [])}
    for name in expect.get("docker", []):
        if name not in docker_names:
            issues.append(("🔴", f"容器 {name} 不在运行"))
    for port in expect.get("ports", []):
        code = facts.get("kv", {}).get(f"PORT_{port}", "000")
        if not str(code).startswith(("2", "3")):
            issues.append(("🔴", f"本地端口 {port} 返回 {code}"))
    return issues


def delta_issues(facts, prev, thresholds):
    """与上次快照的环比异常。纯函数。"""
    issues = []
    if not prev:
        return issues
    disk = int(facts.get("kv", {}).get("DISK_PCT", 0) or 0)
    pdisk = prev.get("disk_pct")
    if pdisk is not None and disk - pdisk >= thresholds["disk_delta_warn"]:
        issues.append(("🟡", f"磁盘环比 +{disk - pdisk}%（{pdisk}% → {disk}%）"))
    prev_restarts = prev.get("pm2_restarts", {}) or {}
    for p in facts.get("pm2", []):
        old = prev_restarts.get(p["name"])
        if old is not None and p["restarts"] - old >= thresholds["restart_delta_warn"]:
            issues.append(("🟡", f"{p['name']} 本月重启 {p['restarts'] - old} 次（累计 {p['restarts']}），疑似崩溃循环"))
    return issues


# --------------------------------------------------------------------------- 判定：项目活跃度


def repo_slug_from_remote(url):
    """git remote → owner/repo。纯函数。"""
    if not url:
        return ""
    m = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?$", url.strip())
    return f"{m.group(1)}/{m.group(2)}" if m else ""


def classify_project(repo_meta, pushed_iso, today, inactive_days):
    """四档判定：活跃 / 不活跃 / 已归档 / 已删除。纯函数。

    repo_meta: None 表示仓库不可访问（删除或私有不可见）；dict 含 isArchived/pushedAt。
    """
    if repo_meta is None:
        return "已删除", None
    if repo_meta.get("isArchived"):
        return "已归档", None
    if not pushed_iso:
        return "活跃", None
    try:
        y, m, d = (int(x) for x in pushed_iso[:10].split("-"))
        idle = (today - date(y, m, d)).days
    except Exception:  # noqa: BLE001
        return "活跃", None
    return ("不活跃", idle) if idle > inactive_days else ("活跃", idle)


def fetch_repo_meta(slug, token=""):
    """查一个 GitHub 仓库的元数据（不依赖 gh，纯标准库）。

    返回 dict(isArchived, pushedAt)；仓库不存在/不可见返回 None；
    网络错误也返回 None（由上层判定为"不可访问"）。
    """
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        f"https://api.github.com/repos/{slug}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "ops-audit"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        return None
    except Exception:  # noqa: BLE001
        return None
    return {"isArchived": bool(data.get("archived")), "pushedAt": data.get("pushed_at")}


def collect_projects(cfg):
    """采集服务器上的项目 + 它们对应的 GitHub 仓库状态。"""
    facts, err = collect_server(cfg)
    if err:
        return None, err
    token = (cfg.get("repos") or {}).get("token", "")
    rows = []
    for proj in facts.get("projects", []):
        slug = repo_slug_from_remote(proj["remote"])
        if not slug:
            continue
        meta = fetch_repo_meta(slug, token)
        pushed = (meta or {}).get("pushedAt")
        rows.append({"slug": slug, "path": proj["path"], "meta": meta, "pushed": pushed})
    return rows, None


# --------------------------------------------------------------------------- 报告


def render_report(cfg, today, health, projects, prev):
    """生成 Markdown 报告。纯函数（只依赖入参）。"""
    lines = [f"# ops-audit 月度报告 · {today}", ""]
    host = (health.get("facts", {}).get("kv", {}) or {}).get("HOSTNAME") or cfg["server"].get("host", "(未配置)")
    lines.append(f"> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}　·　服务器：`{host}`")
    lines.append("")

    # 一、结论
    issues = health.get("issues", [])
    blocker = [i for i in issues if i[0] == "🔴"]
    warn = [i for i in issues if i[0] == "🟡"]
    verdict = "🔴 有阻断问题" if blocker else ("🟡 有提示" if warn else "✅ 健康")
    lines.append(f"## 总体：{verdict}")
    lines.append("")
    if issues:
        for lv, text in issues:
            lines.append(f"- {lv} {text}")
    else:
        lines.append("- 全部检查项正常")
    lines.append("")

    # 二、服务器
    kv = health.get("facts", {}).get("kv", {})
    if kv:
        lines.append("## 服务器")
        lines.append("")
        lines.append("| 指标 | 数值 |")
        lines.append("|---|---|")
        lines.append(f"| 运行时长 | {kv.get('UPTIME_DAYS','?')} 天 |")
        lines.append(f"| 负载 | {kv.get('LOAD1','?')} / {kv.get('NPROC','?')} 核 |")
        lines.append(f"| 内存可用 | {kv.get('MEM_AVAIL_MB','?')} MB / {kv.get('MEM_TOTAL_MB','?')} MB |")
        lines.append(f"| swap 已用 | {kv.get('SWAP_USED_MB','?')} MB（换页 si/so={kv.get('SWAP_SI','?')}/{kv.get('SWAP_SO','?')} KB/s） |")
        lines.append(f"| 磁盘 | {kv.get('DISK_PCT','?')}%（剩 {kv.get('DISK_FREE_GB','?')} GB） |")
        lines.append(f"| inode | {kv.get('INODE_PCT','?')}% |")
        pm2 = health.get("facts", {}).get("pm2", [])
        lines.append(f"| pm2 | {', '.join(p['name']+'('+p['status']+')' for p in pm2) or '无'} |")
        docker = health.get("facts", {}).get("docker", [])
        lines.append(f"| 容器 | {', '.join(d['name'] for d in docker) or '无'} |")
        lines.append("")
    if health.get("domains"):
        lines.append("## 域名可达性")
        lines.append("")
        for k, v in health["domains"].items():
            flag = "✅" if str(v).startswith(("2", "3")) else "🔴"
            lines.append(f"- {flag} `{k}` → HTTP {v}")
        lines.append("")
    if health.get("certs"):
        lines.append("## 证书剩余天数")
        lines.append("")
        for k, v in sorted(health["certs"].items()):
            flag = "🟡" if v < cfg["thresholds"]["cert_warn_days"] else "✅"
            lines.append(f"- {flag} `{k}`：{v} 天")
        lines.append("")
    unused = health.get("unused_certs") or []
    if unused:
        lines.append(f"> 🟡 **{len(unused)} 张证书对应已下线域名**（续期会失败，建议 `certbot delete`）：")
        lines.append(f"> {', '.join('`'+u+'`' for u in unused)}")
        lines.append("")

    # 三、项目
    lines.append("## 部署项目 × GitHub 活跃度")
    lines.append("")
    if projects:
        lines.append("| 项目仓库 | 判定 | 最后推送 | 服务器路径 |")
        lines.append("|---|---|---|---|")
        icon = {"活跃": "✅", "不活跃": "⏸️", "已归档": "📦", "已删除": "❌"}
        for p in projects:
            idle = f"{p['idle_days']} 天前" if p.get("idle_days") is not None else "-"
            lines.append(f"| `{p['slug']}` | {icon.get(p['verdict'],'?')} {p['verdict']} | {idle} | `{p['path']}` |")
        need = [p for p in projects if p["verdict"] in ("已归档", "已删除")]
        if need:
            lines.append("")
            lines.append(f"**建议退休 {len(need)} 个**（上游已归档/删除，服务还在跑）：")
            for p in need:
                lines.append(f"- `{p['slug']}`（{p['verdict']}）← `{p['path']}`")
            lines.append("")
            lines.append("> 处置需人工确认：停进程 → 摘 Nginx 站点 → 删目录 → 留备份。")
    else:
        lines.append("- （未采集到部署项目）")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("*本报告由 ops-audit 自动生成，全部检查均为只读。*")
    return "\n".join(lines)


# --------------------------------------------------------------------------- HTML 报告

STATUS_TONE = {
    "ok": ("#0f7b3e", "#e7f6ec"),
    "warn": ("#8a5a00", "#fff4d6"),
    "bad": ("#a11212", "#fdeaea"),
    "muted": ("#57606a", "#f2f4f7"),
}


def _badge(text, tone="muted"):
    fg, bg = STATUS_TONE.get(tone, STATUS_TONE["muted"])
    return f'<span class="badge" style="color:{fg};background:{bg}">{text}</span>'


def render_html(cfg, today, health, projects, prev):
    """生成单文件 HTML 报告（内联 CSS，可直接打开/发给别人）。纯函数。"""
    kv = (health.get("facts", {}) or {}).get("kv", {}) or {}
    issues = health.get("issues", []) or []
    blocker = [i for i in issues if i[0] == "🔴"]
    warn = [i for i in issues if i[0] == "🟡"]
    if blocker:
        verdict, tone = "有阻断问题", "bad"
    elif warn:
        verdict, tone = "有提示", "warn"
    else:
        verdict, tone = "健康", "ok"

    host = kv.get("HOSTNAME") or cfg["server"].get("host") or "本机"
    generated = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def card(title, value, sub=""):
        return (f'<div class="card"><div class="k">{title}</div>'
                f'<div class="v">{value}</div><div class="s">{sub}</div></div>')

    # 资源卡片
    disk = kv.get("DISK_PCT", "?")
    disk_tone = "bad" if isinstance(disk, str) and disk.isdigit() and int(disk) >= 92 else (
        "warn" if isinstance(disk, str) and disk.isdigit() and int(disk) >= 85 else "ok")
    cards = "".join([
        card("磁盘", f"{disk}%", f"剩 {kv.get('DISK_FREE_GB','?')} GB"),
        card("内存可用", f"{kv.get('MEM_AVAIL_MB','?')} MB", f"总 {kv.get('MEM_TOTAL_MB','?')} MB"),
        card("负载", f"{kv.get('LOAD1','?')}", f"{kv.get('NPROC','?')} 核"),
        card("运行时长", f"{kv.get('UPTIME_DAYS','?')} 天", ""),
    ])

    # 服务行
    pm2 = health.get("facts", {}).get("pm2", []) or []
    docker = health.get("facts", {}).get("docker", []) or []
    services = "".join([
        f"<tr><td>pm2</td><td>{'、'.join(p['name']+'（'+p['status']+'）' for p in pm2) or '—'}</td></tr>",
        f"<tr><td>容器</td><td>{'、'.join(d['name'] for d in docker) or '—'}</td></tr>",
        f"<tr><td>nginx</td><td>{kv.get('NGINX_TEST','?')}</td></tr>",
        f"<tr><td>swap</td><td>已用 {kv.get('SWAP_USED_MB','?')} MB（换页 si/so={kv.get('SWAP_SI','?')}/{kv.get('SWAP_SO','?')} KB/s）</td></tr>",
    ])

    # 域名
    domain_rows = "".join(
        f"<tr><td>{label}</td><td><code>{code}</code></td><td>{_badge('可达','ok') if str(code).startswith(('2','3')) else _badge('不可达','bad')}</td></tr>"
        for label, code in (health.get("domains") or {}).items()
    ) or "<tr><td colspan='3'>未配置域名</td></tr>"

    # 证书
    cert_rows = "".join(
        f"<tr><td>{name}</td><td>{days} 天</td><td>"
        + (_badge('临期','warn') if days < cfg["thresholds"]["cert_warn_days"] else _badge('正常','ok'))
        + "</td></tr>"
        for name, days in sorted((health.get("certs") or {}).items())
    ) or "<tr><td colspan='3'>未发现证书</td></tr>"

    # 项目
    icon = {"活跃": "ok", "不活跃": "warn", "已归档": "warn", "已删除": "bad"}
    project_rows = "".join(
        f"<tr><td><code>{p['slug']}</code></td>"
        f"<td>{_badge(p['verdict'], icon.get(p['verdict'], 'muted'))}</td>"
        f"<td>{('' + str(p['idle_days']) + ' 天前') if p.get('idle_days') is not None else '—'}</td>"
        f"<td><code>{p['path']}</code></td></tr>"
        for p in (projects or [])
    ) or "<tr><td colspan='4'>未采集到部署项目</td></tr>"

    need_remove = [p for p in (projects or []) if p["verdict"] in ("已归档", "已删除")]

    # 问题清单
    if issues:
        issue_html = "<ul class='issues'>" + "".join(
            f"<li><span class='lv'>{lv}</span> {text}</li>" for lv, text in issues
        ) + "</ul>"
    else:
        issue_html = "<p class='ok-text'>✅ 全部检查项正常</p>"

    retire_html = ""
    if need_remove:
        retire_html = (
            "<div class='panel warn-panel'><h3>建议退休（需人工确认）</h3><ul>"
            + "".join(f"<li><code>{p['slug']}</code>（{p['verdict']}）← <code>{p['path']}</code></li>"
                      for p in need_remove)
            + "</ul><p class='hint'>处置流程：停进程 → 摘 Nginx 站点 → 删目录 → 留备份。"
              "仓库状态 ≠ 业务状态，所以不自动执行。</p></div>"
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ops-audit · {today} · {host}</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; padding:32px; background:#f6f7f9; color:#1f2328;
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }}
  .wrap {{ max-width: 980px; margin: 0 auto; }}
  header {{ display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:8px; }}
  h1 {{ font-size:22px; margin:0; }}
  .meta {{ color:#57606a; font-size:13px; }}
  .badge {{ display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; }}
  .cards {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:20px 0; }}
  .card {{ background:#fff; border:1px solid #e6e8eb; border-radius:12px; padding:14px 16px; }}
  .card .k {{ color:#57606a; font-size:12px; }}
  .card .v {{ font-size:22px; font-weight:650; margin-top:2px; }}
  .card .s {{ color:#8c959f; font-size:12px; }}
  .panel {{ background:#fff; border:1px solid #e6e8eb; border-radius:12px; padding:16px 18px; margin-bottom:16px; }}
  .panel h2 {{ font-size:16px; margin:0 0 10px; }}
  .panel h3 {{ font-size:14px; margin:0 0 8px; }}
  table {{ width:100%; border-collapse:collapse; font-size:14px; }}
  th, td {{ text-align:left; padding:8px 10px; border-bottom:1px solid #eef0f2; vertical-align:top; }}
  th {{ color:#57606a; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.02em; }}
  tr:last-child td {{ border-bottom:none; }}
  code {{ background:#f2f4f7; padding:1px 5px; border-radius:5px; font-size:12.5px; }}
  ul.issues {{ margin:0; padding-left:18px; }}
  ul.issues li {{ margin:4px 0; }}
  .lv {{ margin-right:4px; }}
  .ok-text {{ color:#0f7b3e; margin:0; }}
  .hint {{ color:#57606a; font-size:13px; margin:8px 0 0; }}
  .warn-panel {{ border-color:#f0d9a8; background:#fffdf5; }}
  footer {{ color:#8c959f; font-size:12px; margin-top:24px; }}
  @media (max-width:720px) {{ .cards {{ grid-template-columns:repeat(2,1fr); }} body {{ padding:16px; }} }}
</style>
</head>
<body><div class="wrap">
<header>
  <h1>服务器月度体检</h1>
  {_badge(verdict, tone)}
  <span class="meta">{host} · {today} · 生成于 {generated}</span>
</header>

<div class="cards">{cards}</div>

<div class="panel">
  <h2>问题清单</h2>
  {issue_html}
</div>
{retire_html}
<div class="panel">
  <h2>服务状态</h2>
  <table>{services}</table>
</div>
<div class="panel">
  <h2>域名可达性</h2>
  <table><thead><tr><th>域名</th><th>HTTP</th><th>状态</th></tr></thead><tbody>{domain_rows}</tbody></table>
</div>
<div class="panel">
  <h2>证书剩余</h2>
  <table><thead><tr><th>证书</th><th>剩余</th><th>状态</th></tr></thead><tbody>{cert_rows}</tbody></table>
</div>
<div class="panel">
  <h2>部署项目 × GitHub 活跃度</h2>
  <table><thead><tr><th>仓库</th><th>判定</th><th>最后推送</th><th>服务器路径</th></tr></thead><tbody>{project_rows}</tbody></table>
</div>

<footer>本报告由 ops-audit 自动生成，所有检查均为只读；项目处置需人工确认。</footer>
</div></body></html>
"""


# --------------------------------------------------------------------------- CLI


def _state_paths(cfg):
    data_dir = os.path.expanduser(cfg["paths"].get("data_dir", "data"))
    return {
        "data": data_dir,
        "reports": os.path.join(data_dir, "reports"),
        "snapshots": os.path.join(data_dir, "snapshots"),
        "prev": os.path.join(data_dir, "snapshots", "last.json"),
    }


def cmd_health(cfg, today):
    facts, err = collect_server(cfg)
    if err:
        print(f"❌ {err}")
        return 1
    facts["_domain_hosts"] = set((cfg.get("domains") or {}).values())
    domains = check_domains(cfg)
    th = cfg["thresholds"]
    prev = load_json(_state_paths(cfg)["prev"], {})
    hosts = set((cfg.get("domains") or {}).values())
    issues, unused = health_issues(facts, domains, prev, th, domain_hosts=hosts)
    issues += expected_issues(facts, cfg["expect"], domains)
    issues += delta_issues(facts, prev, th)
    kv = facts["kv"]
    print(f"服务器体检 · {kv.get('HOSTNAME') or cfg['server'].get('host') or '本机'} · {today}\n")
    print(f"  运行时长 {kv.get('UPTIME_DAYS','?')} 天 ｜ 负载 {kv.get('LOAD1','?')} / {kv.get('NPROC','?')} 核")
    print(f"  内存可用 {kv.get('MEM_AVAIL_MB','?')}MB ｜ swap {kv.get('SWAP_USED_MB','?')}MB（si/so={kv.get('SWAP_SI','?')}/{kv.get('SWAP_SO','?')}）")
    print(f"  磁盘 {kv.get('DISK_PCT','?')}%（剩 {kv.get('DISK_FREE_GB','?')}GB）｜ inode {kv.get('INODE_PCT','?')}%")
    print(f"  pm2 {len([p for p in facts['pm2'] if p['status']=='online'])}/{len(facts['pm2'])} online ｜ 容器 {len(facts['docker'])}")
    if domains:
        print("  域名：" + " ｜ ".join(f"{k} {v}" for k, v in domains.items()))
    if unused:
        print(f"\n  提示：{len(unused)} 张证书对应已下线域名（certbot 续期会失败）：{', '.join(unused[:6])}")
    if issues:
        print(f"\n⚠️  发现 {len(issues)} 个问题：")
        for lv, t in issues:
            print(f"    {lv} {t}")
    else:
        print("\n✅ 没有发现异常。")
    return 3 if issues else 0


def cmd_projects(cfg, today):
    rows, err = collect_projects(cfg)
    if err:
        print(f"❌ {err}")
        return 1
    inactive_days = cfg["repos"]["inactive_days"]
    today_d = date(*map(int, today.split("-")))
    out = []
    for r in rows:
        verdict, idle = classify_project(r["meta"], r["pushed"], today_d, inactive_days)
        out.append({**r, "verdict": verdict, "idle_days": idle})
    icon = {"活跃": "✅", "不活跃": "⏸️", "已归档": "📦", "已删除": "❌"}
    print(f"部署项目 → GitHub 状态（{len(out)} 个）\n")
    for p in out:
        idle = f"（最后推送 {p['idle_days']} 天前）" if p["idle_days"] is not None else ""
        print(f"   {icon[p['verdict']]} {p['slug']:<42} {p['verdict']:<6}{idle}  ← {p['path']}")
    need = [p for p in out if p["verdict"] in ("已归档", "已删除")]
    confirm = [p for p in out if p["verdict"] == "不活跃"]
    if need:
        print(f"\n🚨 建议退休（{len(need)} 个）：上游已归档/删除，服务器上还部署着")
        for p in need:
            print(f"   • {p['slug']}（{p['verdict']}）← {p['path']}")
        print("   处置需你确认：停进程 → 摘 Nginx 站点 → 删目录 → 留备份")
    if confirm:
        print(f"\n⏸️ 需你判断（{len(confirm)} 个）：仓库在，但超过 {inactive_days} 天没推送")
        print("   这类不等于该删：稳定的生产服务本来就可能长期没有代码改动")
    if not (need or confirm):
        print("\n✅ 部署项目对应的仓库都存在且近期活跃。")
    return 3 if (need or confirm) else 0


def cmd_run(cfg, today):
    facts, err = collect_server(cfg)
    if err:
        print(f"❌ {err}")
        return 1
    facts["_domain_hosts"] = set((cfg.get("domains") or {}).values())
    domains = check_domains(cfg)
    paths = _state_paths(cfg)
    prev = load_json(paths["prev"], {})
    th = cfg["thresholds"]

    hosts = set((cfg.get("domains") or {}).values())
    issues, unused = health_issues(facts, domains, prev, th, domain_hosts=hosts)
    issues += expected_issues(facts, cfg["expect"], domains)
    issues += delta_issues(facts, prev, th)

    # 项目
    rows, _ = collect_projects(cfg)
    today_d = date(*map(int, today.split("-")))
    projects = []
    for r in rows or []:
        verdict, idle = classify_project(r["meta"], r["pushed"], today_d, cfg["repos"]["inactive_days"])
        projects.append({**r, "verdict": verdict, "idle_days": idle})

    health = {"issues": issues, "facts": facts, "domains": domains,
              "certs": facts.get("certs", {}), "unused_certs": unused}
    html = render_html(cfg, today, health, projects, prev)

    os.makedirs(paths["reports"], exist_ok=True)
    report_html = os.path.join(paths["reports"], f"{today}.html")
    with open(report_html, "w", encoding="utf-8") as f:
        f.write(html)
    save_json(os.path.join(paths["reports"], f"{today}.json"), {
        "date": today, "issues": issues, "projects": projects,
    })
    save_json(paths["prev"], {
        "date": today,
        "disk_pct": int(facts["kv"].get("DISK_PCT", 0) or 0),
        "inode_pct": int(facts["kv"].get("INODE_PCT", 0) or 0),
        "pm2_restarts": {p["name"]: p["restarts"] for p in facts["pm2"]},
        "docker": [d["name"] for d in facts["docker"]],
        "certs": facts.get("certs", {}),
        "domains": domains,
    })

    blocker = [i for i in issues if i[0] == "🔴"]
    print(f"报告已生成：{report_html}")
    print(f"  总体：{'🔴 有阻断问题' if blocker else ('🟡 有提示' if issues else '✅ 健康')}"
          f" ｜ 项目 {len(projects)} 个 ｜ 问题 {len(issues)} 条")
    blocker = [i for i in issues if i[0] == "🔴"]
    return 3 if (issues or any(p["verdict"] != "活跃" for p in projects)) else 0


def cmd_check(cfg, today):
    problems = []
    if not cfg.get("runtime", {}).get("local") and not cfg["server"].get("host"):
        problems.append("server.host 未配置，且 runtime.local 不为 true（无法采集服务器事实）")
    if not cfg["repos"].get("owner"):
        problems.append("repos.owner 未配置（报告中无法标注仓库归属）")
    if not cfg["expect"].get("pm2") and not cfg["expect"].get("docker"):
        problems.append("expect.pm2 / expect.docker 都为空（不会发现服务挂掉）")
    if not cfg.get("domains"):
        problems.append("domains 为空（不会检查域名可达性）")
    if problems:
        print("⚠️  配置不完整：")
        for p in problems:
            print(f"   • {p}")
        print(f"\n   参考：{EXAMPLE_CONFIG}")
        return 1
    print(f"✅ 配置完整（来源：{cfg['_source']}）")
    return 0


def main():
    ap = argparse.ArgumentParser(description="ops-audit：服务器与命令的只读审计")
    ap.add_argument("command", nargs="?", default="run",
                    choices=["run", "health", "projects", "check"])
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--today", default="")
    args = ap.parse_args()

    cfg = load_config(args.config)
    today = args.today or date.today().isoformat()
    handlers = {"run": cmd_run, "health": cmd_health, "projects": cmd_projects,
                "check": cmd_check}
    sys.exit(handlers[args.command](cfg, today))


if __name__ == "__main__":
    main()
