/**
 * 体检判定的纯函数。
 *
 * 单独放一个模块，是为了让「什么算已授权」这条规则**可被测试直接覆盖**，
 * 而不必去 mock `execFileSync`。
 *
 * 2026-10-14 的教训：这条规则曾经在 `lark.mjs` 和 `cli.mjs` 里各写了一份，
 * 两份都把正常的 `needs_refresh` 误判成「未授权」——
 * 在豆包工作里实测连接器时，用户明明授权正常，体检却让他去重新登录。
 * **规则只应有一份，且必须可测。**
 */

/**
 * lark-cli 的用户身份是否可用。
 *
 * | status | 含义 | 是否可用 |
 * |---|---|---|
 * | `ready` | 访问令牌有效 | ✅ |
 * | `needs_refresh` | 访问令牌过期、refresh token 有效，**下次调用会自动刷新** | ✅ |
 * | 其他/缺失 | 确实未授权 | ❌ |
 */
export function isLarkUserUsable(user) {
  if (!user || typeof user !== 'object') return false;
  const statusOk = user.status === 'ready' || user.status === 'needs_refresh' || user.available === true;
  if (!statusOk) return false;
  // 没有身份标识就无法确认"是谁"，仍视为不可用
  return Boolean(user.userName || user.openId);
}

/** 从 `lark-cli auth status` 的输出里取用户名与 scope。 */
export function readLarkIdentity(statusPayload) {
  const user = statusPayload?.identities?.user;
  if (!isLarkUserUsable(user)) return { userName: null, scopes: '' };
  return { userName: user.userName || user.openId || null, scopes: user.scope || '' };
}
