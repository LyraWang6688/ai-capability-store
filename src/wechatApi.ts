/**
 * 微信公众号 API 客户端（连接器专用，自包含）。
 *
 * 为什么不复用 src/services/wechat.service.ts：
 *   本模块要被发布成独立 npm 包供豆包工作 / WorkBuddy 以 `npx` 启动。
 *   npm 包不能依赖私有仓库里的 src/ 路径，所以这里必须自包含。
 *   两个通道共享的是「契约与语义」，不是实现。
 *
 * 与仓库内 Publisher 通道的差异（有意为之）：
 *   - 使用 stable_token 而非 cgi-bin/token。stable_token 配额 1 万次/分钟、
 *     50 万次/天，而 cgi-bin/token 新号只有 2000 次/天。
 *   - 正文图片走 media/uploadimg（不占素材库配额），封面走 material/add_material。
 *   - 不读取 .env：凭证只由宿主（豆包/WorkBuddy 的连接器配置）注入环境变量。
 *
 * 该模块只做「调微信」，不做编排、不做幂等、不落盘。
 */

export type WechatCredentials = {
  appId: string;
  appSecret: string;
};

export type WechatApiOptions = {
  credentials: WechatCredentials;
  /** 仅测试替身使用；生产保持默认。 */
  apiBase?: string;
  /** 单次请求超时。微信素材接口可能较慢，默认 30s。 */
  timeoutMs?: number;
  /** 注入点，便于测试。 */
  request?: typeof fetch;
};

/** 微信错误码 → 人话。连接器必须做这层翻译，否则用户只会看到一串数字。 */
function hintFor(errcode: number): string | undefined {
  switch (errcode) {
    case 40164:
      return "调用方出口 IP 不在公众号白名单。请把 request_ip 加入 微信公众平台 → 设置与开发 → 基本配置 → IP白名单；换 Wi-Fi、开 VPN 或重启光猫后 IP 会变，需要重新添加。";
    case 40125:
      return "AppSecret 无效。请在连接器配置里重新填写；平台不显示明文，忘记只能重置，重置会让其他正在使用该密钥的服务立即失效。";
    case 40013:
      return "AppID 无效。请确认填的是「基本配置」里以 wx 开头的开发者 ID，而不是微信号或原始 ID。";
    case 48001:
      // 注意：不要写成「未认证号不能用」。实测未认证个人订阅号可以正常调用
      // draft/add 与 media/uploadimg；把用户往「必须花 300 元认证」的方向带是错的。
      return "该接口未授权给当前公众号。请到 公众号后台 → 设置与开发 → 接口权限 核对该能力的实际授权情况；也可能是账号类型/权限变更或年审到期。";
    case 45009:
      return "接口调用次数超过当日配额，请稍后或次日重试。";
    case 40007:
      return "素材 ID 无效或已过期，通常是用了非永久素材当封面。";
    default:
      return undefined;
  }
}

export class WechatApiError extends Error {
  readonly errcode?: number;
  /** 微信侧结果未知（网络中断/超时）时置 true —— 调用方绝不能盲目重试。 */
  readonly outcomeUnknown: boolean;

