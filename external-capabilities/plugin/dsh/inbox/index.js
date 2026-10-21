/**
 * Host half of the DSH inbox bundle.
 *
 * Reads the Feishu Bitable「任务收件箱」for unread rows, marks rows read, and
 * accepts deliveries from server-side jobs. All access goes through the
 * operator's already-authenticated `lark-cli`; this plugin stores nothing.
 */
import { homedir } from 'node:os';

export const inject = ['webServer', 'subprocess'];

const BASE_TOKEN = process.env.DSH_INBOX_BASE_TOKEN || 'ZNjDb9TrpalLuCsw0macCeVdnld';
const TABLE_ID = process.env.DSH_INBOX_TABLE_ID || 'tbl9LghPBTjFLH4N';
const TASK_TABLE_ID = process.env.DSH_INBOX_TASK_TABLE_ID || 'tbl4k7ggY1paqoUn';
const IDENTITY = process.env.DSH_INBOX_IDENTITY || 'user';
const LIST_PATH = '/plugins/inbox/list';
const READ_PATH = '/plugins/inbox/read';
const DELIVER_PATH = '/plugins/inbox/deliver';

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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function connectionRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || typeof connection.requestRejection !== 'function') return undefined;
  try {
    return connection.requestRejection({ headers: req.headers });
  } catch {
    return undefined;
  }
}

function runLarkCli(ctx, args) {
  return new Promise((resolve, reject) => {
    const handle = ctx.subprocess.spawn({
      argv: ['lark-cli', ...args],
      cwd: homedir(),
      stdio: { stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 30_000,
    });
    handle.done.then((outcome) => {
      const read = (reader) => {
        if (reader === undefined) return '';
        try {
          return reader.readFrom(0).text;
        } catch {
          return '';
        }
      };
      resolve({
        code: outcome.exitCode,
        stdout: read(handle.collected.stdout),
        stderr: read(handle.collected.stderr),
      });
    }, reject);
  });
}

async function lark(ctx, args) {
  const result = await runLarkCli(ctx, [...args, '--as', IDENTITY, '--format', 'json']);
  let payload;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch {
    payload = {};
  }
  if (payload.ok === false) {
    const message = (payload.error && payload.error.message) || result.stderr || 'lark-cli failed';
    throw new Error(message);
  }
  if (result.code !== 0 && payload.ok !== true) {
    throw new Error(result.stderr || `lark-cli exited with ${result.code}`);
  }
  return payload;
}

function pickIndex(fields, name) {
  return Array.isArray(fields) ? fields.indexOf(name) : -1;
}

function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('、');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.name === 'string') return value.name;
    return '';
  }
  return String(value);
}

function linkIds(value) {
  const ids = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      if (Array.isArray(node.record_ids)) ids.push(...node.record_ids.map(String));
      if (Array.isArray(node.link_record_ids)) ids.push(...node.link_record_ids.map(String));
      if (typeof node.id === 'string') ids.push(node.id);
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return [...new Set(ids)];
}

