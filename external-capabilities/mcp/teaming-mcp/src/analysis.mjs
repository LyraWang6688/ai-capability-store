/**
 * 分析：调用服务器，不再在本地跑引擎。
 *
 * ## 2026-10-15 的改动：删掉本地引擎副本
 *
 * 此前本包把引擎源码 vendored 在 `src/engine-src/`（由 `scripts/sync-engine.mjs`
 * 编译到 `dist/engine/`）。理由是"本包要能独立 npm 发布"。
 *
 * 代价很快就显现了：引擎在**两个仓库里各有一份**，改一边忘另一边就会漂移。
 * 当天就真实发生了一次——服务器加了 ABC 相关性甄别、修了 provider 的兜底模型名，
 * 而本包那份还是旧行为，且**没有任何机制会发现**。
 *
 * 现在改为：**引擎只有一份，在服务器上**。本包调
 * `POST /api/host/v1/analyze`，把逐字稿发过去，拿回分析结果。
 *
 * 换来的：
 *   · 物理上不可能再漂移
 *   · npm 包变薄很多（不再打包引擎，也没有构建步骤）
 *   · 服务器换模型、调提示词，用户不用重装
 *
 * 代价：需要联网；逐字稿会上传到服务器。
 *
 * ## 凭证
 *
 * 用 **host token**（接入码换来的），存在 `~/.teaming-mcp/host-token`。
 * 不再需要 `DOUBAO_API_KEY` —— 模型调用在服务器侧发生。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 服务器地址。可用环境变量覆盖（自建部署用）。 */
export const API_BASE_URL = (
  process.env.TEAMING_API_BASE_URL || 'https://meeting.bamamei.online'
).replace(/\/+$/, '');

/** host token 的存放位置。与 Skill 用同一个文件，两者可互换。 */
export const TOKEN_FILE = process.env.TEAMING_TOKEN_FILE
  || join(homedir(), '.teaming-mcp', 'host-token');

/** 没有接入码时给用户的申请入口（填姓名即可） */
export const ENROLL_URL = 'https://my.feishu.cn/share/base/form/shrcnlPdC7aoXczqLl3XkxGvWhc';

export class AnalysisError extends Error {
  constructor(message, { kind = 'analysis_failed', hint = null } = {}) {
    super(message);
    this.name = 'AnalysisError';
    this.kind = kind;
    this.hint = hint;
  }
}

/** 读本地 host token */
export function readHostToken() {
  if (process.env.TEAMING_HOST_TOKEN) return process.env.TEAMING_HOST_TOKEN.trim() || null;
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const value = readFileSync(TOKEN_FILE, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/** 存本地 host token（0600） */
export function writeHostToken(token) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

/**
 * 有没有凭证。
 *
 * 注意：**不再检查"有没有 LLM key"** —— 模型调用在服务器侧，本机不需要任何
 * 模型凭证。以前那句"缺少分析凭证。下一步：配置 DOUBAO_API_KEY"现在会把人
 * 引向错误的方向。
 */
export function analysisReadiness() {
  const problems = [];
  if (!readHostToken()) {
    problems.push(
      '还没有接入码换来的凭证。'
      + `下一步：填 ${ENROLL_URL} 申请接入码（只需填姓名），`
      + '约一分钟会收到飞书消息，拿到后把码告诉我就行。',
    );
  }
  return { ready: problems.length === 0, problems, apiBaseUrl: API_BASE_URL, tokenFile: TOKEN_FILE };
}

/** 体检展示用：不再有"本地模型端点"，改为展示服务器地址 */
export function providerSummary() {
  return {
    mode: 'server',
    apiBaseUrl: API_BASE_URL,
    hasToken: Boolean(readHostToken()),
  };
}

/**
 * 调服务器分析。transcript 必须是引擎能解析的 `姓名 MM:SS 发言` 文本。
 * 单次通常 60~120 秒。
 *
 * @param {string} transcript
 * @param {{ feishuMeetingId?: string|null, title?: string|null,
 *           clientRequestId?: string|null, signal?: AbortSignal }} [options]
 */
export async function analyze(transcript, options = {}) {
  if (!transcript || transcript.trim().length < 50) {
    throw new AnalysisError('逐字稿过短，不足以做判断。', { kind: 'transcript_too_short' });
  }

  const token = readHostToken();
  if (!token) {
    const { problems } = analysisReadiness();
    throw new AnalysisError(problems.join('\n'), { kind: 'not_ready' });
  }

  const body = {
    transcript,
    // 要完整分析结果：本包用它渲染云文档与摘要。
    // 绝大多数调用方只要 reportUrl，所以服务器默认不返回全文。
    includeAnalysis: true,
  };
  if (options.feishuMeetingId) body.feishuMeetingId = String(options.feishuMeetingId);
  if (options.title) body.title = String(options.title);
  if (options.clientRequestId) body.clientRequestId = String(options.clientRequestId);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/api/host/v1/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    throw new AnalysisError(
      `连不上分析服务器（${API_BASE_URL}）：${String(error?.message || error)}`,
      { kind: 'network_failed' },
    );
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new AnalysisError(
      `服务器返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`,
      { kind: 'bad_response' },
    );
  }

  if (!response.ok || !payload?.ok) {
    const code = payload?.error?.code || `http_${response.status}`;
    const message = payload?.error?.message || `分析失败（HTTP ${response.status}）`;
    const hint = payload?.error?.hint || null;

    if (response.status === 401 || response.status === 403) {
      throw new AnalysisError(
        `${message}\n接入码可能已失效或过期。下一步：重新申请一个（${ENROLL_URL}）。`,
        { kind: 'unauthorized', hint },
      );
    }

    throw new AnalysisError(message, { kind: code, hint });
  }

  const analysis = payload.analysisResult;
  if (!analysis) {
    throw new AnalysisError(
      '服务器没有返回分析结果（服务端可能版本较旧，不支持 includeAnalysis）。',
      { kind: 'no_analysis_in_response' },
    );
  }

  return {
    ...analysis,
    server: {
      reportUrl: payload.reportUrl || null,
      reportPublicId: payload.reportPublicId || null,
      reused: Boolean(payload.reused),
      zone: payload.zone ?? analysis?.teamState?.zone ?? null,
    },
  };
}
