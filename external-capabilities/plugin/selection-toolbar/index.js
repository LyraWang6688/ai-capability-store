import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Host half of the selection toolbar bundle.
 *
 * Registers one same-origin route the client calls when the user saves a
 * selection note. The route appends a Markdown block to the operator's Feishu
 * document through the already-authenticated `lark-cli`.
 *
 * The target document token and the CLI path are NOT stored in this package:
 * they live in `~/.dsh/selection-toolbar.json` (outside the repository), so the
 * code can be published without leaking an operator's private doc identity.
 */
const ROUTE_PATH = '/plugins/selection-toolbar/note';
const REWRITE_PATH = '/plugins/selection-toolbar/rewrite';
const DELIVER_PATH = '/plugins/selection-toolbar/deliver';
const DEFAULT_CONFIG_PATH = join(homedir(), '.dsh', 'selection-toolbar.json');

/** Read the operator config from outside the repository on every write. */
function loadOperatorConfig() {
  const path = process.env.DSH_SELECTION_TOOLBAR_CONFIG || DEFAULT_CONFIG_PATH;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return {
      path,
      docToken: typeof data.docToken === 'string' ? data.docToken.trim() : '',
      larkCli: typeof data.larkCli === 'string' && data.larkCli.trim() !== ''
        ? data.larkCli.trim()
        : 'lark-cli',
      rewriteModel: typeof data.rewriteModel === 'string' && data.rewriteModel.trim() !== ''
        ? data.rewriteModel.trim()
        : 'deepseek-flash',
      rewriteBaseUrl: typeof data.rewriteBaseUrl === 'string' && data.rewriteBaseUrl.trim() !== ''
        ? data.rewriteBaseUrl.trim().replace(/\/+$/, '')
        : 'https://api.deepseek.com',
      keychainService: typeof data.keychainService === 'string' && data.keychainService.trim() !== ''
        ? data.keychainService.trim()
        : 'DEEPSEEK_API_KEY',
      baseToken: typeof data.baseToken === 'string' ? data.baseToken.trim() : '',
      tableId: typeof data.tableId === 'string' ? data.tableId.trim() : '',
      skillDir: typeof data.skillDir === 'string' && data.skillDir.trim() !== ''
        ? data.skillDir.trim()
        : join(homedir(), 'Documents', 'workplace', 'ai-capability-store', 'skills', 'context-submit'),
      defaultProject: typeof data.defaultProject === 'string' && data.defaultProject.trim() !== ''
        ? data.defaultProject.trim()
        : 'DSH 选区投递',
    };
  } catch (error) {
    return {
      path,
      docToken: '',
      larkCli: 'lark-cli',
      rewriteModel: 'deepseek-flash',
      rewriteBaseUrl: 'https://api.deepseek.com',
      keychainService: 'DEEPSEEK_API_KEY',
      baseToken: '',
      tableId: '',
      skillDir: join(homedir(), 'Documents', 'workplace', 'ai-capability-store', 'skills', 'context-submit'),
      defaultProject: 'DSH 选区投递',
    };
  }
}

export const inject = ['webServer', 'subprocess'];