  constructor(message: string, options: { errcode?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "WechatApiError";
    this.errcode = options.errcode;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export type DraftArticle = {
  article_type?: "news" | "newspic";
  title: string;
  author?: string;
  digest?: string;
  content?: string;
  content_source_url?: string;
  thumb_media_id?: string;
  image_info?: { image_list: Array<{ image_media_id: string }> };
  need_open_comment?: 0 | 1;
  only_fans_can_comment?: 0 | 1;
  /** 封面是否显示在正文顶部。更新草稿时必须原样回传，否则会被重置。 */
  show_cover_pic?: 0 | 1;
  /**
   * 封面裁切信息（微信返回的 crop_percent_list）。
   * 更新草稿时必须原样回传：不回传会丢掉用户手工选的裁切比例。
   */
  cover_info?: Record<string, unknown>;
};

export function createWechatApi(options: WechatApiOptions) {
  const apiBase = (options.apiBase || "https://api.weixin.qq.com").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const request = options.request ?? fetch;
  let token: string | undefined;

  async function raw<T>(path: string, init: { method?: string; body?: BodyInit; json?: unknown }): Promise<T> {
    const url = new URL(`${apiBase}/cgi-bin/${path}`);
    if (token) {
      url.searchParams.set("access_token", token);
    }
    const headers: Record<string, string> = {};
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }

    let response: Response;
    let text: string;
    try {
      response = await request(url, {
        method: init.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
      text = await response.text();
    } catch {
      // 网络层失败：请求可能已经到达微信，结果未知。调用方必须按 unknown outcome 处理。
      throw new WechatApiError("微信请求失败或超时；结果未知，请先核对公众号草稿箱，不要盲目重复创建。", {
        outcomeUnknown: true
      });
    }

    let payload: Record<string, unknown>;
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new WechatApiError("微信返回了非 JSON 响应，接口行为异常。", { outcomeUnknown: false });
    }

    const errcode = typeof payload.errcode === "number" ? payload.errcode : undefined;
    if (!response.ok || (errcode !== undefined && errcode !== 0)) {
      const code = errcode ?? response.status;
      const errmsg = typeof payload.errmsg === "string" ? payload.errmsg : "";
      const hint = hintFor(code);
      let message = `微信接口错误 ${code}${errmsg ? `：${errmsg}` : ""}${hint ? `。${hint}` : ""}`;
      if (code === 40164) {
        const ip = extractRequestIp(errmsg);
        if (ip) message += `（当前 request_ip=${ip}）`;
      }
      throw new WechatApiError(message, { errcode: code });
    }

    return payload as T;
  }

  /** 只返回状态，绝不返回 token 或密钥。 */
  async function checkAccess(): Promise<{ ok: true; expires_in: number }> {
    ensureCredentialShape(options.credentials);
    const data = await raw<{ access_token?: string; expires_in?: number }>("stable_token", {
      json: {
        grant_type: "client_credential",
        appid: options.credentials.appId,
        secret: options.credentials.appSecret,
        force_refresh: false
      }
    });
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new WechatApiError("微信未返回 access_token。");
    }
    token = data.access_token;
    return { ok: true, expires_in: Number(data.expires_in) || 0 };
  }

  async function ensureToken() {
    if (!token) {
      await checkAccess();
    }
  }

  return {
    checkAccess,

    /** 上传正文图片，返回可嵌入 HTML 的 URL（不占素材库配额）。 */
    async uploadBodyImage(image: { bytes: Uint8Array; fileName: string }): Promise<string> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      const form = new FormData();
      form.append("media", new Blob([image.bytes as BlobPart], { type: mimeOf(image.fileName) }), image.fileName);
      const data = await raw<{ url?: string }>("media/uploadimg", { body: form });
      if (typeof data.url !== "string" || !/^https?:\/\//.test(data.url)) {
        throw new WechatApiError("微信正文图片接口未返回合法 URL。");
      }
      return data.url;
    },

    /** 上传永久素材，返回 media_id（封面必须走这里，thumb_media_id 要求永久素材）。 */
    async uploadMaterial(image: { bytes: Uint8Array; fileName: string }): Promise<{ mediaId: string; url?: string }> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      const form = new FormData();
      form.append("media", new Blob([image.bytes as BlobPart], { type: mimeOf(image.fileName) }), image.fileName);
      const data = await raw<{ media_id?: string; url?: string }>("material/add_material?type=image", { body: form });
      if (typeof data.media_id !== "string" || !data.media_id) {
        throw new WechatApiError("微信永久素材接口未返回 media_id。");
      }
      return { mediaId: data.media_id, url: data.url };
    },

    async addDraft(article: DraftArticle): Promise<string> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      const data = await raw<{ media_id?: string }>("draft/add", { json: { articles: [stripUndefined(article)] } });
      if (typeof data.media_id !== "string" || !data.media_id) {
        // 草稿可能已经创建成功但没有返回 ID —— 属于结果未知，不能重试。
        throw new WechatApiError("创建草稿未返回 media_id，结果未知，请先到草稿箱核对。", { outcomeUnknown: true });
      }
      return data.media_id;
    },

