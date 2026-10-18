/**
 * 飞书后端的记录形状定义。
 *
 * 0.3.0 起只有一种实现（OpenAPI + tenant_access_token）。
 * 保留这个接口是为了约束「后端返回的记录长什么样」，
 * 上层（base.ts）直接消费 RawRecord。
 */

export interface RawRecord {
  record_id: string;
  代码?: string | null;
  名称?: string | null;
  资产种类?: string[] | null;
  定价方式?: string[] | null;
  平台?: string | null;
  [key: string]: unknown;
}

export interface FeishuBackend {
  /** 后端名，用于日志与错误提示 */
  readonly name: string;
  /** 列出表内全部记录 */
  listRecords(tableId: string, limit: number): Promise<RawRecord[]>;
  /** 批量更新记录；updates 的 key 是 record_id，value 是要写的字段 */
  batchUpdateRecords(
    tableId: string,
    updates: Array<{ recordId: string; fields: Record<string, unknown> }>,
  ): Promise<number>;
}
