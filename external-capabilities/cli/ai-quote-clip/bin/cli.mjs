#!/usr/bin/env node
/** ai-quote-clip — 把值得留下的 AI 金句/片段，一键收进飞书文档。 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CONFIG_PATH, HOTKEY_CONFIG_PATH, loadConfig, requireConfig, saveConfig } from '../src/config.mjs';
import { appendMarkdown, checkDoc, docTokenFromUrl, run } from '../src/feishu.mjs';
import { hotkeyStatus, installHotkey, isMac, uninstallHotkey } from '../src/hotkey.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const PKG = JSON.parse(readFileSync(join(dirname(dirname(CLI_PATH)), 'package.json'), 'utf8'));

const HELP = `ai-quote-clip ${PKG.version} — 把 AI 说得好、值得留下的句子一键收进飞书

用法:
  ai-quote-clip init [--doc <飞书文档 URL|token>] [--lark-profile <name>] [--no-hotkey]
  ai-quote-clip add [文字…] [--clipboard] [--source <来源>]
  ai-quote-clip doc                      查看当前目标文档
  ai-quote-clip doc set <URL|token>      切换目标文档
  ai-quote-clip hotkey [install [--key z] [--force]|uninstall|status]   macOS 全局快捷键（默认 ⌃⌥Z）
  ai-quote-clip status
  ai-quote-clip --version | --help

配置: ${CONFIG_PATH}
`;

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function prompt(question, fallback) {
  if (!input.isTTY) return fallback;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    return answer === '' ? fallback : answer;
  } finally {
    rl.close();
  }
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readStdin() {
  return new Promise((resolve) => {
    let out = '';
    input.setEncoding('utf8');
    input.on('data', (d) => { out += d; });
    input.on('end', () => resolve(out));
  });
}

function pbpaste() {
  return new Promise((resolve) => {
    const child = spawn('pbpaste', [], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
  });
}

async function readInput(args) {
  const rest = args.filter((a) => !a.startsWith('--') && a !== flag(args, '--source'));
  if (rest.length > 0) return rest.join(' ');
  if (args.includes('--clipboard')) return pbpaste();
  if (!input.isTTY) return readStdin();
  return '';
}

async function init(args) {
  const cfg = loadConfig() || {};
  const lark = flag(args, '--lark-profile');
  const resolved = spawnSync('/usr/bin/which', ['lark-cli'], { encoding: 'utf8' });
  const absoluteLark = (resolved.stdout || '').trim() || 'lark-cli';
  const base = { ...cfg, larkCli: cfg.larkCli && cfg.larkCli !== 'lark-cli' ? cfg.larkCli : absoluteLark };
  if (lark !== undefined) base.larkProfile = lark;

  const version = await run({ ...base, larkProfile: base.larkProfile || '' }, ['--version'], undefined, 20000);
  if (version.code !== 0) {
    console.error('✗ 未找到 lark-cli：请先安装并授权（npm i -g @larksuite/cli && lark-cli auth login --domain docs）');
    process.exitCode = 1;
    return;
  }

  let target = flag(args, '--doc');
  if (!target) target = await prompt('飞书文档 URL 或 token（选中文字会追加到这篇末尾）: ', '');
  if (!target) {
    console.error('✗ 需要文档 URL 或 token');
    process.exitCode = 1;
    return;
  }
  const docToken = docTokenFromUrl(target);
  const check = await checkDoc({ ...base, docToken }, docToken);
  if (!check.ok) {
    console.error(`✗ 读取文档失败：${check.message}`);
    console.error('  确认 lark-cli 已授权（docs 域），且这篇文档你有编辑权限。');
    process.exitCode = 1;
    return;
  }
  saveConfig({ ...base, docToken, docUrl: String(target).includes('http') ? target : '' });
  console.log(`✓ 已配置目标文档：${check.title || docToken}（revision ${check.revisionId}）`);
  console.log(`  配置: ${CONFIG_PATH}`);

  if (!args.includes('--no-hotkey') && isMac()) {
    const install = await prompt('安装 ⌃⌥S 全局快捷键？[Y/n]: ', 'y');
    if (/^y/i.test(install) || install === '') {
      try {
        const result = installHotkey({ nodePath: process.execPath, cliPath: CLI_PATH });
        console.log(`✓ 快捷键已安装：${result.plist}`);
        console.log('  首次按 ⌃⌥S 会请求「辅助功能」权限，去系统设置勾选 AiQuoteClip 即可。');
      } catch (error) {
        console.error(`✗ 快捷键安装失败：${error.message}`);
      }
    }
  }
  console.log('\n用法：选中文字后按 ⌃⌥S；或在终端 echo "文字" | ai-quote-clip add');
}

async function add(args) {
  const cfg = requireConfig();
  const raw = (await readInput(args)).trim();
  if (!raw) {
    console.error('没有输入：从管道 / 参数 / --clipboard 传一段文字');
    process.exitCode = 2;
    return;
  }
  const source = flag(args, '--source');
  const quoted = raw.split('\n').map((line) => '> ' + line).join('\n');
  const meta = [`收录：${stamp()}`];
  if (source) meta.push(`来源：${source}`);
  const result = await appendMarkdown(cfg, cfg.docToken, `${quoted}\n\n${meta.join('　')}\n\n---\n\n`);
  if (result.code === 0) {
    console.log(JSON.stringify({ ok: true, doc: cfg.docToken, chars: raw.length }));
  } else {
    console.error('写入失败：' + (result.stderr || result.stdout).trim().slice(0, 400));
    process.exitCode = 1;
  }
}

async function doc(args) {
  const cfg = requireConfig();
  const action = args[0];
  if (action === 'set') {
    const target = args[1];
    if (!target) { console.error('用法：ai-quote-clip doc set <URL|token>'); process.exitCode = 2; return; }
    const token = docTokenFromUrl(target);
    const check = await checkDoc(cfg, token);
    if (!check.ok) { console.error('✗ 读取失败：' + check.message); process.exitCode = 1; return; }
    saveConfig({ ...cfg, docToken: token, docUrl: target.includes('http') ? target : '' });
    console.log(`✓ 目标文档已切换：${check.title || token}`);
    return;
  }
  const check = await checkDoc(cfg, cfg.docToken);
  console.log(JSON.stringify({ docToken: cfg.docToken, ok: check.ok, title: check.title, revisionId: check.revisionId }, null, 2));
}

function status() {
  const cfg = loadConfig();
  const hotkey = hotkeyStatus();
  let hotkeyKey = 'z';
  try { hotkeyKey = JSON.parse(readFileSync(HOTKEY_CONFIG_PATH, 'utf8')).key || 'z'; } catch { /* not installed */ }
  console.log(JSON.stringify({
    config: CONFIG_PATH,
    initialized: Boolean(cfg && cfg.docToken),
    hotkeyKey: `⌃⌥${hotkeyKey.toUpperCase()}`,
    docToken: cfg ? cfg.docToken : null,
    hotkey,
    hotkeyConfig: HOTKEY_CONFIG_PATH,
  }, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case 'init': await init(rest); break;
    case 'add': await add(rest); break;
    case 'doc': await doc(rest); break;
    case 'hotkey': {
      const action = rest[0];
      if (action === 'install') {
        const key = (flag(rest, '--key') || 'z').toLowerCase();
        if (!/^[a-z]$/.test(key)) throw new Error('--key 只接受单个字母，例如 --key z');
        const result = installHotkey({ nodePath: process.execPath, cliPath: CLI_PATH, key, force: rest.includes('--force') });
        console.log(`快捷键：⌃⌥${key.toUpperCase()}`);
        console.log(`✓ 已安装：${result.plist}`);
        console.log('首次按 ⌃⌥S 会请求辅助功能权限，去系统设置勾选 AiQuoteClip。');
      } else if (action === 'uninstall') {
        const result = uninstallHotkey();
        console.log(result.removed ? `✓ 已卸载：${result.plist}` : '未安装');
      } else {
        console.log(JSON.stringify(hotkeyStatus(), null, 2));
      }
      break;
    }
    case 'status': status(); break;
    case '--version': case '-v': console.log(PKG.version); break;
    case '--help': case '-h': case undefined: console.log(HELP); break;
    default:
      console.error(`未知命令: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
