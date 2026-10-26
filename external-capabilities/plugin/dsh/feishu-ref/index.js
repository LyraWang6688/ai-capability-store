/**
 * Host half of the feishu-ref bundle.
 *
 * One read-only route: search the operator's Feishu docs / bitables / sheets
 * **and group chats** through the already-authenticated `lark-cli`, and hand the
 * client a compact list (title + url + type + edited time). The client inserts
 * the chosen link into the composer; nothing is written back to Feishu.
 *
 * Two independent `lark-cli` calls, run in parallel on purpose: a failure in one
 * must not empty the other. Docs go through `drive +search`; chats go through
 * `im +chat-search` and are addressed by an AppLink whose `openChatId` carries
 * the stable `chat_id`, so the agent can read that chat after the link is sent.
 */
import { homedir } from 'node:os';

export const inject = ['webServer', 'subprocess'];

const SEARCH_PATH = '/plugins/feishu-ref/search';
const PAGE_SIZE = '12';
const CHAT_PAGE_SIZE = '8';
const DOC_TYPES = 'docx,bitable,sheet,wiki,slides';
// Only chats the operator can actually open and read. `public_not_joined` is
// excluded: a link to a chat you are not in is not a reference to your own data.
const CHAT_TYPES = 'private,external,public_joined';
// Documented joined-conversation AppLink. NOT `im chats link` — that one returns
// an expiring `add_by_link` invite token, which would leak an invitation.
const CHAT_APPLINK = 'https://applink.feishu.cn/client/chat/open?openChatId=';
// Feishu Search v2 caps the document keyword at 30 chars; chat search accepts 64.
const DOC_QUERY_LIMIT = 30;
const CHAT_QUERY_LIMIT = 64;

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

function toDocItem(result) {
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

function toChatItem(chat) {
  const chatId = String((chat && chat.chat_id) || '');
  if (!chatId) return null;
  // Dissolved groups stay in the search index for a while; a dead link is noise.
  const status = String((chat && chat.chat_status) || 'normal');
  if (status !== 'normal') return null;
  return {
    title: String((chat && chat.name) || '').trim() || '(未命名群)',
    // The AppLink embeds the stable chat_id, so the agent can read the chat later.
    url: CHAT_APPLINK + chatId,
    type: 'chat',
    desc: String((chat && chat.description) || '').trim(),
    external: chat.external === true,
    editedAt: '',
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

async function runJson(ctx, args) {
  const result = await runLarkCli(ctx, args);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || '').trim().slice(0, 300) || 'lark-cli 搜索失败');
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('lark-cli 输出不是 JSON');
  }
  if (payload.ok === false) {
    throw new Error((payload.error && payload.error.message) || '搜索失败');
  }
  return payload;
}

function searchDocs(ctx, query) {
  const args = ['drive', '+search', '--as', 'user', '--format', 'json', '--page-size', PAGE_SIZE, '--sort', 'edit_time', '--doc-types', DOC_TYPES];
  if (query === '') {
    args.push('--query', '', '--edited-since', '30d');
  } else {
    args.push('--query', query);
  }
  return runJson(ctx, args).then((payload) => (
    ((payload.data && payload.data.results) || []).map(toDocItem).filter(Boolean).slice(0, 12)
  ));
}

function searchChats(ctx, query) {
  // `im +chat-search` needs a keyword (or member ids). Empty input is not an
  // error — it just means "no group-chat section" until the operator types.
  if (query === '') return Promise.resolve([]);
  const args = ['im', '+chat-search', '--as', 'user', '--format', 'json', '--page-size', CHAT_PAGE_SIZE, '--search-types', CHAT_TYPES, '--query', query];
  return runJson(ctx, args).then((payload) => (
    ((payload.data && payload.data.chats) || []).map(toChatItem).filter(Boolean).slice(0, 8)
  ));
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
      const query = String(body.q ?? '').trim();
      // Both searches run at once: one failing must not empty the other list.
      const [docs, chats] = await Promise.allSettled([
        searchDocs(ctx, query.slice(0, DOC_QUERY_LIMIT)),
        searchChats(ctx, query.slice(0, CHAT_QUERY_LIMIT)),
      ]);
      const failures = [];
      if (docs.status === 'rejected') {
        failures.push({ kind: 'docs', message: String(docs.reason && docs.reason.message || docs.reason).slice(0, 300) });
      }
      if (chats.status === 'rejected') {
        failures.push({ kind: 'chats', message: String(chats.reason && chats.reason.message || chats.reason).slice(0, 300) });
      }
      if (failures.length === 2) {
        sendJson(res, 500, { ok: false, message: failures.map((entry) => entry.message).join('；') });
        return;
      }
      for (const failure of failures) {
        ctx.logger?.warn?.(`feishu-ref: ${failure.kind} search failed: ${failure.message}`);
      }
      sendJson(res, 200, {
        ok: true,
        query,
        items: docs.status === 'fulfilled' ? docs.value : [],
        chats: chats.status === 'fulfilled' ? chats.value : [],
        failures,
      });
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
