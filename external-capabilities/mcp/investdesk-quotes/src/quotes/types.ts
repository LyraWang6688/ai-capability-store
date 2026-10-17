/**
 * 行情模块的公共类型。
 *
 * 关键设计：定价链路由「定价方式」字段决定，而不是由平台或代码前缀猜测。
 * 原因见 docs/base-health-report.md：同一串 6 位代码可能既是股票又是场外基金
 * （如 000866 既是已退市的扬子石化，也是华宝制造股票），必须显式区分。
 */

/** 定价方式：决定去哪个数据源取价 */
export type PricingRoute = '场内行情' | '场外净值' | '手工录入';

/** 资产种类：仅用于分类统计，不参与取价路由 */
export type AssetType =
  | '个股'
  | 'ETF'
  | 'LOF'
  | 'REIT'
  | '场外基金'
  | '银行理财'
  | '其他';

/** 一条待取价的持仓 */
export interface QuoteTarget {
  recordId: string;
  code: string;
  name: string;
  assetType: AssetType | '';
  route: PricingRoute;
}

/** 取到的一条价格 */
export interface Quote {
  code: string;
  name: string;
  /** 最新价：场内为收盘价/最新成交价，场外为最新单位净值 */
  price: number;
  /** 涨跌幅（%）；来源未提供时为 null */
  changePct: number | null;
  /** 数据时间：场内为 yyyyMMddHHmmss，场外为 yyyy-MM-dd */
  tradeTime: string;
  source: 'tencent' | 'eastmoney-fund';
}

/** 取价失败 */
export interface Failure {
  code: string;
  name: string;
  reason: string;
}

export interface FetchResult {
  /** key = recordId，直接对应飞书表格的一行；CLI 场景下 key = 代码 */
  byRecord: Map<string, Quote>;
  failures: Failure[];
}
