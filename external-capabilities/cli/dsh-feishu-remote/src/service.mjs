/**
 * macOS launchd integration: render a launcher script + LaunchAgent and
 * bootstrap it. Other platforms are told to use their own process manager.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_DIR, PLIST_LABEL, ROOT_DIR, SERVICE_SCRIPT, ensureDirs } from './config.mjs';

const TEMPLATE_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'templates');
const LAUNCH_AGENTS = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(LAUNCH_AGENTS, `${PLIST_LABEL}.plist`);

export function isMac() {
  return process.platform === 'darwin';
}

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : 501;
}

function launchctl(args, { allowFailure = true } = {}) {
  try {
    return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (!allowFailure) throw error;
    return '';
  }
}

export function serviceStatus() {
  if (!isMac()) return { supported: false, running: false, detail: 'launchd 仅 macOS 支持' };
  const output = launchctl(['print', `gui/${uid()}/${PLIST_LABEL}`]);
  if (!output) return { supported: true, running: false, detail: '未安装或未运行' };
  const pid = /pid = (\d+)/.exec(output);
  const state = /state = (\w+)/.exec(output);
  return { supported: true, running: Boolean(pid), detail: pid ? `running pid=${pid[1]}` : (state ? `state=${state[1]}` : 'unknown') };
}

function renderScript(cfg, { nodePath, cliPath }) {
  const lines = [
    '#!/bin/bash',
    'set -u',
    'export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
  ];
  const keyVar = cfg.apiKeyEnv || 'DEEPSEEK_API_KEY';
  if (cfg.keychainService) {
    lines.push(`export ${keyVar}="$(/usr/bin/security find-generic-password -a "$USER" -s ${JSON.stringify(cfg.keychainService)} -w 2>/dev/null)"`);
  }
  lines.push(`cd ${JSON.stringify(cfg.workdir)} || exit 1`);
  lines.push(`exec /usr/bin/caffeinate -dimsu ${JSON.stringify(nodePath)} ${JSON.stringify(cliPath)} run >> ${JSON.stringify(join(LOG_DIR, 'daemon.log'))} 2>&1`);
  return lines.join('\n') + '\n';
}

export function installService(cfg, { nodePath, cliPath }) {
  if (!isMac()) {
    throw new Error('自动安装服务仅支持 macOS。其他系统请用 systemd / PM2 等方式运行：dsh-feishu-remote run');
  }
  ensureDirs();
  writeFileSync(SERVICE_SCRIPT, renderScript(cfg, { nodePath, cliPath }));
  chmodSync(SERVICE_SCRIPT, 0o700);

  const template = readFileSync(join(TEMPLATE_DIR, 'launchd.plist.tmpl'), 'utf8');
  const plist = template
    .replaceAll('{{LABEL}}', PLIST_LABEL)
    .replaceAll('{{SCRIPT}}', SERVICE_SCRIPT)
    .replaceAll('{{HOME}}', homedir())
    .replaceAll('{{STDOUT}}', join(LOG_DIR, 'launchd.out.log'))
    .replaceAll('{{STDERR}}', join(LOG_DIR, 'launchd.err.log'));
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  writeFileSync(PLIST_PATH, plist);

  launchctl(['bootout', `gui/${uid()}/${PLIST_LABEL}`]);
  launchctl(['bootstrap', `gui/${uid()}`, PLIST_PATH], { allowFailure: false });
  launchctl(['enable', `gui/${uid()}/${PLIST_LABEL}`]);
  return { plist: PLIST_PATH, script: SERVICE_SCRIPT };
}

export function uninstallService() {
  if (!isMac()) return { removed: false };
  launchctl(['bootout', `gui/${uid()}/${PLIST_LABEL}`]);
  let removed = false;
  if (existsSync(PLIST_PATH)) {
    try { unlinkSync(PLIST_PATH); removed = true; } catch { /* ignore */ }
  }
  return { removed, plist: PLIST_PATH };
}
