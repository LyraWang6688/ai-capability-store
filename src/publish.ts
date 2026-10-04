/**
 * 发布编排：把「文章包」变成「微信公众号草稿」。
 *
 * 安全不变量（与 Publisher 通道同一套语义，实现独立）：
 *   1. 第一次微信副作用之前，必须先落盘 `creating`
 *   2. 落盘 `creating` 之后的任何异常/超时 —— 结果未知，保持 creating，禁止自动重试
 *   3. 同一内容重复调用 —— 读回既有草稿，不重复创建
 *   4. 单篇互斥：锁被占用即拒绝，绝不并发创建
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { loadArticleBundle, LIMITS, type ArticleBundle } from "./articleBundle.js";
import {
  DeliveryLockedError,
  DeliveryOutcomeUnknownError,
  isReusable,
  markDeliveryStates,
  readDeliveryState,
  stateDir,
  stateFile,
  withDeliveryLock,
  writeDeliveryState
} from "./deliveryState.js";
import {
  appendAudit,
  assertConfirmed,
  assertDestructiveAllowed,
  writeBackup,
  type DestructiveOperation
} from "./destructive.js";
import {
  createWechatApi,
  readCredentialsFromEnv,
  type DraftArticle,
  type WechatApi,
  type WechatCredentials
} from "./wechatApi.js";

export type PublishOptions = {
  bundlePath: string;
  credentials?: WechatCredentials;
  env?: NodeJS.ProcessEnv;
  /** 注入点：测试传替身，生产不传。 */
  api?: WechatApi;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
};

export type PublishResult = {
  ok: true;
  reused: boolean;
  mediaId: string;
  title: string;
  author?: string;
  digest?: string;
  verified: boolean;
  content: { chars: number; bytes: number };
  images: {
    uploaded: Array<{ src: string; url: string }>;
    skippedRemote: string[];
    skippedDataUri: number;
  };
  cover: { source: string; mediaId: string };
  warnings: string[];
  message: string;
};

export function summarizeBundle(bundle: ArticleBundle) {
  return {
    dir: bundle.dir,
    htmlFile: bundle.htmlPath.split("/").pop(),
    metaFile: bundle.metaPath ? bundle.metaPath.split("/").pop() : null,
    title: bundle.title,
    author: bundle.author ?? null,
    digest: bundle.digest ?? null,
    column: bundle.column ?? null,
    metaSources: bundle.metaSources,
    content: {
      chars: bundle.stats.chars,
      bytes: bundle.stats.bytes,
      limitChars: LIMITS.contentChars,
      limitBytes: LIMITS.contentBytes
    },
    bodyImages: bundle.bodyImages.map((image) => image.src),
    remoteImages: bundle.remoteImages,
    dataUriImages: bundle.dataUriCount,
    cover: bundle.cover ? { source: bundle.cover.source, bytes: bundle.cover.bytes.length } : null,
    bundleHash: bundle.hash,
    warnings: bundle.warnings,
    blockingIssues: bundle.blockingIssues
  };
}

/** 只读预检：完全不调用微信，不落盘。 */
export async function inspectArticleBundle(bundlePath: string, env: NodeJS.ProcessEnv = process.env) {
  const bundle = await loadArticleBundle(bundlePath, env);
  return { ...summarizeBundle(bundle), ready: bundle.blockingIssues.length === 0 };
}

