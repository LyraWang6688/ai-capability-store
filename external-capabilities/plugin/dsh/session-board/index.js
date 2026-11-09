/**
 * Host half of the DSH session board.
 *
 * Answers one question per Session: **which requirements did the operator state,
 * and how far did the agents get on each one?**
 *
 * Everything is derived from the Session's own event log — no second database,
 * no model call, no write into the Session:
 *   - requirements  ← `user/message` events, segmented into goals
 *   - tasks         ← `tool/call` + `tool/result` events that delegate work
 *   - subagents     ← child Sessions whose header carries `parentSession`
 *
 * The one thing that is persisted is the **segmentation** (which user message
 * belongs to which requirement). Recomputing it on every refresh would make the
 * board's row count drift between polls, which is worse than being approximate:
 * the operator would think they misremembered. New messages are only ever
 * appended to the last requirement or start a new one.
 *
 * Routes (same-origin, behind DSH connection auth):
 *   GET  /plugins/session-board/board?session=<id>   → the board
 *   POST /plugins/session-board/board                → merge / split / reset
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const inject = ['webServer'];

const BOARD_PATH = '/plugins/session-board/board';

/** Tools that represent delegated work rather than the agent's own reads. */
const WORK_TOOLS = new Set([
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'workflow',
  'ralph',
  'team_task_create',
  'team_task_update',
  'send_message',
  'wait_agent',
]);

/** A message that continues/repairs the previous goal rather than opening one. */
const CORRECTION = /其实不是|不是这样|不是这个|不对|说得不对|我意思|我的意思|改一下|改成|换成|更正|修正|补充|补充一下|另外|还有一个|刚才那个|上面那个|再改|还是不对|说错|漏了|忘说|重新说/;

const MAX_ROWS = 200;
const IDLE_GAP_MS = 30 * 60 * 1000;

function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 64 * 1024) {
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

/**
 * Was this `user/message` actually typed by the operator?
 *
 * Context injected by the harness also arrives as `user/message` events —
 * AGENTS.md instructions, the skill catalog, the runtime context snapshot, the
 * time stamp, action-card notices. They are not requirements. In every log we
 * checked they carry a `source.kind` other than `'user'`, so that field is the
 * discriminator; the text patterns are only a fallback for older logs.
 */
export function isOperatorMessage(data) {
  const kind = data && data.source && data.source.kind;
  if (typeof kind === 'string') return kind === 'user';
  const text = textOf(data).trim();
  if (!text) return false;
  if (/^<(system-reminder|skill_content|available_skills)/.test(text)) return false;
  if (text.startsWith('Current runtime context.')) return false;
  if (text.startsWith('Latest status of action cards')) return false;
  if (text.startsWith('### Updated Tool Schemas')) return false;
  if (text.startsWith('Time sampled while preparing turn')) return false;
  return true;
}

/** Pull plain text out of a message's content blocks. */
export function textOf(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Character-bigram overlap; works for Chinese without a segmenter. */
export function overlap(a, b) {
  const gram = (text) => {
    const clean = String(text || '').replace(/\s+/g, '').toLowerCase();
    const set = new Set();
    for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
    return set;
  };
  const left = gram(a);
  const right = gram(b);
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const item of right) if (left.has(item)) hit += 1;
  return hit / Math.min(left.size, right.size);
}

export function isCorrection(text) {
  return CORRECTION.test(String(text || ''));
}

/** First line of a message, trimmed to a row-sized title. */
export function titleOf(text, limit = 46) {
  const first = String(text || '').replace(/\s+/g, ' ').trim();
  return first.length > limit ? `${first.slice(0, limit)}…` : first;
}

function safeId(sessionId) {
  return String(sessionId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

/**
 * Assign each not-yet-seen message to the open requirement or open a new one.
 *
 * Bias is deliberate: when unsure, **join**. Splitting one goal into three rows
 * makes the board lie (statuses contradict each other); joining two goals only
 * makes a row coarser, which stays readable.
 */
export function segment(requirements, messages) {
  const seen = new Set();
  for (const requirement of requirements) for (const seq of requirement) seen.add(seq);
  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  let lastTime = 0;
  for (const requirement of requirements) {
    for (const seq of requirement) {
      const message = bySeq.get(seq);
      if (message && message.time > lastTime) lastTime = message.time;
    }
  }
  for (const message of messages) {
    if (seen.has(message.seq)) continue;
    if (requirements.length === 0) {
      requirements.push([message.seq]);
      lastTime = message.time;
      continue;
    }
    const current = requirements[requirements.length - 1];
    const recent = current
      .map((seq) => bySeq.get(seq))
      .filter(Boolean)
      .slice(-3)
      .map((m) => m.text)
      .join(' ');
    const continues =
      isCorrection(message.text) ||
      overlap(recent, message.text) >= 0.12 ||
      (lastTime > 0 && message.time - lastTime < IDLE_GAP_MS);
    if (continues) current.push(message.seq);
    else requirements.push([message.seq]);
    lastTime = message.time;
  }
  return requirements;
}

function storeDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'session-board');
}

function statePath(sessionId) {
  return join(storeDir(), `${safeId(sessionId)}.json`);
}

function loadState(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
    if (raw && Array.isArray(raw.requirements)) return raw;
  } catch {
    /* no state yet */
  }
  return null;
}

