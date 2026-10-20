/**
 * 路径沙箱。
 *
 * 模型可以给出任意字符串当路径，必须假设它是敌意的：
 * 相对路径、`..` 穿越、指向包外的 symlink、凭证/系统目录都要挡住。
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  PathNotAllowedError,
  allowedRoots,
  assertSafeInputPath,
  resolveInsideBundle,
  resolveSafePath
} from "../src/security.js";
import { makeTempDir, symlinkInside, writeBundle, type TempDir } from "./helpers/fixtures.js";

function codeOf(error: unknown): string {
  assert.ok(error instanceof PathNotAllowedError, `期望 PathNotAllowedError，实际 ${String(error)}`);
  return (error as PathNotAllowedError).code;
}

async function expectReject(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return codeOf(error);
  }
  throw new Error("期望被拒绝，但调用成功了");
}

describe("security：顶层路径", () => {
  let temp: TempDir;
  before(async () => {
    temp = await makeTempDir("wdmcp-security-");
  });
  after(async () => {
    await temp.cleanup();
  });

  test("相对路径一律拒绝", async () => {
    assert.throws(() => assertSafeInputPath("articles/foo"), (error: unknown) => codeOf(error) === "PATH_NOT_ABSOLUTE");
    assert.equal(await expectReject(() => resolveSafePath("./relative/dir")), "PATH_NOT_ABSOLUTE");
    assert.throws(() => assertSafeInputPath(""), (error: unknown) => codeOf(error) === "PATH_INVALID");
  });

  test("含 NUL 字节的路径拒绝", () => {
    assert.throws(() => assertSafeInputPath("/tmp/a\u0000b"), (error: unknown) => codeOf(error) === "PATH_INVALID");
  });

  test("不存在的路径报 PATH_NOT_FOUND", async () => {
    assert.equal(await expectReject(() => resolveSafePath(path.join(temp.path, "不存在"))), "PATH_NOT_FOUND");
  });

  test("敏感目录黑名单：/etc 即使真实存在也拒绝", async () => {
    assert.equal(await expectReject(() => resolveSafePath("/etc")), "PATH_FORBIDDEN");
    assert.equal(await expectReject(() => resolveSafePath("/etc/hosts")), "PATH_FORBIDDEN");

  });

  test("HOME 下的 .ssh 等凭证目录拒绝", async () => {
    const fakeHome = path.join(temp.path, "fake-home");
    const sshDir = path.join(fakeHome, ".ssh");
    await mkdir(sshDir, { recursive: true });
    await writeFile(path.join(sshDir, "id_rsa"), "PRIVATE KEY");

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      assert.equal(await expectReject(() => resolveSafePath(sshDir)), "PATH_FORBIDDEN");
      assert.equal(await expectReject(() => resolveSafePath(path.join(sshDir, "id_rsa"))), "PATH_FORBIDDEN");

      // 黑名单补全之前，这些都能被读进来。
      for (const name of [".npmrc", ".env", ".netrc"]) {
        const credential = path.join(fakeHome, name);
        await writeFile(credential, "SECRET");
        assert.equal(await expectReject(() => resolveSafePath(credential)), "PATH_FORBIDDEN");
      }
      // .env 不只在家目录：项目目录里的也算 —— 所以按 basename 判，不按位置判。
      const projectDir = path.join(fakeHome, "project");
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, ".env.production"), "SECRET");
      assert.equal(
        await expectReject(() => resolveSafePath(path.join(projectDir, ".env.production"))),
        "PATH_FORBIDDEN"
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test("WECHAT_DRAFT_ALLOWED_ROOTS：包内放行、包外拒绝、前缀相似不误判", async () => {
    const root = await temp.sub("allowed-root");
    const inside = await temp.sub("allowed-root/inside");
    const sibling = await temp.sub("allowed-root-sibling");
    await writeBundle(inside, { title: "允许" });
    await writeBundle(sibling, { title: "不在根内" });

    const env = { WECHAT_DRAFT_ALLOWED_ROOTS: root } as NodeJS.ProcessEnv;
    assert.deepEqual(allowedRoots(env), [root]);
    assert.equal(await resolveSafePath(inside, env), inside);
    assert.equal(await expectReject(() => resolveSafePath(sibling, env)), "PATH_NOT_ALLOWED");
    assert.equal(await expectReject(() => resolveSafePath(temp.path, env)), "PATH_NOT_ALLOWED");
  });

  test("symlink 指向允许根之外的目录会被 realpath 校验拦住", async () => {
    const root = await temp.sub("symlink-root");
    const outside = await temp.sub("symlink-outside");
    await writeBundle(outside, { title: "包外文章" });
    const link = path.join(temp.path, "escape-link");
    await symlink(outside, link);

    const env = { WECHAT_DRAFT_ALLOWED_ROOTS: root } as NodeJS.ProcessEnv;
    assert.equal(await expectReject(() => resolveSafePath(link, env)), "PATH_NOT_ALLOWED");
  });
});

describe("security：文章包内的相对引用", () => {
  let temp: TempDir;
  before(async () => {
    temp = await makeTempDir("wdmcp-security-bundle-");
  });
  after(async () => {
    await temp.cleanup();
  });

  test("包内正常引用放行", async () => {
    const dir = await temp.sub("bundle");
    await writeBundle(dir, { title: "正常" });
    assert.equal(await resolveInsideBundle(dir, "images/fig1.png"), path.join(dir, "images", "fig1.png"));
  });

  test("绝对路径引用拒绝", async () => {
    const dir = await temp.sub("absolute-ref");
    await writeBundle(dir, { title: "绝对引用" });
    assert.equal(await expectReject(() => resolveInsideBundle(dir, "/etc/hosts")), "REFERENCE_ABSOLUTE");
  });

  test("`..` 穿越拒绝", async () => {
    const dir = await temp.sub("traversal");
    await writeBundle(dir, { title: "穿越" });
    assert.equal(await expectReject(() => resolveInsideBundle(dir, "../outside.png")), "REFERENCE_ESCAPE");
    assert.equal(await expectReject(() => resolveInsideBundle(dir, "images/../../outside.png")), "REFERENCE_ESCAPE");
  });

  test("包内指向包外的 symlink 引用拒绝（读文件逃逸）", async () => {
    const dir = await temp.sub("symlink-escape");
    const secretDir = await temp.sub("secret");
    const secretFile = path.join(secretDir, "id_rsa");
    await writeFile(secretFile, "TOP SECRET");
    await writeBundle(dir, { title: "symlink 逃逸", images: { "images/fig1.png": Buffer.from("ok") } });
    await symlinkInside(dir, "images/leak.png", secretFile);

    assert.equal(await expectReject(() => resolveInsideBundle(dir, "images/leak.png")), "REFERENCE_ESCAPE");
  });

  test("包内 symlink 指向包内文件仍然放行", async () => {
    const dir = await temp.sub("symlink-inside");
    await writeBundle(dir, { title: "内部链接", images: { "images/fig1.png": Buffer.from("ok") } });
    await symlinkInside(dir, "images/alias.png", path.join(dir, "images", "fig1.png"));

    assert.equal(await resolveInsideBundle(dir, "images/alias.png"), path.join(dir, "images", "alias.png"));
  });
});

describe("security：白名单细节", () => {
  let temp: TempDir;
  before(async () => {
    temp = await makeTempDir("wdmcp-roots-");
  });
  after(async () => {
    await temp.cleanup();
  });

  test("多个根目录（逗号 + 空格 + 尾部斜杠）都能放行", async () => {
    const rootA = await temp.sub("multi-a");
    const rootB = await temp.sub("multi-b");
    await writeBundle(rootA, { title: "A" });
    await writeBundle(rootB, { title: "B" });

    const env = { WECHAT_DRAFT_ALLOWED_ROOTS: `${rootA}/, ${rootB}` } as NodeJS.ProcessEnv;
    assert.deepEqual(allowedRoots(env), [rootA, rootB], "尾部斜杠与空格都要归一化");
    assert.equal(await resolveSafePath(rootB, env), rootB);
    assert.equal(await resolveSafePath(path.join(rootB, "article.html"), env), path.join(rootB, "article.html"));
  });

  test("白名单为空字符串等于不限制根目录", async () => {
    const dir = await temp.sub("empty-roots");
    await writeBundle(dir, { title: "不限根" });

    assert.deepEqual(allowedRoots({ WECHAT_DRAFT_ALLOWED_ROOTS: "  " } as NodeJS.ProcessEnv), []);
    assert.equal(await resolveSafePath(dir, { WECHAT_DRAFT_ALLOWED_ROOTS: "" } as NodeJS.ProcessEnv), dir);
  });

  test("根目录本身（不是子目录）也放行，且不会把兄弟目录误判进来", async () => {
    const root = await temp.sub("self-root");
    const sibling = await temp.sub("self-root-x");
    await writeBundle(root, { title: "根" });
    await writeBundle(sibling, { title: "兄弟" });

    const env = { WECHAT_DRAFT_ALLOWED_ROOTS: root } as NodeJS.ProcessEnv;
    assert.equal(await resolveSafePath(root, env), root);
    assert.equal(await expectReject(() => resolveSafePath(sibling, env)), "PATH_NOT_ALLOWED");
  });
});
