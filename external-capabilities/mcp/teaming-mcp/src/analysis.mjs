/**
 * 分析引擎加载与调用
 *
 * 引擎源码 vendored 在 src/engine-src/（从 teaming-bot 同步），
 * 由 scripts/sync-engine.mjs 编译到 dist/engine/。
 *
 * 为什么要 vendored 而不是依赖 teaming-bot：
 * 本包要能独立 npm 发布；但也因此会和上游漂移，
 * 所以保留 sync 脚本并在 HANDOFF.md 里写明同步时机。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export const ENGINE_PATH = process.env.TEAMING_ENGINE
  || join(ROOT, 'dist', 'engine', 'lib', 'analysis', 'engine.js');

export class AnalysisError extends Error {
  constructor(message, { kind = 'analysis_failed' } = {}) {
    super(message);
    this.name = 'AnalysisError';
    this.kind = kind;
  }
}

/**
 * 方舟（Ark）公开端点。引擎的 `getBaseUrl()` **没有内置默认值**，
 * 不配 `DOUBAO_BASE_URL` 就会在分析时抛
 * 「未配置 LLM_API_KEY/LLM_BASE_URL…」，整场分析降级成 basic_fallback。
 *
 * 而连接器配置文档过去只写了 `DOUBAO_API_KEY`——于是每个照文档配置的用户
 * 都会踩到"体检通过、分析降级"。2026-10-14 在豆包工作里实测时正是如此。
 *
 * 这里补一个默认值（仍可被环境变量覆盖），让"只配一个 key"就能跑通。
 */
export const DEFAULT_DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/** 引擎读取 process.env，因此必须在调用前落到位。 */
export function applyProviderDefaults() {
  if (!process.env.DOUBAO_BASE_URL && !process.env.LLM_BASE_URL && !process.env.ARK_BASE_URL) {
    process.env.DOUBAO_BASE_URL = DEFAULT_DOUBAO_BASE_URL;
  }
}

function resolveProviderConfig() {
  const key = process.env.LLM_API_KEY || process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  const explicit = process.env.LLM_BASE_URL || process.env.DOUBAO_BASE_URL || process.env.ARK_BASE_URL;
  const baseUrl = explicit || DEFAULT_DOUBAO_BASE_URL;
  const model = process.env.ANALYSIS_MODEL || process.env.DOUBAO_MODEL || '';
  return { key, baseUrl, model, baseUrlIsDefault: !explicit };
}

/** 检查分析所需的前置条件（只读，不联网） */
export function analysisReadiness() {
  const problems = [];
  if (!existsSync(ENGINE_PATH)) {
    problems.push(`分析引擎未构建（期望 ${ENGINE_PATH}）。下一步：npm run build`);
  }
  const { key, baseUrl } = resolveProviderConfig();
  if (!key) {
    problems.push('缺少分析凭证。下一步：配置环境变量 DOUBAO_API_KEY');
  }
  return { ready: problems.length === 0, problems, enginePath: ENGINE_PATH, baseUrl };
}

/** 体检展示用：当前实际生效的模型端点与模型。 */
export function providerSummary() {
  const { baseUrl, baseUrlIsDefault, model } = resolveProviderConfig();
  return {
    baseUrl,
    baseUrlIsDefault,
    model: model || 'doubao-seed-2-0-pro-260215（引擎默认）',
  };
}

export function loadEngine() {
  const { ready, problems } = analysisReadiness();
  if (!ready) throw new AnalysisError(problems.join('\n'), { kind: 'not_ready' });
  applyProviderDefaults();
  const mod = require(ENGINE_PATH);
  if (typeof mod.analyzeTranscript !== 'function') {
    throw new AnalysisError('分析引擎缺少 analyzeTranscript 导出，可能版本不匹配。', { kind: 'bad_engine' });
  }
  return mod.analyzeTranscript;
}

/**
 * 跑一次分析。transcript 必须是引擎能解析的 `姓名 MM:SS 发言` 文本。
 * 单次通常 60~120 秒。
 */
export async function analyze(transcript) {
  const analyzeTranscript = loadEngine();
  if (!transcript || transcript.trim().length < 50) {
    throw new AnalysisError('逐字稿过短，不足以做判断。', { kind: 'transcript_too_short' });
  }
  return analyzeTranscript(transcript);
}
