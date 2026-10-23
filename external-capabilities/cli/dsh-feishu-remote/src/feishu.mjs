/**
 * Thin wrappers around the already-authenticated `lark-cli`.
 * Credentials never pass through this package.
 */
import { spawn } from 'node:child_process';

function withProfile(cfg, args) {
  return cfg.larkProfile ? ['--profile', cfg.larkProfile, ...args] : [...args];
}

/** Run a short-lived lark-cli command and collect its output. */
export function run(cfg, args, { timeoutMs = 60000, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cfg.larkCli, withProfile(cfg, args), {
      cwd: cwd || cfg.workdir,
      env: process.env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish('timeout');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += String(error); finish('spawn-error'); });
    if (input !== undefined && child.stdin) child.stdin.end(input);
    child.on('close', (code) => finish(code));
  });
}

export async function authStatus(cfg) {
  const result = await run(cfg, ['auth', 'status', '--json'], { timeoutMs: 30000 });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

export function currentOpenId(status) {
  if (!status) return null;
  const user = status.identities && status.identities.user;
  return (user && user.openId) || status.openId || null;
}

/**
 * The bridge only calls the API as the bot (`--as bot`): it reads p2p messages
 * and sends replies. A machine may legitimately be bot-only — a headless Linux
 * server usually is, because user login is a device-code flow. `init` still
 * needs a human open_id for the whitelist, which is why it accepts `--open-id`.
 */
export function botReady(status) {
  if (!status) return false;
  const bot = status.identities && status.identities.bot;
  return Boolean(bot && bot.status === 'ready');
}

export async function sendText(cfg, chatId, text) {
  const body = String(text || '').trim().slice(0, cfg.maxReplyChars) || '（无内容）';
  return run(cfg, ['im', '+messages-send', '--chat-id', chatId, '--text', body, '--as', 'bot']);
}

/**
 * Send a Card 2.0 reply. The payload goes through stdin on purpose:
 * `--content @file` is limited to a path whitelist, and stdin keeps the JSON
 * out of the process argv (so no card content ends up in `ps`).
 */
export async function sendCard(cfg, chatId, card) {
  const result = await run(cfg, [
    'im', '+messages-send', '--chat-id', chatId,
    '--msg-type', 'interactive', '--content', '-', '--as', 'bot',
  ], { timeoutMs: 60000, input: JSON.stringify(card) });
  let ok = false;
  try { ok = JSON.parse(result.stdout || '{}').ok === true; } catch { ok = false; }
  return { ...result, ok };
}

/**
 * Spawn the long-connection event consumer.
 * stdin MUST stay open: lark-cli treats stdin EOF as an exit signal.
 */
export function spawnConsumer(cfg) {
  return spawn(cfg.larkCli, withProfile(cfg, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot']), {
    cwd: cfg.workdir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function listProfiles(cfg) {
  return run(cfg, ['profile', 'list'], { timeoutMs: 30000 });
}

export function eventDryRun(cfg) {
  return run(cfg, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--dry-run'], { timeoutMs: 45000 });
}
