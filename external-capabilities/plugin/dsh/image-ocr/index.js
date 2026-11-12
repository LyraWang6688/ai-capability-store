/**
 * Host half of the image-ocr bundle.
 *
 * One read-only route: OCR an image and hand the client plain text.
 *
 * The OCR engine itself is NOT part of this package. It lives in
 * `@lyra_wang/image-ocr-cli`, a separate npm package that also installs the
 * `image-ocr` command. Two reasons:
 *
 *   1. one source of truth — the DSH button and any outside caller (a
 *      system-wide hotkey, a script) run the same engine instead of a copy;
 *   2. the engine's compile cache is keyed by the source hash and owned by that
 *      package, so an upgrade cannot leave one caller running a stale binary.
 *
 * This file only wires the engine to the DSH web server (auth, body limits,
 * temp file, JSON shape).
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEngine, runOcr } from '@lyra_wang/image-ocr-cli';

export const inject = ['webServer'];

const OCR_PATH = '/plugins/image-ocr/ocr';

function sendJson(res, status, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 16 * 1024 * 1024) {
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

export function apply(ctx) {
  // Warm the engine at startup: the first click then does not pay the compile.
  ensureEngine().catch((error) => {
    ctx.logger?.warn?.('image-ocr: engine warmup failed: ' + (error instanceof Error ? error.message : String(error)));
  });

  const ocrHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const rejection = connectionRejection(ctx, req);
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, message: '未通过 DSH 连接鉴权（本地 token 无效）' });
      return;
    }
    let tempPath;
    try {
      const body = await readJsonBody(req);
      try {
        await ensureEngine();
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const image = typeof body.image === 'string' ? body.image : '';
      if (image !== '') {
        const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length === 0) throw new Error('图片数据为空');
        if (buffer.length > 12 * 1024 * 1024) throw new Error('图片太大（上限 12MB）');
        tempPath = join(tmpdir(), 'dsh-image-ocr-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.png');
        writeFileSync(tempPath, buffer);
      }
      // No image in the body = OCR the clipboard, same as the panel's
      // 「直接读剪贴板」 button.
      const text = await runOcr({ imagePath: tempPath });
      sendJson(res, 200, { ok: true, text, lines: text === '' ? 0 : text.split('\n').length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.('image-ocr: ocr failed: ' + message);
      sendJson(res, 500, { ok: false, message });
    } finally {
      if (tempPath) {
        try { unlinkSync(tempPath); } catch { /* 忽略清理失败 */ }
      }
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OCR_PATH,
    handler: ocrHandler,
  }));
}
