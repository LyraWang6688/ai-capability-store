#!/usr/bin/env node
/**
 * MCP 服务器（stdio）—— 产品主入口。
 *
 * 宿主（豆包工作 / WorkBuddy）通过它调用本机能力：预检文章包、创建公众号草稿、体检。
 *
 * ★ stdio 模式下 stdout 是 JSON-RPC 通道。任何写入 stdout 的内容都会破坏协议握手，
 *   表现为「连接器显示已连接但一个工具都没有」或直接断连。
 *   本文件在**第一行**就把 console.log 重定向到 stderr 作为兜底防线，
 *   因为宿主不一定会给用户看子进程的 stderr。
 *
 * 边界：只创建草稿。不发布、不群发、不删除、不改账号设置。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── 防线 1：任何 console.log 都改走 stderr，绝不污染 JSON-RPC 通道 ───────────────
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};

process.on("uncaughtException", (error) => {
  process.stderr.write(`[connector] uncaught: ${error?.message ?? error}\n`);
  process.exit(1);
});

const { inspectArticleBundle, publishArticleBundle, summarizeBundle, updateArticleBundle, deleteDraftById, deleteMaterialById, deletePublishedById } = await import("./publish.js");
const { createWechatApi, readCredentialsFromEnv } = await import("./wechatApi.js");

const server = new McpServer({
  name: "wechat-draft-mcp",
  // 必须与 package.json 的 version 一致（tests/mcpStdio.test.ts 里有断言守着）。
  version: "0.3.0"
});

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[connector] tool error: ${message}\n`);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, message }) }] };
}

const BUNDLE_PATH = z
  .string()
  .min(1)
  .describe("文章文件夹的绝对路径。正文与图片从磁盘读取，不要把 HTML 内容放到参数里。");

server.registerTool(
  "wechat_draft_status",
  {
    title: "检查公众号连接",
    description:
      "检查本机是否已配置公众号凭证、出口 IP 是否在白名单、草稿箱接口是否可用。只读，不产生任何微信数据，也不会返回密钥。上传失败时先用它排查环境问题。",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async () => {
    try {
      const credentials = readCredentialsFromEnv();
      const api = createWechatApi({ credentials });
      const access = await api.checkAccess();
      const draftCount = await api.draftCount();
      return text({
        ok: true,
        message: "公众号连接正常",
        expiresInSeconds: access.expires_in,
        draftCount,
        appIdMasked: credentials.appId ? `${credentials.appId.slice(0, 6)}****` : null
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "inspect_wechat_article",
  {
    title: "预检文章包",
    description:
      "在上传之前检查文章文件夹：能否找到正文与封面、标题作者摘要是什么、正文长度是否超限、有哪些图片、有没有阻塞问题。完全不调用微信、不产生任何数据。用户说「先看看这篇能不能传」时用它。",
    inputSchema: { bundle_path: BUNDLE_PATH },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ bundle_path }) => {
    try {
      return text(await inspectArticleBundle(bundle_path));
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "upload_wechat_draft",
  {
    title: "上传到公众号草稿箱",
    description:
      "把磁盘上的文章创建为微信公众号草稿（只创建草稿，不发布、不群发）。" +
      "仅在用户明确要求上传、发布到草稿箱、或说「把这个传上去」时调用；用户只是让你写文章时不要调用。" +
      "同一篇文章重复调用会返回既有草稿，不会重复创建。",
    inputSchema: {
      bundle_path: BUNDLE_PATH,
      need_open_comment: z.boolean().optional().describe("是否开启留言，默认否"),
      only_fans_can_comment: z.boolean().optional().describe("是否仅粉丝可留言，默认否")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ bundle_path, need_open_comment, only_fans_can_comment }) => {
    try {
      const result = await publishArticleBundle({
        bundlePath: bundle_path,
        needOpenComment: need_open_comment,
        onlyFansCanComment: only_fans_can_comment
      });
      return text({
        ok: true,
        message: result.message,
        draftMediaId: result.mediaId,
        title: result.title,
        author: result.author ?? null,
        reused: result.reused,
        verified: result.verified,
        content: result.content,
        uploadedBodyImages: result.images.uploaded.length,
        skippedRemoteImages: result.images.skippedRemote.length,
        warnings: result.warnings
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "get_wechat_draft",
  {
    title: "按 ID 读回草稿",
    description:
      "根据草稿 media_id 从公众号读回草稿内容，用于确认某次上传是否真的成功了。当上传返回「结果未知」或用户要求核对草稿时用它。只读。",
    inputSchema: { media_id: z.string().min(1).max(512).describe("上传返回的草稿 media_id") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async ({ media_id }) => {
    try {
      const api = createWechatApi({ credentials: readCredentialsFromEnv() });
      const draft = await api.getDraft(media_id);
      const item = (draft as { news_item?: Array<{ title?: string; author?: string; digest?: string }> }).news_item?.[0];
      return text({
        ok: true,
        title: item?.title ?? null,
        author: item?.author ?? null,
        digest: item?.digest ?? null
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "update_wechat_draft",
  {
    title: "更新已有草稿（原地覆盖正文）",
    description:
      "把磁盘上的文章**更新到已存在的草稿**里，不新建草稿。除正文外一律保留线上字段：标题、作者、摘要、封面及其裁切、评论设置。" +
      "执行前会自动把当前线上正文备份到本机；执行后读回核验。用户说「改一下草稿」「把最新的排版同步进草稿」时用它。" +
      "默认只换正文；要连标题/摘要一起覆盖用 with_meta，要换封面用 with_cover。指定 dry_run 可先演练（不改线上）。",
    inputSchema: {
      media_id: z.string().min(1).max(512).describe("要更新的草稿 media_id（草稿箱素材链接里可找到）"),
      bundle_path: BUNDLE_PATH,
      with_meta: z.boolean().optional().describe("是否用本地文章的标题/作者/摘要覆盖线上（默认否，只换正文）"),
      with_cover: z.boolean().optional().describe("是否用本地封面替换线上封面（默认否，保留线上封面与裁切）"),
      dry_run: z.boolean().optional().describe("只演练：读回+备份+算结果，不调用 draft/update")
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  async ({ media_id, bundle_path, with_meta, with_cover, dry_run }) => {
    try {
      const result = await updateArticleBundle({
        mediaId: media_id,
        bundlePath: bundle_path,
        withMeta: with_meta,
        withCover: with_cover,
        dryRun: dry_run
      });
      return text({
        ok: true,
        message: result.message,
        mediaId: result.mediaId,
        title: result.title,
        dryRun: result.dryRun,
        verified: result.verified,
        preserved: result.preserved,
        content: result.content,
        uploadedBodyImages: result.images.uploaded.length,
        backupPath: result.backupPath,
        warnings: result.warnings
      });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "delete_wechat_draft",
  {
    title: "删除草稿（不可逆）",
    description:
      "按 media_id 删除一条微信公众号草稿。**不可逆**：微信不提供恢复，因此本工具要求 ① 宿主机显式设置 WECHAT_ALLOW_DESTRUCTIVE=1 ② confirm 必须等于 media_id 的后 6 位。" +
      "删除前会自动把草稿正文备份到本机（state/backups/），并把本次操作写入审计日志。用户明确要求「删掉那条草稿」时才调用。",
    inputSchema: {
      media_id: z.string().min(1).max(512).describe("要删除的草稿 media_id"),
      confirm: z.string().min(1).describe("二次确认：填 media_id 的后 6 位"),
      dry_run: z.boolean().optional().describe("只演练：读回+备份，但不删除")
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  async ({ media_id, confirm, dry_run }) => {
    try {
      const result = await deleteDraftById({ targetId: media_id, confirm, dryRun: dry_run });
      return text({ ...result });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "delete_wechat_material",
  {
    title: "删除永久素材（如封面图，不可逆）",
    description:
      "按 media_id 删除公众号永久素材。素材可能被其他草稿/已发布文章引用，删掉后那些内容的封面会显示异常。" +
      "同样要求 WECHAT_ALLOW_DESTRUCTIVE=1 与 confirm（素材 ID 后 6 位），并会记录审计。" +
      "注意：素材内容无法通过接口读回，本地备份只记录素材 ID 与时间。仅在用户明确要求时调用。",
    inputSchema: {
      media_id: z.string().min(1).max(512).describe("要删除的永久素材 media_id"),
      confirm: z.string().min(1).describe("二次确认：填素材 media_id 的后 6 位"),
      dry_run: z.boolean().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  async ({ media_id, confirm, dry_run }) => {
    try {
      const result = await deleteMaterialById({ targetId: media_id, confirm, dryRun: dry_run });
      return text({ ...result });
    } catch (error) {
      return failure(error);
    }
  }
);

server.registerTool(
  "delete_wechat_published",
  {
    title: "删除已发布文章（最高危 · 动线上内容）",
    description:
      "删除一篇**已发布**的公众号文章。这是本项目里风险最高的操作：影响读者可见的线上内容，且不可逆。" +
      "三重门槛：① 宿主设置 WECHAT_ALLOW_DESTRUCTIVE=1 ② confirm = article_id 的后 6 位 ③ i_understand_published_deletion 必须显式传 true。" +
      "执行前会读回该文章全文并备份到本机。只有在用户明确、重复确认要下线某篇已发布文章时才调用。",
    inputSchema: {
      article_id: z.string().min(1).max(512).describe("已发布文章的 article_id（freepublish 返回的 ID）"),
      confirm: z.string().min(1).describe("二次确认：填 article_id 的后 6 位"),
      index: z.number().int().min(0).max(20).optional().describe("多图文时删第几篇，默认 0"),
      i_understand_published_deletion: z
        .literal(true)
        .describe("必须显式传 true，表示确认要删除线上已发布内容"),
      dry_run: z.boolean().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  async ({ article_id, confirm, index, i_understand_published_deletion, dry_run }) => {
    try {
      if (i_understand_published_deletion !== true) {
        return failure(
          new Error(
            "删除已发布文章需要显式确认：请在参数里传 i_understand_published_deletion=true，并确认你了解这会下线线上内容且不可逆。"
          )
        );
      }
      const result = await deletePublishedById({ targetId: article_id, confirm, index, dryRun: dry_run });
      return text({ ...result });
    } catch (error) {
      return failure(error);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`${JSON.stringify({ event: "connector_started", pid: process.pid })}\n`);
