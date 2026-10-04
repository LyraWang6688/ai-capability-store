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

/** 检查分析所需的前置条件（只读，不联网） */
export function analysisReadiness() {
  const problems = [];
  if (!existsSync(ENGINE_PATH)) {
    problems.push(`分析引擎未构建（期望 ${ENGINE_PATH}）。下一步：npm run build`);
  }
  const key = process.env.DOUBAO_API_KEY || process.env.LLM_API_KEY || process.env.ARK_API_KEY;
  if (!key) {
    problems.push('缺少分析凭证。下一步：配置环境变量 DOUBAO_API_KEY');
  }
  return { ready: problems.length === 0, problems, enginePath: ENGINE_PATH };
}

export function loadEngine() {
  const { ready, problems } = analysisReadiness();
  if (!ready) throw new AnalysisError(problems.join('\n'), { kind: 'not_ready' });
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
