/**
 * Host half of the feishu-ref bundle.
 *
 * One read-only route: search the operator's Feishu **docs / bitables / sheets /
 * wikis / slides / drive files / group chats / messages / contacts** through the
 * already-authenticated `lark-cli`, and hand the client a compact list per kind.
 * The client inserts a short reference into the composer; nothing is written
 * back to Feishu.
 *
 * The contract that matters: whatever gets inserted must be something the agent
 * can *act on* without guessing —
 *   docs / drive files / folders -> the Feishu URL itself (token inside)
 *   group chats                 -> AppLink carrying `openChatId=<chat_id>`
 *   messages                    -> AppLink + `message_id` (the AppLink alone
 *                                  does not carry the message id)
 *   contacts                    -> AppLink carrying the p2p chat id, plus
 *                                  `open_id` when there is no chat yet
 *
 * Four independent `lark-cli` calls run in parallel on purpose: one failing
 * must not empty the others. Search APIs used:
 *   drive +search        (doc_wiki/search: docx,bitable,sheet,wiki,slides,file,folder)
 *   im +chat-search      (groups the operator is in / external / joined public)
 *   im +messages-search  (messages across conversations, needs a keyword)
 *   contact +search-user (people; user identity only, needs contact:user:search)
 */
import { homedir } from 'node:os';

export const inject = ['webServer', 'subprocess'];

