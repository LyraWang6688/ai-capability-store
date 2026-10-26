#!/usr/bin/env node
// `command-sync doctor`：检查这台机器能不能跑完整功能。
//
// 为什么需要它：npm 能装的是「代码」，装不了宿主。Hammerspoon 得单独 brew 装、
// 辅助功能得人工勾一次，新用户装完看面板没反应只会以为是坏的。doctor 把
// 「缺什么 + 去哪儿补」一次说完，别让人去翻 README。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const HS_APP = '/Applications/Hammerspoon.app';
const HS_BIN_CANDIDATES = ['/opt/homebrew/bin/hs', '/usr/local/bin/hs'];
const BASE = process.env.COMMAND_SYNC_HOME || join(HOME, '.command-sync');
const HS_DIR = join(HOME, '.hammerspoon');

const problems = [];
const notes = [];

const ok = (msg) => console.log('✓ ' + msg);
const bad = (msg, fix) => {
  console.log('✗ ' + msg);
  if (fix) console.log('    → ' + fix.replace(/\n/g, '\n    → '));
  problems.push(msg);
};
const warn = (msg, fix) => {
  console.log('⚠ ' + msg);
  if (fix) console.log('    → ' + fix.replace(/\n/g, '\n    → '));
};
const info = (msg) => console.log('· ' + msg);

function tryRun(cmd, args, timeout = 5000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function expand(p) {
  return p && p.startsWith('~') ? join(HOME, p.slice(1)) : p;
}

// ── 1. 运行时依赖 ─────────────────────────────────────────────────────────
console.log('command-sync doctor · 这台机器能跑完整功能吗\n');

info('Node ' + process.version);

const py = tryRun('/usr/bin/python3', ['--version']);
if (py.code === 0) ok('python3 ' + py.out.trim().replace(/^Python /, ''));
else bad('找不到 /usr/bin/python3（面板数据靠它生成）',
  'macOS 自带：终端跑 xcode-select --install 装 Command Line Tools');

// ── 2. 宿主：Hammerspoon ──────────────────────────────────────────────────
if (!existsSync(HS_APP)) {
  bad('没装 Hammerspoon（面板宿主，npm 装不了它）',
    'brew install --cask hammerspoon');
  notes.push('装好 Hammerspoon 后重跑：command-sync install');
} else {
  ok('Hammerspoon 已安装（' + HS_APP + '）');

  const hsBin = HS_BIN_CANDIDATES.find((p) => existsSync(p));
  const ipc = hsBin ? tryRun(hsBin, ['-c', 'print("__CS_OK__")']) : { code: 1, out: '' };
  if (hsBin && ipc.out.includes('__CS_OK__')) {
    ok('Hammerspoon 正在运行（IPC 可用）');

    const ax = tryRun(hsBin, ['-c', 'print(tostring(hs.accessibilityState()))']);
    if (/true/.test(ax.out)) {
      ok('辅助功能已授权');
    } else {
      bad('辅助功能没授权（读选中文字、⌘V 粘贴、全局热键都靠它）',
        '系统设置 → 隐私与安全性 → 辅助功能 → 勾选 Hammerspoon\n勾完不用重启，直接再按一次 ⌥X');
    }
  } else {
    bad('Hammerspoon 没在运行（或 IPC 不可用）',
      'open -a Hammerspoon\n首次启动请在屏幕上按提示授予辅助功能');
  }
}

// ── 3. 安装产物 ──────────────────────────────────────────────────────────
const files = [
  [join(BASE, 'palette.html'), '面板 HTML'],
  [join(BASE, 'palette.json'), '面板数据'],
  [join(HS_DIR, 'command-palette.lua'), 'Hammerspoon 面板控制'],
  [join(HS_DIR, 'clip-history.lua'), '剪贴板历史模块'],
];
const missing = files.filter(([p]) => !existsSync(p));
if (missing.length === 0) {
  ok('安装产物齐全（~/.command-sync + ~/.hammerspoon）');
} else {
  for (const [, label] of missing) bad('缺少' + label, '重跑：command-sync install');
}

const initLua = join(HS_DIR, 'init.lua');
if (existsSync(initLua) && readFileSync(initLua, 'utf8').includes('command-palette.lua')) {
  ok('Hammerspoon 配置已挂载（init.lua 里有 dofile）');
} else {
  bad('Hammerspoon 的 init.lua 没引用面板', '重跑：command-sync install');
}

if (existsSync(join(BASE, 'palette.json'))) {
  try {
    const data = JSON.parse(readFileSync(join(BASE, 'palette.json'), 'utf8'));
    info('面板数据生成于 ' + (data.generated_at || '未知') + '，共 ' + (data.items || []).length + ' 条');
  } catch {
    warn('palette.json 解析失败', '重跑：command-sync palette');
  }
}

// ── 4. 数据源（不 blocking，只是提醒） ────────────────────────────────────
let historyPath = join(HOME, '.zsh_history');
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(BASE, 'config.json'), 'utf8')) || {};
} catch { /* 没有配置就用默认 */ }
if (cfg.history) historyPath = expand(cfg.history);

const rawMax = cfg.clipboardHistory && Number(cfg.clipboardHistory.maxEntries);
const maxEntries = Number.isFinite(rawMax) && rawMax >= 3 ? Math.min(Math.floor(rawMax), 500) : 100;

if (existsSync(historyPath)) {
  const mtime = statSync(historyPath).mtime.toISOString().replace('T', ' ').slice(0, 16);
  ok('终端历史可读：' + historyPath + '（最后更新 ' + mtime + ' UTC）');
} else {
  warn('终端历史还不存在：' + historyPath,
    '在终端（zsh）里敲几条命令就会生成\n非 zsh 用户可在 ~/.command-sync/config.json 改 history 路径');
}

const clipFile = join(HS_DIR, 'clipboard-history.jsonl');
if (existsSync(clipFile)) {
  const lines = readFileSync(clipFile, 'utf8').split('\n').filter(Boolean).length;
  ok('剪贴板历史：已记录 ' + lines + ' 条（上限 ' + maxEntries + ' 条）');
} else {
  info('剪贴板历史尚未生成（复制任意文本后出现；上限 ' + maxEntries + ' 条）');
}

// ── 5. 结论 ──────────────────────────────────────────────────────────────
console.log('');
if (problems.length === 0) {
  console.log('结论：一切就绪，按 ⌥X 就能用。');
  process.exit(0);
} else {
  console.log('结论：还有 ' + problems.length + ' 个问题要处理（见上面 ✗）');
  process.exit(1);
}
