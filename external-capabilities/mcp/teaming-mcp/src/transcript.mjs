/**
 * 逐字稿归一化。
 *
 * ## 为什么需要它
 *
 * 原设计里，逐字稿总是由本 MCP 自己经 lark-cli 取，格式天然就是引擎能吃的
 * `姓名 MM:SS 内容`，所以从不需要转换。
 *
 * 但 2026-10-14 确定了新架构：**由宿主（豆包工作/WorkBuddy）取数，MCP 只做分析。**
 * 宿主取到的东西形态不受我们控制——可能是妙记导出的纯文本，也可能是从
 * 飞书文档抓来的 HTML，还可能夹着标题标签。
 *
 * 所以这里统一做三件事：
 *   1. HTML → 纯文本（**必须剥掉 `<title>`**，否则会粘到第一条发言上污染发言人姓名）
 *   2. 收敛空白与行结构
 *   3. 判断是否真的像逐字稿——不像就明确报错，而不是拿垃圾数据烧一次模型
 *
 * 第 3 点很重要：**不给不出结论**。逐字稿不合格时应直接告诉宿主"这份不能用"，
 * 而不是硬跑出一份看起来像报告的东西。
 */

/** 是否像 HTML（有标签或实体） */
export function looksLikeHtml(text) {
  if (typeof text !== 'string' || !text) return false;
  return /<\/?(p|div|br|span|title|html|body|table|tr|td|h[1-6])\b/i.test(text)
    || /&(nbsp|amp|lt|gt|quot|#\d+);/.test(text);
}

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

function decodeEntities(text) {
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/** HTML → 纯文本，按块级元素保留换行。 */
export function htmlToTranscript(html) {
  return decodeEntities(
    String(html)
      // title 必须先整个删掉：它不在 <body> 里，剥标签后会直接粘到第一条发言前面
      .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      // 块级结束标签 → 换行
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // 其余标签直接去掉
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * 判断"像不像逐字稿"。
 *
 * **解析的权威永远是引擎**（服务器侧 `src/lib/analysis/transcript.ts` 的 matchSpeakerLine），
 * 这里只做一道**粗筛**，目的是把「AI 摘要 / 会议纪要」这类东西挡在模型调用之前。
 *
 * 为什么不直接复制引擎的正则：它有十几个排除规则（日期、章节标题、文档元数据标签…），
 * 复制过来必然漂移。而**这里的假阳性（把不是逐字稿的放过去）代价很小——
 * 引擎自己会忽略认不出的行；假阴性（把真逐字稿拦下）代价很大——用户直接被拒绝。**
 * 所以刻意宽松。
 *
 * 两种真实形态都要认（实测 2026-10-14）：
 *
 *   祥子不爱胡妞 00:00:15.381      ← 妙记导出：时间戳单独一行，内容在下一行
 *   哈喽哈喽，老师，看一下啊。
 *
 *   张三：这个我来负责              ← 聊天式：姓名冒号内容，无时间戳
 */
const TIMESTAMP = /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?/;
const COLON_SPEAKER = /^.{1,32}?[：:]\s*\S/;

export function countSpeakerLines(text) {
  if (!text) return 0;
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (TIMESTAMP.test(line) || COLON_SPEAKER.test(line)))
    .length;
}

export class TranscriptError extends Error {
  constructor(message, { kind = 'bad_transcript' } = {}) {
    super(message);
    this.name = 'TranscriptError';
    this.kind = kind;
  }
}

/**
 * 归一化 + 校验。不合格直接抛 TranscriptError（带人话原因）。
 */
export function normalizeTranscript(raw, { minSpeakerLines = 5 } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new TranscriptError('逐字稿为空。请把妙记导出的文字转录稿传进来。', { kind: 'transcript_empty' });
  }

  const text = looksLikeHtml(raw) ? htmlToTranscript(raw) : raw.replace(/\r\n?/g, '\n').trim();
  const speakerLines = countSpeakerLines(text);

  if (speakerLines < minSpeakerLines) {
    throw new TranscriptError(
      `这不是可用的逐字稿（只认出 ${speakerLines} 条「姓名 时间 内容」形式的发言）。\n`
      + '  团队动力分析需要成员原始发言，不接受 AI 摘要或其他产物。\n'
      + '  请传妙记导出的文字转录稿（格式为每行「姓名 MM:SS 发言内容」）。',
      { kind: 'transcript_not_speaker_lines' }
    );
  }

  return { text, speakerLines };
}
