/**
 * 持仓价格同步完成通知 —— 同步成功后给王颖发一条飞书单聊消息。
 *
 * 目的：把「价格同步完成」作为一个事件信号推给豆包，豆包侧监听该消息后
 * 触发 investdesk-portfolio 生成持仓日报（事件推送型，替代固定 21:00 定时）。
 *
 * 设计：
 * - 独立凭证（NOTIFY_APP_ID / NOTIFY_APP_SECRET），与写表的 FEISHU_* 分离；
 * - 通知失败只警告，不影响价格同步主流程的退出码；
 * - 文案固定包含触发关键词「持仓价格同步完成」，豆包事件监听按它命中。
 */

import { FEISHU_BASE_URL } from './config.ts';

const DEFAULT_BASE_URL = FEISHU_BASE_URL;

export interface NotifyOptions {
  appId: string;
  appSecret: string;
  userId: string; // 接收人 open_id
  baseUrl?: string;
}

/** 换取 tenant_access_token（无缓存，通知是低频动作） */
async function getTenantToken(appId: string, appSecret: string, baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const payload = (await response.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败（code=${payload.code}）：${payload.msg ?? 'unknown'}`);
  }
  return payload.tenant_access_token;
}

/** 给指定用户发一条纯文本单聊消息 */
export async function sendNotifyMessage(
  options: NotifyOptions,
  text: string,
): Promise<void> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const token = await getTenantToken(options.appId, options.appSecret, baseUrl);

  const response = await fetch(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: options.userId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const payload = (await response.json()) as { code?: number; msg?: string; data?: { message_id?: string } };
  if (payload.code !== 0) {
    throw new Error(`发送飞书消息失败（code=${payload.code}）：${payload.msg ?? 'unknown'}`);
  }
  console.log(`[notify] 已发送同步完成通知（message_id=${payload.data?.message_id ?? '?'}）`);
}

/** 组装通知文案：固定含触发关键词，供豆包事件任务命中 */
export function buildSyncNotifyText(summary: {
  total: number;
  written: number;
  failures: number;
}): string {
  const time = new Date().toISOString();
  const lines = [
    `📊 持仓价格同步完成，触发今日持仓分析`,
    `时间：${time}`,
    `覆盖 ${summary.total} 只 · 成功写入 ${summary.written} 只 · 失败 ${summary.failures} 只`,
  ];
  return lines.join('\n');
}
