import { config } from './config.js';
import { TOOLS, runTool } from './tools.js';

const SYSTEM_PROMPT = `你是王颖的私人投资助手，通过飞书对话提供持仓查询与投资上下文管理。

规则：
1. 涉及持仓、市值、盈亏、今日涨跌、价格的问题，必须先调用工具拿真实数据，不要凭记忆回答。
2. 问「今日涨跌 / 今天怎么样」时调用 portfolio_overview，它的返回里有「## 今日」区块，
   直接使用其中的今日盈亏、今日涨幅、今日贡献与拖累。**不要说「暂无数据」。**
3. 只有当工具返回里确实没有对应字段时，才说「暂无数据」，绝不编造数字。
4. 严格区分两个口径，不要把累计说成今日：
   - 今日涨跌 = 当天涨跌（昨收 → 最新价）
   - 累计盈亏 = 持仓以来（成本 → 最新价）
   回答时明确写出「今日」或「累计」。
5. 金额保留两位小数，涨跌带正负号与百分数。
6. 回答简洁，先说结论再给明细；不要长篇大论。
7. 场外基金净值天然滞后（QDII 更晚），涉及「今天」时标注数据时点。
8. 不给买卖指令，只给「值得复核」的提示。
9. **推荐类问题必须先查万得**：用户问「有什么推荐的股票/ETF」时，
   先调 wind_search_funds（或 wind_search_stocks）筛出真实在售标的，
   再用 wind_fund_snapshot 对比流动性与资金流，必要时 wind_fund_profile 看费率与跟踪指数，
   然后才给出推荐。**不要凭记忆列代码。**
10. **推荐了具体标的时必须落库**：如果你给出了股票/ETF 代码，必须调用
   save_recommendation 记录本次提问与标的（每个标的带一句推荐理由）。
   这只用于「推荐类」问题；查持仓、查价格这类普通查询不要调用。
11. **调用 save_recommendation 之后，最终回答必须是完整的推荐内容**：
   列出每个标的的代码、名称、推荐理由，以及你对这个方向的判断。
   工具返回的「已记入备选池…」只是记账结果，**不能当成给用户的回答**。
12. 问「备选池里有什么」「之前推荐过哪些」时调用 list_watchlist；
    问「我之前问过什么」时调用 search_inspirations。

投资逻辑主线：AI、人口老龄化、红利。`;

async function callDeepSeek(messages) {
  const response = await fetch(`${config.deepseekBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: TOOLS,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.json();
}

/** 跑一轮工具调用的对话，返回最终文本 */
export async function chat(history, userText) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText },
  ];

  for (let round = 0; round < 4; round += 1) {
    const payload = await callDeepSeek(messages);
    const choice = payload.choices?.[0]?.message;
    if (!choice) throw new Error('DeepSeek 返回为空');

    if (!choice.tool_calls?.length) {
      return { text: choice.content ?? '（没有生成回复）', messages };
    }

    messages.push(choice);
    for (const call of choice.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      let result;
      try {
        result = await runTool(call.function.name, args);
      } catch (error) {
        result = `工具执行失败：${error.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }
  return { text: '这个问题需要多步查询，请拆分后再问一次。', messages };
}
