#!/usr/bin/env node
/**
 * 命令行入口 —— 诊断与手动执行。
 *
 * 产品主入口是 MCP（豆包工作 / WorkBuddy 调用）；CLI 的存在是为了：
 *   1. 用户自查（doctor）
 *   2. 上传前预检（inspect，完全不调用微信）
 *   3. 出问题时把「是我们的代码坏了还是宿主环境坏了」一次性分清
 *   4. 0.3.0 起：更新/删除这类破坏性操作，在 CLI 里做最直观的人工复核
 *
 * 用法：
 *   node dist/cli.js doctor
 *   node dist/cli.js inspect "<文章目录>"
 *   node dist/cli.js upload  "<文章目录>"
 *   node dist/cli.js update  "<文章目录>" --media-id <草稿ID> [--with-meta] [--with-cover] [--dry-run]
 *   node dist/cli.js delete-draft     <草稿ID>  --confirm <ID后6位> [--dry-run]
 *   node dist/cli.js delete-material  <素材ID>  --confirm <ID后6位> [--dry-run]
 *   node dist/cli.js delete-published <文章ID>  --confirm <ID后6位> --i-understand [--index 0] [--dry-run]
 *   node dist/cli.js audit [--limit 20]
 *
 * 破坏性命令要求宿主显式设置 WECHAT_ALLOW_DESTRUCTIVE=1；否则直接拒绝。
 */
import { readAudit } from "./destructive.js";
import {
  deleteDraftById,
  deleteMaterialById,
  deletePublishedById,
  inspectArticleBundle,
  publishArticleBundle,
  summarizeDraft,
  updateArticleBundle
} from "./publish.js";
import { createWechatApi, readCredentialsFromEnv } from "./wechatApi.js";

const [command, target, ...rest] = process.argv.slice(2);
const asJson = rest.includes("--json");
const flag = {
  has: (name: string) => rest.includes(`--${name}`),
  value: (name: string) => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? rest[index + 1] : undefined;
  }
};

async function main() {
  switch (command) {
    case "doctor":
      return doctor();
    case "inspect":
      return inspect(target);
    case "upload":
      return upload(target);
    case "update":
      return update(target);
    case "show":
      return show(target);
    case "delete-draft":
      return remove("draft", target);
    case "delete-material":
      return remove("material", target);
    case "delete-published":
      return remove("published", target);
    case "audit":
      return audit();
    default:
      printUsage();
      process.exit(2);
  }
}

async function doctor() {
  const credentials = readCredentialsFromEnv();
  const api = createWechatApi({ credentials });
  try {
    const access = await api.checkAccess();
    const count = await api.draftCount();
    output({ ok: true, expiresIn: access.expires_in, draftCount: count, message: "微信连接正常" });
  } catch (error) {
    output({ ok: false, message: messageOf(error) }, true);
  }
}

async function inspect(bundlePath?: string) {
  if (!bundlePath) {
    console.error("用法：inspect <文章目录绝对路径>");
    process.exit(2);
  }
  try {
    const result = await inspectArticleBundle(bundlePath);
    if (asJson) {
      output(result);
      return;
    }
    console.log("\n=== 上传前预检（未调用微信）===\n");
    console.log("正文文件   :", result.htmlFile);
    console.log("元数据     :", result.metaFile ?? "(无)");
    console.log("标题       :", result.title, `(${[...result.title].length} 字)`);
    console.log("作者       :", result.author ?? "(未设置)");
    console.log("摘要       :", result.digest ?? "(未设置，微信会自动截取)");
    console.log("正文       :", result.content.chars, "字符 /", result.content.bytes, "字节");
    console.log("正文图片   :", result.bodyImages.length, "张本地 ·", result.remoteImages.length, "张外链 ·", result.dataUriImages, "张 data URI");
    console.log("封面       :", result.cover ? `${result.cover.source}（${result.cover.bytes} 字节）` : "❌ 未找到");
    console.log("内容指纹   :", result.bundleHash.slice(0, 24), "…");
    if (result.warnings.length) {
      console.log("\n⚠ 警告：");
      for (const w of result.warnings) console.log("  ·", w);
    }
    if (result.blockingIssues.length) {
      console.log("\n❌ 阻塞问题（必须先解决）：");
      for (const issue of result.blockingIssues) console.log("  ·", issue);
      process.exit(1);
    }
    console.log("\n✅ 可以上传\n");
  } catch (error) {
    output({ ok: false, message: messageOf(error) }, true);
  }
}

