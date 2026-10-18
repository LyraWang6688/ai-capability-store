import { fundFlow, indexSnapshot, marketNews, sectorRanking } from '../market.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'sector_ranking',
    description:
      '行业/概念板块涨跌排行，带主力资金净额。用户问「今天哪些板块涨得好」「什么行业强」时调用。' +
      '返回的是 T 日收盘后的数据。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['行业', '概念'], description: '板块类型，默认行业' },
        direction: { type: 'string', enum: ['涨', '跌'], description: '涨幅榜或跌幅榜，默认涨幅' },
        limit: { type: 'number', description: '返回条数，默认 10，最多 30' },
      },
    },
  },
  {
    name: 'fund_flow',
    description: '查询个股或 ETF 最近一日的主力资金流（主力净流入、超大单、大单）。用户问「资金在流入还是流出」时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        codes: { type: 'array', items: { type: 'string' }, description: '6 位代码，最多 5 个' },
      },
      required: ['codes'],
    },
  },
  {
    name: 'market_news',
    description: '财经快讯（东方财富 7×24 快讯）。用户问「最近有什么消息」「有没有相关政策」时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '条数，默认 10' },
        keyword: { type: 'string', description: '关键词过滤，如 AI、算力、半导体' },
      },
    },
  },
  {
    name: 'index_snapshot',
    description: '主要指数快照（上证、深证、创业板、科创50、沪深300、中证500）。用户问「大盘怎么样」时调用。',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function callTool(name: string, args: Record<string, unknown>) {
  try {
    let text: string;
    switch (name) {
      case 'sector_ranking':
        text = await sectorRanking({
          type: args.type as '行业' | '概念' | undefined,
          direction: args.direction as '涨' | '跌' | undefined,
          limit: args.limit ? Number(args.limit) : undefined,
        });
        break;
      case 'fund_flow':
        text = await fundFlow({ codes: Array.isArray(args.codes) ? args.codes.map(String) : [] });
        break;
      case 'market_news':
        text = await marketNews({
          limit: args.limit ? Number(args.limit) : undefined,
          keyword: args.keyword ? String(args.keyword) : undefined,
        });
        break;
      case 'index_snapshot':
        text = await indexSnapshot();
        break;
      default:
        return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `获取失败：${(error as Error).message}` }], isError: true };
  }
}