/** Read a JSON request body with a size cap. */
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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Format one instant as plain Beijing time (no markup Lark could re-parse). */
function formatStamp(value) {
  const at = typeof value === 'string' && value !== '' ? new Date(value) : new Date();
  if (Number.isNaN(at.getTime())) return new Date().toISOString();
  try {
    return at.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch (error) {
    return at.toISOString();
  }
}

/** Format one note as the Markdown block appended to the document. */
function formatNote(input) {
  const text = String(input.text ?? '').trim().replace(/\r\n/g, '\n');
  const note = String(input.note ?? '').trim();
  if (text === '') throw new Error('text is required');
  const quoted = text
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
  const noteLine = note === '' ? '' : `\n\n**注释：** ${note}`;
  return `${quoted}${noteLine}\n\n时间：${formatStamp(input.at)}\n\n---\n\n`;
}

/** Run `lark-cli docs +update --command append` with the given Markdown. */
async function appendToDoc(ctx, markdown, config) {
  const handle = ctx.subprocess.spawn({
    argv: [
      config.larkCli,
      'docs',
      '+update',
      '--doc',
      config.docToken,
      '--command',
      'append',
      '--doc-format',
      'markdown',
      '--content',
      '-',
    ],
    cwd: process.env.HOME || '/tmp',
    stdio: {
      stdin: { data: markdown },
      stdout: { maxBytes: 256 * 1024 },
      stderr: { maxBytes: 256 * 1024 },
    },
    graceMs: 90_000,
  });

  const outcome = await handle.done;
  const read = (reader) => {
    if (reader === undefined) return '';
    try {
      return reader.readFrom(0).text;
    } catch (error) {
      return '';
    }
  };
  const stdout = read(handle.collected.stdout);
  const stderr = read(handle.collected.stderr);
  if (outcome.exitCode !== 0) {
    const detail = (stderr || stdout).trim().slice(0, 500) || `exit code ${String(outcome.exitCode)}`;
    throw new Error(detail);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    parsed = undefined;
  }
  if (parsed !== undefined && parsed.ok === false) {
    const message = parsed.error && parsed.error.message ? parsed.error.message : 'lark-cli reported a failure';
    throw new Error(message);
  }
  return { revisionId: parsed && parsed.data ? parsed.data.revision_id : undefined };
}

/** Reuse the Host's browser authentication for this plugin's own routes. */
function connectionRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || typeof connection.requestRejection !== 'function') return undefined;
  try {
    return connection.requestRejection({ headers: req.headers });
  } catch (error) {
    return undefined;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/** Read the model API key from the environment or the OS keychain (never stored here). */
function readApiKey(config) {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  try {
    const value = execFileSync('/usr/bin/security', [
      'find-generic-password', '-a', process.env.USER || '', '-s', config.keychainService, '-w',
    ], { encoding: 'utf8' });
    const trimmed = String(value).trim();
    return trimmed !== '' ? trimmed : '';
  } catch (error) {
    return '';
  }
}

/** Rewrite one selected passage with the configured model. */
export async function rewriteText(config, text, instruction) {
  const apiKey = readApiKey(config);
  if (apiKey === '') {
    throw new Error(`未找到模型 API Key：请设置 DEEPSEEK_API_KEY 环境变量，或把 key 存进钥匙串（-s ${config.keychainService}）`);
  }
  const system = '你是中文文字编辑。只输出改写后的文字本身：不要解释、不要加引号、不要标注"改写后"。';
  const ask = instruction === ''
    ? '请润色下面这段文字，保持原意，让表达更通顺自然。\n\n原文：\n' + text
    : '改写要求：' + instruction + '\n\n原文：\n' + text;
  const response = await fetch(config.rewriteBaseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: config.rewriteModel,
      temperature: 0.6,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: ask },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload && payload.error && payload.error.message ? payload.error.message : 'HTTP ' + response.status;
    throw new Error('模型调用失败：' + detail);
  }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  const result = typeof content === 'string' ? content.trim() : '';
  if (result === '') throw new Error('模型没有返回内容');
  return result;
}


/** Run one child process and collect its output. */
async function runProcess(ctx, argv, stdinData = '', timeoutMs = 90_000) {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: process.env.HOME || '/tmp',
    stdio: {
      stdin: { data: stdinData },
      stdout: { maxBytes: 512 * 1024 },
      stderr: { maxBytes: 512 * 1024 },
    },
    graceMs: timeoutMs,
  });
  const outcome = await handle.done;
  const read = (reader) => {
    if (reader === undefined) return '';
    try {
      return reader.readFrom(0).text;
    } catch (error) {
      return '';
    }
  };
  return {
    exitCode: outcome.exitCode,
    stdout: read(handle.collected.stdout),
    stderr: read(handle.collected.stderr),
  };
}

