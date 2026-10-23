#!/usr/bin/env node
/**
 * deepseek-invoice 的纯逻辑（不碰浏览器，方便单测）。
 *
 * 为什么单独拆出来：金额解析曾经把「读不到」和「读到 0」混成同一个分支 ——
 * 页面改版 / 金额未加载 → 读到 null → 被当成「本月无可开额度」静默跳过。
 * 这类失败分支需要一个不启动浏览器就能跑的测试，否则修完也没人守。
 */

/** 进程退出码。0 只留给「真的成功」与「明确读到 0」。 */
export const EXIT_CODES = {
  OK: 0,
  EXCEPTION: 1,
  AUTH_REQUIRED: 2,
  AMOUNT_EXCEEDED: 3,
  AMOUNT_UNREADABLE: 4,
  SUBMIT_UNVERIFIED: 5,
};

/**
 * 解析「可开票金额」文本。
 *
 * @param {*} text 页面上读到的最内层文本（可能为 null）
 * @returns {{kind: 'positive'|'zero'|'unreadable', value: number|null, raw: *}}
 *
 * - unreadable：null / 空串 / 匹配不到数字 / 解析出 NaN
 *               —— 页面结构变化、金额未加载、匹配规则失效
 * - zero：明确读到 0（本月已开完）
 * - positive：有额度
 */
export function parseAvailableAmount(text) {
  if (text === null || text === undefined) return { kind: 'unreadable', value: null, raw: text };
  const raw = String(text).trim();
  if (!raw) return { kind: 'unreadable', value: null, raw };
  const digits = raw.replace(/[^\d.]/g, '');
  // Number('') === 0，所以"剥完一个数字都不剩"必须显式判成 unreadable，
  // 否则 '¥--' 会被当成 0。
  if (!/\d/.test(digits)) return { kind: 'unreadable', value: null, raw };
  const value = Number(digits);
  if (!Number.isFinite(value)) return { kind: 'unreadable', value: null, raw };
  if (value <= 0) return { kind: 'zero', value: 0, raw };
  return { kind: 'positive', value, raw };
}
