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

export const inject = ['webServer', 'tools'];

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
const CORRECTION = /其实不是|不是这样|不是这个|不对|说得不对|我意思|我的意思|改一下|改成|换成|更正|修正|补充|补充一下|刚才那个|上面那个|再改|还是不对|说错|漏了|忘说|重新说/;

const MAX_ROWS = 200;

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

/** A one-word answer ("好", "继续", "所以呢") continues the open goal. */
export function isShortContinuation(text) {
  const clean = String(text || '').replace(/[\s，。、！？,.!?~～:：；;]/g, '');
  return clean.length > 0 && clean.length <= 12;
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
 *
 * Time proximity is NOT a joining signal. Two messages an hour apart can be the
 * same goal, and two messages ten seconds apart can be two goals — using the
 * clock as evidence collapses an entire working session into one row, which is
 * exactly the failure the board exists to prevent.
 */
export function segment(requirements, messages) {
  const seen = new Set();
  for (const requirement of requirements) for (const seq of requirement) seen.add(seq);
  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  for (const message of messages) {
    if (seen.has(message.seq)) continue;
    if (requirements.length === 0) {
      requirements.push([message.seq]);
      continue;
    }
    const current = requirements[requirements.length - 1];
    // Bounded context on purpose: last few messages of the open requirement plus
    // the assistant reply just before this one. A follow-up usually picks up the
    // *answer*, not the question, so the reply is where its shared vocabulary
    // actually comes from. Growing the context to the whole requirement makes
    // every message look related and collapses the session into one row.
    const said = current
      .map((seq) => bySeq.get(seq))
      .filter(Boolean)
      .slice(-3)
      .map((m) => m.text)
      .join(' ');
    const context = `${said} ${message.prev || ''}`;
    const continues =
      isCorrection(message.text) ||
      isShortContinuation(message.text) ||
      overlap(context, message.text) >= 0.08;
    if (continues) current.push(message.seq);
    else requirements.push([message.seq]);
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
    if (raw && Array.isArray(raw.requirements)) {
      return {
        requirements: raw.requirements,
        reports: Array.isArray(raw.reports) ? raw.reports : [],
      };
    }
  } catch {
    /* no state yet */
  }
  return null;
}

/**
 * Persist the two things the board owns: the segmentation, and what the agent
 * reported about each requirement. Everything else is re-derived from the log.
 */
function saveState(sessionId, requirements, reports = []) {
  try {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(
      statePath(sessionId),
      JSON.stringify({ v: 2, sessionId, requirements, reports, updatedAt: Date.now() }, null, 2),
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
  let lastAssistant = '';

  for (const event of events) {
    if (!event || typeof event.seq !== 'number') continue;
    if (event.type === 'user/message') {
      const text = textOf(event.data);
      if (text && isOperatorMessage(event.data)) {
        messages.push({ seq: event.seq, time: event.time, text, prev: lastAssistant });
      }
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message);
      if (text) lastAssistant = text.slice(-800);
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

/**
 * Overlay what the agent reported on top of what the log says.
 *
 * Division of labour, deliberately:
 *   - the **log** is the skeleton — it cannot miss a requirement, but it can only
 *     see what was said and called;
 *   - the **report** is the intent — it knows why something is blocked, what a
 *     correction was about, and which subtask belongs where.
 *
 * A report claims the log row that contains its anchor sequence (the operator
 * message current when it was declared), so a later correction keeps reporting
 * into the same row instead of forking a second one. A report that claims
 * nothing yet still shows up as its own row: the agent declared a goal the
 * operator has not typed anything about, and hiding it would be worse.
 */
export function mergeReports(rows, reports) {
  if (!reports || reports.length === 0) return rows.map((row) => ({ ...row, source: 'log' }));

  const ordered = reports.slice().sort((a, b) => (a.anchorSeq || 0) - (b.anchorSeq || 0));
  const claimed = new Map();
  const orphans = [];
  for (const report of ordered) {
    let target = null;
    for (const row of rows) {
      if (row.firstSeq <= (report.anchorSeq || 0)) target = row;
      else break;
    }
    if (target && !claimed.has(target.id)) claimed.set(target.id, report);
    else orphans.push(report);
  }

  const agentTasksOf = (report) =>
    (report.tasks || []).map((task, index) => ({
      id: task.id || `t${index + 1}`,
      name: 'agent',
      label: titleOf(task.title || '', 60),
      status: agentTaskStatus(task),
      subagentId: task.subagentId,
      subagentStatus: task.subagentStatus,
      source: 'agent',
    }));

  const merged = rows.map((row) => {
    const report = claimed.get(row.id);
    if (!report) return { ...row, source: 'log' };
    return {
      ...row,
      title: report.goal ? titleOf(report.goal, 60) : row.title,
      autoStatus: row.status,
      status: report.status || row.status,
      reason: report.reason || '',
      reported: true,
      tasks: [
        ...row.tasks.map((task) => ({ ...task, id: `${task.name}-${task.label}`, source: 'log' })),
        ...agentTasksOf(report),
      ],
    };
  });

  for (const report of orphans) {
    merged.push({
      id: `r${report.id}`,
      title: titleOf(report.goal || '', 60),
      firstSeq: report.anchorSeq || 0,
      messageCount: 0,
      messages: [],
      autoStatus: 'open',
      status: report.status || 'open',
      reason: report.reason || '',
      reported: true,
      source: 'agent',
      tasks: agentTasksOf(report),
    });
  }
  return merged;
}

/** Agent task status → the board's task vocabulary. */
function agentTaskStatus(task) {
  if (task.subagentStatus === 'blocked') return 'failed';
  switch (task.status) {
    case 'completed':
      return 'done';
    case 'in_progress':
      return 'running';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
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
    const reports = previous ? previous.reports : [];
    const before = JSON.stringify(requirements);
    const projected = project(snapshot.events, requirements);
    if (JSON.stringify(requirements) !== before || !previous) saveState(sessionId, requirements, reports);
    const rows = mergeReports(projected.rows, reports);
    const children = await listChildren(ctx.get('sessionQuery'), sessionId);
    return {
      sessionId,
      cwd: snapshot.session?.cwd || '',
      savedAt: Date.now(),
      rows,
      messages: projected.messages.length,
      tasks: rows.reduce((sum, row) => sum + row.tasks.length, 0),
      reported: reports.length,
      children,
    };
  }

  /** Sequence of the newest operator message: the anchor a report claims. */
  function lastOperatorSeq(events) {
    let anchor = 0;
    for (const event of events) {
      if (event?.type !== 'user/message') continue;
      if (!isOperatorMessage(event.data)) continue;
      if (event.seq > anchor) anchor = event.seq;
    }
    return anchor;
  }

  /**
   * Read the log, apply one change to the agent's reports, persist, return the board.
   * Every mutation re-derives the segmentation first, so ids the agent saw in a
   * previous result still point at the same rows.
   */
  async function mutateReports(sessionId, mutate) {
    const snapshot = await readSession(sessionId);
    const previous = loadState(sessionId);
    const requirements = previous ? previous.requirements.map((row) => row.slice()) : [];
    const reports = previous ? previous.reports.slice() : [];
    project(snapshot.events, requirements);
    const next = mutate(reports, { anchorSeq: lastOperatorSeq(snapshot.events) });
    saveState(sessionId, requirements, next);
    return buildBoard(sessionId);
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
            const reports = state ? state.reports : [];
            project(snapshot.events, requirements);

            const action = String(body.action || '');
            const index = Number(body.index || 0) - 1;
            if (action === 'reset') {
              rmSync(statePath(sessionId), { force: true });
            } else if (action === 'merge' && index > 0 && index < requirements.length) {
              requirements[index - 1] = requirements[index - 1].concat(requirements[index]);
              requirements.splice(index, 1);
              saveState(sessionId, requirements, reports);
            } else if (action === 'split' && index >= 0 && index < requirements.length) {
              const seq = Number(body.fromSeq || 0);
              const row = requirements[index];
              const cut = row.findIndex((value) => value >= seq);
              if (cut > 0) {
                const moved = row.splice(cut);
                requirements.splice(index + 1, 0, moved);
                saveState(sessionId, requirements, reports);
              }
            } else {
              saveState(sessionId, requirements, reports);
            }
            sendJson(res, 200, { ok: true, board: await buildBoard(sessionId) });
          } catch (error) {
            sendJson(res, 500, { ok: false, message: error?.message || String(error) });
          }
        },
      }),
    'dsh-session-board: board route',
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'session_board',
        description:
          'Report this conversation\'s requirements on the session board the operator reads in the right sidebar. The board already lists every requirement it can infer from the log; this tool adds what the log cannot know — what a goal actually is once the operator corrected it, why something is blocked, and which subtask belongs to which requirement. Call `declare` only for a genuinely new goal; a correction, addition or rework of an existing goal is `update` on that requirement, not a new entry.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['declare', 'update', 'add_tasks', 'update_task'],
              description: 'declare = new goal; update = correct/extend an existing requirement; add_tasks = record subtasks; update_task = change one subtask.',
            },
            requirementId: {
              type: 'string',
              description: 'Target requirement id (r1, r2, ... as returned by the previous call). Required by update, add_tasks, update_task.',
            },
            goal: { type: 'string', description: 'The goal in one line. Required by declare; on update it rewrites the goal after a correction.' },
            status: {
              type: 'string',
              enum: ['open', 'active', 'done', 'blocked'],
              description: 'Requirement status. `blocked` also wants a reason.',
            },
            reason: { type: 'string', description: 'Short context: why the goal changed, or what is blocking it.' },
            tasks: {
              type: 'array',
              description: 'Subtasks to append, for add_tasks.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'What the subtask is — a short imperative line.' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
                  subagentId: { type: 'string', description: 'The subagent working on it, when delegated.' },
                  subagentStatus: { type: 'string', description: 'That subagent status: running, blocked, completed, failed, ...' },
                },
                required: ['title'],
                additionalProperties: false,
              },
            },
            taskId: { type: 'string', description: 'Subtask id (t1, t2, ...), for update_task.' },
            taskTitle: { type: 'string', description: 'New subtask title, for update_task.' },
            taskStatus: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'New subtask status, for update_task.' },
            sessionId: { type: 'string', description: 'Optional explicit session id; defaults to the calling session.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          const sessionId = String((args && args.sessionId) || exec?.agent?.id || '').trim();
          if (!sessionId) throw new Error('session_board: no session id in the tool context');
          const action = String((args && args.action) || '');
          const wanted = normaliseRequirementId(args && args.requirementId);

          const board = await mutateReports(sessionId, (reports, info) => {
            const next = reports.map((report) => ({ ...report, tasks: (report.tasks || []).slice() }));
            const nextId = () =>
              next.reduce((max, report) => Math.max(max, Number(String(report.id).replace(/\D/g, '')) || 0), 0) + 1;

            if (action === 'declare') {
              if (!args.goal) throw new Error('session_board: declare requires goal');
              next.push({
                id: nextId(),
                anchorSeq: info.anchorSeq,
                goal: String(args.goal),
                status: String(args.status || 'active'),
                reason: String(args.reason || ''),
                tasks: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              return next;
            }

            const report = next.find((item) => String(item.id) === wanted);
            if (!report) throw new Error(`session_board: requirement ${wanted || '(none)'} not found in this session`);

            if (action === 'update') {
              if (args.goal) report.goal = String(args.goal);
              if (args.status) report.status = String(args.status);
              if (typeof args.reason === 'string') report.reason = args.reason;
            } else if (action === 'add_tasks') {
              const list = Array.isArray(args.tasks) ? args.tasks : [];
              let taskNo = report.tasks.length;
              for (const task of list) {
                taskNo += 1;
                report.tasks.push({
                  id: `t${taskNo}`,
                  title: String(task.title || ''),
                  status: String(task.status || 'pending'),
                  subagentId: task.subagentId ? String(task.subagentId) : undefined,
                  subagentStatus: task.subagentStatus ? String(task.subagentStatus) : undefined,
                });
              }
            } else if (action === 'update_task') {
              const task = report.tasks.find((item) => String(item.id) === String(args.taskId || ''));
              if (!task) throw new Error(`session_board: task ${args.taskId || '(none)'} not found`);
              if (args.taskTitle) task.title = String(args.taskTitle);
              if (args.taskStatus) task.status = String(args.taskStatus);
              if (args.subagentStatus) task.subagentStatus = String(args.subagentStatus);
            } else {
              throw new Error(`session_board: unknown action ${action}`);
            }
            report.updatedAt = Date.now();
            return next;
          });

          return {
            ok: true,
            requirements: board.rows.map((row) => ({
              id: typeof row.id === 'number' ? `r${row.id}` : String(row.id),
              goal: row.title,
              status: row.status,
              reason: row.reason || '',
              tasks: (row.tasks || []).map((task) => ({ id: task.id, title: task.label, status: task.status })),
            })),
          };
        },
      }),
    'dsh-session-board: report tool',
  );
}

/** Accept `r3`, `3`, or 3 — the tool hands out `rN`, older state holds numbers. */
function normaliseRequirementId(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/^r/i, '').trim();
}
