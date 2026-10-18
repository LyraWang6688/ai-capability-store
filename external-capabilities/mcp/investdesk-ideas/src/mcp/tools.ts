import { listWatchlist, saveRecommendation, searchInspirations, updateWatchlist } from '../ideas.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'save_recommendation',
    description:
      '记录一次「推荐标的」：用户问了某话题/行业，你给出了具体的股票或 ETF。' +
      '会写入灵感记录（问题+回复），并把每个标的沉淀到备选池：已有的提及次数+1、更新最近提及、追加理由，' +
      '并在标的上反向关联这次提问。**只在你确实推荐了具体标的时调用**，普通查询不用调用。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户的原问题' },
        answer: { type: 'string', description: '你给出的完整回复' },
        topic: { type: 'string', description: '话题，如 AI / 人口老龄化 / 红利 / 其他' },
        instruments: {
          type: 'array',
          description: '推荐的具体标的列表',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: '6 位代码' },
              name: { type: 'string', description: '名称' },
              type: { type: 'string', enum: ['股票', 'ETF', 'LOF', 'REIT', '场外基金', '其他'] },
              reason: { type: 'string', description: '这次推荐它的理由' },
            },
            required: ['code'],
          },
        },
      },
      required: ['question', 'instruments'],
    },
  },
  {
    name: 'list_watchlist',
    description: '查看备选池：每个标的的提及次数、首次/最近提及、状态、最近推荐理由。按提及次数排序。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['观察中', '已买入', '已忽略'] },
        keyword: { type: 'string', description: '按代码/名称/理由过滤' },
        limit: { type: 'number', description: '条数，默认 20' },
      },
    },
  },
  {
    name: 'search_inspirations',
    description: '搜索历史灵感记录（我问过什么、你答了什么），按关键词匹配。',
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
    name: 'update_watchlist',
    description: '修改备选池里某个标的的状态（观察中 / 已买入 / 已忽略）。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '6 位代码' },
        recordId: { type: 'string', description: '也可以直接给 record_id' },
        status: { type: 'string', enum: ['观察中', '已买入', '已忽略'] },
      },
    },
  },
];

export async function callTool(name: string, args: Record<string, unknown>) {
  try {
    let text: string;
    switch (name) {
      case 'save_recommendation':
        text = await saveRecommendation({
          question: String(args.question ?? ''),
          answer: args.answer ? String(args.answer) : undefined,
          topic: args.topic ? String(args.topic) : undefined,
          instruments: Array.isArray(args.instruments) ? (args.instruments as never[]) : [],
        });
        break;
      case 'list_watchlist':
        text = await listWatchlist({
          status: args.status as never,
          keyword: args.keyword ? String(args.keyword) : undefined,
          limit: args.limit ? Number(args.limit) : undefined,
        });
        break;
      case 'search_inspirations':
        text = await searchInspirations({
          keyword: String(args.keyword ?? ''),
          limit: args.limit ? Number(args.limit) : undefined,
        });
        break;
      case 'update_watchlist':
        text = await updateWatchlist({
          code: args.code ? String(args.code) : undefined,
          recordId: args.recordId ? String(args.recordId) : undefined,
          status: args.status as never,
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