function toMs(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  if (text === '') return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function listTaskNames(ctx) {
  const payload = await lark(ctx, ['base', '+record-list', '--base-token', BASE_TOKEN, '--table-id', TASK_TABLE_ID, '--limit', '200']);
  const meta = payload.data || {};
  const fields = meta.fields || [];
  const rows = meta.data || [];
  const ids = meta.record_id_list || [];
  const nameIndex = pickIndex(fields, '任务名称');
  const map = new Map();
  rows.forEach((row, index) => {
    map.set(String(ids[index] || ''), asText(nameIndex >= 0 ? row[nameIndex] : row[0]));
  });
  return map;
}

export function apply(ctx) {
  const listHandler = async (req, res) => {
    const rejection = connectionRejection(ctx, req);
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, message: '未通过 DSH 连接鉴权' });
      return;
    }
    try {
      const includeRead = /(?:[?&]includeRead=1)/.test(String(req.url || ''));
      const [payload, names] = await Promise.all([
        lark(ctx, ['base', '+record-list', '--base-token', BASE_TOKEN, '--table-id', TABLE_ID, '--limit', '200']),
        listTaskNames(ctx).catch(() => new Map()),
      ]);
      const meta = payload.data || {};
      const fields = meta.fields || [];
      const rows = meta.data || [];
      const ids = meta.record_id_list || [];
      const idx = {
        summary: pickIndex(fields, '结果摘要'),
        result: pickIndex(fields, '结果'),
        status: pickIndex(fields, '状态'),
        executedAt: pickIndex(fields, '执行任务'),
        task: pickIndex(fields, '关联任务'),
      };
      const items = rows.map((row, index) => {
        const status = asText(idx.status >= 0 ? row[idx.status] : '');
        const taskIds = idx.task >= 0 ? linkIds(row[idx.task]) : [];
        const taskName = asText(taskIds.map((id) => names.get(id)).filter(Boolean)[0]) || asText(taskIds[0]) || '(未关联任务)';
        return {
          recordId: String(ids[index] || ''),
          taskName,
          taskRecordId: taskIds[0] || '',
          result: asText(idx.result >= 0 ? row[idx.result] : '成功') || '成功',
          status,
          executedAt: toMs(idx.executedAt >= 0 ? row[idx.executedAt] : 0),
          summary: asText(idx.summary >= 0 ? row[idx.summary] : ''),
        };
      });
      const filtered = items
        .filter((item) => includeRead || item.status !== '已读')
        .sort((a, b) => (b.executedAt || 0) - (a.executedAt || 0));
      sendJson(res, 200, { ok: true, unread: filtered.filter((item) => item.status !== '已读').length, items: filtered });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  };

  const readHandler = async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: 'method not allowed' }); return; }
    const rejection = connectionRejection(ctx, req);
    if (rejection !== undefined) { sendJson(res, rejection, { ok: false, message: '未通过 DSH 连接鉴权' }); return; }
    try {
      const body = await readJsonBody(req);
      const recordIds = Array.isArray(body.recordIds) ? body.recordIds.map(String).filter(Boolean) : [];
      if (recordIds.length === 0) throw new Error('recordIds is required');
      for (const recordId of recordIds) {
        await lark(ctx, ['base', '+record-upsert', '--base-token', BASE_TOKEN, '--table-id', TABLE_ID, '--record-id', recordId, '--json', JSON.stringify({ 状态: ['已读'] })]);
      }
      sendJson(res, 200, { ok: true, marked: recordIds.length });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  };

  const deliverHandler = async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: 'method not allowed' }); return; }
    const rejection = connectionRejection(ctx, req);
    if (rejection !== undefined) { sendJson(res, rejection, { ok: false, message: '未通过 DSH 连接鉴权' }); return; }
    try {
      const body = await readJsonBody(req);
      const summary = String(body.summary || '').trim();
      if (summary === '') throw new Error('summary is required');
      const result = ['成功', '失败', '超时'].includes(body.result) ? body.result : '成功';
      const record = {
        结果摘要: summary,
        结果: [result],
        状态: ['未读'],
        执行任务: typeof body.executedAt === 'number' ? body.executedAt : Date.now(),
      };
      const taskRecordId = String(body.taskRecordId || '').trim();
      if (taskRecordId !== '') record.关联任务 = [taskRecordId];
      await lark(ctx, ['base', '+record-batch-create', '--base-token', BASE_TOKEN, '--table-id', TABLE_ID, '--json', JSON.stringify({ create_records: [record] })]);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: LIST_PATH, handler: listHandler }), 'dsh-inbox: list');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: READ_PATH, handler: readHandler }), 'dsh-inbox: read');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DELIVER_PATH, handler: deliverHandler }), 'dsh-inbox: deliver');
}
