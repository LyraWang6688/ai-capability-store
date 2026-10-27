/**
 * Host half of the DSH memory panel.
 *
 * Exposes three authenticated routes the client half calls:
 *   GET  /plugins/memory/projects   → ai-memory GET /api/v1/projects
 *   POST /plugins/memory/rpc        → ai-memory POST /mcp (JSON-RPC, tools/call)
 *   GET  /plugins/memory/resolve    → derive {workspace, project} for a cwd
 *
 * The browser side never sees the bearer token: this file reads it from the
 * ai-memory data dir and forwards on the operator's behalf.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

export const inject = ['webServer'];

const PROJECTS_PATH = '/plugins/memory/projects';
const RPC_PATH = '/plugins/memory/rpc';
const RESOLVE_PATH = '/plugins/memory/resolve';

function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** `git@github.com:Owner/Repo.git` → `owner-repo` (matches hooks' project strategy). */
export function projectFromRemoteUrl(url) {
  if (!url) return '';
  const cleaned = String(url).trim().replace(/\.git$/, '');
  const parts = cleaned.split(/[:/]/).filter(Boolean);
  if (parts.length < 2) return '';
  return `${parts[parts.length - 2]}-${parts[parts.length - 1]}`.toLowerCase();
}

/** Read the origin url out of `<cwd>/.git/config` without spawning git. */
export function remoteUrlOf(cwd) {
  try {
    const text = readFileSync(join(cwd, '.git', 'config'), 'utf8');
    const section = text.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
    if (!section) return '';
    const url = section[1].match(/^\s*url\s*=\s*(.+)$/m);
    return url ? url[1].trim() : '';
  } catch {
    return '';
  }
}

/** Find a session's cwd by reading the cwd recorded in its DSH session log. */
export function cwdFromSession(sessionId, sessionsRoot = join(homedir(), '.dsh', 'sessions')) {
  const norm = String(sessionId || '').replace(/^session-/, '').trim();
  if (!norm) return '';
  try {
    for (const group of readdirSync(sessionsRoot)) {
      const dir = join(sessionsRoot, group, `session-${norm}`);
      const file = join(dir, 'session.v4.jsonl.zstd');
      if (!existsSync(file)) continue;
      const head = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0];
      const record = JSON.parse(head);
      return typeof record.cwd === 'string' ? record.cwd : '';
    }
  } catch {
    return '';
  }
  return '';
}

export function resolveScope(cwd) {
  const base = basename(cwd || '') || '';
  const project = projectFromRemoteUrl(remoteUrlOf(cwd)) || base.toLowerCase();
  return { workspace: 'default', project, cwd, derivedFrom: project ? (remoteUrlOf(cwd) ? 'git_remote' : 'basename') : 'none' };
}

export function apply(ctx, config = {}) {
  const serverUrl = String(config.serverUrl || 'http://127.0.0.1:49374').replace(/\/$/, '');
  const dataDir = String(config.dataDir || join(process.env.HOME || '', 'Library/Application Support/ai-memory'));

  function authHeader() {
    try {
      return readFileSync(join(dataDir, 'auth-header'), 'utf8').trim();
    } catch {
      return '';
    }
  }

  async function callServer(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    const auth = authHeader();
    if (auth) headers.authorization = auth.replace(/^Authorization:\s*/i, '');
    const response = await fetch(serverUrl + path, { ...init, headers });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    return { ok: response.ok, status: response.status, payload };
  }

  async function listProjects() {
    const { ok, status, payload } = await callServer('/api/v1/projects');
    const list = Array.isArray(payload) ? payload : (payload.projects || []);
    return { ok, status, projects: list };
  }

  async function rpc(method, params) {
    const { status, payload } = await callServer('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    if (payload && payload.error) return { ok: false, status, error: payload.error };
    return { ok: true, status, result: payload.result };
  }

  /** Unwrap MCP text content into a JS value when the payload is JSON. */
  function unwrap(result) {
    const first = result && Array.isArray(result.content) ? result.content[0] : null;
    if (!first || first.type !== 'text') return result;
    try { return JSON.parse(first.text); } catch { return { text: first.text }; }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PROJECTS_PATH,
    handler: async (req, res) => {
      try {
        const { projects, status } = await listProjects();
        sendJson(res, 200, { ok: true, status, projects });
      } catch (error) {
        sendJson(res, 502, { ok: false, message: error?.message || String(error) });
      }
    },
  }), 'dsh-memory-panel: projects');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RESOLVE_PATH,
    handler: (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const session = url.searchParams.get('session') || '';
        let cwd = url.searchParams.get('cwd') || '';
        let via = 'query';
        if (!cwd && session) {
          cwd = cwdFromSession(session);
          via = cwd ? 'session_log' : 'session_log_miss';
        }
        sendJson(res, 200, { ok: true, via, ...resolveScope(cwd) });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: error?.message || String(error) });
      }
    },
  }), 'dsh-memory-panel: resolve');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RPC_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, message: 'POST required' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const tool = String(body.tool || '');
        const args = body.arguments || {};
        if (!tool) {
          sendJson(res, 400, { ok: false, message: 'tool is required' });
          return;
        }
        const outcome = await rpc('tools/call', { name: tool, arguments: args });
        if (!outcome.ok) {
          sendJson(res, outcome.status === 200 ? 400 : outcome.status, { ok: false, message: JSON.stringify(outcome.error || {}) });
          return;
        }
        sendJson(res, 200, { ok: true, data: unwrap(outcome.result) });
      } catch (error) {
        sendJson(res, 500, { ok: false, message: error?.message || String(error) });
      }
    },
  }), 'dsh-memory-panel: rpc');
}
