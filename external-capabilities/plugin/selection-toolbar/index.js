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
    };
  } catch (error) {
    return { path, docToken: '', larkCli: 'lark-cli' };
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
}
