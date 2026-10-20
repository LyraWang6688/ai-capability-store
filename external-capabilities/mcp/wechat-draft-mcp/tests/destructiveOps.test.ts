/**
 * 0.3.0 破坏性操作：更新草稿 / 删除草稿 / 删除永久素材 / 删除已发布文章。
 *
 * 这些用例守的是「四道门 + 两个不可逆后果」：
 *   ① 开关 WECHAT_ALLOW_DESTRUCTIVE（默认关闭）
 *   ② 目标确认 confirm = 目标 ID 后 6 位
 *   ③ 先备份后动手（备份失败即中止）
 *   ④ 审计留痕 + 账本标记（防止以后复用到一个已经不存在的草稿）
 * 以及更新时"除正文外一律保留线上字段"（标题/摘要/封面/封面裁切/评论设置）。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { loadArticleBundle } from "../src/articleBundle.js";
import { isReusable, readDeliveryState, stateFile, writeDeliveryState } from "../src/deliveryState.js";
import { DestructiveOperationBlockedError, confirmationTokenFor, readAudit } from "../src/destructive.js";
import {
  summarizeDraft,
  deleteDraftById,
  deleteMaterialById,
  deletePublishedById,
  publishArticleBundle,
  updateArticleBundle
} from "../src/publish.js";
import { createWechatApi, type WechatApi } from "../src/wechatApi.js";
import { makeTempDir, writeBundle, type TempDir } from "./helpers/fixtures.js";
import { MockWechatServer } from "./helpers/mockWechatServer.js";

const credentials = { appId: "wx1234567890abcdef", appSecret: "secret-must-never-leak" };
const ALLOW = "1";

describe("破坏性操作：更新与删除", () => {
  let temp: TempDir;
  let server: MockWechatServer;
  let api: WechatApi;

  before(async () => {
    temp = await makeTempDir("wdmcp-destructive-");
    server = new MockWechatServer();
    await server.start();
    api = createWechatApi({ apiBase: server.url, credentials });
  });
  after(async () => {
    await server.stop();
    await temp.cleanup();
  });
  beforeEach(() => server.clearRequests());

  const envWith = async (name: string, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> => ({
    WECHAT_DRAFT_STATE_DIR: await temp.sub(name),
    ...extra
  });

  async function backupsOf(env: NodeJS.ProcessEnv): Promise<string[]> {
    try {
      return await readdir(path.join(env.WECHAT_DRAFT_STATE_DIR as string, "backups"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  // ── 目标确认令牌 ───────────────────────────────────────────────────────────
  test("确认令牌 = 目标 ID 后 6 位（不足 6 位则取全量）", () => {
    assert.equal(confirmationTokenFor("ABC123456789"), "456789");
    assert.equal(confirmationTokenFor("AB12"), "AB12");
    assert.equal(confirmationTokenFor(""), "");
  });

  // ── 草稿摘要（CLI show 的渲染逻辑，纯函数）────────────────────────────────
  test("summarizeDraft：把 draft/get 的返回压成一页，并读出封面裁切比例", () => {
    const summary = summarizeDraft("DRAFT_SUM", {
      news_item: [
        {
          title: "标题",
          author: "老王",
          digest: "摘要",
          content: '<p>正文</p><img src="a.png"><img src="b.png">',
          thumb_media_id: "COVER_1",
          cover_info: { crop_percent_list: [{ ratio: "2.35_1" }, { ratio: "1_1" }] },
          need_open_comment: 1,
          only_fans_can_comment: 1
        }
      ]
    });
    assert.ok(summary);
    assert.equal(summary.title, "标题");
    assert.equal(summary.bodyImageCount, 2);
    assert.deepEqual(summary.coverCropRatios, ["2.35_1", "1_1"]);
    assert.deepEqual(summary.comment, { open: true, onlyFans: true });
    assert.equal(summary.hasCover, true);
    // 空 news_item → undefined（CLI 据此报"读不到草稿"）
    assert.equal(summarizeDraft("X", { news_item: [] }), undefined);
  });

  // ── 更新草稿 ──────────────────────────────────────────────────────────────
  test("更新：默认只换正文，标题/摘要/封面/封面裁切/评论设置全保留，且先备份", async () => {
    const env = await envWith("upd-keep");
    const dir = await temp.sub("bundle-keep");
    await writeBundle(dir, { title: "本地标题", author: "本地作者", digest: "本地摘要" });
    const coverInfo = { crop_percent_list: [{ ratio: "2.35_1", x1: "0", y1: "0", x2: "1", y2: "1" }] };
    server.seedDraft("DRAFT_KEEP", {
      title: "线上标题",
      author: "线上作者",
      digest: "线上摘要",
      content: "<p>线上被人手工改过的正文</p>",
      thumb_media_id: "MOCK_COVER_MEDIA_9",
      show_cover_pic: 0,
      cover_info: coverInfo,
      need_open_comment: 1,
      only_fans_can_comment: 1
    });

    const result = await updateArticleBundle({ credentials, bundlePath: dir, mediaId: "DRAFT_KEEP", api, env });

    // ③ 先备份，且备份内容 = 更新前的线上正文
    const files = await backupsOf(env);
    assert.equal(files.length, 1, "更新前必须留下恰好一份备份");
    const backup = JSON.parse(await readFile(path.join(env.WECHAT_DRAFT_STATE_DIR as string, "backups", files[0]), "utf8"));
    assert.equal(backup.content, "<p>线上被人手工改过的正文</p>");
    assert.equal(result.backupPath, path.join(env.WECHAT_DRAFT_STATE_DIR as string, "backups", files[0]));

    // 除正文外全部保留
    const stored = server.drafts.get("DRAFT_KEEP");
    assert.ok(stored);
    assert.equal(stored.title, "线上标题");
    assert.equal(stored.author, "线上作者");
    assert.equal(stored.digest, "线上摘要");
    assert.equal(stored.thumb_media_id, "MOCK_COVER_MEDIA_9");
    assert.deepEqual(stored.cover_info, coverInfo, "封面裁切必须原样回传，否则会丢用户的裁切设置");
    assert.equal(stored.need_open_comment, 1);
    assert.equal(stored.only_fans_can_comment, 1);
    assert.deepEqual(result.preserved, { title: true, digest: true, cover: true });
    assert.equal(result.verified, true);

    // 正文已替换：本地路径消失、出现微信图片地址
    assert.ok(stored.content && !stored.content.includes("images/fig1.png"));
    assert.match(stored.content ?? "", /mock\/body-image-/);

    // 只更新了一次，且没有新建草稿
    assert.equal(server.count("draft/update"), 1);
    assert.equal(server.count("draft/add"), 0);
    assert.equal(server.drafts.size, 1);

    // 线上标题与本地不同 → 给出提示，但不擅自覆盖
    assert.ok(result.warnings.some((w) => w.includes("线上标题与本地不一致")));
  });

  test("更新：withMeta + withCover 时才用本地标题/摘要与本地封面", async () => {
    const env = await envWith("upd-meta");
    const dir = await temp.sub("bundle-meta");
    await writeBundle(dir, { title: "本地新标题", author: "本地作者", digest: "本地新摘要" });
    server.seedDraft("DRAFT_META", { title: "旧标题", digest: "旧摘要", thumb_media_id: "OLD_COVER", content: "<p>旧</p>" });

    await updateArticleBundle({ credentials, bundlePath: dir, mediaId: "DRAFT_META", api, env, withMeta: true, withCover: true });

    const stored = server.drafts.get("DRAFT_META");
    assert.equal(stored?.title, "本地新标题");
    assert.equal(stored?.digest, "本地新摘要");
    assert.notEqual(stored?.thumb_media_id, "OLD_COVER");
    assert.equal(server.count("material/add_material"), 1);
  });

  test("更新 dryRun：只读回并备份，绝不调用 draft/update", async () => {
    const env = await envWith("upd-dry");
    const dir = await temp.sub("bundle-dry");
    await writeBundle(dir, { title: "演练标题" });
    server.seedDraft("DRAFT_DRY", { title: "线上", content: "<p>线上正文</p>" });

    const result = await updateArticleBundle({ credentials, bundlePath: dir, mediaId: "DRAFT_DRY", api, env, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(server.count("draft/update"), 0);
    assert.equal(server.drafts.get("DRAFT_DRY")?.content, "<p>线上正文</p>");
    assert.equal((await backupsOf(env)).length, 1);
    const audit = await readAudit(5, env);
    assert.equal(audit.at(-1)?.outcome, "dry-run");
  });

  test("更新后账本：旧指纹标记失效、新指纹登记同一 mediaId，旧指纹不再复用", async () => {
    const env = await envWith("upd-ledger");
    const dir = await temp.sub("bundle-ledger");
    await writeBundle(dir, { title: "账本标题" });
    server.seedDraft("DRAFT_LEDGER", { title: "线上", content: "<p>旧</p>" });

    const oldFile = stateFile(credentials.appId, "old-hash-0000", env);
    await writeDeliveryState(oldFile, {
      status: "created",
      title: "旧内容",
      mediaId: "DRAFT_LEDGER",
      updatedAt: new Date().toISOString()
    });

    const bundle = await loadArticleBundle(dir, env);
    const result = await updateArticleBundle({ credentials, bundlePath: dir, mediaId: "DRAFT_LEDGER", api, env });

    assert.equal(result.ledgerSuperseded, 1);
    assert.equal(isReusable(await readDeliveryState(oldFile)), false, "旧指纹必须失效，否则以后会复用到内容已变的草稿");
    const fresh = await readDeliveryState(stateFile(credentials.appId, bundle.hash, env));
    assert.equal(isReusable(fresh), true);
    assert.equal(fresh?.mediaId, "DRAFT_LEDGER");
  });

  // ── 删除草稿 ──────────────────────────────────────────────────────────────
  test("删除草稿：开关未开 → 拒绝，且一个请求都不发、草稿仍在", async () => {
    const env = await envWith("del-off");
    server.seedDraft("DRAFT_OFF", { title: "不该被删", content: "<p>x</p>" });

    await assert.rejects(
      () => deleteDraftById({ credentials, targetId: "DRAFT_OFF", confirm: "AFT_OFF".slice(-6), api, env }),
      (error: unknown) => error instanceof DestructiveOperationBlockedError
    );
    assert.equal(server.requests.length, 0, "被拒绝时不得发出任何请求");
    assert.equal(server.drafts.has("DRAFT_OFF"), true);
  });

  test("删除草稿：开关打开但 confirm 不匹配 → 拒绝", async () => {
    const env = await envWith("del-confirm", { WECHAT_ALLOW_DESTRUCTIVE: ALLOW });
    server.seedDraft("DRAFT_BAD", { title: "不该被删" });

    await assert.rejects(
      () => deleteDraftById({ credentials, targetId: "DRAFT_BAD", confirm: "WRONG1", api, env }),
      /二次确认/
    );
    assert.equal(server.count("draft/delete"), 0);
    assert.equal(server.drafts.has("DRAFT_BAD"), true);
  });

  test("删除草稿：确认通过 → 先备份、再删除、写审计、账本标记 deleted", async () => {
    const env = await envWith("del-ok", { WECHAT_ALLOW_DESTRUCTIVE: ALLOW });
    server.seedDraft("DRAFT_OK", { title: "要删的", content: "<p>要删的正文</p>" });
    const ledger = stateFile(credentials.appId, "hash-del-0001", env);
    await writeDeliveryState(ledger, {
      status: "created",
      title: "要删的",
      mediaId: "DRAFT_OK",
      updatedAt: new Date().toISOString()
    });

    const result = await deleteDraftById({ credentials, targetId: "DRAFT_OK", confirm: "AFT_OK", api, env });

    assert.equal(server.drafts.has("DRAFT_OK"), false);
    assert.equal(server.count("draft/delete"), 1);
    const backup = JSON.parse(await readFile(result.backupPath as string, "utf8"));
    assert.equal(backup.content, "<p>要删的正文</p>", "删之前必须把正文备份下来");
    assert.equal(result.ledgerMarked, 1);
    assert.equal(isReusable(await readDeliveryState(ledger)), false, "已删除的草稿不能再被复用");
    const audit = await readAudit(5, env);
    assert.equal(audit.at(-1)?.operation, "draft/delete");
    assert.equal(audit.at(-1)?.outcome, "ok");
  });

  test("删除草稿 dryRun：只备份，不删除", async () => {
    const env = await envWith("del-dry", { WECHAT_ALLOW_DESTRUCTIVE: ALLOW });
    server.seedDraft("DRAFT_DRYDEL", { title: "演练", content: "<p>演练</p>" });

    const result = await deleteDraftById({ credentials, targetId: "DRAFT_DRYDEL", confirm: "DRYDEL", api, env, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(server.count("draft/delete"), 0);
    assert.equal(server.drafts.has("DRAFT_DRYDEL"), true);
    assert.equal((await backupsOf(env)).length, 1);
  });

  // ── 删除永久素材 ──────────────────────────────────────────────────────────
  test("删除永久素材：需要开关+确认；备份只记录素材 ID（内容不可读回）", async () => {
    const env = await envWith("del-material", { WECHAT_ALLOW_DESTRUCTIVE: ALLOW });
    const target = "MOCK_MATERIAL_ABC123";

    // 报错里不能出现期望值 —— 否则第二次照抄就能通过，这道门等于没设。
    let blocked = "";
    try {
      await deleteMaterialById({ credentials, targetId: target, confirm: "WRONG1", api, env });
      assert.fail("confirm 不匹配时应当被拒绝");
    } catch (error) {
      blocked = String((error as Error).message);
    }
    assert.match(blocked, /二次确认/);
    assert.ok(!blocked.includes(target.slice(-6)), "错误信息泄露了 confirm 期望值");
    assert.equal(server.count("material/del_material"), 0);

    const result = await deleteMaterialById({ credentials, targetId: target, confirm: "ABC123", api, env });
    assert.deepEqual(server.deletedMaterials, [target]);
    assert.match(result.backupNote ?? "", /不可读回/);
    const backup = JSON.parse(await readFile(result.backupPath as string, "utf8"));
    assert.equal(backup.mediaId, target);
  });

  // ── 删除已发布文章（最高危）───────────────────────────────────────────────
  test("删除已发布文章：先读回全文备份，再删除", async () => {
    const env = await envWith("del-published", { WECHAT_ALLOW_DESTRUCTIVE: ALLOW });
    server.seedPublished({ article_id: "PUB_ABC123", title: "线上文章", content: "<p>线上真实内容</p>" });

    // 未开开关 → 拒绝（不碰线上）
    const noFlag = await envWith("del-published-off");
    await assert.rejects(() => deletePublishedById({ credentials, targetId: "PUB_ABC123", confirm: "ABC123", api, env: noFlag }), /默认关闭/);
    assert.equal(server.published.has("PUB_ABC123"), true);

    const result = await deletePublishedById({ credentials, targetId: "PUB_ABC123", confirm: "ABC123", api, env });

    assert.equal(server.published.has("PUB_ABC123"), false);
    assert.deepEqual(server.deletedPublished, ["PUB_ABC123"]);
    const backup = await readFile(result.backupPath as string, "utf8");
    assert.match(backup, /线上真实内容/);
    const order = server.requests.map((request) => request.endpoint);
    assert.ok(
      order.indexOf("freepublish/getarticle") < order.indexOf("freepublish/delete"),
      "必须先读回备份再删除"
    );
  });

  // ── 与幂等账本的交互 ─────────────────────────────────────────────────────
  test("publish：被标记 superseded / deleted 的账目不再复用，会重新创建草稿", async () => {
    const env = await envWith("pub-superseded");
    const dir = await temp.sub("bundle-superseded");
    await writeBundle(dir, { title: "幂等交互标题" });
    const bundle = await loadArticleBundle(dir, env);
    const ledger = stateFile(credentials.appId, bundle.hash, env);
    server.seedDraft("MOCK_DRAFT_REUSED", { title: bundle.title, content: "<p>旧</p>" });

    // 控制组：正常 created 记录 → 复用
    await writeDeliveryState(ledger, {
      status: "created",
      title: bundle.title,
      mediaId: "MOCK_DRAFT_REUSED",
      updatedAt: new Date().toISOString()
    });
    const reused = await publishArticleBundle({ bundlePath: dir, api, env, credentials });
    assert.equal(reused.reused, true);
    assert.equal(reused.mediaId, "MOCK_DRAFT_REUSED");

    // 被更新覆盖过 → 不再复用
    await writeDeliveryState(ledger, {
      status: "created",
      title: bundle.title,
      mediaId: "MOCK_DRAFT_REUSED",
      updatedAt: new Date().toISOString(),
      supersededAt: new Date().toISOString()
    });
    const fresh = await publishArticleBundle({ bundlePath: dir, api, env, credentials });
    assert.equal(fresh.reused, false);
    assert.notEqual(fresh.mediaId, "MOCK_DRAFT_REUSED");

    // 草稿已被删除 → 同样不再复用
    await writeDeliveryState(ledger, {
      status: "created",
      title: bundle.title,
      mediaId: "MOCK_DRAFT_REUSED",
      updatedAt: new Date().toISOString(),
      deletedAt: new Date().toISOString()
    });
    const afterDelete = await publishArticleBundle({ bundlePath: dir, api, env, credentials });
    assert.equal(afterDelete.reused, false);
    assert.notEqual(afterDelete.mediaId, "MOCK_DRAFT_REUSED");
  });
});