/** One model call that must return a single JSON object. */
async function callModelJson(config, system, user) {
  const apiKey = readApiKey(config);
  if (apiKey === '') {
    throw new Error(`未找到模型 API Key：请设置 DEEPSEEK_API_KEY 环境变量，或把 key 存进钥匙串（-s ${config.keychainService}）`);
  }
  const response = await fetch(config.rewriteBaseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: config.rewriteModel,
      temperature: 0.2,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload && payload.error && payload.error.message ? payload.error.message : 'HTTP ' + response.status;
    throw new Error('模型调用失败：' + detail);
  }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  let raw = typeof content === 'string' ? content.trim() : '';
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

const DELIVER_SYSTEM = [
  '你是"投递箱"信息整理助手。把用户给的原文整理成一条结构化记录，严格只输出一个 JSON 对象，不要代码块、不要解释。',
  'JSON 字段：',
  '{"类型":"踩坑|经验|集成|偏好|事实|规则","内容":"...","来源项目":"..."}',
  '规则：',
  '1. 类型只能取上面六个之一；判断不了就用「经验」。',
  '2. 内容必须包含模板段，且总长度 80–2000 字：',
  '   - 技术类（踩坑/经验/集成）：观察/场景 + 现象 + 原因（不知道写「未定位」）+ 修法（没解决写「待解决」）',
  '   - 认知类（偏好/事实/规则）：观察/场景 + 原话（照抄原文，不得改写）+ 我的解读（明确标注这是解读）',
  '3. 来源项目：能从原文推断就填项目名；推断不了填空字符串。',
  '4. 不要输出「状态」「关联准则」，不要加解释文字。',
].join('\n');

/** Structure one selection into a compliant inbox entry via the model. */
async function structureEntry(config, text) {
  const entry = await callModelJson(config, DELIVER_SYSTEM, text);
  const type = typeof entry['类型'] === 'string' ? entry['类型'].trim() : '';
  const content = typeof entry['内容'] === 'string' ? entry['内容'].trim() : '';
  const project = typeof entry['来源项目'] === 'string' ? entry['来源项目'].trim() : '';
  if (type === '' || content === '') throw new Error('模型返回缺少「类型」或「内容」');
  return { type, content, project };
}

/** Run the skill's validator against one candidate entry file. */
async function validateEntryFile(ctx, config, entryPath) {
  const script = join(config.skillDir, 'scripts', 'validate_entry.py');
  const result = await runProcess(ctx, ['/usr/bin/python3', script, entryPath], '', 30_000);
  if (result.exitCode !== 0) {
    const detail = (result.stdout || result.stderr || '').trim().slice(0, 500);
    throw new Error('门禁未通过：' + (detail || `exit ${String(result.exitCode)}`));
  }
  return (result.stdout || '').trim();
}

/** Best-effort duplicate probe; never blocks the write. */
async function checkSimilarFile(ctx, config, entryPath) {
  try {
    const script = join(config.skillDir, 'scripts', 'check_similar.py');
    const result = await runProcess(ctx, ['/usr/bin/python3', script, entryPath], '', 45_000);
    return (result.stdout || '').trim().slice(0, 300);
  } catch (error) {
    return '';
  }
}

/** Write one structured entry into the inbox Base and return its record id. */
async function writeInboxRecord(ctx, config, entry, sourceProject, sourceSession) {
  const record = {
    '类型': [entry.type],
    '内容': entry.content,
    '来源项目': sourceProject !== '' ? sourceProject : (entry.project !== '' ? entry.project : config.defaultProject),
    '来源会话': sourceSession,
    '状态': ['待提炼'],
  };
  const payload = JSON.stringify({ create_records: [record] });
  const result = await runProcess(ctx, [
    config.larkCli,
    'base', '+record-batch-create',
    '--base-token', config.baseToken,
    '--table-id', config.tableId,
    '--json', payload,
    '--as', 'user',
  ], '', 90_000);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    parsed = undefined;
  }
  if (result.exitCode !== 0 || (parsed && parsed.ok === false)) {
    const detail = parsed && parsed.error && parsed.error.message
      ? parsed.error.message
      : ((result.stderr || result.stdout || '').trim().slice(0, 400) || `exit ${String(result.exitCode)}`);
    throw new Error('写入投递箱失败：' + detail);
  }
  const ids = parsed && parsed.data ? (parsed.data.record_id_list || parsed.data.record_ids) : undefined;
  return { recordId: Array.isArray(ids) && ids.length > 0 ? ids[0] : '', type: entry.type };
}

