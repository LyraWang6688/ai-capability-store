/**
 * Host half of the image-ocr bundle.
 *
 * One read-only route: OCR the clipboard image with a locally-compiled Swift
 * helper (macOS Vision framework, offline), then hand the client plain text.
 * Compilation happens once on first use and is cached outside the package.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const inject = ['webServer'];

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, 'ocr.swift');
const CACHE_DIR = join(homedir(), 'Library', 'Application Support', 'dsh-image-ocr');
const BINARY = join(CACHE_DIR, 'ocr');
const OCR_PATH = '/plugins/image-ocr/ocr';

let enginePromise;

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

function compileEngine() {
  return new Promise((resolve, reject) => {
    mkdirSync(CACHE_DIR, { recursive: true });
    execFile('/usr/bin/xcrun', ['swiftc', '-O', '-o', BINARY, SOURCE], {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error('OCR 引擎编译失败：' + String(stderr || error.message).slice(0, 400)));
        return;
      }
      resolve(BINARY);
    });
  });
}

function ensureEngine() {
  if (existsSync(BINARY)) return Promise.resolve(BINARY);
  if (!enginePromise) {
    enginePromise = compileEngine().catch((error) => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

function runOcr(binary, imagePath) {
  return new Promise((resolve, reject) => {
    execFile(binary, imagePath ? [imagePath] : ['--clipboard'], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error('OCR 执行失败：' + String(stderr || error.message).slice(0, 300)));
        return;
      }
      resolve(String(stdout || '').replace(/\s+$/g, ''));
    });
  });
}

export function apply(ctx) {
  // 首次启动后台预热：用户第一次点按钮时通常已编译完成。
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
      let binary;
      try {
        binary = await ensureEngine();
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
        tempPath = join(os.tmpdir(), 'dsh-image-ocr-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.png');
        writeFileSync(tempPath, buffer);
      }
      const text = await runOcr(binary, tempPath);
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
