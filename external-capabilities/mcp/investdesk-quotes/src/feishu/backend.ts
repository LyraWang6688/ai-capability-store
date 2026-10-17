/**
 * 飞书后端接口。
 *
 * 两种实现，按环境变量自动选择：
 *   - larkCliBackend  ：复用本机已登录的 lark-cli，零配置，但只能在本机跑
 *   - openapiBackend  ：飞书自建应用 + tenant_access_token，可在云端/CI 跑
 *
 * 上层（base.ts）只依赖这个接口，不关心背后是谁。
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
