/**
 * CLI 外壳（doctor / inspect / upload）。
 *
 * 除了功能本身，这里锁死一条凭证不变量：连接器**不自动读 .env**，
 * 凭证只能由宿主注入环境变量。
 */
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTempDir, writeBundle, type TempDir } from "./helpers/fixtures.js";
import { nodeEnv, runNode, srcFile } from "./helpers/spawnNode.js";

const CLI = srcFile("cli.js");

describe("cli", () => {
  let temp: TempDir;
  before(async () => {
    temp = await makeTempDir("wdmcp-cli-");
  });
  after(async () => {
    await temp.cleanup();
  });

  test("inspect --json：输出机器可读结果，退出码 0", async () => {
    const dir = await temp.sub("inspect-ok");
    await writeBundle(dir, { title: "CLI 标题", author: "老王" });

    const result = await runNode([CLI, "inspect", dir, "--json"], { env: nodeEnv() });

    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout) as {
      ready: boolean;
      title: string;
      bundleHash: string;
      htmlFile: string;
      blockingIssues: string[];
    };
    assert.equal(payload.ready, true);
    assert.equal(payload.title, "CLI 标题");
    assert.equal(payload.htmlFile, "article.html");
    assert.deepEqual(payload.blockingIssues, []);
    assert.match(payload.bundleHash, /^[0-9a-f]{64}$/);
  });

  test("inspect 人类可读模式：显示指纹与阻塞问题，阻塞时退出码 1", async () => {
    const dir = await temp.sub("inspect-blocking");
    await writeBundle(dir, { title: "缺封面", cover: null, images: {} });

    const result = await runNode([CLI, "inspect", dir], { env: nodeEnv() });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /内容指纹/);
    assert.match(result.stdout, /阻塞问题/);
    assert.match(result.stdout, /缺少封面/);
  });

  test("路径不存在：退出码 1 + 人话错误，不抛栈", async () => {
    const result = await runNode([CLI, "inspect", path.join(temp.path, "不存在"), "--json"], { env: nodeEnv() });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; message: string };
    assert.equal(payload.ok, false);
    assert.match(payload.message, /找不到该路径/);
    assert.equal(result.stdout.includes("at "), false, "不应把堆栈吐给用户");
  });

  test("上限可由环境变量覆盖（WECHAT_CONTENT_MAX_CHARS）", async () => {
    const dir = await temp.sub("inspect-limit");
    await writeBundle(dir, { title: "短正文", bodyHtml: "<p>一句话正文，超过十个字符。</p>" });

    const result = await runNode([CLI, "inspect", dir, "--json"], {
      env: nodeEnv({ WECHAT_CONTENT_MAX_CHARS: "10" })
    });

    const payload = JSON.parse(result.stdout) as { ready: boolean; blockingIssues: string[] };
    assert.equal(payload.ready, false);
    assert.ok(payload.blockingIssues.some((issue) => issue.includes("上限 10")), JSON.stringify(payload.blockingIssues));
  });

  test("doctor：没有凭证时明确报错，不尝试网络", async () => {
    const result = await runNode([CLI, "doctor", "--json"], { env: nodeEnv() });

    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stdout).message, /缺少公众号凭证/);
  });

  test("doctor：绝不自动读取工作目录下的 .env", async () => {
    const cwd = await temp.sub("dotenv-cwd");
    await writeFile(
      path.join(cwd, ".env"),
      "WECHAT_APP_ID=wx_from_dotenv_file\nWECHAT_APP_SECRET=secret_from_dotenv_file\n",
      "utf8"
    );

    const result = await runNode([CLI, "doctor", "--json"], { env: nodeEnv(), cwd });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout) as { message: string };
    assert.match(payload.message, /缺少公众号凭证/, "凭证只能由宿主注入，不能从 .env 读");
    assert.equal(result.stdout.includes("wx_from_dotenv_file"), false);
  });

  test("upload：缺凭证时不落账本、不建草稿", async () => {
    const dir = await temp.sub("upload-nocreds");
    await writeBundle(dir, { title: "无凭证", author: "A" });
    const stateDir = await temp.sub("state-cli-upload");

    const result = await runNode([CLI, "upload", dir, "--json"], {
      env: nodeEnv({ WECHAT_DRAFT_STATE_DIR: stateDir })
    });

    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stdout).message, /缺少公众号凭证/);
    assert.deepEqual(await readdir(stateDir), []);
  });

  test("show：没有凭证时明确报错，不抛栈、不落盘", async () => {
    const result = await runNode([CLI, "show", "MOCK_DRAFT_ID"], { env: nodeEnv() });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; message: string };
    assert.equal(payload.ok, false);
    assert.match(payload.message, /缺少公众号凭证/);
    assert.equal(result.stderr.includes("\n    at "), false, "不应把栈打给用户");
  });

  test("未知命令：退出码 2 并打印用法", async () => {
    const result = await runNode([CLI, "not-a-command"], { env: nodeEnv() });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /用法/);
  });
});