async function upload(bundlePath?: string) {
  if (!bundlePath) {
    console.error("用法：upload <文章目录绝对路径>");
    process.exit(2);
  }
  try {
    const result = await publishArticleBundle({ bundlePath });
    if (asJson) {
      output(result);
      return;
    }
    console.log("\n=== 上传结果 ===\n");
    console.log("状态       :", result.reused ? "复用既有草稿（内容未变）" : "新建草稿");
    console.log("标题       :", result.title);
    console.log("草稿 ID    :", result.mediaId);
    console.log("读回核验   :", result.verified ? "✅ 通过" : "⚠️ 未通过，请到后台人工检查");
    console.log("正文       :", result.content.chars, "字符 /", result.content.bytes, "字节");
    console.log("正文图片   :", result.images.uploaded.length, "张已上传");
    console.log("封面素材   :", result.cover.mediaId);
    if (result.warnings.length) {
      console.log("\n⚠ 警告：");
      for (const w of result.warnings) console.log("  ·", w);
    }
    console.log("\n" + result.message + "\n");
  } catch (error) {
    output({ ok: false, message: messageOf(error) }, true);
  }
}

async function update(bundlePath?: string) {
  const mediaId = flag.value("media-id");
  if (!bundlePath || !mediaId) {
    console.error("用法：update <文章目录绝对路径> --media-id <草稿ID> [--with-meta] [--with-cover] [--dry-run]");
    process.exit(2);
  }
  try {
    const result = await updateArticleBundle({
      bundlePath,
      mediaId,
      withMeta: flag.has("with-meta"),
      withCover: flag.has("with-cover"),
      dryRun: flag.has("dry-run")
    });
    if (asJson) {
      output(result);
      return;
    }
    console.log("\n=== 更新结果 ===\n");
    console.log("草稿 ID    :", result.mediaId);
    console.log("模式       :", result.dryRun ? "演练（未改动线上）" : "已原地更新");
    console.log("读回核验   :", result.dryRun ? "—" : result.verified ? "✅ 通过" : "⚠️ 未完全通过");
    console.log("保留字段   :", `标题 ${result.preserved.title ? "✓" : "✗"} · 摘要 ${result.preserved.digest ? "✓" : "✗"} · 封面 ${result.preserved.cover ? "✓" : "✗"}`);
    console.log("正文       :", result.content.chars, "字符 /", result.content.bytes, "字节");
    console.log("正文图片   :", result.images.uploaded.length, "张已上传");
    console.log("备份       :", result.backupPath);
    if (result.warnings.length) {
      console.log("\n⚠ 警告：");
      for (const w of result.warnings) console.log("  ·", w);
    }
    console.log("\n" + result.message + "\n");
  } catch (error) {
    output({ ok: false, message: messageOf(error) }, true);
  }
}

async function show(mediaId?: string) {
  if (!mediaId) {
    console.error("用法：show <草稿ID> [--json]");
    process.exit(2);
  }
  try {
    const api = createWechatApi({ credentials: readCredentialsFromEnv() });
    const payload = await api.getDraft(mediaId);
    const summary = summarizeDraft(mediaId, payload);
    if (!summary) {
      output({ ok: false, message: `读不到草稿 ${mediaId}：media_id 无效，或不属于当前公众号。` }, true);
      return;
    }
    if (asJson) {
      output({ ok: true, ...summary });
      return;
    }
    console.log("\n=== 草稿内容 ===\n");
    console.log("标题       :", summary.title, `(${[...summary.title].length} 字)`);
    console.log("作者       :", summary.author ?? "(未设置)");
    console.log("摘要       :", summary.digest ?? "(未设置)");
    console.log("正文       :", summary.contentChars, "字符 /", summary.contentBytes, "字节");
    console.log("正文图片   :", summary.bodyImageCount, "张");
    console.log("封面       :", summary.hasCover ? "已设置" : "❌ 缺失", summary.coverCropRatios.length ? `（裁切比例：${summary.coverCropRatios.join(" / ")}）` : "");
    console.log("留言       :", summary.comment.open ? "开启" : "关闭", summary.comment.onlyFans ? "· 仅粉丝可留言" : "");
    console.log("草稿 ID    :", summary.mediaId, "\n");
  } catch (error) {
    output({ ok: false, message: messageOf(error) }, true);
  }
}