/** Append one selection note to the Feishu document. */
export function apply(ctx) {
  const handler = async (req, res) => {
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
      const markdown = formatNote(body);
      const config = loadOperatorConfig();
      if (config.docToken === '') {
        throw new Error(
          `未配置飞书文档：请在 ${config.path} 写入 {"docToken":"<文档 token>"}（可选 larkCli 指定 CLI 路径）`,
        );
      }
      const result = await appendToDoc(ctx, markdown, config);
      sendJson(res, 200, { ok: true, revisionId: result.revisionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`selection-toolbar: Feishu append failed: ${message}`);
      sendJson(res, 500, { ok: false, message });
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler,
  }));

  const rewriteHandler = async (req, res) => {
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
      const text = String(body.text ?? '').trim();
      const instruction = String(body.instruction ?? '').trim();
      if (text === '') throw new Error('text is required');
      if (text.length > 12000) throw new Error('选中的文字太长（上限 12000 字符）');
      const config = loadOperatorConfig();
      const result = await rewriteText(config, text, instruction);
      sendJson(res, 200, { ok: true, text: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`selection-toolbar: rewrite failed: ${message}`);
      sendJson(res, 500, { ok: false, message });
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REWRITE_PATH,
    handler: rewriteHandler,
  }));

  const deliverHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const rejection = connectionRejection(ctx, req);
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, message: '未通过 DSH 连接鉴权（本地 token 无效）' });
      return;
    }
    let entryPath = '';
    try {
      const body = await readJsonBody(req);
      const text = String(body.text ?? '').trim();
      if (text === '') throw new Error('text is required');
      if (text.length > 12000) throw new Error('选中的文字太长（上限 12000 字符）');
      const config = loadOperatorConfig();
      if (config.baseToken === '' || config.tableId === '') {
        throw new Error(`未配置投递箱：请在 ${config.path} 写入 {"baseToken":"<base token>","tableId":"<table id>"}`);
      }
      const entry = await structureEntry(config, text);
      // 门禁要求「来源项目/来源会话」至少填一个；UI 只传正文，所以这里兜底到配置的默认项目。
      const sourceProject = String(body.sourceProject ?? '').trim();
      const sourceSession = String(body.sourceSession ?? '').trim();
      const resolvedProject = sourceProject || entry.project || config.defaultProject;
      entryPath = join(tmpdir(), `selection-deliver-${Date.now()}-${process.pid}.json`);
      writeFileSync(entryPath, JSON.stringify({
        '类型': entry.type,
        '内容': entry.content,
        '来源项目': resolvedProject,
        '来源会话': sourceSession,
        '状态': '待提炼',
      }, null, 2));
      const gate = await validateEntryFile(ctx, config, entryPath);
      const similar = await checkSimilarFile(ctx, config, entryPath);
      const written = await writeInboxRecord(ctx, config, entry, resolvedProject, sourceSession);
      sendJson(res, 200, { ok: true, recordId: written.recordId, type: written.type, gate, similar });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`selection-toolbar: deliver failed: ${message}`);
      sendJson(res, 500, { ok: false, message });
    } finally {
      if (entryPath !== '') {
        try { unlinkSync(entryPath); } catch (error) { /* ignore */ }
      }
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DELIVER_PATH,
    handler: deliverHandler,
  }));
}