function saveState(sessionId, requirements) {
  try {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(
      statePath(sessionId),
      JSON.stringify({ v: 1, sessionId, requirements, updatedAt: Date.now() }, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

/** Coerce the tool arguments (a JSON string) into an object. */
function argsOf(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function taskLabel(name, args) {
  if (name === 'spawn_teammate' || name === 'subagent') {
    return args.description || args.name || args.prompt?.slice?.(0, 60) || name;
  }
  if (name === 'team_task_create') return args.subject || '新建任务';
  if (name === 'team_task_update') return `${args.action || '更新'}任务`;
  if (name === 'workflow') return args.meta?.name || '工作流';
  if (name === 'send_message') return `发消息给 ${args.target || '队友'}`;
  if (name === 'ralph') return args.objective?.slice?.(0, 40) || 'Ralph 循环';
  if (name === 'wait_agent') return '等待队友';
  return name;
}

/**
 * Walk the raw log once and produce the three projections the board needs.
 */
export function project(events, requirements) {
  const messages = [];
  const calls = new Map();
  const order = [];
  let lastTurnEnd = 0;
  let sessionTitle = '';

  for (const event of events) {
    if (!event || typeof event.seq !== 'number') continue;
    if (event.type === 'user/message') {
      const text = textOf(event.data);
      if (text && isOperatorMessage(event.data)) messages.push({ seq: event.seq, time: event.time, text });
    } else if (event.type === 'turn/end') {
      lastTurnEnd = event.seq;
    } else if (event.type === 'tool/call') {
      const data = event.data || {};
      if (!WORK_TOOLS.has(data.name)) continue;
      const entry = {
        seq: event.seq,
        time: event.time,
        callId: data.callId,
        name: data.name,
        label: taskLabel(data.name, argsOf(data.arguments)),
        status: 'running',
      };
      calls.set(data.callId, entry);
      order.push(entry);
    } else if (event.type === 'tool/result') {
      const data = event.data || {};
      const entry = calls.get(data.callId);
      if (!entry) continue;
      entry.status = data.error ? 'failed' : 'done';
      entry.error = data.error?.reason || data.error?.code;
      entry.doneAt = event.time;
    }
  }

  segment(requirements, messages);

  const rows = requirements.map((seqs, index) => {
    const own = messages.filter((m) => seqs.includes(m.seq));
    const start = seqs[0];
    const end = index + 1 < requirements.length ? requirements[index + 1][0] : Number.POSITIVE_INFINITY;
    const tasks = order.filter((task) => task.seq > start && task.seq < end);
    const open = own.length > 0 && own[own.length - 1].seq > lastTurnEnd;
    let status = 'done';
    if (tasks.some((task) => task.status === 'failed')) status = 'blocked';
    else if (open || tasks.some((task) => task.status === 'running')) status = 'active';
    return {
      id: index + 1,
      title: titleOf(own[0]?.text || ''),
      firstSeq: start,
      messageCount: own.length,
      messages: own.slice(-6).map((m) => ({ seq: m.seq, text: titleOf(m.text, 120) })),
      tasks: tasks.map((task) => ({
        name: task.name,
        label: titleOf(task.label, 60),
        status: task.status,
        error: task.error,
      })),
      status,
    };
  });

  return { messages, rows, sessionTitle, lastTurnEnd };
}

/** Child Sessions spawned under this one. */
async function listChildren(sessionQuery, sessionId) {
  try {
    const records = await sessionQuery.filterSessions([{ kind: 'parent', values: [sessionId] }]);
    return records
      .filter((record) => record.header && record.header.parentSession === sessionId)
      .map((record) => ({
        id: record.header.id,
        live: record.live,
        delegated: record.header.origin === 'subagent',
        depth: record.header.delegationDepth || 1,
      }));
  } catch {
    return [];
  }
}

export function apply(ctx) {
  async function readSession(sessionId) {
    const query = ctx.get('sessionQuery');
    if (!query) throw new Error('sessionQuery unavailable');
    try {
      return await query.readSession(sessionId);
    } catch (first) {
      const stripped = String(sessionId).replace(/^session-/, '');
      if (stripped === sessionId) throw first;
      return await query.readSession(stripped);
    }
  }

  async function buildBoard(sessionId) {
    const snapshot = await readSession(sessionId);
    const previous = loadState(sessionId);
    const requirements = previous ? previous.requirements.map((row) => row.slice()) : [];
    const before = JSON.stringify(requirements);
    const projected = project(snapshot.events, requirements);
    if (JSON.stringify(requirements) !== before || !previous) saveState(sessionId, requirements);
    const children = await listChildren(ctx.get('sessionQuery'), sessionId);
    return {
      sessionId,
      cwd: snapshot.session?.cwd || '',
      savedAt: Date.now(),
      rows: projected.rows,
      messages: projected.messages.length,
      tasks: projected.rows.reduce((sum, row) => sum + row.tasks.length, 0),
      children,
    };
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: BOARD_PATH,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              const url = new URL(req.url, 'http://127.0.0.1');
              const sessionId = url.searchParams.get('session') || '';
              if (!sessionId) {
                sendJson(res, 400, { ok: false, message: 'session is required' });
                return;
              }
              sendJson(res, 200, { ok: true, board: await buildBoard(sessionId) });
              return;
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, message: 'GET or POST required' });
              return;
            }
            const body = await readJsonBody(req);
            const sessionId = String(body.sessionId || '');
            if (!sessionId) {
              sendJson(res, 400, { ok: false, message: 'sessionId is required' });
              return;
            }
            const snapshot = await readSession(sessionId);
            const messages = [];
            for (const event of snapshot.events) {
              if (event?.type !== 'user/message') continue;
              const text = textOf(event.data);
              if (text && isOperatorMessage(event.data)) messages.push({ seq: event.seq, time: event.time, text });
            }
            const state = loadState(sessionId);
            const requirements = state ? state.requirements.map((row) => row.slice()) : [];
            project(snapshot.events, requirements);

            const action = String(body.action || '');
            const index = Number(body.index || 0) - 1;
            if (action === 'reset') {
              rmSync(statePath(sessionId), { force: true });
            } else if (action === 'merge' && index > 0 && index < requirements.length) {
              requirements[index - 1] = requirements[index - 1].concat(requirements[index]);
              requirements.splice(index, 1);
              saveState(sessionId, requirements);
            } else if (action === 'split' && index >= 0 && index < requirements.length) {
              const seq = Number(body.fromSeq || 0);
              const row = requirements[index];
              const cut = row.findIndex((value) => value >= seq);
              if (cut > 0) {
                const moved = row.splice(cut);
                requirements.splice(index + 1, 0, moved);
                saveState(sessionId, requirements);
              }
            } else {
              saveState(sessionId, requirements);
            }
            sendJson(res, 200, { ok: true, board: await buildBoard(sessionId) });
          } catch (error) {
            sendJson(res, 500, { ok: false, message: error?.message || String(error) });
          }
        },
      }),
    'dsh-session-board: board route',
  );
}
