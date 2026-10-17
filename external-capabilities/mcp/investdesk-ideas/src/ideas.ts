import { createRecord, listRecords, textOf, updateRecord, type IdeaRecord } from './feishu.ts';

export type IdeaType = '问答' | '灵感' | '复盘';
export type IdeaStatus = '待复核' | '已采纳' | '已忽略';

export interface SaveIdeaInput {
  question?: string;
  answer?: string;
  topic?: string;
  relatedCodes?: string[];
  messageId?: string;
  type?: IdeaType;
}

export async function saveIdea(input: SaveIdeaInput): Promise<string> {
  const fields: Record<string, unknown> = {
    问题: input.question ?? '',
    助手回复: input.answer ?? '',
    时间: Date.now(),
    类型: input.type ?? '问答',
    状态: '待复核',
  };
  if (input.topic) fields.话题 = [input.topic];
  if (input.relatedCodes?.length) fields.涉及标的 = input.relatedCodes.join(', ');
  if (input.messageId) fields.消息ID = input.messageId;
  return createRecord(fields);
}

export interface ListIdeaInput {
  status?: IdeaStatus;
  type?: IdeaType;
  topic?: string;
  days?: number;
  limit?: number;
}

export async function listIdeas(input: ListIdeaInput): Promise<string> {
  const conditions: Array<{ field_name: string; operator: string; value: string[] }> = [];
  if (input.status) conditions.push({ field_name: '状态', operator: 'is', value: [input.status] });
  if (input.type) conditions.push({ field_name: '类型', operator: 'is', value: [input.type] });
  if (input.topic) conditions.push({ field_name: '话题', operator: 'contains', value: [input.topic] });
  if (input.days) {
    const since = Date.now() - input.days * 86400_000;
    conditions.push({ field_name: '时间', operator: 'isGreater', value: [String(since)] });
  }
  const filter = conditions.length
    ? JSON.stringify({ conjunction: 'and', conditions })
    : undefined;

  const records = (await listRecords({ pageSize: input.limit ?? 20, filter })).sort(byTimeDesc);
  if (records.length === 0) return '没有符合条件的记录。';
  return records.map(formatRecord).join('\n---\n');
}

export async function searchIdeas(input: { keyword: string; limit?: number }): Promise<string> {
  const keyword = (input.keyword ?? '').trim();
  if (!keyword) return '请提供搜索关键词。';
  // 飞书不支持下推全文检索，这里拉最近记录后本地过滤（池子规模小，够用）
  const records = (await listRecords({ pageSize: 200 })).sort(byTimeDesc);
  const hit = records.filter((record) => {
    const haystack = [textOf(record.问题), textOf(record.助手回复), textOf(record.涉及标的), textOf(record.话题)].join(' ');
    return haystack.includes(keyword);
  });
  if (hit.length === 0) return `没有找到包含「${keyword}」的记录。`;
  return hit.slice(0, input.limit ?? 10).map(formatRecord).join('\n---\n');
}

export async function updateIdea(input: { recordId: string; status?: IdeaStatus; topic?: string }): Promise<string> {
  if (!input.recordId) return '缺少 recordId。';
  const fields: Record<string, unknown> = {};
  if (input.status) fields.状态 = input.status;
  if (input.topic) fields.话题 = [input.topic];
  if (Object.keys(fields).length === 0) return '没有要更新的字段。';
  await updateRecord(input.recordId, fields);
  return `已更新记录 ${input.recordId}`;
}

function byTimeDesc(a: IdeaRecord, b: IdeaRecord): number {
  return Number(b.时间 ?? 0) - Number(a.时间 ?? 0);
}

function formatRecord(record: IdeaRecord): string {
  const time = record.时间 ? new Date(Number(record.时间)).toISOString().slice(0, 16).replace('T', ' ') : '';
  const lines = [
    `【${time}】类型=${textOf(record.类型)} 状态=${textOf(record.状态)} 话题=${textOf(record.话题) || '-'}`,
    `问题：${textOf(record.问题)}`,
    `回复：${textOf(record.助手回复).slice(0, 300)}`,
  ];
  const codes = textOf(record.涉及标的);
  if (codes) lines.push(`标的：${codes}`);
  lines.push(`record_id=${String(record.record_id ?? '')}`);
  return lines.join('\n');
}
