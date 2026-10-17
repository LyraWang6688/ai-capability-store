import { listIdeas, saveIdea, searchIdeas, updateIdea } from '../ideas.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'save_idea',
    description:
      '把一条内容写入「想法池」：可以是问答记录（问题+回复），也可以是灵感。' +
      '用户说「记一下」「记住这个」「帮我记录」时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户的问题或灵感内容' },
        answer: { type: 'string', description: '助手回复（问答场景）' },
        topic: { type: 'string', description: '话题，如 AI / 人口老龄化 / 红利' },
        relatedCodes: { type: 'array', items: { type: 'string' }, description: '相关标的代码' },
        type: { type: 'string', enum: ['问答', '灵感', '复盘'], description: '记录类型，默认问答' },
      },
      required: ['question'],
    },
  },
  {
    name: 'list_ideas',
    description: '按状态、类型、话题、时间范围列出想法池记录，最近的在前。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['待复核', '已采纳', '已忽略'] },
        type: { type: 'string', enum: ['问答', '灵感', '复盘'] },
        topic: { type: 'string' },
        days: { type: 'number', description: '只看最近 N 天' },
        limit: { type: 'number', description: '返回条数，默认 20' },
      },
    },
  },
  {
    name: 'search_ideas',
    description: '在想法池里按关键词搜索问题、回复、标的、话题。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'update_idea',
    description: '更新一条想法记录的状态或话题（用于标记已采纳 / 已忽略）。',
    inputSchema: {
      type: 'object',
      properties: {
        recordId: { type: 'string' },
        status: { type: 'string', enum: ['待复核', '已采纳', '已忽略'] },
        topic: { type: 'string' },
      },
      required: ['recordId'],
    },
  },
];

export async function callTool(name: string, args: Record<string, unknown>) {
  try {
    let text: string;
    switch (name) {
      case 'save_idea': {
        const id = await saveIdea({
          question: String(args.question ?? ''),
          answer: args.answer ? String(args.answer) : undefined,
          topic: args.topic ? String(args.topic) : undefined,
          relatedCodes: Array.isArray(args.relatedCodes) ? args.relatedCodes.map(String) : undefined,
          type: (args.type as '问答' | '灵感' | '复盘' | undefined) ?? '问答',
        });
        text = `已写入想法池，record_id=${id}`;
        break;
      }
      case 'list_ideas':
        text = await listIdeas({
          status: args.status as never,
          type: args.type as never,
          topic: args.topic ? String(args.topic) : undefined,
          days: args.days ? Number(args.days) : undefined,
          limit: args.limit ? Number(args.limit) : undefined,
        });
        break;
      case 'search_ideas':
        text = await searchIdeas({ keyword: String(args.keyword ?? ''), limit: args.limit ? Number(args.limit) : undefined });
        break;
      case 'update_idea':
        text = await updateIdea({
          recordId: String(args.recordId ?? ''),
          status: args.status as never,
          topic: args.topic ? String(args.topic) : undefined,
        });
        break;
      default:
        return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `执行失败：${(error as Error).message}` }], isError: true };
  }
}
