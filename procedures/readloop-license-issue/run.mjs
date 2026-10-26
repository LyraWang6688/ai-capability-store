#!/usr/bin/env node
/**
 * 本地入口：调用 ReadLoop 服务仓库的 scripts/license-gen.ts 生成授权码。
 *
 * 用法：
 *   LICENSE_SECRET=... node run.mjs [count]
 *   LICENSE_SECRET=... node run.mjs --count 10 [--repo <路径>] [--keep]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_URL = "https://github.com/LyraWang6688/readloop.git";
const ENTRY = "scripts/license-gen.ts";

function parseArgs(argv) {
  const opts = { repo: null, count: 10, keep: false, selfTest: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") opts.repo = path.resolve(argv[++i] ?? "");
    else if (arg === "--count") opts.count = Number(argv[++i]);
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 0) opts.count = Number(positional[0]);
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 1000) {
    throw new Error("数量必须是 1–1000 的整数");
  }
  return opts;
}

function resolveRepo(opts) {
  if (opts.repo) {
    if (!existsSync(path.join(opts.repo, ENTRY))) {
      throw new Error(`不是 ReadLoop 服务仓库（缺少 ${ENTRY}）：${opts.repo}`);
    }
    return { dir: opts.repo, temp: false };
  }
  const dir = mkdtempSync(path.join(tmpdir(), "readloop-license-"));
  console.log(`==> clone ${REPO_URL} → ${dir}`);
  execFileSync("git", ["clone", "--depth", "1", REPO_URL, dir], { stdio: "inherit" });
  return { dir, temp: true };
}

function selfTest() {
  if (parseArgs(["5"]).count !== 5) throw new Error("self-test: 位置参数解析错误");
  if (parseArgs(["--count", "7"]).count !== 7) throw new Error("self-test: --count 解析错误");
  let rejected = false;
  try {
    parseArgs(["--count", "0"]);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("self-test: 非法数量未被拒绝");
  console.log("✅ self-test: 参数与数量校验通过");
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    selfTest();
  } else {
    if (!process.env.LICENSE_SECRET) throw new Error("缺少 LICENSE_SECRET 环境变量");
    const { dir, temp } = resolveRepo(opts);
    try {
      execFileSync(
        "npx",
        ["--yes", "tsx@4", ENTRY, String(opts.count)],
        { cwd: dir, stdio: "inherit", env: process.env }
      );
    } finally {
      if (temp && !opts.keep) rmSync(dir, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