export async function publishArticleBundle(options: PublishOptions): Promise<PublishResult> {
  const env = options.env ?? process.env;
  const credentials = options.credentials ?? readCredentialsFromEnv(env);
  const bundle = await loadArticleBundle(options.bundlePath, env);

  if (bundle.blockingIssues.length > 0) {
    throw new Error(`文章不满足微信草稿要求：${bundle.blockingIssues.join("；")}`);
  }

  const api = options.api ?? createWechatApi({ credentials });
  const file = stateFile(credentials.appId, bundle.hash, env);

  return withDeliveryLock(file, async () => {
    const saved = await readDeliveryState(file);

    // 幂等重放：同一账号 + 同一内容，直接读回既有草稿，绝不重复创建。
    // 已被「更新」覆盖或已「删除」的条目不算可复用（isReusable），会重新创建。
    if (isReusable(saved)) {
      const verified = await verifyDraft(api, saved!.mediaId as string, bundle.title);
      return {
        ok: true as const,
        reused: true,
        mediaId: saved!.mediaId as string,
        title: bundle.title,
        author: bundle.author,
        digest: bundle.digest,
        verified,
        content: { chars: bundle.stats.chars, bytes: bundle.stats.bytes },
        images: { uploaded: [], skippedRemote: bundle.remoteImages, skippedDataUri: bundle.dataUriCount },
        cover: { source: bundle.cover?.source ?? "", mediaId: "" },
        warnings: bundle.warnings,
        message: verified
          ? "该文章此前已上传过，已返回既有草稿，未重复创建。"
          : "该文章此前已上传过，返回既有草稿 ID，但读回核验未通过，请到公众号后台确认。"
      };
    }

    // 结果未知：上次创建中断，草稿可能已经存在，禁止自动重试。
    if (saved?.status === "creating") {
      throw new DeliveryOutcomeUnknownError(
        "这篇文章上一次的上传结果未知（可能已经创建了草稿）。请先到公众号草稿箱核对，" +
          "确认后再手动删除状态文件重试：" +
          file
      );
    }

    await api.checkAccess();

    // ★ 关键：第一次微信副作用之前先落盘 creating。
    //   此后无论发生什么，下一次调用都会看到 creating 并拒绝重试，由人工核对。
    await writeDeliveryState(file, {
      status: "creating",
      title: bundle.title,
      updatedAt: new Date().toISOString()
    });

    const uploaded: Array<{ src: string; url: string }> = [];
    let html = bundle.contentHtml;

    // 正文图片走 media/uploadimg（不占素材库配额），并把 src 换成微信 URL。
    for (const image of bundle.bodyImages) {
      const url = await api.uploadBodyImage({ bytes: image.bytes, fileName: image.fileName });
      html = rewriteImageSrc(html, image.src, url);
      uploaded.push({ src: image.src, url });
    }

    // 封面必须走永久素材，thumb_media_id 只接受永久素材。
    if (!bundle.cover) {
      throw new Error("缺少封面，无法创建草稿。");
    }
    const cover = await api.uploadMaterial({ bytes: bundle.cover.bytes, fileName: bundle.cover.fileName });

    const chars = [...html].length;
    const bytes = Buffer.byteLength(html, "utf8");
    if (chars >= LIMITS.contentChars || bytes >= LIMITS.contentBytes) {
      throw new Error(
        `替换图片地址后正文超限（${chars} 字符 / ${bytes} 字节，上限 ${LIMITS.contentChars} 字符 / ${LIMITS.contentBytes} 字节）。`
      );
    }

    const mediaId = await api.addDraft({
      article_type: "news",
      title: bundle.title,
      author: bundle.author,
      digest: bundle.digest,
      content: html,
      thumb_media_id: cover.mediaId,
      need_open_comment: options.needOpenComment ? 1 : 0,
      only_fans_can_comment: options.onlyFansCanComment ? 1 : 0
    });

    await writeDeliveryState(file, {
      status: "created",
      title: bundle.title,
      mediaId,
      imageCount: uploaded.length,
      updatedAt: new Date().toISOString()
    });

    const verified = await verifyDraft(api, mediaId, bundle.title);

    return {
      ok: true as const,
      reused: false,
      mediaId,
      title: bundle.title,
      author: bundle.author,
      digest: bundle.digest,
      verified,
      content: { chars, bytes },
      images: { uploaded, skippedRemote: bundle.remoteImages, skippedDataUri: bundle.dataUriCount },
      cover: { source: bundle.cover.source, mediaId: cover.mediaId },
      warnings: [...bundle.warnings, ...remoteImageWarnings(bundle)],
      message: verified
        ? "已创建微信公众号草稿并读回核验通过。"
        : "草稿已创建，但读回核验未通过，请到公众号后台人工检查。"
    };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 0.3.0：更新与删除（破坏性操作）
//
// 四道防护（见 src/destructive.ts）：
//   ① 开关 WECHAT_ALLOW_DESTRUCTIVE=1（默认关闭）
//   ② 目标确认 confirm = 目标 ID 后 6 位
//   ③ 执行前自动备份到 state/backups/
//   ④ 审计写入 state/audit.jsonl
// draft/update 不受 ①② 约束（不改存在性），但**仍然先备份**，因为它会覆盖
// 用户可能在编辑器里手工改过的正文。
// ───────────────────────────────────────────────────────────────────────────

export type UpdateOptions = {
  bundlePath: string;
  /** 要更新的草稿 media_id（必须是当前账号名下的草稿）。 */
  mediaId: string;
  credentials?: WechatCredentials;
  env?: NodeJS.ProcessEnv;
  api?: WechatApi;
  /** 用本地文章的标题/作者/摘要覆盖线上（默认只换正文，其余保留线上）。 */
  withMeta?: boolean;
  /** 用本地封面重新上传并替换线上封面（默认保留线上封面）。 */
  withCover?: boolean;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
  /** 只演练：读回 + 备份 + 算结果，但不调用 draft/update。 */
  dryRun?: boolean;
};

export type UpdateResult = {
  ok: true;
  mediaId: string;
  title: string;
  author?: string;
  digest?: string;
  dryRun: boolean;
  content: { chars: number; bytes: number };
  images: {
    uploaded: Array<{ src: string; url: string }>;
    skippedRemote: string[];
    skippedDataUri: number;
  };
  backupPath: string;
  preserved: { title: boolean; digest: boolean; cover: boolean };
  ledgerSuperseded: number;
  verified: boolean;
  warnings: string[];
  message: string;
};

/** 原地更新一条已有草稿的正文；除正文外一律保留线上字段（含封面裁切、评论设置）。 */
export async function updateArticleBundle(options: UpdateOptions): Promise<UpdateResult> {
  const env = options.env ?? process.env;
  const mediaId = (options.mediaId ?? "").trim();
  if (!mediaId) throw new Error("更新草稿必须提供 mediaId（可在草稿箱的素材链接里找到）。");

  const credentials = options.credentials ?? readCredentialsFromEnv(env);
  const bundle = await loadArticleBundle(options.bundlePath, env);
  if (bundle.blockingIssues.length > 0) {
    throw new Error(`文章不满足微信草稿要求：${bundle.blockingIssues.join("；")}`);
  }
  const api = options.api ?? createWechatApi({ credentials });
  const lockFile = path.join(stateDir(env), `update-${lockKey(credentials.appId, mediaId)}.json`);

  return withDeliveryLock(lockFile, async () => {
    // ① 读回当前草稿：既是备份来源，也是"要保留哪些字段"的来源。
    const current = await api.getDraft(mediaId);
    const item = firstNewsItem(current);
    if (!item) throw new Error(`读不到草稿 ${mediaId}：请确认它属于当前公众号，且不是已发布文章。`);

    // ② ★ 覆盖之前先备份当前正文与元数据（update 不经过开关/确认，但一定备份）
    const backup = await writeBackup({ kind: "draft", targetId: mediaId, payload: item, env });

    // ③ 正文图片换微信 URL
    const uploaded: Array<{ src: string; url: string }> = [];
    let html = bundle.contentHtml;
    for (const image of bundle.bodyImages) {
      const url = await api.uploadBodyImage({ bytes: image.bytes, fileName: image.fileName });
      html = rewriteImageSrc(html, image.src, url);
      uploaded.push({ src: image.src, url });
    }
    const chars = [...html].length;
    const bytes = Buffer.byteLength(html, "utf8");
    if (chars >= LIMITS.contentChars || bytes >= LIMITS.contentBytes) {
      throw new Error(
        `替换图片地址后正文超限（${chars} 字符 / ${bytes} 字节，上限 ${LIMITS.contentChars} 字符 / ${LIMITS.contentBytes} 字节）。`
      );
    }

    // ④ 封面：默认保留线上封面及其裁切信息
    let thumbMediaId = asString(item.thumb_media_id);
    if (options.withCover) {
      if (!bundle.cover) throw new Error("withCover 需要文章包里带封面图。");
      const cover = await api.uploadMaterial({ bytes: bundle.cover.bytes, fileName: bundle.cover.fileName });
      thumbMediaId = cover.mediaId;
    }

    // ⑤ 元数据：默认保留线上
    const title = options.withMeta ? bundle.title : asString(item.title) || bundle.title;
    const author = options.withMeta ? bundle.author : asString(item.author) || undefined;
    const digest = options.withMeta ? bundle.digest : asString(item.digest) || undefined;
    const warnings = [...bundle.warnings, ...remoteImageWarnings(bundle)];
    if (!options.withMeta && asString(item.title) && asString(item.title) !== bundle.title) {
      warnings.push(
        `线上标题与本地不一致（线上「${asString(item.title)}」/本地「${bundle.title}」）；本次保留线上标题，如需同步请用 withMeta。`
      );
    }

    const article: DraftArticle = {
      article_type: (asString(item.article_type) as DraftArticle["article_type"]) || "news",
      title,
      author,
      digest,
      content: html,
      content_source_url: asString(item.content_source_url) ?? "",
      thumb_media_id: thumbMediaId || undefined,
      show_cover_pic: (item.show_cover_pic as 0 | 1 | undefined) ?? 0,
      cover_info: (item.cover_info as Record<string, unknown> | undefined) ?? undefined,
      need_open_comment: (item.need_open_comment as 0 | 1 | undefined) ?? (options.needOpenComment ? 1 : 0),
      only_fans_can_comment:
        (item.only_fans_can_comment as 0 | 1 | undefined) ?? (options.onlyFansCanComment ? 1 : 0)
    };

    if (options.dryRun) {
      await appendAudit(
        { operation: "draft/update", targetId: mediaId, outcome: "dry-run", backupPath: backup.path },
        env
      );
      return {
        ok: true as const,
        mediaId,
        title,
        author,
        digest,
        dryRun: true,
        content: { chars, bytes },
        images: { uploaded, skippedRemote: bundle.remoteImages, skippedDataUri: bundle.dataUriCount },
        backupPath: backup.path,
        preserved: { title: true, digest: true, cover: true },
        ledgerSuperseded: 0,
        verified: false,
        warnings,
        message: `演练完成，未改动线上草稿。当前正文会被替换为 ${chars} 字符（含 ${uploaded.length} 张新上传的正文图）；已备份现有正文到 ${backup.path}。`
      };
    }

    // ⑥ 真正更新
    await api.updateDraft(mediaId, article);

    // ⑦ 读回核验：除我们有意替换的字段外，其余必须与更新前一致
    const after = firstNewsItem(await api.getDraft(mediaId));
    if (!after) throw new Error("更新后读回草稿失败，请到公众号后台人工确认。");
    const afterContent = String(after.content ?? "");
    const preserved = {
      title: after.title === (options.withMeta ? bundle.title : item.title),
      digest: String(after.digest ?? "") === String(options.withMeta ? bundle.digest ?? "" : item.digest ?? ""),
      cover: asString(after.thumb_media_id) === thumbMediaId
    };
    const noLocalPaths = !afterContent.includes("assets/");
    const verified = preserved.title && preserved.digest && preserved.cover && noLocalPaths;

    // ⑧ 账本：先把指向同一 mediaId 的旧指纹标为失效（不可再复用），再登记新指纹
    const newStateFile = stateFile(credentials.appId, bundle.hash, env);
    const superseded = await markDeliveryStates(mediaId, { supersededAt: new Date().toISOString() }, env);
    const supersededOthers = superseded.filter((file) => file !== newStateFile);
    await writeDeliveryState(newStateFile, {
      status: "created",
      title,
      mediaId,
      imageCount: uploaded.length,
      updatedAt: new Date().toISOString()
    });

    await appendAudit(
      {
        operation: "draft/update",
        targetId: mediaId,
        outcome: "ok",
        backupPath: backup.path,
        detail: `chars=${chars} images=${uploaded.length} verified=${verified}`
      },
      env
    );

    return {
      ok: true as const,
      mediaId,
      title,
      author,
      digest,
      dryRun: false,
      content: { chars, bytes },
      images: { uploaded, skippedRemote: bundle.remoteImages, skippedDataUri: bundle.dataUriCount },
      backupPath: backup.path,
      preserved,
      ledgerSuperseded: supersededOthers.length,
      verified,
      warnings,
      message: verified
        ? `已原地更新草稿（保留封面/摘要/评论设置），备份在 ${backup.path}。`
        : `草稿已更新，但读回核验未完全通过，请到公众号后台确认；备份在 ${backup.path}。`
    };
  });
}

export type DraftSummary = {
  mediaId: string;
  title: string;
  author: string | null;
  digest: string | null;
  contentChars: number;
  contentBytes: number;
  bodyImageCount: number;
  hasCover: boolean;
  /** 封面裁切比例（微信返回的 crop_percent_list，如 ["2.35_1","1_1"]）。 */
  coverCropRatios: string[];
  comment: { open: boolean; onlyFans: boolean };
};

/** 把 draft/get 的原始返回压成"人看得懂的一页"（纯函数，便于测试与 CLI/MCP 复用）。 */
export function summarizeDraft(mediaId: string, payload: Record<string, unknown>): DraftSummary | undefined {
  const item = firstNewsItem(payload);
  if (!item) return undefined;
  const content = String(item.content ?? "");
  const crop =
    ((item.cover_info as { crop_percent_list?: Array<{ ratio?: string }> } | undefined)?.crop_percent_list ?? []);
  return {
    mediaId,
    title: String(item.title ?? ""),
    author: asString(item.author) ?? null,
    digest: asString(item.digest) ?? null,
    contentChars: [...content].length,
    contentBytes: Buffer.byteLength(content, "utf8"),
    bodyImageCount: (content.match(/<img/gi) ?? []).length,
    hasCover: Boolean(asString(item.thumb_media_id)),
    coverCropRatios: crop.map((entry) => String(entry.ratio ?? "")).filter(Boolean),
    comment: {
      open: (item.need_open_comment as number | undefined) === 1,
      onlyFans: (item.only_fans_can_comment as number | undefined) === 1
    }
  };
}

export type DeleteKind = "draft" | "material" | "published";

export type DeleteOptions = {
  targetId: string;
  /** 二次确认：必须等于 targetId 的后 6 位。 */
  confirm?: string;
  credentials?: WechatCredentials;
  env?: NodeJS.ProcessEnv;
  api?: WechatApi;
  dryRun?: boolean;
  /** 仅 published：删除第几篇（默认 0）。 */
  index?: number;
};

export type DeleteResult = {
  ok: true;
  kind: DeleteKind;
  targetId: string;
  dryRun: boolean;
  backupPath?: string;
  backupBytes?: number;
  backupNote?: string;
  ledgerMarked: number;
  message: string;
};

/** 删除草稿（不可逆）。 */
export async function deleteDraftById(options: DeleteOptions): Promise<DeleteResult> {
  return runDelete("draft", "draft/delete", options, async (api, targetId) => {
    const item = firstNewsItem(await api.getDraft(targetId));
    if (!item) throw new Error(`读不到草稿 ${targetId}，无法备份，已中止删除。`);
    const backup = await writeBackup({ kind: "draft", targetId, payload: item, env: options.env });
    return { backup };
  }, async (api, targetId) => {
    await api.deleteDraft(targetId);
  });
}

/** 删除永久素材（如封面图）。素材内容无法通过接口读回，备份的是我们记录到的元数据。 */
export async function deleteMaterialById(options: DeleteOptions): Promise<DeleteResult> {
  return runDelete("material", "material/del_material", options, async (_api, targetId) => {
    const backup = await writeBackup({
      kind: "material",
      targetId,
      payload: { mediaId: targetId, note: "永久素材内容无法通过接口读回；此处仅记录被删除的素材 ID 与时间。" },
      env: options.env
    });
    return { backup, backupNote: "素材内容不可读回，已记录素材 ID 供追溯。" };
  }, async (api, targetId) => {
    await api.deleteMaterial(targetId);
  });
}

/** 删除已发布文章（最高危：动线上内容）。 */
export async function deletePublishedById(options: DeleteOptions): Promise<DeleteResult> {
  return runDelete("published", "freepublish/delete", options, async (api, targetId) => {
    const published = await api.getPublishedArticle(targetId);
    const backup = await writeBackup({ kind: "published", targetId, payload: published, env: options.env });
    return { backup };
  }, async (api, targetId) => {
    await api.deletePublishedArticle(targetId, options.index ?? 0);
  });
}

/** draft/material/published 三种删除共用的防护流程：开关 → 确认 → 备份 → 删除 → 标记账本 → 审计。 */
async function runDelete(
  kind: DeleteKind,
  operation: DestructiveOperation,
  options: DeleteOptions,
  prepare: (api: WechatApi, targetId: string) => Promise<{ backup: { path: string; bytes: number }; backupNote?: string }>,
  perform: (api: WechatApi, targetId: string) => Promise<void>
): Promise<DeleteResult> {
  const env = options.env ?? process.env;
  const targetId = (options.targetId ?? "").trim();

  // 门 ① 与 ②：任何副作用之前先过开关与目标确认
  assertDestructiveAllowed(operation, env);
  assertConfirmed(operation, targetId, options.confirm);

  const credentials = options.credentials ?? readCredentialsFromEnv(env);
  const api = options.api ?? createWechatApi({ credentials });
  const lockFile = path.join(stateDir(env), `delete-${lockKey(credentials.appId, targetId)}.json`);

  return withDeliveryLock(lockFile, async () => {
    // 门 ③ 先备份（备份失败即中止，绝不"没备份就删"）
    const { backup, backupNote } = await prepare(api, targetId);

    if (options.dryRun) {
      await appendAudit({ operation, targetId, outcome: "dry-run", backupPath: backup.path }, env);
      return {
        ok: true as const,
        kind,
        targetId,
        dryRun: true,
        backupPath: backup.path,
        backupBytes: backup.bytes,
        backupNote,
        ledgerMarked: 0,
        message: `演练完成，未删除任何内容。目标已读回并备份到 ${backup.path}。`
      };
    }

    try {
      await perform(api, targetId);
    } catch (error) {
      await appendAudit(
        { operation, targetId, outcome: "failed", backupPath: backup.path, detail: (error as Error).message },
        env
      );
      throw error;
    }

    // 账本标记：指向该目标的条目失效，避免以后"复用"到一个已经不存在的草稿
    const marked = await markDeliveryStates(targetId, { deletedAt: new Date().toISOString() }, env);

    await appendAudit(
      { operation, targetId, outcome: "ok", backupPath: backup.path, detail: `ledgerMarked=${marked.length}` },
      env
    );

    return {
      ok: true as const,
      kind,
      targetId,
      dryRun: false,
      backupPath: backup.path,
      backupBytes: backup.bytes,
      backupNote,
      ledgerMarked: marked.length,
      message:
        kind === "material"
          ? `已删除永久素材 ${targetId}。注意：若其他草稿仍在引用它，封面会显示异常。`
          : `已删除${kind === "draft" ? "草稿" : "已发布文章"} ${targetId}；内容已备份到 ${backup.path}，可用同一条更新流程重建。`
    };
  });
}

function firstNewsItem(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const items = payload.news_item as Array<Record<string, unknown>> | undefined;
  const item = items?.[0];
  return item && Object.keys(item).length > 0 ? item : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 更新/删除的互斥锁按「账号 + 目标」命名：同一目标不会被并发改两次。 */
function lockKey(appId: string, targetId: string): string {
  return createHash("sha256").update(`${appId}:${targetId}`).digest("hex").slice(0, 16);
}

/** 只替换指定 src 属性值，不动其他内容。 */
export function rewriteImageSrc(html: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(`((?:^|\\s)src\\s*=\\s*)(["'])${escaped}\\2`, "gi"), `$1$2${to}$2`);
}

async function verifyDraft(api: WechatApi, mediaId: string, expectedTitle: string): Promise<boolean> {
  try {
    const draft = (await api.getDraft(mediaId)) as { news_item?: Array<{ title?: string }> };
    return draft.news_item?.[0]?.title === expectedTitle;
  } catch {
    return false;
  }
}

function remoteImageWarnings(bundle: ArticleBundle): string[] {
  if (bundle.remoteImages.length === 0) return [];
  return [
    `正文有 ${bundle.remoteImages.length} 张外链图片未处理。微信会过滤外部图片 URL，草稿里这些图可能不显示；` +
      `请把图片下载到文章包内改用本地路径。`
  ];
}

export { DeliveryLockedError, DeliveryOutcomeUnknownError };
