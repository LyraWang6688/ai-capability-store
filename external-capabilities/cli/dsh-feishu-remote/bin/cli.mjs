#!/usr/bin/env node
/**
 * dsh-feishu-remote — Feishu bot <-> local agent bridge.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  CONFIG_PATH, DEFAULTS, LOG_DIR, ROOT_DIR, SERVICE_SCRIPT, ensureDirs, loadConfig, requireConfig, saveConfig,
} from '../src/config.mjs';
import { authStatus, currentOpenId } from '../src/feishu.mjs';
import { startListener } from '../src/listener.mjs';
import { installService, isMac, serviceStatus, uninstallService } from '../src/service.mjs';
import { runDoctor } from '../src/doctor.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const CLI_DIR = dirname(CLI_PATH);
const PKG = JSON.parse(readFileSync(join(dirname(CLI_DIR), 'package.json'), 'utf8'));

const HELP = `dsh-feishu-remote ${PKG.version} — 用飞书私聊远程操作这台电脑

用法:
  dsh-feishu-remote init [--workdir <dir>] [--lark-profile <name>] [--dsh <cmd>] [--yes] [--no-service]
  dsh-feishu-remote doctor
  dsh-feishu-remote status
  dsh-feishu-remote logs [--lines 50]
  dsh-feishu-remote run                前台运行（调试用；服务模式由 launchd/systemd 调用）
  dsh-feishu-remote install-service    安装开机自启（macOS launchd / Linux systemd）
  dsh-feishu-remote uninstall-service  卸载开机自启服务
  dsh-feishu-remote config             打印配置路径与当前值
  dsh-feishu-remote --version | --help

配置文件: ${CONFIG_PATH}
`;

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(args, name) {
  return args.includes(name);
}
function resolveNode() {
  return process.execPath;
}
const DSH_CANDIDATES = [
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
  '/usr/local/bin/dsh',
  '/opt/homebrew/bin/dsh',
];

/** Prefer an explicitly configured backend, otherwise find the bundled DSH. */
function detectDsh(explicit) {
  if (explicit && explicit !== 'dsh' && spawnBinary(explicit)) return explicit;
  for (const candidate of DSH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return explicit || 'dsh';
}

function spawnBinary(command) {
  if (command.includes('/')) return existsSync(command) ? command : null;
  const result = spawnSync('/usr/bin/which', [command], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').trim() : null;
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

async function init(args) {
  ensureDirs();
  const cfg = loadConfig() || { ...DEFAULTS };
  const status = await authStatus(cfg);
  const openId = currentOpenId(status);
  if (!openId) {
    console.error('✗ 飞书尚未授权：请先运行 `lark-cli auth login --domain im`（或带 --profile），再执行 init。');
    process.exitCode = 1;
    return;
  }

  const yes = has(args, '--yes');
  const workdir = flag(args, '--workdir') || (yes ? (cfg.workdir || process.cwd()) : await prompt(`执行工作目录 [${cfg.workdir || process.cwd()}]: `, cfg.workdir || process.cwd()));
  const larkProfile = flag(args, '--lark-profile') || (yes ? cfg.larkProfile : await prompt(`lark-cli profile（空=默认）[${cfg.larkProfile || ''}]: `, cfg.larkProfile));
  const dshCliRequested = flag(args, '--dsh') || (yes ? cfg.dshCli : await prompt(`执行后端命令 [${cfg.dshCli}]: `, cfg.dshCli));
  const dshCli = detectDsh(dshCliRequested);
  const keychainService = yes ? cfg.keychainService : await prompt(`API Key 的钥匙串名称 [${cfg.keychainService || 'DEEPSEEK_API_KEY'}]: `, cfg.keychainService || 'DEEPSEEK_API_KEY');

  const next = saveConfig({
    ...cfg,
    workdir: workdir || homedir(),
    larkProfile,
    dshCli,
    keychainService,
    allowedOpenIds: Array.from(new Set([...(cfg.allowedOpenIds || []), openId])),
  });

  console.log(`✓ 配置已写入: ${CONFIG_PATH}`);
  console.log(`  白名单: ${next.allowedOpenIds.join(', ')}`);
  console.log(`  工作目录: ${next.workdir}`);
  console.log(`  执行后端: ${next.dshCli} ${next.agentArgs.join(' ')}`);

  if (!has(args, '--no-service')) {
    if (!isMac()) {
      console.log('ℹ 非 macOS / Linux：请用 PM2 等方式运行 `dsh-feishu-remote run`');
      return;
    }
    const install = yes ? 'y' : await prompt('安装开机自启（macOS launchd / Linux systemd）？[Y/n]: ', 'y');
    if (/^y/i.test(install) || install === '') {
      try {
        const result = installService(next, { nodePath: resolveNode(), cliPath: CLI_PATH });
        console.log(`✓ 服务已安装: ${result.plist}`);
        console.log('  状态: dsh-feishu-remote status');
      } catch (error) {
        console.error(`✗ 服务安装失败: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
      }
    }
  }
  console.log('\n下一步：在飞书里私聊你的机器人，发一句「帮助」测试。');
}

function status() {
  const cfg = loadConfig();
  if (!cfg) {
    console.log('未初始化：运行 dsh-feishu-remote init');
    return;
  }
  const svc = serviceStatus();
  console.log(`配置: ${CONFIG_PATH}`);
  console.log(`工作目录: ${cfg.workdir}`);
  console.log(`执行后端: ${cfg.dshCli} ${(cfg.agentArgs || []).join(' ')}`);
  console.log(`白名单: ${(cfg.allowedOpenIds || []).length} 人`);
  console.log(`后台服务: ${svc.running ? '运行中' : '未运行'} (${svc.detail})`);
  const files = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((name) => name.startsWith('audit-')).sort() : [];
  const latest = files.length > 0 ? join(LOG_DIR, files[files.length - 1]) : null;
  if (latest) {
    const lines = readFileSync(latest, 'utf8').trim().split('\n').slice(-5);
    console.log(`最近任务（${files[files.length - 1]}）:`);
    for (const line of lines) console.log('  ' + line);
  }
}

function logs(args) {
  const limit = Number(flag(args, '--lines') || 50);
  if (!existsSync(LOG_DIR)) {
    console.log('还没有日志。');
    return;
  }
  const files = readdirSync(LOG_DIR).filter((name) => name.startsWith('audit-')).sort();
  const target = files.length > 0 ? join(LOG_DIR, files[files.length - 1]) : null;
  if (!target) {
    console.log('还没有审计日志。');
    return;
  }
  const lines = readFileSync(target, 'utf8').trim().split('\n');
  for (const line of lines.slice(-limit)) console.log(line);
}

async function runForeground() {
  const cfg = requireConfig();
  ensureDirs();
  console.log(`监听中… 工作目录 ${cfg.workdir}（Ctrl+C 退出）`);
  const stop = startListener(cfg);
  const shutdown = () => { stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function doctor() {
  const checks = await runDoctor();
  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  for (const check of checks) {
    console.log(`${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.status !== 'ok' && check.hint) console.log(`   → ${check.hint}`);
  }
  const failures = checks.filter((check) => check.status === 'fail').length;
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项需要处理'}`);
  if (failures > 0) process.exitCode = 1;
}

function install(args) {
  const cfg = requireConfig();
  const result = installService(cfg, { nodePath: resolveNode(), cliPath: CLI_PATH });
  console.log(`✓ 已安装: ${result.plist}`);
}

function uninstall() {
  const result = uninstallService();
  console.log(result.removed ? `✓ 已卸载: ${result.plist}` : '未发现已安装的服务');
}

function showConfig() {
  const cfg = loadConfig();
  console.log(`配置文件: ${CONFIG_PATH}`);
  console.log(`服务脚本: ${SERVICE_SCRIPT}`);
  console.log(JSON.stringify(cfg, null, 2));
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'init': await init(rest); break;
    case 'doctor': await doctor(); break;
    case 'status': status(); break;
    case 'logs': logs(rest); break;
    case 'run': await runForeground(); break;
    case 'install-service': install(rest); break;
    case 'uninstall-service': uninstall(); break;
    case 'config': showConfig(); break;
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
