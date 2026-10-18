/** Thin wrappers around the operator's already-authenticated lark-cli. */
import { spawn } from 'node:child_process';

function args(cfg, rest) {
  const out = [];
  if (cfg.larkProfile) out.push('--profile', cfg.larkProfile);
  return out.concat(rest);
}

export function run(cfg, rest, input, timeoutMs = 90000) {
  return new Promise((resolve) => {
    // GUI/launchd processes start with a minimal PATH; lark-cli is a node shim.
    const env = {
      ...process.env,
      PATH: ['/usr/local/bin', '/opt/homebrew/bin', process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
    };
    const child = spawn(cfg.larkCli, args(cfg, rest), { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '', settled = false;
    const finish = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } finish('timeout'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e); finish('spawn-error'); });
    child.on('close', (code) => finish(code));
    child.stdin.end(input === undefined ? '' : input);
  });
}

export function docTokenFromUrl(value) {
  const match = String(value).match(/\/docx\/([A-Za-z0-9]+)/);
  return match ? match[1] : String(value).trim();
}

export async function checkDoc(cfg, docToken) {
  const result = await run(cfg, ['docs', '+fetch', '--doc', docToken]);
  if (result.code !== 0) return { ok: false, message: (result.stderr || result.stdout).trim().slice(0, 300) };
  try {
    const payload = JSON.parse(result.stdout);
    if (!payload.ok) return { ok: false, message: JSON.stringify(payload.error || {}).slice(0, 300) };
    return { ok: true, revisionId: payload.data?.document?.revision_id, title: payload.data?.document?.content?.match(/<title>([^<]*)<\/title>/)?.[1] || '' };
  } catch {
    return { ok: false, message: '返回非 JSON' };
  }
}

export async function appendMarkdown(cfg, docToken, markdown) {
  return run(cfg, ['docs', '+update', '--doc', docToken, '--command', 'append', '--doc-format', 'markdown', '--content', '-'], markdown);
}
