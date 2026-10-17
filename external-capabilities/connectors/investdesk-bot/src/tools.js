import { callTool } from 'investdesk-quotes/dist/mcp/tools.js';
import { callTool as callIdeaTool } from 'investdesk-ideas/dist/mcp/tools.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'portfolio_overview',
      description:
        '查询用户当前持仓汇总：总市值、总成本、累计盈亏、收益率、各平台分布，以及市值前 N 只标的。' +
        '用户问「我的组合怎么样」「今天赚了多少」「持仓情况」「总资产」时调用。',
      parameters: {
        type: 'object',
        properties: {
          top: { type: 'number', description: '返回市值前几名标的，默认 5，最多 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_quotes',
      description:
        '查询指定证券或基金的最新价格 / 单位净值。代码 6 位，场外基金自动走净值接口。' +
        '用户问「XXX 现在多少钱」「510300 价格」时调用。',
      parameters: {
        type: 'object',
        properties: {
          codes: {
            type: 'array',
            items: { type: 'string' },
            description: '6 位代码数组，例如 ["510300","008284"]',
          },
        },
        required: ['codes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_ideas',
      description:
        '列出想法池的历史记录（问答与灵感），最近的在前。' +
        '用户问「我之前问过什么」「我记录过哪些想法」时调用。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '只看最近 N 天' },
          topic: { type: 'string', description: '按话题过滤' },
          limit: { type: 'number', description: '条数，默认 10' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_ideas',
      description: '在想法池里按关键词搜索历史记录。用户问「我之前是不是提过 XXX」时调用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_idea',
      description:
        '把一条投资灵感 / 关注点写入多维表格。用户说「记一下」「帮我记住」「记录这个想法」时调用。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '关注话题，例如 AI算力 / 红利 / 人口老龄化' },
          content: { type: 'string', description: '灵感原文或要点' },
          relatedCodes: {
            type: 'array',
            items: { type: 'string' },
            description: '相关标的代码（可选）',
          },
        },
        required: ['topic', 'content'],
      },
    },
  },
];

export async function runTool(name, args) {
  switch (name) {
    case 'portfolio_overview': {
      const result = await callTool('portfolio_overview', { top: args.top ?? 5 });
      return result.content?.[0]?.text ?? '查询失败';
    }
    case 'lookup_quotes': {
      const result = await callTool('lookup_quotes', { codes: args.codes ?? [] });
      return result.content?.[0]?.text ?? '查询失败';
    }
    case 'list_ideas': {
      const result = await callIdeaTool('list_ideas', {
        days: args.days ? Number(args.days) : undefined,
        topic: args.topic ? String(args.topic) : undefined,
        limit: args.limit ? Number(args.limit) : 10,
      });
      return result.content?.[0]?.text ?? '查询失败';
    }
    case 'search_ideas': {
      const result = await callIdeaTool('search_ideas', {
        keyword: String(args.keyword ?? ''),
        limit: args.limit ? Number(args.limit) : 5,
      });
      return result.content?.[0]?.text ?? '查询失败';
    }
    case 'save_idea': {
      const result = await callIdeaTool('save_idea', {
        question: args.content ?? '',
        topic: args.topic ?? '其他',
        relatedCodes: args.relatedCodes ?? [],
        type: '灵感',
      });
      return result.content?.[0]?.text ?? '记录失败';
    }
    default:
      return `未知工具：${name}`;
  }
}
