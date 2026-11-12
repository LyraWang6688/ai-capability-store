/**
 * Local OCR engine (macOS Vision), shared by the `image-ocr` CLI and the DSH
 * `image-ocr` plugin.
 *
 * The Swift source ships inside this package. The first call compiles it with
 * `xcrun swiftc` into a cache keyed by the source hash, so:
 *   - an upgrade cannot silently keep using a stale binary (new source → new
 *     path), and
 *   - consumers never need to know where the binary lives.
 *
 * No network, no credentials: the image never leaves the machine.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, 'ocr.swift');
const CACHE_ROOT = join(homedir(), 'Library', 'Caches', 'lyra-wang-image-ocr');

let enginePromise;

/** Directory the compiled engine is cached in (also where `--engine-path` points). */
export function engineCacheDir() {
  return CACHE_ROOT;
}

/** Absolute path of the compiled engine for the Swift source currently shipped. */
export function resolveEnginePath() {
  const hash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex').slice(0, 12);
  return join(CACHE_ROOT, `ocr-${hash}`);
}

/**
 * Compile the engine on first use and return its path.
 * Concurrent callers share one compile.
 */
export function ensureEngine() {
  const binary = resolveEnginePath();
  if (existsSync(binary)) return Promise.resolve(binary);
  if (!enginePromise) {
    enginePromise = compile(binary).catch((error) => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

function compile(binary) {
  return new Promise((resolve, reject) => {
    // Keep every artifact of the compile under our own cache: the default
    // clang module cache lives in the shared temp dir, which can be
    // unwritable for sandboxed / managed environments.
    const moduleCache = join(CACHE_ROOT, 'modulecache');
    const tmp = join(CACHE_ROOT, 'tmp');
    mkdirSync(moduleCache, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    execFile('/usr/bin/xcrun', ['swiftc', '-module-cache-path', moduleCache, '-O', '-o', binary, SOURCE], {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TMPDIR: tmp },
    }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error('OCR 引擎编译失败：' + String(stderr || error.message).slice(0, 400)));
        return;
      }
      resolve(binary);
    });
  });
}

/**
 * Recognize text and return it as one string (lines joined with `\n`).
 *
 * @param {{ imagePath?: string }} options `imagePath` = a PNG/JPEG on disk;
 *        omit it to read the image currently on the clipboard.
 * @returns {Promise<string>} recognized text, trailing whitespace trimmed
 */
export async function runOcr({ imagePath } = {}) {
  const binary = await ensureEngine();
  return new Promise((resolve, reject) => {
    execFile(binary, imagePath ? [imagePath] : ['--clipboard'], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error('OCR 执行失败：' + String(stderr || error.message).slice(0, 300)));
        return;
      }
      resolve(String(stdout || '').replace(/\s+$/, ''));
    });
  });
}
