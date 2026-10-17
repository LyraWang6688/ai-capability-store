/**
 * 微信服务器替身（本地 HTTP）。
 *
 * 为什么是真 HTTP 服务器而不是 stub 函数：
 *   客户端用的是全局 fetch + FormData + AbortSignal，只有让请求真的走一遍网络栈，
 *   才能覆盖 multipart 编码、超时中断、连接被重置这些真实故障形态。
 *
 * 所有端点、鉴权与错误码都按微信文档的形状返回，且每个请求都被记录，
 * 供测试断言「有没有发请求」「发了几次」「发了什么」。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

export type Endpoint =
  | "stable_token"
  | "media/uploadimg"
  | "material/add_material"
  | "material/del_material"
  | "draft/add"
  | "draft/update"
  | "draft/get"
  | "draft/delete"
  | "draft/count"
  | "freepublish/getarticle"
  | "freepublish/delete";

export type Failure =
  /** 微信风格的业务错误（HTTP 200 + errcode）。 */
  | { kind: "errcode"; errcode: number; errmsg?: string; status?: number }
  /** 任意原始响应体（测非 JSON / 异常响应）。 */
  | { kind: "raw"; status: number; body: string; contentType?: string }
  /** 直接断开连接：模拟网络中断，客户端应视为「结果未知」。 */
  | { kind: "destroy" }
  /** 永不响应：触发客户端超时。 */
  | { kind: "hang" };

export type RecordedRequest = {
  endpoint: Endpoint;
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  text: string;
  rawBody: Buffer;
  json?: unknown;
  /** multipart 请求里解析出的文件名。 */
  fileNames: string[];
  at: number;
};

export type MockWechatOptions = {
  token?: string;
  /** 每个端点的一次性/持续故障。 */
  failures?: Partial<Record<Endpoint, Failure>>;
  /** 收到请求时的钩子（在返回响应之前）。 */
  onRequest?: (request: RecordedRequest) => void | Promise<void>;
};

const ENDPOINTS: Endpoint[] = [
  "stable_token",
  "media/uploadimg",
  "material/add_material",
  "material/del_material",
  "draft/add",
  "draft/update",
  "draft/get",
  "draft/delete",
  "draft/count",
  "freepublish/getarticle",
  "freepublish/delete"
];

/** mock 里保存的草稿形状（尽量贴近微信真实返回，便于断言"哪些字段被保留"）。 */
export type MockDraft = {
  title?: string;
  author?: string;
  digest?: string;
  content?: string;
  content_source_url?: string;
  thumb_media_id?: string;
  show_cover_pic?: 0 | 1;
  cover_info?: Record<string, unknown>;
  need_open_comment?: 0 | 1;
  only_fans_can_comment?: 0 | 1;
  article_type?: string;
};

export type MockPublished = {
  article_id: string;
  title?: string;
  content?: string;
  index?: number;
};

export class MockWechatServer {
  readonly requests: RecordedRequest[] = [];
  readonly drafts = new Map<string, MockDraft>();
  readonly published = new Map<string, MockPublished>();
  /** 已删除的永久素材 / 已删除的草稿 id，便于断言"真的删了"。 */
  readonly deletedMaterials: string[] = [];
  readonly deletedPublished: string[] = [];

  private readonly sockets = new Set<Socket>();
  private server?: ReturnType<typeof createServer>;
  private base = "";
  private tokenCounter = 0;
  private mediaCounter = 0;

  constructor(private readonly options: MockWechatOptions = {}) {}

  get url(): string {
    if (!this.base) throw new Error("mock server 尚未 start()");
    return this.base;
  }

  get tokenRequests(): number {
    return this.requests.filter((r) => r.endpoint === "stable_token").length;
  }

  count(endpoint: Endpoint): number {
    return this.requests.filter((r) => r.endpoint === endpoint).length;
  }

  requestsFor(endpoint: Endpoint): RecordedRequest[] {
    return this.requests.filter((r) => r.endpoint === endpoint);
  }

  /** 制造一次故障（默认单次，收到后自动清除）。 */
  failOnce(endpoint: Endpoint, failure: Failure): void {
    this.options.failures = { ...this.options.failures, [endpoint]: failure };
  }

