/**
 * Host half of the screenshot bundle.
 *
 * One route: run macOS `screencapture` and hand the client the raw PNG bytes.
 *
 * Why the host and not the browser: a page cannot open the system capture UI.
 * `screencapture` is a normal CLI in the same GUI session as the Host, so a
 * region/window selection appears on top of everything and returns when the
 * operator finishes (Esc cancels).
 *
 * `-i` = interactive (crosshair; Space toggles window-picking mode),
 * `-x` = no shutter sound, `-t png` = explicit format.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inject = ['webServer'];

const CAPTURE_PATH = '/plugins/screenshot/capture';
const CAPTURE_TIMEOUT_MS = 180_000;

let capturing = false;

function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(payload));
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

/**
 * Run screencapture into a temp file.
 * @param mode - "region" for the interactive crosshair, "full" for a silent
 *   whole-screen capture (kept for self-tests and headless verification).
 * @returns PNG bytes, or null when the operator cancelled.
 */
function capturePng(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-screenshot-'));
  const file = join(dir, 'capture.png');
  const args = mode === 'full' ? ['-x', '-t', 'png', file] : ['-i', '-x', '-t', 'png', file];
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/screencapture', args, { timeout: CAPTURE_TIMEOUT_MS }, (error) => {
      try {
        const buffer = readFileSync(file);
        resolve(buffer.length > 0 ? buffer : null);
      } catch {
        // No file: the operator pressed Esc, or the tool refused to capture.
        if (error && error.killed !== true && error.code !== 0 && error.code !== 1) {
          reject(new Error(String(error.message || error)));
          return;
        }
        resolve(null);
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  });
}

async function handleCapture(ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: 'method not allowed' });
    return;
  }
  const rejection = connectionRejection(ctx, req);
  if (rejection !== undefined) {
    sendJson(res, rejection, { ok: false, message: '未通过 DSH 连接鉴权（本地 token 无效）' });
    return;
  }
  if (capturing) {
    sendJson(res, 409, { ok: false, message: '已有一次截图正在进行' });
    return;
  }
  capturing = true;
  try {
    const body = await readJsonBody(req);
    const mode = body && body.mode === 'full' ? 'full' : 'region';
    const png = await capturePng(mode);
    if (png === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'no-store',
    });
    res.end(png);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.('screenshot: capture failed: ' + message);
    sendJson(res, 500, { ok: false, message });
  } finally {
    capturing = false;
  }
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
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CAPTURE_PATH,
    handler: (req, res) => {
      handleCapture(ctx, req, res).catch((error) => {
        ctx.logger?.warn?.('screenshot: unhandled: ' + String(error));
        try { sendJson(res, 500, { ok: false, message: String(error) }); } catch { /* already sent */ }
      });
    },
  }));
}
