/**
 * Host half of the feishu-ref bundle.
 *
 * One read-only route: search the operator's Feishu docs / bitables / sheets
 * through the already-authenticated `lark-cli`, and hand the client a compact
 * list (title + url + type + edited time). The client inserts the chosen link
 * into the composer; nothing is written back to Feishu.
 */
import { homedir } from 'node:os';

export const inject = ['webServer', 'subprocess'];

const SEARCH_PATH = '/plugins/feishu-ref/search';
const PAGE_SIZE = '12';
const DOC_TYPES = 'docx,bitable,sheet,wiki,slides';

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

/** Reuse the Host's browser authentication for this plugin's own route. */
function connectionRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || typeof connection.requestRejection !== 'function') return undefined;
  try {
    return connection.requestRejection({ headers: req.headers });
  } catch {
    return undefined;
  }
}

function stripHighlight(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function toItem(result) {
  const meta = (result && result.result_meta) || {};
  const title = stripHighlight(result && result.title_highlighted) || '(未命名)';
  const url = meta.url || '';
  if (!url) return null;
  return {
    title,
    url,
    type: String(meta.doc_types || result.entity_type || '').toLowerCase(),
    editedAt: meta.update_time_iso || meta.create_time_iso || '',
  };
}

function runLarkCli(ctx, args) {
  return new Promise((resolve, reject) => {
    const handle = ctx.subprocess.spawn({
      argv: ['lark-cli', ...args],
      cwd: homedir(),
      stdio: { stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 25_000,
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

export function apply(ctx) {
  const searchHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const rejection = connectionRejection(ctx, req);
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, message: '未通过 DSH 连接鉴权（本地 token 无效）' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const query = String(body.q ?? '').trim().slice(0, 30);
      const args = ['drive', '+search', '--as', 'user', '--format', 'json', '--page-size', PAGE_SIZE, '--sort', 'edit_time', '--doc-types', DOC_TYPES];
      if (query === '') {
        args.push('--query', '', '--edited-since', '30d');
      } else {
        args.push('--query', query);
      }
      const result = await runLarkCli(ctx, args);
      if (result.code !== 0) {
        sendJson(res, 500, {
          ok: false,
          message: (result.stderr || result.stdout || '').trim().slice(0, 300) || 'lark-cli 搜索失败',
        });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(result.stdout);
      } catch {
        sendJson(res, 500, { ok: false, message: 'lark-cli 输出不是 JSON' });
        return;
      }
      if (payload.ok === false) {
        sendJson(res, 500, { ok: false, message: (payload.error && payload.error.message) || '搜索失败' });
        return;
      }
      const results = (payload.data && payload.data.results) || [];
      const items = results.map(toItem).filter(Boolean).slice(0, 12);
      sendJson(res, 200, { ok: true, query, items });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`feishu-ref: search failed: ${message}`);
      sendJson(res, 500, { ok: false, message });
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SEARCH_PATH,
    handler: searchHandler,
  }));
}
