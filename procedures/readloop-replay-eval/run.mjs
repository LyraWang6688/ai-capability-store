#!/usr/bin/env node
/**
 * 本地入口：clone/复用 ReadLoop 服务仓库，跑 scripts/replay-compare.ts。
 *
 * 用法：
 *   node run.mjs [--repo <路径>] [--keep] [--self-test] [-- <传给 replay-compare 的参数>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_URL = "https://github.com/LyraWang6688/readloop.git";
const ENTRY = "scripts/replay-compare.ts";

function parseArgs(argv) {
  const opts = { repo: null, keep: false, selfTest: false, passthrough: [] };
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  if (sep !== -1) opts.passthrough = argv.slice(sep + 1);
  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (arg === "--repo") opts.repo = path.resolve(head[++i] ?? "");
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg.startsWith("--")) opts.passthrough.push(arg);
    else throw new Error(`未知参数：${arg}`);
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
  const dir = mkdtempSync(path.join(tmpdir(), "readloop-eval-"));
  console.log(`==> clone ${REPO_URL} → ${dir}`);
  execFileSync("git", ["clone", "--depth", "1", REPO_URL, dir], { stdio: "inherit" });
  return { dir, temp: true };
}

function selfTest() {
  const opts = parseArgs(["--repo", "/tmp/x", "--", "--days", "30"]);
  if (opts.repo !== "/tmp/x") throw new Error("self-test: --repo 解析错误");
  if (opts.passthrough.join(",") !== "--days,30") throw new Error("self-test: 透传参数解析错误");
  if (!REPO_URL.startsWith("https://")) throw new Error("self-test: repo URL 必须是 https");
  console.log("✅ self-test: 参数解析通过");
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    selfTest();
  } else {
    const { dir, temp } = resolveRepo(opts);
    try {
      execFileSync("npx", ["--yes", "tsx@4", ENTRY, ...opts.passthrough], {
        cwd: dir,
        stdio: "inherit",
        env: process.env,
      });
    } finally {
      if (temp && !opts.keep) rmSync(dir, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
