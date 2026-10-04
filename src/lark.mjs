/**
 * 飞书能力封装 —— 全部经由 lark-cli（用户身份）
 *
 * 为什么用 lark-cli 而不是自建 OpenAPI 客户端：
 * - 它已经处理了设备码登录、token 刷新、代理探测等一堆边界
 * - 宿主（豆包工作 / WorkBuddy）本身就用它，行为一致
 * - 本项目的定位是"分析"，飞书取数不该重复造轮子
 *
 * 约定：所有函数失败时抛 Error（消息面向用户），不返回裸错误对象。
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

const LARK = process.env.LARK_CLI || 'lark-cli';

/**
 * 调 lark-cli 时用的环境变量。
 *
 * 为什么必须显式补 PATH：GUI 宿主（豆包工作 / WorkBuddy）不继承 shell 的 PATH，
 * 通常是 `/usr/bin:/bin:/usr/sbin:/sbin`。而 lark-cli 的 shebang 是
 * `#!/usr/bin/env node`，node 装在 /usr/local/bin —— 于是即使给了 lark-cli 的
 * 绝对路径，它自己也起不来（表现为 ENOENT，很容易被误判成"没装"）。
 *
 * 做法：把 node 自己所在目录和常见的用户 bin 目录前置到 PATH。
 */
const SPAWN_ENV = (() => {
  const extra = [
    dirname(process.execPath),   // node 所在目录，保证 `#!/usr/bin/env node` 能找到
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const cur = (process.env.PATH || '').split(':').filter(Boolean);
  return { ...process.env, PATH: [...new Set([...extra, ...cur])].join(':') };
})();

export class LarkError extends Error {
  constructor(message, { kind = 'unknown', raw = '' } = {}) {
    super(message);
    this.name = 'LarkError';
    this.kind = kind;
    this.raw = raw;
  }
}

/** 调用 lark-cli，返回解析后的 JSON（lark-cli 会在 JSON 前打印进度行） */
export function larkJson(args, { allowFail = false } = {}) {
  let out;
  try {
    out = execFileSync(LARK, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: SPAWN_ENV,
    });
  } catch (e) {
    if (allowFail) return null;
    throw toLarkError(e, args);
  }
  const text = out.trim();
  const start = text.indexOf('{');
  if (start < 0) throw new LarkError(`lark-cli 返回无法解析：${text.slice(0, 200)}`, { raw: text });
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw new LarkError(`lark-cli 返回非法 JSON：${text.slice(0, 200)}`, { raw: text });
  }
}