  /** 设置请求钩子（在返回响应之前调用，可用来在副作用发生瞬间检查磁盘状态）。 */
  setOnRequest(hook: (request: RecordedRequest) => void | Promise<void>): void {
    this.options.onRequest = hook;
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  /** 预置一条草稿（模拟"用户已经在编辑器里编辑过"的线上状态）。 */
  seedDraft(mediaId: string, draft: MockDraft): void {
    this.drafts.set(mediaId, draft);
  }

  /** 预置一篇已发布文章。 */
  seedPublished(article: MockPublished): void {
    this.published.set(article.article_id, article);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.base = `http://127.0.0.1:${port}`;
    return this.base;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.server = undefined;
    this.base = "";
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base || "http://127.0.0.1");
    const endpoint = ENDPOINTS.find((candidate) => url.pathname.endsWith(`/cgi-bin/${candidate}`));

    const rawBody = await readBody(req);
    const text = rawBody.toString("utf8");
    const request: RecordedRequest = {
      endpoint: endpoint ?? "draft/count",
      method: req.method ?? "GET",
      pathname: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      text,
      rawBody,
      json: parseJson(text, req.headers["content-type"]),
      fileNames: [...text.matchAll(/filename="([^"]*)"/g)].map((match) => match[1]),
      at: Date.now()
    };
    this.requests.push(request);

    const failure = endpoint ? this.options.failures?.[endpoint] : undefined;
    if (failure) {
      delete this.options.failures![endpoint!];
      await this.options.onRequest?.(request);
      return this.applyFailure(failure, res);
    }

    if (!endpoint) {
      return sendJson(res, 404, { errcode: 40004, errmsg: "invalid media type" });
    }

    // 除 stable_token 外，微信所有接口都必须带 access_token。
    if (endpoint !== "stable_token") {
      const token = url.searchParams.get("access_token");
      if (!token || token !== (this.options.token ?? "MOCK_ACCESS_TOKEN")) {
        return sendJson(res, 200, { errcode: 40001, errmsg: "invalid credential, access_token is invalid or not latest" });
      }
    }

    await this.options.onRequest?.(request);

    switch (endpoint) {
      case "stable_token":
        this.tokenCounter += 1;
        return sendJson(res, 200, {
          access_token: this.options.token ?? "MOCK_ACCESS_TOKEN",
          expires_in: 7200
        });
      case "media/uploadimg":
        this.mediaCounter += 1;
        return sendJson(res, 200, { url: `${this.base}/mock/body-image-${this.mediaCounter}.png` });
      case "material/add_material": {
        this.mediaCounter += 1;
        const id = `MOCK_COVER_MEDIA_${this.mediaCounter}`;
        return sendJson(res, 200, { media_id: id, url: `${this.base}/mock/material-${this.mediaCounter}.jpg` });
      }
      case "material/del_material": {
        const mediaId = (request.json as { media_id?: string } | undefined)?.media_id ?? "";
        this.deletedMaterials.push(mediaId);
        return sendJson(res, 200, { errcode: 0, errmsg: "ok" });
      }
      case "draft/add": {
        const articles = (request.json as { articles?: Array<Record<string, unknown>> } | undefined)?.articles ?? [];
        const article = articles[0] ?? {};
        const mediaId = `MOCK_DRAFT_MEDIA_${this.drafts.size + 1}`;
        this.drafts.set(mediaId, {
          title: article.title as string | undefined,
          author: article.author as string | undefined,
          digest: article.digest as string | undefined,
          content: article.content as string | undefined,
          thumb_media_id: article.thumb_media_id as string | undefined
        });
        return sendJson(res, 200, { media_id: mediaId });
      }
      case "draft/update": {
        const body = request.json as { media_id?: string; index?: number; articles?: MockDraft | MockDraft[] } | undefined;
        const mediaId = body?.media_id ?? "";
        if (!this.drafts.has(mediaId)) return sendJson(res, 200, { errcode: 40007, errmsg: "invalid media_id" });
        const articles = Array.isArray(body?.articles) ? body!.articles! : [body?.articles as MockDraft];
        // 微信 update 是"替换这一篇的全部字段"，因此这里也整体覆盖（能验证调用方有没有把要保留的字段传回来）
        this.drafts.set(mediaId, { ...(articles[0] ?? {}) });
        return sendJson(res, 200, { errcode: 0, errmsg: "ok" });
      }
      case "draft/get": {
        const mediaId = (request.json as { media_id?: string } | undefined)?.media_id ?? "";
        const draft = this.drafts.get(mediaId);
        if (!draft) return sendJson(res, 200, { errcode: 40007, errmsg: "invalid media_id" });
        return sendJson(res, 200, { media_id: mediaId, news_item: [{ ...draft }] });
      }
      case "draft/delete": {
        const mediaId = (request.json as { media_id?: string } | undefined)?.media_id ?? "";
        if (!this.drafts.has(mediaId)) return sendJson(res, 200, { errcode: 40007, errmsg: "invalid media_id" });
        this.drafts.delete(mediaId);
        return sendJson(res, 200, { errcode: 0, errmsg: "ok" });
      }
      case "freepublish/getarticle": {
        const articleId = (request.json as { article_id?: string } | undefined)?.article_id ?? "";
        const article = this.published.get(articleId);
        if (!article) return sendJson(res, 200, { errcode: 40007, errmsg: "invalid article_id" });
        return sendJson(res, 200, {
          article_id: articleId,
          news_item: [{ title: article.title ?? "", content: article.content ?? "" }]
        });
      }
      case "freepublish/delete": {
        const articleId = (request.json as { article_id?: string } | undefined)?.article_id ?? "";
        if (!this.published.has(articleId)) return sendJson(res, 200, { errcode: 40007, errmsg: "invalid article_id" });
        this.published.delete(articleId);
        this.deletedPublished.push(articleId);
        return sendJson(res, 200, { errcode: 0, errmsg: "ok" });
      }
      case "draft/count":
        return sendJson(res, 200, { total_count: this.drafts.size });
    }
  }

  private applyFailure(failure: Failure, res: ServerResponse): void {
    switch (failure.kind) {
      case "errcode":
        return sendJson(res, failure.status ?? 200, {
          errcode: failure.errcode,
          errmsg: failure.errmsg ?? `mock errmsg ${failure.errcode}`
        });
      case "raw":
        res.writeHead(failure.status, { "Content-Type": failure.contentType ?? "text/plain" });
        res.end(failure.body);
        return;
      case "destroy":
        res.socket?.destroy();
        return;
      case "hang":
        return;
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(text: string, contentType?: string): unknown {
  if (!text) return undefined;
  if (contentType?.includes("application/json") || text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