async function remove(kind: "draft" | "material" | "published", targetId?: string) {
  const confirm = flag.value("confirm");
  const usage =
    kind === "published"
      ? "用法：delete-published <文章ID> --confirm <ID后6位> --i-understand [--index 0] [--dry-run]"
      : `用法：delete-${kind === "draft" ? "draft" : "material"} <${kind === "draft" ? "草稿" : "素材"}ID> --confirm <ID后6位> [--dry-run]`;
  if (!targetId || !confirm) {
    console.error(usage);
    process.exit(2);
  }
  if (kind === "published" && !flag.has("i-understand")) {
    console.error("删除已发布文章必须加 --i-understand（确认要下线线上内容）。");
    process.exit(2);
  }
  try {
    const options = {
      targetId,
      confirm,
      dryRun: flag.has("dry-run"),
      index: flag.value("index") ? Number(flag.value("index")) : undefined
    };
    const result =
      kind === "draft"
        ? await deleteDraftById(options)
        : kind === "material"
          ? await deleteMaterialById(options)
          : await deletePublishedById(options);
    if (asJson) {
      output(result);
      return;
    }
    console.log("\n=== 删除结果 ===\n");
    console.log("类型       :", result.kind);
    console.log("目标 ID    :", result.targetId);
    console.log("模式       :", result.dryRun ? "演练（未删除）" : "已删除");
    console.log("备份       :", result.backupPath ?? "(无)", result.backupBytes ? `(${result.backupBytes} 字节)` : "");
    if (result.backupNote) console.log("备份说明   :", result.backupNote);
    console.log("账本标记   :", result.ledgerMarked, "条（这些条目的草稿已不存在，不会再被复用）");
    console.log("\n" + result.message + "\n");
  } catch (error) {
    output({ ok: false, message: messageOf(error) }, true);
  }
}

async function audit() {
  const limit = flag.value("limit") ? Number(flag.value("limit")) : 20;
  const records = await readAudit(limit);
  if (asJson) {
    output(records);
    return;
  }
  console.log(`\n=== 破坏性操作审计（最近 ${records.length} 条）===\n`);
  if (records.length === 0) {
    console.log("(暂无记录)\n");
    return;
  }
  for (const record of records) {
    console.log(`${record.at}  ${record.operation}  ${record.outcome}  ${record.targetId}`);
    if (record.backupPath) console.log(`   备份: ${record.backupPath}`);
    if (record.detail) console.log(`   详情: ${record.detail}`);
  }
  console.log();
}

function output(value: unknown, isError = false) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  if (isError) process.exit(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printUsage() {
  console.error(`
用法：cli.js <命令> [参数]

  doctor                        检查微信凭证、IP 白名单与草稿箱权限（只读）
  inspect "<文章目录>"           上传前预检，不调用微信
  upload  "<文章目录>"           创建公众号草稿
  show    <草稿ID>               读回一条草稿，打印它当前的样子
  update  "<文章目录>" --media-id <草稿ID>
                                原地更新已有草稿的正文（默认保留标题/摘要/封面/评论设置）
                                可选：--with-meta（连标题摘要一起覆盖）--with-cover（换封面）--dry-run
  delete-draft     <草稿ID>  --confirm <ID后6位> [--dry-run]
  delete-material  <素材ID>  --confirm <ID后6位> [--dry-run]
  delete-published <文章ID>  --confirm <ID后6位> --i-understand [--index 0] [--dry-run]
  audit [--limit 20]            查看更新/删除的审计记录

  破坏性命令（delete-*）需要宿主显式设置 WECHAT_ALLOW_DESTRUCTIVE=1；删除前会自动备份，操作写入审计。
  可选：在命令后加 --json 输出机器可读结果
`);
}

main().catch((error) => {
  console.error("CLI 异常：", messageOf(error));
  process.exit(1);
});
