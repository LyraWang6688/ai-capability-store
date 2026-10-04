/**
 * MCP stdio 入口。
 *
 * 最要命的一条：stdio 模式下 stdout 就是 JSON-RPC 通道。
 * 任何一行日志写进 stdout，宿主看到的都是「已连接但没有任何工具」——
 * 所以这里逐行断言 stdout 全是合法 JSON-RPC。
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { StdioMcpClient, assertStdoutPristine, nodeEnv, srcFile } from "./helpers/spawnNode.js";
import { makeTempDir, writeBundle, type TempDir } from "./helpers/fixtures.js";

const SERVER = srcFile("mcpServer.js");
const TOOL_NAMES = [
  "delete_wechat_draft",
  "delete_wechat_material",
  "delete_wechat_published",
  "get_wechat_draft",
  "inspect_wechat_article",
  "update_wechat_draft",
  "upload_wechat_draft",
  "wechat_draft_status"
].sort();
const PACKAGE_VERSION = (
  JSON.parse(
    await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
  ) as { version: string }
).version;

async function startClient(extraEnv: Record<string, string | undefined> = {}): Promise<StdioMcpClient> {
  const client = new StdioMcpClient([SERVER], nodeEnv(extraEnv));
  const initialized = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "wdmcp-tests", version: "0.0.0" }
  });
  assert.equal(initialized.error, undefined, `initialize 失败：${JSON.stringify(initialized.error)}`);
  // 握手广播的版本必须与 package.json 一致，否则宿主看到的版本是错的
  const serverInfo = (initialized.result as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo;
  assert.equal(serverInfo?.name, "wechat-draft-mcp");
  assert.equal(serverInfo?.version, PACKAGE_VERSION, "握手版本与 package.json 不一致");
  client.notify("notifications/initialized");
  return client;
}

describe("mcpServer：stdio 协议", () => {
  let temp: TempDir;
  before(async () => {
    temp = await makeTempDir("wdmcp-mcp-");
  });
  after(async () => {
    await temp.cleanup();
  });

  test("握手 + tools/list：暴露 8 个工具，stdout 全程纯净", async () => {
    const client = await startClient();
    try {
      const response = await client.request("tools/list");
      const tools = (response.result as { tools: Array<{ name: string; description: string }> }).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
      for (const tool of tools) assert.ok(tool.description.length > 10, `${tool.name} 缺少给模型看的描述`);

      assertStdoutPristine(client);
      assert.match(client.stderr, /connector_started/, "启动标记应写在 stderr");
      assert.equal(client.stderr.includes("secret"), false);
    } finally {
      await client.close();
    }
  });

  test("inspect_wechat_article：正常文章包返回结构化预检结果", async () => {
    const dir = await temp.sub("mcp-inspect-ok");
    await writeBundle(dir, { title: "MCP 预检标题", author: "老王", digest: "摘要" });
    const client = await startClient({ WECHAT_DRAFT_STATE_DIR: await temp.sub("state-mcp-inspect") });
    try {
      const result = await client.callTool("inspect_wechat_article", { bundle_path: dir });
      assert.equal(result.isError, undefined);
      const payload = JSON.parse(result.text) as { ready: boolean; title: string; bodyImages: string[]; blockingIssues: string[] };
      assert.equal(payload.ready, true);
      assert.equal(payload.title, "MCP 预检标题");
      assert.deepEqual(payload.bodyImages, ["images/fig1.png"]);
      assert.deepEqual(payload.blockingIssues, []);
      assertStdoutPristine(client);
    } finally {
      await client.close();
    }
  });

  test("inspect 失败：返回 isError + 人话，不泄露路径细节，stdout 依然纯净", async () => {
    const client = await startClient();
    try {
      const missing = await client.callTool("inspect_wechat_article", { bundle_path: "/definitely/not/here" });
      assert.equal(missing.isError, true);
      const payload = JSON.parse(missing.text) as { ok: boolean; message: string };
      assert.equal(payload.ok, false);
      assert.match(payload.message, /找不到该路径/);

      const relative = await client.callTool("inspect_wechat_article", { bundle_path: "relative/path" });
      assert.equal(relative.isError, true);
      assert.match(JSON.parse(relative.text).message, /绝对路径/);

      assert.match(client.stderr, /tool error/);
      assertStdoutPristine(client);
    } finally {
      await client.close();
    }
  });

  test("参数校验失败被包成 isError（协议层不写 stdout 日志）", async () => {
    const client = await startClient();
    try {
      const response = await client.request("tools/call", { name: "inspect_wechat_article", arguments: { bundle_path: "" } });
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> } | undefined;
      assert.equal(result?.isError, true);
      assert.match(result!.content[0]!.text, /validation error/i);
      assertStdoutPristine(client);
    } finally {
      await client.close();
    }
  });

  test("wechat_draft_status：没配凭证时明确报错且不碰网络", async () => {
    const client = await startClient();
    try {
      const result = await client.callTool("wechat_draft_status", {});
      assert.equal(result.isError, true);
      assert.match(JSON.parse(result.text).message, /缺少公众号凭证/);
      assertStdoutPristine(client);
    } finally {
      await client.close();
    }
  });

  test("upload_wechat_draft：缺凭证时既不建草稿也不写账本", async () => {
    const dir = await temp.sub("mcp-upload-nocreds");
    await writeBundle(dir, { title: "无凭证上传", author: "A" });
    const stateDir = await temp.sub("state-mcp-upload");
    const client = await startClient({ WECHAT_DRAFT_STATE_DIR: stateDir });
    try {
      const result = await client.callTool("upload_wechat_draft", { bundle_path: dir });
      assert.equal(result.isError, true);
      assert.match(JSON.parse(result.text).message, /缺少公众号凭证/);
      assert.deepEqual(await readdir(stateDir), [], "失败时不能留下账本文件");
      assertStdoutPristine(client);
    } finally {
      await client.close();
    }
  });
});

describe("mcpServer：只读工具无凭证时", () => {
  test("get_wechat_draft 报缺凭证，不碰网络、不写 stdout 日志", async () => {
    const client = await startClient();
    try {
      const result = await client.callTool("get_wechat_draft", { media_id: "MOCK_ID" });
      assert.equal(result.isError, true);
      assert.match(JSON.parse(result.text).message, /缺少公众号凭证/);
      assertStdoutPristine(client);
    } finally {
      await client.close();
    }
  });
});