const SEARCH_PATH = '/plugins/feishu-ref/search';
const DRIVE_PAGE_SIZE = '20';
const CHAT_PAGE_SIZE = '8';
const MESSAGE_PAGE_SIZE = '8';
const CONTACT_PAGE_SIZE = '8';
// Search v2 accepts `file` / `folder` too, but a mixed query ranks them below
// online docs (measured: 报告 -> 0 files mixed vs 8 files alone), so 云盘 gets
// its own parallel call. One extra lark-cli process, a group the operator can
// actually see.
const DOC_TYPES = 'docx,bitable,sheet,wiki,slides';
const FILE_TYPES = 'file,folder';
// Only chats the operator can actually open and read. `public_not_joined` is
// excluded: a link to a chat you are not in is not a reference to your own data.
const CHAT_TYPES = 'private,external,public_joined';
// Documented joined-conversation AppLink. NOT `im chats link` — that one returns
// an expiring `add_by_link` invite token, which would leak an invitation.
const CHAT_APPLINK = 'https://applink.feishu.cn/client/chat/open?openChatId=';
// Feishu Search v2 caps the document keyword at 30 chars; chat search accepts
// 64, message search is floored at the same 64, contact search at 50.
const DOC_QUERY_LIMIT = 30;
const CHAT_QUERY_LIMIT = 64;
const MESSAGE_QUERY_LIMIT = 64;
const CONTACT_QUERY_LIMIT = 50;
const DOC_RESULT_LIMIT = 12;
const DRIVE_RESULT_LIMIT = 8;
const CHAT_RESULT_LIMIT = 8;
const MESSAGE_RESULT_LIMIT = 8;
const CONTACT_RESULT_LIMIT = 8;

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

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHighlight(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, '')).trim();
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Message bodies arrive as plain text, markdown-ish `post` JSON, or card XML. */
function toSnippet(content) {
  let text = String(content || '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const payload = parseJson(trimmed);
    const pieces = [];
    if (payload && typeof payload.title === 'string' && payload.title) pieces.push(payload.title);
    if (payload && Array.isArray(payload.content)) {
      for (const row of payload.content) {
        if (!Array.isArray(row)) continue;
        for (const node of row) {
          if (node && typeof node.text === 'string' && node.text) pieces.push(node.text);
        }
      }
    }
    if (pieces.length) text = pieces.join(' ');
  }
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  // Light markdown strip: keep the words, drop the syntax noise.
  text = text.replace(/[*_`>#~[\]]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 120);
}

function toIso(time) {
  const raw = String(time || '').trim();
  if (!raw) return '';
  // lark-cli renders `YYYY-MM-DD HH:mm`; Date() accepts it as local time.
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toDocItem(result) {
  const meta = (result && result.result_meta) || {};
  const title = stripHighlight(result && result.title_highlighted) || '(未命名)';
  const url = meta.url || '';
  if (!url) return null;
  const type = String(meta.doc_types || result.entity_type || '').toLowerCase();
  return {
    title,
    url,
    type,
    fileType: String(meta.file_type || '').toLowerCase(),
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

function toMessageItem(message) {
  if (!message || message.deleted === true) return null;
  const chatId = String(message.chat_id || '');
  const messageId = String(message.message_id || '');
  const url = String(message.message_app_link || '') || (chatId ? CHAT_APPLINK + chatId : '');
  if (!url && !messageId) return null;
  const sender = String((message.sender && message.sender.name) || '').trim();
  const chatName = String(message.chat_name || '').trim();
  const snippet = toSnippet(message.content) || '(无文本内容)';
  return {
    title: sender ? sender + '：' + snippet : snippet,
    url,
    type: 'message',
    chatName,
    sender,
    messageId,
    msgType: String(message.msg_type || ''),
    editedAt: toIso(message.create_time),
  };
}

function toContactItem(user) {
  const openId = String((user && user.open_id) || '');
  if (!openId) return null;
  const name = String((user && (user.localized_name || user.name)) || '').trim() || openId;
  const p2pChatId = String((user && user.p2p_chat_id) || '');
  return {
    title: name,
    // Chatted peers get an openable p2p conversation; the rest only carry the id.
    url: p2pChatId ? CHAT_APPLINK + p2pChatId : '',
    type: 'contact',
    openId,
    p2pChatId,
    desc: String((user && user.department) || '').trim(),
    external: user && user.is_cross_tenant === true,
    editedAt: '',
  };
}

function runLarkCli(ctx, args) {
  return new Promise((resolve, reject) => {
    const handle = ctx.subprocess.spawn({
      argv: ['lark-cli', ...args],
      cwd: homedir(),
      stdio: { stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
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

function cliErrorMessage(error) {
  if (!error) return '搜索失败';
  const scopes = Array.isArray(error.missing_scopes) ? error.missing_scopes : [];
  // The raw English "missing required scope(s): ..." is useless to an operator.
  if (scopes.length) return '缺少授权：' + scopes.join('、');
  return String(error.message || '搜索失败');
}

async function runJson(ctx, args) {
  const result = await runLarkCli(ctx, args);
  const stdoutPayload = parseJson(result.stdout);
  if (result.code !== 0) {
    // lark-cli prints its error JSON on stderr for authorization failures.
    const payload = stdoutPayload || parseJson(result.stderr);
    if (payload && payload.error) throw new Error(cliErrorMessage(payload.error));
    throw new Error(((result.stderr || result.stdout) || '').trim().slice(0, 300) || 'lark-cli 搜索失败');
  }
  if (!stdoutPayload) throw new Error('lark-cli 输出不是 JSON');
  if (stdoutPayload.ok === false) throw new Error(cliErrorMessage(stdoutPayload.error));
  return stdoutPayload;
}

function driveSearch(ctx, query, docTypes, limit) {
  const args = [
    'drive', '+search', '--as', 'user', '--format', 'json',
    '--page-size', DRIVE_PAGE_SIZE, '--sort', 'edit_time',
    '--doc-types', docTypes,
  ];
  if (query === '') args.push('--query', '', '--edited-since', '30d');
  else args.push('--query', query);
  return runJson(ctx, args).then((payload) => (
    ((payload.data && payload.data.results) || [])
      .map(toDocItem).filter(Boolean).slice(0, limit)
  ));
}

const searchDocs = (ctx, query) => driveSearch(ctx, query, DOC_TYPES, DOC_RESULT_LIMIT);
const searchFiles = (ctx, query) => driveSearch(ctx, query, FILE_TYPES, DRIVE_RESULT_LIMIT);

function searchChats(ctx, query) {
  // `im +chat-search` needs a keyword (or member ids). Empty input is not an
  // error — it just means "no chat section" until the operator types.
  if (query === '') return Promise.resolve([]);
  const args = [
    'im', '+chat-search', '--as', 'user', '--format', 'json',
    '--page-size', CHAT_PAGE_SIZE, '--search-types', CHAT_TYPES, '--query', query,
  ];
  return runJson(ctx, args).then((payload) => (
    ((payload.data && payload.data.chats) || [])
      .map(toChatItem).filter(Boolean).slice(0, CHAT_RESULT_LIMIT)
  ));
}

function searchMessages(ctx, query) {
  if (query === '') return Promise.resolve([]);
  const args = [
    'im', '+messages-search', '--as', 'user', '--format', 'json',
    '--page-size', MESSAGE_PAGE_SIZE, '--query', query,
  ];
  return runJson(ctx, args).then((payload) => (
    ((payload.data && payload.data.messages) || [])
      .map(toMessageItem).filter(Boolean).slice(0, MESSAGE_RESULT_LIMIT)
  ));
}

function searchContacts(ctx, query) {
  if (query === '') return Promise.resolve([]);
  const args = [
    'contact', '+search-user', '--as', 'user', '--format', 'json',
    '--page-size', CONTACT_PAGE_SIZE, '--query', query,
  ];
  return runJson(ctx, args).then((payload) => {
    const data = payload.data || {};
    const users = data.users || data.results || [];
    return users.map(toContactItem).filter(Boolean).slice(0, CONTACT_RESULT_LIMIT);
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
      const query = String(body.q ?? '').trim();
      // All five searches run at once: one failing must not empty the others.
      const [docs, files, chats, messages, contacts] = await Promise.allSettled([
        searchDocs(ctx, query.slice(0, DOC_QUERY_LIMIT)),
        searchFiles(ctx, query.slice(0, DOC_QUERY_LIMIT)),
        searchChats(ctx, query.slice(0, CHAT_QUERY_LIMIT)),
        searchMessages(ctx, query.slice(0, MESSAGE_QUERY_LIMIT)),
        searchContacts(ctx, query.slice(0, CONTACT_QUERY_LIMIT)),
      ]);
      const failures = [];
      const note = (kind, label, result) => {
        if (result.status === 'fulfilled') return;
        const reason = result.reason;
        failures.push({
          kind,
          label,
          message: String((reason && reason.message) || reason).slice(0, 300),
        });
      };
      note('docs', '文档', docs);
      note('files', '云盘', files);
      note('chats', '群聊', chats);
      note('messages', '消息', messages);
      note('contacts', '联系人', contacts);
      if (failures.length === 5) {
        sendJson(res, 500, { ok: false, message: failures.map((entry) => entry.message).join('；') });
        return;
      }
      for (const failure of failures) {
        ctx.logger?.warn?.(`feishu-ref: ${failure.kind} search failed: ${failure.message}`);
      }
      sendJson(res, 200, {
        ok: true,
        query,
        docs: docs.status === 'fulfilled' ? docs.value : [],
        files: files.status === 'fulfilled' ? files.value : [],
        chats: chats.status === 'fulfilled' ? chats.value : [],
        messages: messages.status === 'fulfilled' ? messages.value : [],
        contacts: contacts.status === 'fulfilled' ? contacts.value : [],
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
