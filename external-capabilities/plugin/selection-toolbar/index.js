import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    };
  } catch (error) {
    return {
      path,
      docToken: '',
      larkCli: 'lark-cli',
      rewriteModel: 'deepseek-flash',
      rewriteBaseUrl: 'https://api.deepseek.com',
      keychainService: 'DEEPSEEK_API_KEY',
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
  if (text === '' || note === '') throw new Error('text and note are required');
  const quoted = text
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
  return `${quoted}\n\n**注释：** ${note}\n\n时间：${formatStamp(input.at)}\n\n---\n\n`;
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

/** Append one selection note to the Feishu document. */
export function apply(ctx) {
  const handler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'method not allowed' });
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
}
