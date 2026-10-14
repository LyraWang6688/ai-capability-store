#!/usr/bin/env node
/**
 * 把 src/engine-src 里的分析引擎编译到 dist/engine/
 *
 * 引擎源码是从 teaming-bot vendored 过来的（见 HANDOFF.md 的同步约定），
 * 本脚本只负责编译，不改源码。加 --build-only 时跳过"来源检查"。
 *
 * 用法：
 *   node scripts/sync-engine.mjs              # 编译
 *   node scripts/sync-engine.mjs --build-only # 同上（保留参数以便区分语义）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src', 'engine-src');
const OUT = join(ROOT, 'dist', 'engine');

function findTsc() {
  const candidates = [
    process.env.TSC,
    join(ROOT, 'node_modules', '.bin', 'tsc'),
    join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  // 退路：从 PATH 找
  try {
    execFileSync('tsc', ['--version'], { stdio: 'ignore' });
    return 'tsc';
  } catch { return null; }
}

const tsc = findTsc();
if (!tsc) {
  process.stderr.write(
    '\n找不到 TypeScript 编译器。\n'
    + '  下一步：npm install（会把 typescript 装成 devDependency）\n'
    + '  或显式指定：TSC=/path/to/tsc node scripts/sync-engine.mjs\n',
  );
  process.exit(1);
}

if (!existsSync(join(SRC, 'lib', 'analysis', 'engine.ts'))) {
  process.stderr.write(`\n找不到引擎源码：${join(SRC, 'lib', 'analysis', 'engine.ts')}\n`);
  process.exit(1);
}

// @types/node：项目自带的，或同级的其他项目里的
const typeRoots = [
  join(ROOT, 'node_modules', '@types'),
  join(ROOT, '..', 'wechat-draft-mcp', 'node_modules', '@types'),
].filter((p) => existsSync(p));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const tsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',           // 引擎产出 CJS，运行时用 createRequire 加载
    moduleResolution: 'node',
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    outDir: OUT,
    rootDir: SRC,
    baseUrl: ROOT,
    paths: { '@/*': ['./src/engine-src/*'] },
    noEmit: false,
    declaration: false,
    types: ['node'],
    ...(typeRoots.length ? { typeRoots } : {}),
  },
  include: [`${SRC}/**/*.ts`],
};

const cfgPath = join(OUT, 'tsconfig.build.json');
writeFileSync(cfgPath, JSON.stringify(tsconfig, null, 2));

process.stderr.write(`用 ${tsc} 编译分析引擎…\n`);
try {
  execFileSync(tsc, ['-p', cfgPath], { stdio: ['ignore', 'inherit', 'inherit'] });
} catch {
  process.stderr.write('\n编译失败，请检查上面的 TypeScript 报错。\n');
  process.exit(1);
}

const produced = join(OUT, 'lib', 'analysis', 'engine.js');
if (!existsSync(produced)) {
  process.stderr.write(`\n未找到产物：${produced}\n`);
  process.exit(1);
}

function countJs(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countJs(join(dir, e.name));
    else if (e.name.endsWith('.js')) n += 1;
  }
  return n;
}
process.stderr.write(`\n构建完成：${produced}（共 ${countJs(OUT)} 个 js 文件）\n`);

// 本项目 package.json 是 "type": "module"，会让 dist/engine 下的 .js 被当作 ESM，
// 而引擎是 tsc 编出来的 CommonJS。加一个作用域内的 package.json 把它标回 CJS。
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
process.stderr.write('已写入 dist/engine/package.json（声明 commonjs 作用域）\n');
