#!/usr/bin/env node
/**
 * 打包 ReadLoop Chrome 扩展：校验 manifest → 生成 zip → 校验包内容/版本。
 *
 * 用法：
 *   node pack.mjs [--source <插件目录>] [--out <输出目录>]
 *   node pack.mjs --self-test
 *
 * 纯 Node 内置模块 + 系统 zip/unzip；无第三方依赖。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = path.resolve(HERE, "../../external-capabilities/plugin/chrome/readloop-extension");
const REQUIRED = [
  "manifest.json",
  "src/background.js",
  "src/content-script.js",
  "src/sidepanel/index.html",
  "src/sidepanel/main.js",
  "src/sidepanel/styles.css",
  "src/lib/api.js",
  "src/lib/feishu.js",
  "src/lib/storage.js",
  "assets/icons/icon-128.png",
];
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function parseArgs(argv) {
  const args = { selfTest: false, source: DEFAULT_SOURCE, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") args.selfTest = true;
    else if (arg === "--source") args.source = path.resolve(argv[++i] ?? "");
    else if (arg === "--out") args.out = path.resolve(argv[++i] ?? "");
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function readManifest(source) {
  const manifestPath = path.join(source, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`缺少 manifest.json：${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) throw new Error("manifest_version 必须是 3");
  if (typeof manifest.name !== "string" || !manifest.name) throw new Error("manifest.name 缺失");
  if (!VERSION_RE.test(String(manifest.version))) throw new Error(`manifest 版本不是 X.Y.Z：${manifest.version}`);
  return manifest;
}

function checkRequired(source) {
  const missing = REQUIRED.filter((rel) => !existsSync(path.join(source, rel)));
  if (missing.length > 0) throw new Error(`缺少运行时文件：${missing.join(", ")}`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function pack(source, out) {
  const manifest = readManifest(source);
  checkRequired(source);
  mkdirSync(out, { recursive: true });
  const zipPath = path.join(out, `readloop-extension-${manifest.version}.zip`);

  execFileSync(
    "zip",
    ["-qrX", zipPath, ".", "-x", "tools/*", "-x", "*.DS_Store", "-x", "__MACOSX/*"],
    { cwd: source, stdio: "inherit" }
  );

  const packedVersion = execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" });
  if (JSON.parse(packedVersion).version !== manifest.version) {
    throw new Error("包内 manifest 版本与源版本不一致");
  }
  const listed = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
  for (const rel of REQUIRED) {
    if (!listed.includes(rel)) throw new Error(`包内缺少 ${rel}`);
  }
  if (/\btools\//.test(listed)) throw new Error("包内混进了 tools/");

  const size = statSync(zipPath).size;
  console.log(`✅ ${zipPath}`);
  console.log(`   version=${manifest.version} size=${size} bytes sha256=${sha256(zipPath)}`);
  return zipPath;
}

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "readloop-pack-"));
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "ReadLoop Test", version: "0.3.2", permissions: ["storage"],
  }));
  const manifest = readManifest(dir);
  if (manifest.version !== "0.3.2") throw new Error("self-test: version 解析错误");
  console.log("✅ self-test: manifest 校验通过");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) selfTest();
  else pack(args.source, args.out ?? path.resolve(process.cwd(), "dist"));
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
