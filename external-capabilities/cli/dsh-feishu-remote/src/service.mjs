/**
 * Service integration: launchd on macOS, systemd (user unit) on Linux.
 *
 * The rendered launcher script is the only place that knows about the runtime
 * paths, so it is built by a pure function and covered by tests.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_FILE, LOG_DIR, PLIST_LABEL, SERVICE_SCRIPT, ensureDirs } from './config.mjs';

const TEMPLATE_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'templates');
const LAUNCH_AGENTS = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(LAUNCH_AGENTS, `${PLIST_LABEL}.plist`);

/** PATH the launcher script starts from when the config does not override it. */
export const DEFAULT_SERVICE_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function isMac() {
  return process.platform === 'darwin';
}

export function isLinux() {
  return process.platform === 'linux';
}

const SYSTEMD_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = join(SYSTEMD_DIR, `${PLIST_LABEL}.service`);

function systemctl(args, { allowFailure = true } = {}) {
  try {
    return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (!allowFailure) throw error;
    return '';
  }
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
  if (isLinux()) {
    const output = systemctl(['is-active', PLIST_LABEL]);
    const enabled = systemctl(['is-enabled', PLIST_LABEL]).trim();
    const active = output.trim();
    return {
      supported: true,
      running: active === 'active',
      detail: `systemd(user): ${active || 'unknown'}${enabled ? `, ${enabled}` : ''}`,
    };
  }
  if (!isMac()) return { supported: false, running: false, detail: 'launchd/systemd 之外请用 PM2 等方式运行' };
  const output = launchctl(['print', `gui/${uid()}/${PLIST_LABEL}`]);
  if (!output) return { supported: true, running: false, detail: '未安装或未运行' };
  const pid = /pid = (\d+)/.exec(output);
  const state = /state = (\w+)/.exec(output);
  return { supported: true, running: Boolean(pid), detail: pid ? `running pid=${pid[1]}` : (state ? `state=${state[1]}` : 'unknown') };
}

/**
 * Build the launcher script the service runs.
 *
 * Pure on purpose: this is where a wrong PATH silently breaks everything on
 * Linux. `dsh` starts with `#!/usr/bin/env node`, and a `dsh` newer than Node
 * <24 silently exits 0 when the shebang resolves to an older node, so the
 * config `extraEnv.PATH` must win over the default one.
 */
export function buildServiceScript(cfg, { nodePath, cliPath, platform = process.platform } = {}) {
  const linux = platform === 'linux';
  const lines = [
    '#!/bin/bash',
    'set -u',
    `export PATH=${JSON.stringify(cfg.extraEnv?.PATH || DEFAULT_SERVICE_PATH)}`,
  ];
  const keyVar = cfg.apiKeyEnv || 'DEEPSEEK_API_KEY';
  if (cfg.keychainService && platform === 'darwin') {
    lines.push(`export ${keyVar}="$(/usr/bin/security find-generic-password -a "$USER" -s ${JSON.stringify(cfg.keychainService)} -w 2>/dev/null)"`);
  }
  lines.push(`cd ${JSON.stringify(cfg.workdir)} || exit 1`);
  const logFile = JSON.stringify(join(LOG_DIR, 'daemon.log'));
  if (linux) {
    // Keep the model key out of the unit file: the bridge reads its own env file.
    lines.push(`[ -f ${JSON.stringify(ENV_FILE)} ] && set -a && . ${JSON.stringify(ENV_FILE)} && set +a`);
    lines.push(`exec ${JSON.stringify(nodePath)} ${JSON.stringify(cliPath)} run >> ${logFile} 2>&1`);
  } else {
    lines.push(`exec /usr/bin/caffeinate -dimsu ${JSON.stringify(nodePath)} ${JSON.stringify(cliPath)} run >> ${logFile} 2>&1`);
  }
  return lines.join('\n') + '\n';
}

/** systemd user unit. Credentials stay out of it; the script reads the env file. */
export function buildSystemdUnit(cfg) {
  return [
    '[Unit]',
    'Description=DSH Feishu remote bridge',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/bin/bash ${SERVICE_SCRIPT}`,
    'Restart=always',
    'RestartSec=5',
    `WorkingDirectory=${cfg.workdir}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * A non-root user can usually not enable linger for itself; report that instead
 * of aborting an otherwise valid install.
 */
function enableLinger() {
  const user = process.env.USER || process.env.LOGNAME || '';
  if (!user) return '';
  try {
    execFileSync('loginctl', ['enable-linger', user], { stdio: ['ignore', 'pipe', 'ignore'] });
    return 'linger 已开启';
  } catch {
    return `未能自行开启 linger（需要 root 执行一次：loginctl enable-linger ${user}）`;
  }
}

export function installService(cfg, { nodePath, cliPath }) {
  if (isLinux()) {
    ensureDirs();
    writeFileSync(SERVICE_SCRIPT, buildServiceScript(cfg, { nodePath, cliPath, platform: 'linux' }));
    chmodSync(SERVICE_SCRIPT, 0o700);
    mkdirSync(SYSTEMD_DIR, { recursive: true });
    writeFileSync(UNIT_PATH, buildSystemdUnit(cfg));
    systemctl(['daemon-reload']);
    let started = true;
    try { systemctl(['enable', '--now', PLIST_LABEL], { allowFailure: false }); } catch { started = false; }
    const linger = enableLinger();
    const detail = `systemd user unit: ${UNIT_PATH}（${started ? '已启动' : '启动失败，检查 systemctl --user status'}；${linger}）`;
    return { detail, unit: UNIT_PATH, script: SERVICE_SCRIPT, linger, started };
  }
  if (!isMac()) {
    throw new Error('自动安装服务仅支持 macOS / Linux(systemd)。其他系统请用 PM2 等方式运行：dsh-feishu-remote run');
  }
  ensureDirs();
  writeFileSync(SERVICE_SCRIPT, buildServiceScript(cfg, { nodePath, cliPath, platform: 'darwin' }));
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
  return { detail: `launchd LaunchAgent: ${PLIST_PATH}`, plist: PLIST_PATH, script: SERVICE_SCRIPT };
}

export function uninstallService() {
  if (isLinux()) {
    systemctl(['disable', '--now', PLIST_LABEL]);
    let removed = false;
    try { unlinkSync(UNIT_PATH); removed = true; } catch { /* 已不存在 */ }
    systemctl(['daemon-reload']);
    systemctl(['reset-failed', PLIST_LABEL]);
    return { removed, detail: removed ? `已卸载 systemd user unit: ${UNIT_PATH}` : '未发现已安装的 systemd user unit' };
  }
  if (!isMac()) return { removed: false, detail: '当前平台没有可卸载的服务' };
  launchctl(['bootout', `gui/${uid()}/${PLIST_LABEL}`]);
  let removed = false;
  if (existsSync(PLIST_PATH)) {
    try { unlinkSync(PLIST_PATH); removed = true; } catch { /* ignore */ }
  }
  return { removed, detail: removed ? `已卸载 launchd LaunchAgent: ${PLIST_PATH}` : '未发现已安装的 LaunchAgent' };
}