/** 把 lark-cli 的失败翻译成用户能照着做的提示 */
function toLarkError(e, args) {
  const stderr = `${e.stderr || ''}${e.message || ''}`;
  const scope = /missing required scope\(?s?\)?:\s*([^\n"]+)/i.exec(stderr);
  if (scope) {
    return new LarkError(
      `缺少飞书权限：${scope[1]}\n`
      + '  下一步：在终端执行  lark-cli auth login --recommend\n'
      + '  完成授权后重试。',
      { kind: 'missing_scope', raw: stderr },
    );
  }
  if (/not authenticated|token.*(expired|invalid)|unauthoriz/i.test(stderr)) {
    return new LarkError(
      '飞书登录已失效。\n  下一步：在终端执行  lark-cli auth login --recommend',
      { kind: 'unauthenticated', raw: stderr },
    );
  }
  if (/ENOENT/.test(stderr)) {
    return new LarkError(
      `找不到 lark-cli（当前按 "${LARK}" 查找）。\n`
      + '  下一步：安装  npm install -g @larksuite/cli\n'
      + '  或用环境变量 LARK_CLI 指定它的绝对路径。',
      { kind: 'lark_cli_missing', raw: stderr },
    );
  }
  return new LarkError(
    `飞书接口调用失败（${args.slice(0, 2).join(' ')}）：${stderr.slice(-300) || '未知原因'}`,
    { kind: 'lark_failed', raw: stderr },
  );
}

const fmtDate = (d) => d.toISOString().slice(0, 10);

/**
 * 搜索近期会议。
 * 注意：这是"用户参加过/可见"的会议；飞书会议详情官方时效约 90 天。
 */
export function searchMeetings({ days = 30, query = '' } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const res = larkJson(['vc', '+search', '--start', fmtDate(start), '--end', fmtDate(end),
    '--format', 'json', '--as', 'user']);
  const items = res?.data?.items || [];
  return items.map((it) => {
    const info = it.display_info || '';
    const title = (/^[^\n]*/.exec(info) || [''])[0].trim();
    return {
      meetingId: it.id,
      title,
      hasRecording: info.includes('录制'),
      hasDoc: info.includes('云文档'),
    };
  }).filter((m) => !query || m.title.includes(query));
}

/** 会议详情：拿 note_id / minute_token，并识别妙记权限 */
export function meetingDetail(meetingId) {
  const res = larkJson(['vc', '+detail', '--meeting-ids', meetingId, '--as', 'user', '--format', 'json']);
  const mt = res?.data?.meetings?.[0];
  if (!mt) return null;
  return {
    meetingId,
    topic: mt.topic || '(无标题)',
    startTime: mt.start_time || '',
    noteId: mt.note_id || null,
    minuteToken: mt.minute_token || null,
    minuteDenied: /no permission/i.test(mt.hint || ''),
  };
}

/**
 * 取逐字稿。两条路径：
 *  1) 妙记文字稿（需要妙记权限）
 *  2) 智能纪要的「逐字稿文档」（妙记无权限时的可行路径）
 * 两条都取不到就抛错——不要用 AI 摘要替代，那会丢掉全部原始发言。
 */
export function fetchTranscript({ noteId, minuteToken, topic = '这场会' }) {
  if (minuteToken) {
    const out = larkJson(['minutes', '+detail', '--minute-token', minuteToken, '--as', 'user', '--format', 'json'],
      { allowFail: true });
    const t = pickTranscript(out);
    if (t) return t;
  }
  if (!noteId) {
    throw new LarkError(
      `${topic} 没有可用的妙记，也没有智能纪要逐字稿。\n`
      + '  团队动力分析需要成员原始发言，AI 摘要无法替代。请换一场有逐字稿的会议。',
      { kind: 'no_transcript' },
    );
  }
  const note = larkJson(['note', '+detail', '--note-id', noteId, '--as', 'user', '--format', 'json']);
  const docToken = note?.data?.note?.verbatim_doc_token;
  if (!docToken) {
    throw new LarkError(
      `${topic} 只有 AI 智能纪要，没有逐字稿文档。\n`
      + '  团队动力分析需要原始发言，无法继续。',
      { kind: 'no_verbatim_doc' },
    );
  }
  const doc = larkJson(['docs', '+fetch', '--doc', docToken, '--as', 'user']);
  const html = doc?.data?.document?.content;
  if (!html) throw new LarkError(`${topic} 的逐字稿文档为空。`, { kind: 'empty_doc' });
  return htmlToTranscript(html);
}

function pickTranscript(out) {
  const d = out?.data;
  if (!d) return null;
  for (const k of ['transcript', 'content', 'text']) {
    if (typeof d[k] === 'string' && d[k].trim()) return d[k].trim();
  }
  return null;
}

/**
 * 飞书逐字稿 HTML → 引擎可解析的纯文本。
 * 目标格式：`姓名 MM:SS 发言`（引擎的 matchSpeakerLine 认这个）
 * 已知形态：
 *   <cite type="user" user-name="方春剑"></cite> 00:00:09<br/>发言
 *   @Lyra Wang 00:00:12<br/>发言
 *   说话人 1 用 @Lyra Wang 的设备 00:01:24<br/>嗯。
 */
export function htmlToTranscript(html) {
  let s = String(html);
  s = s.replace(/<title>[\s\S]*?<\/title>/g, '');   // 文档标题会粘到第一条发言上，必须先剥掉
  s = s.replace(/<blockquote>[\s\S]*?<\/blockquote>/g, '');
  s = s.replace(/<cite[^>]*user-name="([^"]*)"[^>]*><\/cite>/g, '$1');
  s = s.replace(/<br\s*\/?>/g, '\n');       // 必须早于去标签，否则发言会粘在时间戳上
  s = s.replace(/<\/p>/g, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
  const turns = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(.{1,60}?)\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)$/);
    if (m) { if (cur) turns.push(cur); cur = { sp: m[1].replace(/^@/, '').trim(), ts: m[2], tx: [] }; continue; }
    if (cur && /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(line)) { cur.ts = line; continue; }
    if (cur) cur.tx.push(line);
  }
  if (cur) turns.push(cur);

  const kept = turns.filter((t) => t.tx.length);
  if (!kept.length) {
    throw new LarkError('逐字稿解析后没有任何发言，文档格式可能变了。请把原始文档反馈给维护者。',
      { kind: 'transcript_parse_failed' });
  }
  return kept
    .map((t) => `${t.sp.replace(/\s*用\s*@?.*的设备\s*/, '（设备）')} ${t.ts} ${t.tx.join(' ')}`)
    .join('\n');
}