    async getDraft(mediaId: string): Promise<Record<string, unknown>> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      return raw<Record<string, unknown>>("draft/get", { json: { media_id: mediaId } });
    },

    /**
     * 原地更新草稿正文（覆盖）。
     * 调用方**必须**先备份当前正文，并在更新后读回核验。
     */
    async updateDraft(mediaId: string, article: DraftArticle): Promise<void> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      await raw<Record<string, unknown>>("draft/update", {
        json: { media_id: mediaId, index: 0, articles: stripUndefined(article) }
      });
    },

    /**
     * 删除草稿（不可逆，微信不提供恢复）。
     * 调用方**必须**已完成备份与二次确认；本函数只负责调接口。
     */
    async deleteDraft(mediaId: string): Promise<void> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      await raw<Record<string, unknown>>("draft/delete", { json: { media_id: mediaId } });
    },

    /**
     * 删除永久素材（如封面图）。
     * 注意：素材可能被其他草稿/已发布文章引用，删除前应确认引用关系。
     */
    async deleteMaterial(mediaId: string): Promise<void> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      await raw<Record<string, unknown>>("material/del_material", { json: { media_id: mediaId } });
    },

    /** 读取已发布图文（删除前备份用）。 */
    async getPublishedArticle(articleId: string): Promise<Record<string, unknown>> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      return raw<Record<string, unknown>>("freepublish/getarticle", { json: { article_id: articleId } });
    },

    /**
     * 删除已发布的文章（最高危：动的是线上内容）。
     * 调用方**必须**先备份（getPublishedArticle）并完成二次确认。
     */
    async deletePublishedArticle(articleId: string, index = 0): Promise<void> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      await raw<Record<string, unknown>>("freepublish/delete", { json: { article_id: articleId, index } });
    },

    /** 无副作用的权限探测：能读到草稿总数即说明草稿箱接口已授权。 */
    async draftCount(): Promise<number> {
      ensureCredentialShape(options.credentials);
      await ensureToken();
      const data = await raw<{ total_count?: number }>("draft/count", {});
      return Number(data.total_count) || 0;
    }
  };
}

export function ensureCredentialShape(credentials: WechatCredentials) {
  // 宿主平台未替换 ${VAR} 占位符时会把字面量传进来。这时报「AppID 无效」会让用户
  // 反复核对其实填对了的内容，而问题出在平台注入环节，必须区分开。
  const placeholder = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
  // 凭证是从宿主配置跨边界传进来的，运行时可能是 undefined，先归一化再判断。
  const appId = (credentials.appId ?? "").trim();
  const appSecret = (credentials.appSecret ?? "").trim();
  if (placeholder.test(appId) || placeholder.test(appSecret)) {
    throw new WechatApiError(
      "凭证未被注入：读到的仍是占位符。这不是你填错了，是平台尚未把凭证传给连接器。请在连接器配置页重新填写并保存，然后重连后重试。"
    );
  }
  if (!appId || !appSecret) {
    throw new WechatApiError("缺少公众号凭证：请在连接器配置里填写 AppID 与 AppSecret，不要在聊天中发送密钥。");
  }
}

export function readCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): WechatCredentials {
  return {
    appId: (env.WECHAT_APP_ID || "").trim(),
    appSecret: (env.WECHAT_APP_SECRET || "").trim()
  };
}

/** 供编排层做依赖注入（测试时可传替身）。 */
export type WechatApi = ReturnType<typeof createWechatApi>;

function extractRequestIp(errmsg: string): string | undefined {
  const candidate = errmsg.match(/invalid ip\s+([\da-fA-F:.]+)/i)?.[1];
  return candidate;
}

function mimeOf(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  return "image/jpeg";
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
