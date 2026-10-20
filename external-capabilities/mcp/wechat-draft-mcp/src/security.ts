/**
 * 路径安全沙箱。
 *
 * 连接器运行在用户的 Mac 上，模型可以给出任意字符串当路径。必须假设路径是敌意的：
 *   - 只接受绝对路径，拒绝 `..` 穿越
 *   - 用 realpath 解析后再校验，因此指向外部的符号链接无法逃逸
 *   - 前缀比较按路径分段，避免 `/a/b` 与 `/a/bc` 这类前缀相似误判
 *   - 默认拒绝敏感目录（凭证、SSH、系统配置）
 *
 * 未设置 WECHAT_DRAFT_ALLOWED_ROOTS 时不限制根目录，但仍然禁止敏感目录与穿越。
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

/** 即使用户放开了根目录限制，这些目录也永远不读。 */
const FORBIDDEN_PREFIXES = [
  "/etc",
  // macOS 上 /etc 是指向 /private/etc 的符号链接，而校验发生在 realpath 之后，
  // 所以私有路径必须单独列出，否则 /etc/hosts 会绕过黑名单。
  "/private/etc",
  "/var/root",
  "/private/var/root",
  "/System",
  "/Library/Keychains"
];

const FORBIDDEN_HOME_ENTRIES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".codebuddy",
  ".workbuddy",
  // Credential stores that were missing from the first list. The allowlist
  // (WECHAT_DRAFT_ALLOWED_ROOTS) is the real answer, but it is opt-in — so when it is
  // unset this list is the *only* boundary, and a boundary made of an incomplete list is
  // not a boundary. Everything below is a known credential location, not a guess.
  ".npmrc", // npm publish tokens — this repository has published packages
  ".netrc", // machine auth
  ".docker", // registry credentials
  ".kube", // cluster credentials
  ".dsh", // DSH model credentials
  ".env",
  ".env.local",
  ".config/gh", // gh auth
  ".config/gcloud",
  "Library/Keychains",
  "Library/Application Support/lark-cli"
];

/**
 * 文件名级黑名单 —— 与位置无关。
 *
 * `.env` 不会只出现在家目录：任何一个项目目录下的 `.env.` 变体都藏着凭据。
 * 按 basename 判，才不会因为「它不在 $HOME 里」而放过。
 */
const FORBIDDEN_BASENAMES = [/^\.env(\..+)?$/, /^\.netrc$/, /^\.npmrc$/, /^id_(rsa|ed25519|ecdsa|dsa)$/, /^\.p12$/, /^\.pfx$/];

export class PathNotAllowedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PathNotAllowedError";
    this.code = code;
  }
}

export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.WECHAT_DRAFT_ALLOWED_ROOTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

export function assertSafeInputPath(input: string) {
  if (!input || typeof input !== "string") {
    throw new PathNotAllowedError("PATH_INVALID", "缺少文章包路径。");
  }
  if (!path.isAbsolute(input)) {
    throw new PathNotAllowedError("PATH_NOT_ABSOLUTE", "文章包路径必须是绝对路径。");
  }
  if (input.includes("\0")) {
    throw new PathNotAllowedError("PATH_INVALID", "路径包含非法字符。");
  }
}

/** 解析为真实路径后再做全部校验，阻断 symlink 逃逸。 */
export async function resolveSafePath(input: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  assertSafeInputPath(input);
  let resolved: string;
  try {
    resolved = await realpath(input);
  } catch {
    throw new PathNotAllowedError("PATH_NOT_FOUND", "找不到该路径，请确认文件或目录存在。");
  }

  const home = env.HOME || process.env.HOME || "";
  const denied = [
    ...FORBIDDEN_PREFIXES,
    ...FORBIDDEN_HOME_ENTRIES.map((entry) => (home ? path.join(home, entry) : ""))
  ].filter(Boolean);

  // 文件名级检查：`.env` 之类的凭据在任何目录里都是凭据。
  const base = path.basename(resolved);
  if (FORBIDDEN_BASENAMES.some((pattern) => pattern.test(base))) {
    throw new PathNotAllowedError("PATH_FORBIDDEN", "出于安全考虑，不允许读取该文件。");
  }

  for (const prefix of denied) {
    if (isInside(resolved, prefix)) {
      throw new PathNotAllowedError("PATH_FORBIDDEN", "出于安全考虑，不允许读取该目录。");
    }
  }

  const roots = allowedRoots(env);
  if (roots.length > 0 && !roots.some((root) => isInside(resolved, root))) {
    throw new PathNotAllowedError(
      "PATH_NOT_ALLOWED",
      "该路径不在允许的文章目录内。如需放开，请把目录加到 WECHAT_DRAFT_ALLOWED_ROOTS。"
    );
  }

  return resolved;
}

/** 按分段比较，避免 /a/b 与 /a/bc 这类前缀误判。 */
function isInside(target: string, prefix: string): boolean {
  if (target === prefix) return true;
  const base = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
  return target.startsWith(base);
}

/**
 * 解析文章包内的相对引用（如 HTML 里的 `images/fig1.png`、assets.json 里的 `assets/cover.jpg`）。
 * 相对引用必须落在文章包目录内。
 *
 * 先做词法比较，再对存在的文件做 realpath 复核：
 * 只做词法比较的话，包内一个指向 `~/.ssh/id_rsa` 的符号链接就能把包外文件读进来。
 */
export async function resolveInsideBundle(bundleDir: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) {
    throw new PathNotAllowedError("REFERENCE_ABSOLUTE", "文章包内的图片引用不能是绝对路径。");
  }
  const candidate = path.resolve(bundleDir, relative);
  if (!isInside(candidate, bundleDir)) {
    throw new PathNotAllowedError("REFERENCE_ESCAPE", "文章包内的图片引用不能指向包外。");
  }
  try {
    const real = await realpath(candidate);
    if (!isInside(real, await realpath(bundleDir))) {
      throw new PathNotAllowedError("REFERENCE_ESCAPE", "文章包内的图片引用不能指向包外。");
    }
  } catch (error) {
    if (error instanceof PathNotAllowedError) throw error;
    // 文件不存在等情况交给调用方按「图片缺失」处理，保持原有提示语义。
  }
  return candidate;
}