/** 找和自己单聊的会话 ID（推送给自己的最稳方式；用 --user-id 发给自己会被飞书拒绝） */
export function findSelfChatId() {
  const res = larkJson(['im', '+chat-list', '--types', 'p2p', '--as', 'user', '--format', 'json']);
  const chats = res?.data?.chats || [];
  const self = chats.find((c) => c.p2p_target_type === 'user' && String(c.p2p_target_id || '').startsWith('ou_'));
  return self?.chat_id || null;
}

/**
 * 飞书侧的就绪检查（只读、不联网之外的副作用）。
 *
 * 之所以单独抽出来：GUI 宿主不继承 shell 的 PATH，
 * lark-cli 很可能不在宿主进程的 PATH 里——这会让所有飞书工具静默失效。
 * 因此体检必须显式覆盖这一项。
 */
export function larkReadiness() {
  const problems = [];
  let version = '';
  try {
    version = execFileSync(LARK, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: SPAWN_ENV }).trim();
  } catch {
    problems.push(
      `找不到 lark-cli（当前按 "${LARK}" 查找）。\n`
      + '  下一步：npm install -g @larksuite/cli，'
      + '并在宿主配置里用 LARK_CLI 指向它的绝对路径（GUI 宿主不继承 shell 的 PATH）。',
    );
    return { ready: false, problems, version: null, userName: null, scopes: '' };
  }

  let userName = null; let scopes = '';
  try {
    const s = JSON.parse(execFileSync(LARK, ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: SPAWN_ENV }));
    const u = s?.identities?.user;
    if (u?.status === 'ready') { userName = u.userName || null; scopes = u.scope || ''; }
    else problems.push('飞书未授权。下一步：lark-cli auth login --recommend');
  } catch {
    problems.push('读取飞书授权状态失败。下一步：lark-cli auth login --recommend');
  }

  if (userName) {
    if (!scopes.includes('vc:meeting.search:read')) problems.push('缺少会议搜索权限。下一步：lark-cli auth login --recommend');
    if (!scopes.includes('minutes:minutes:readonly') && !scopes.includes('minutes:minutes.basic:read')) {
      problems.push('缺少妙记读取权限。下一步：lark-cli auth login --recommend');
    }
  }
  return { ready: problems.length === 0, problems, version, userName, scopes };
}


/**
 * 发飞书消息。idempotencyKey 由调用方固定，重试不会产生重复消息。
 */
export function sendMessage({ chatId, userId, markdown, idempotencyKey }) {
  if (!chatId && !userId) throw new LarkError('发送消息需要 chatId 或 userId。', { kind: 'bad_target' });
  const target = chatId ? ['--chat-id', chatId] : ['--user-id', userId];
  const args = ['im', '+messages-send', ...target, '--markdown', markdown, '--as', 'user', '--format', 'json'];
  if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey).slice(0, 50));
  const res = larkJson(args);
  if (res?.ok === false) {
    throw new LarkError(`消息发送失败：${res.error?.message || '未知错误'}`, { kind: 'send_failed' });
  }
  return { messageId: res?.data?.message_id || null };
}
