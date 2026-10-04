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
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';   // 仅作为 /tmp 不可用时的兜底
import { dirname, join } from 'node:path';

const LARK = process.env.LARK_CLI || 'lark-cli';
const execFileAsync = promisify(execFile);

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
function spawnEnv() {
  const extra = [
    dirname(process.execPath),   // node 所在目录，保证 `#!/usr/bin/env node` 能找到
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const cur = (process.env.PATH || '').split(':').filter(Boolean);
  // 每次调用时读取：既覆盖宿主注入的环境变量，也便于测试替换
  return { ...process.env, PATH: [...new Set([...extra, ...cur])].join(':') };
}

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
      env: spawnEnv(),
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

/**
 * 批量取会议详情。
 *
 * 两个性能坑（都实测过）：
 * 1. 逐场调用是 N+1——15 场要 12 秒，必然撞宿主的 tools/call 总超时
 * 2. 即使一次传 15 个 ID，服务端**仍是逐场串行查**——实测 9.7 秒
 *
 * 所以这里切成小块**并发**跑：实测 15 场从 9.7 秒降到 2 秒级。
 * 并发上限保守取 4，避免触发限流。
 */
export async function meetingDetailsBatch(meetingIds, { chunkSize = 3, concurrency = 4 } = {}) {
  const ids = [...new Set(meetingIds.filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

  const result = new Map();
  for (let i = 0; i < chunks.length; i += concurrency) {
    const wave = chunks.slice(i, i + concurrency);
    const settled = await Promise.all(wave.map(async (chunk) => {
      const { stdout } = await execFileAsync(LARK, [
        'vc', '+detail', '--meeting-ids', chunk.join(','), '--as', 'user', '--format', 'json',
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: spawnEnv() });
      const text = String(stdout).trim();
      const start = text.indexOf('{');
      if (start < 0) throw new LarkError(`vc +detail 返回无法解析：${text.slice(0, 120)}`, { kind: 'lark_failed' });
      return JSON.parse(text.slice(start));
    }).map((pr) => pr.catch((e) => ({ __error: e }))));

    for (const res of settled) {
      if (res?.__error) throw res.__error;   // 让调用方决定是否降级，不静默吞
      for (const mt of res?.data?.meetings || []) {
        result.set(mt.meeting_id, {
          meetingId: mt.meeting_id,
          topic: mt.topic || '(无标题)',
          startTime: mt.start_time || '',
          noteId: mt.note_id || null,
          minuteToken: mt.minute_token || null,
          minuteDenied: /no permission/i.test(mt.hint || ''),
        });
      }
    }
  }
  return result;
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
export function fetchTranscript({ minuteToken, topic = '这场会' }) {
  if (!minuteToken) {
    throw new LarkError(
      `${topic} 没有妙记（未录制或未生成），无法做团队动力分析。\n`
      + '  团队动力分析只认妙记的文字转录稿——成员原始发言，'
      + '不可用 AI 摘要或其他产物替代。',
      { kind: 'no_minute' },
    );
  }
  try {
    return fetchMinuteTranscript(minuteToken);
  } catch (e) {
    throw new LarkError(
      `${topic} 的妙记转录稿取不到。\n`
      + `  · ${e.message.split('\n')[0]}\n`
      + '  团队动力分析只认妙记文字转录稿，不会退化成 AI 摘要。',
      { kind: 'minute_transcript_failed' },
    );
  }
}

/**
 * 从妙记导出逐字稿。
 *
 * 关键点（曾经写错导致妙记路径完全走不通）：
 * - flag 是 `--minute-tokens`（复数），不是 `--minute-token`
 * - 必须显式传 `--transcript`，否则只返回基本信息、不导出文字稿
 * - 文字稿落在 `--output-dir` 下的文件里，路径在返回的 artifacts.transcript_file
 * - 导出格式恰好就是引擎能直接解析的 `姓名 MM:SS.mmm` + 内容，**不需要转换**
 */
function fetchMinuteTranscript(minuteToken) {
  // lark-cli 的 --output-dir 只允许 cwd、/tmp、~/files。
  // macOS 的 os.tmpdir() 返回 /var/folders/...（不在允许列表里），所以显式用 /tmp。
  const base = existsSync('/tmp') ? '/tmp' : tmpdir();
  const dir = mkdtempSync(join(base, 'teaming-minute-'));
  try {
    const res = larkJson([
      'minutes', '+detail', '--minute-tokens', minuteToken,
      '--transcript', '--output-dir', dir,
      '--as', 'user', '--format', 'json',
    ]);
    const file = res?.data?.minutes?.[0]?.artifacts?.transcript_file;
    if (!file || !existsSync(file)) {
      throw new LarkError('妙记导出未返回逐字稿文件路径。', { kind: 'minute_no_file' });
    }
    const text = readFileSync(file, 'utf8').trim();
    if (!text) throw new LarkError('妙记导出的逐字稿为空。', { kind: 'minute_empty' });
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    version = execFileSync(LARK, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv() }).trim();
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
    const s = JSON.parse(execFileSync(LARK, ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv() }));
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
 * 创建飞书云文档，返回 { documentId, url }。
 * 用作「点击查看报告」的落点——本地链路没有报告网页，用飞书文档承载。
 */
export function createDoc({ title, markdown }) {
  const res = larkJson([
    'docs', '+create', '--title', title,
    '--doc-format', 'markdown', '--content', markdown,
    '--as', 'user', '--format', 'json',
  ]);
  const doc = res?.data?.document;
  if (!doc?.url) throw new LarkError('创建飞书文档未返回链接。', { kind: 'doc_create_failed' });
  return { documentId: doc.document_id || null, url: doc.url };
}

/**
 * 发飞书消息。idempotencyKey 由调用方固定，重试不会产生重复消息。
 *
 * 传 card（对象）则发**交互卡片**；传 markdown 则发纯文本。
 * 卡片是团队 bot 线上的形态，也是这里默认使用的形态。
 */
export function sendMessage({ chatId, userId, markdown, card, idempotencyKey }) {
  if (!chatId && !userId) throw new LarkError('发送消息需要 chatId 或 userId。', { kind: 'bad_target' });
  if (!card && !markdown) throw new LarkError('发送消息需要 card 或 markdown。', { kind: 'bad_payload' });

  const target = chatId ? ['--chat-id', chatId] : ['--user-id', userId];
  const args = ['im', '+messages-send', ...target, '--as', 'user', '--format', 'json'];
  if (card) args.push('--msg-type', 'interactive', '--content', JSON.stringify(card));
  else args.push('--markdown', markdown);
  if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey).slice(0, 50));

  const res = larkJson(args);
  if (res?.ok === false) {
    throw new LarkError(`消息发送失败：${res.error?.message || '未知错误'}`, { kind: 'send_failed' });
  }
  return { messageId: res?.data?.message_id || null };
}
