import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';

const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret });

/** 写一条记录到「想法池」多维表格 */
async function appendRecord(fields) {
  if (!config.ideasTable) return null;
  const response = await client.bitable.v1.appTableRecord.create({
    path: { app_token: config.baseToken, table_id: config.ideasTable },
    data: { fields },
  });
  return response?.data?.record?.record_id ?? null;
}

/** 每次问答自动沉淀：问题 + 回复 + 时间 */
export async function saveQA({ question, answer, messageId }) {
  const fields = {
    问题: question,
    助手回复: answer,
    时间: Date.now(),
    消息ID: messageId,
  };
  return appendRecord(fields);
}

/** 模型主动记录灵感时调用 */
export async function saveIdea({ topic, content, relatedCodes }) {
  const fields = {
    问题: content,
    助手回复: `（灵感记录，话题：${topic}）`,
    时间: Date.now(),
    话题: [topic],
  };
  if (relatedCodes?.length) fields.涉及标的 = relatedCodes.join(', ');
  return appendRecord(fields);
}
