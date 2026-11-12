#!/usr/bin/env node
/**
 * image-ocr — recognize text in an image with macOS Vision, offline.
 *
 * The same engine backs the DSH `image-ocr` plugin; this binary is the stable
 * entry point for scripts, hotkeys and anything else outside the Harness.
 */
import { readFileSync } from 'node:fs';
import { runOcr, ensureEngine, resolveEnginePath } from '../index.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const USAGE = `image-ocr ${VERSION} — 从图片里识别文字（macOS Vision，离线）

用法：
  image-ocr [图片路径]            识别指定图片（PNG / JPEG）
  image-ocr                       不给路径时，读剪贴板里的图片
  image-ocr --clipboard           同上，显式写法

选项：
  -c, --clipboard                 读剪贴板里的图片
      --json                      以 JSON 输出 {ok, text, lines}
      --engine-path               打印编译后的引擎路径（不识别）
  -v, --version                   打印版本
  -h, --help                      显示本帮助

退出码：0 成功 / 1 识别失败 / 2 用法错误 / 4 没有可识别的文字或图片

首次运行会用 xcrun swiftc 编译引擎（约 30–60 秒），之后按源码哈希缓存，
热启动约 0.5–1 秒。图片不出本机。`;

function fail(message, code) {
  process.stderr.write(`image-ocr: ${message}\n`);
  process.exit(code);
}

function parse(argv) {
  const options = { clipboard: false, json: false, enginePath: false, version: false, help: false, file: '' };
  for (const arg of argv) {
    if (arg === '--clipboard' || arg === '-c') options.clipboard = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--engine-path') options.enginePath = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) fail(`未知选项 ${arg}（-h 看用法）`, 2);
    else if (options.file === '') options.file = arg;
    else fail('只能给一个图片路径', 2);
  }
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (options.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (options.enginePath) {
    // Do not compile just to print the path.
    process.stdout.write(resolveEnginePath() + '\n');
    return 0;
  }
  if (options.file !== '' && options.clipboard) {
    fail('图片路径和 --clipboard 只能选一个', 2);
  }

  let text;
  try {
    if (options.file === '') await ensureEngine();
    text = await runOcr({ imagePath: options.file === '' ? undefined : options.file });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 引擎用退出码 2 表示「找不到图片」：剪贴板空 / 文件不是图片
    if (/找不到图片/.test(message)) fail('没有可识别的图片（剪贴板为空，或文件不是图片）', 4);
    fail(message, 1);
  }

  if (text === '') fail('没有识别到文字（图片可能是纯图 / 分辨率太低）', 4);

  const lines = text.split('\n').length;
  if (options.json) process.stdout.write(JSON.stringify({ ok: true, text, lines }) + '\n');
  else process.stdout.write(text + '\n');
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`image-ocr: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
