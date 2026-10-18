import { callTool } from 'investdesk-quotes/dist/mcp/tools.js';
import { callTool as callIdeaTool } from 'investdesk-ideas/dist/mcp/tools.js';
import { fundProfile, fundSnapshot, searchFunds, searchStocks } from './wind.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'portfolio_overview',
      description:
        '查询用户当前持仓汇总：总市值、总成本、累计盈亏、收益率、各平台分布，以及市值前 N 只标的。' +
        '返回里还包含「## 今日」区块：今日盈亏、今日涨幅、今日贡献与拖累。' +
        '用户问「我的组合怎么样」「今天赚了多少」「今日涨跌」「持仓情况」「总资产」时都要调用。',
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
      name: 'wind_search_funds',
      description:
        '用自然语言筛选全市场基金/ETF（万得权威数据）。推荐 ETF 前先调这个，拿到真实在售的标的与跟踪指数。' +
        '例：question="跟踪人工智能主题的ETF"。**每次调用消耗 Wind 积分**，不要滥用。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: '自然语言筛选条件' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wind_fund_snapshot',
      description:
        '批量查询 ETF/LOF 行情快照：最新价、涨跌幅、成交额、换手率、当日与近5日主力净流入。' +
        '筛选出候选后用它对比流动性与资金流向。',
      parameters: {
        type: 'object',
        properties: {
          codes: { type: 'array', items: { type: 'string' }, description: '6 位代码，最多 10 个' },
        },
        required: ['codes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wind_fund_profile',
      description: '查询单只基金的档案：投资类型、跟踪指数、管理费率、基金经理、成立日期。推荐时用它核实标的。',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '6 位代码' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wind_search_stocks',
      description:
        '用自然语言筛选 A 股个股（万得权威数据）。推荐个股前先调这个。**消耗 Wind 积分**，不要滥用。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: '自然语言筛选条件' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_watchlist',
      description:
        '查看备选池：每个标的的提及次数、首次/最近提及、状态、最近推荐理由，按提及次数排序。' +
        '用户问「备选池里有什么」「之前推荐过哪些标的」时调用。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['观察中', '已买入', '已忽略'] },
          keyword: { type: 'string', description: '按代码/名称/理由过滤' },
          limit: { type: 'number', description: '条数，默认 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_inspirations',
      description: '搜索历史灵感记录（我问过什么、你答了什么）。用户问「我之前问过什么」时调用。',
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
      name: 'save_recommendation',
      description:
        '**当你推荐了具体的股票或 ETF 时，必须调用这个工具**，把标的沉淀进备选池。' +
        '会记录本次提问（灵感记录），并更新每个标的的提及次数、最近提及、推荐理由，建立双向关联。' +
        '回答完后调用一次即可，不要对普通查询调用。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '用户的原问题' },
          answer: { type: 'string', description: '你给出的完整回复' },
          topic: { type: 'string', description: '话题：AI / 人口老龄化 / 红利 / 其他' },
          instruments: {
            type: 'array',
            description: '推荐的具体标的',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string', description: '6 位代码' },
                name: { type: 'string' },
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
  },
  {
    type: 'function',
    function: {
      name: 'update_watchlist',
      description: '修改备选池里某个标的的状态（观察中 / 已买入 / 已忽略）。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          status: { type: 'string', enum: ['观察中', '已买入', '已忽略'] },
        },
        required: ['code', 'status'],
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
    case 'wind_search_funds': {
      try {
        return await searchFunds(String(args.question ?? ''));
      } catch (error) {
        return `Wind 暂时不可用（${error.message}），请基于已有信息回答，并说明数据来源受限。`;
      }
    }
    case 'wind_fund_snapshot': {
      try {
        return await fundSnapshot(Array.isArray(args.codes) ? args.codes.map(String) : []);
      } catch (error) {
        return `Wind 暂时不可用（${error.message}）`;
      }
    }
    case 'wind_fund_profile': {
      try {
        return await fundProfile(String(args.code ?? ''));
      } catch (error) {
        return `Wind 暂时不可用（${error.message}）`;
      }
    }
    case 'wind_search_stocks': {
      try {
        return await searchStocks(String(args.question ?? ''));
      } catch (error) {
        return `Wind 暂时不可用（${error.message}），请基于已有信息回答，并说明数据来源受限。`;
      }
    }
    case 'list_watchlist': {
      const result = await callIdeaTool('list_watchlist', {
        status: args.status,
        keyword: args.keyword,
        limit: args.limit ? Number(args.limit) : undefined,
      });
      return result.content?.[0]?.text ?? '查询失败';
    }
    case 'search_inspirations': {
      const result = await callIdeaTool('search_inspirations', {
        keyword: String(args.keyword ?? ''),
        limit: args.limit ? Number(args.limit) : undefined,
      });
      return result.content?.[0]?.text ?? '查询失败';
    }
    case 'save_recommendation': {
      const result = await callIdeaTool('save_recommendation', {
        question: String(args.question ?? ''),
        answer: args.answer,
        topic: args.topic,
        instruments: args.instruments ?? [],
      });
      const detail = result.content?.[0]?.text ?? '记录失败';
      // 关键：不能让模型把「记录结果」当成给用户的回答
      return `${detail}\n\n（记录已完成。现在请把完整的推荐内容发给用户：每个标的的代码、名称、推荐理由，以及你对这个方向的判断。不要只回复记录结果。）`;
    }
    case 'update_watchlist': {
      const result = await callIdeaTool('update_watchlist', {
        code: args.code,
        status: args.status,
      });
      return result.content?.[0]?.text ?? '更新失败';
    }
    default:
      return `未知工具：${name}`;
  }
}
