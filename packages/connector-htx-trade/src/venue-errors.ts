// SPDX-License-Identifier: CPAL-1.0
// HTX 错误码 / 文案 → 稳定分类 → 协议 Problem（契约 §2.8）。
// 口径来源（三份，全部可查本地参照）：
//   1) QD backend_api_python/app/services/pending_orders/error_classification.py:31-188 的分类**顺序**与分类名
//      （credentials → clock_skew → rate_limit → invalid_symbol → transport → price_band → insufficient_funds →
//       order_size → account_configuration → position_conflict → risk_limit → market_unavailable → exchange_rejected）；
//   2) QD live_trading/htx_v5.py:41-50（单币种保证金不可用 / 联合保证金与 v1 冲突）、:224-237（1499 dual_side 与
//      1500 single_side 的方向错误码——这两个码是 QD 真实生产代码里点名引用的，本文件把它们原样收进码表）；
//   3) HTX 官方《USDT 本位永续 · 错误码》与《V5 错误码》的**文案**（原文是英文/中文短句）。
// 纪律（G3）：码表只收 QD 点名引用过的码，其余一律靠文案关键字分类；认不出来的落 3001 且不重试。
// 「系统类」码（1000 系统错误 / 1001 系统未就绪 / 1002 查询错误 / 1003 redis 异常 / 1004 系统繁忙 /
// 500 v5 系统错误 / 6021 v5 请求超时）只用来判「结果未知」，不据此判业务原因。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'

export const VENUE_ID = 'htx'

export type HtxErrorClass =
  | 'credentials'
  | 'clock_skew'
  | 'rate_limit'
  | 'invalid_symbol'
  | 'transport'
  | 'price_band'
  | 'insufficient_funds'
  | 'order_size'
  | 'account_configuration'
  | 'position_conflict'
  | 'risk_limit'
  | 'market_unavailable'
  | 'invalid_params'
  | 'exchange_rejected'

interface Mapping {
  name: ProblemName
  retryable: boolean
  summary: string
}

/** 分类 → 协议 Problem。rate_limit 落 3002（HTTP 429/418 在 errors.ts 里同一口径）。 */
const PROBLEM_FOR_CLASS: Record<HtxErrorClass, Mapping> = {
  credentials: { name: 'VENUE_AUTH', retryable: false, summary: 'venue could not authenticate the API key' },
  clock_skew: { name: 'INVALID_PARAMS', retryable: false, summary: 'request timestamp drifted outside the venue window; resync the clock before resending' },
  rate_limit: { name: 'VENUE_RATE_LIMITED', retryable: true, summary: 'venue rate limited the request' },
  invalid_symbol: { name: 'INSTRUMENT_UNKNOWN', retryable: false, summary: 'venue does not know this contract' },
  transport: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'venue reported a transient system error' },
  price_band: { name: 'PRICE_DRIFT', retryable: false, summary: 'price is outside the venue price band for this contract' },
  insufficient_funds: { name: 'VENUE_INSUFFICIENT_MARGIN', retryable: false, summary: 'venue reports insufficient margin or balance' },
  order_size: { name: 'PRECISION', retryable: false, summary: 'order size or price violates the contract specification' },
  account_configuration: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request for the current account configuration (position mode / margin mode / leverage)' },
  position_conflict: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it conflicts with the current position' },
  risk_limit: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request because it exceeds a risk limit' },
  market_unavailable: { name: 'VENUE_UNAVAILABLE', retryable: true, summary: 'contract is delisted, settling or halted' },
  invalid_params: { name: 'INVALID_PARAMS', retryable: false, summary: 'venue rejected the request parameters' },
  exchange_rejected: { name: 'VENUE_REJECTED', retryable: false, summary: 'venue rejected the request' },
}

/**
 * 码表（只收官方点名的码；其余靠关键字）。
 *   1013/1014 = 合约不存在 → invalid_symbol；
 *   1032 = 限频 → rate_limit（带退避，rest.ts 在 HTTP 200 上也会先 penalize）；
 *   1499 = 账户是 dual_side（双向），订单却按单向参数发出（QD htx_v5.py:224-229 注释与判定）；
 *   1500 = 账户是 single_side（单向），订单却按双向参数发出（QD htx_v5.py:232-237）。
 */
export const HTX_ERROR_CLASSES: Record<number, HtxErrorClass> = {
  1013: 'invalid_symbol',
  1014: 'invalid_symbol',
  1032: 'rate_limit',
  1499: 'account_configuration',
  1500: 'account_configuration',
}

/**
 * 「系统类 / 结果未知」码：官方系统错误、系统未就绪、系统繁忙、请求超时、redis 异常。
 * 只用来判「结果未知」（非 GET 上 → 3006），不当业务原因用。
 */
export const AMBIGUOUS_VENUE_CODES = [1000, 1001, 1002, 1003, 1004, 500, 6021] as const

export function isAmbiguousVenueCode(code: number): boolean {
  return (AMBIGUOUS_VENUE_CODES as readonly number[]).includes(code)
}

/** 关键字规则，顺序照 QD error_classification.py（一旦命中即停止）。 */
const RULES: ReadonlyArray<{ cls: HtxErrorClass; re: RegExp }> = [
  { cls: 'credentials', re: /invalid\s*(api\s*)?key|apikey|access\s*key|signature|verify|authoriz|authentic|permission|无权|签名|验证失败|api\s*密钥/i },
  { cls: 'clock_skew', re: /timestamp|time\s*deviation|时间戳|时间偏差/i },
  { cls: 'rate_limit', re: /too\s*(many|frequent)|frequent|rate\s*limit|请求过于频繁|限频|频率/i },
  { cls: 'invalid_symbol', re: /contract[^.]{0,40}(does\s*not\s*exist|not\s*exist|not\s*found|unknown|invalid)|invalid\s*contract|unknown\s*contract|合约不存在|不存在的合约|无效合约/i },
  { cls: 'transport', re: /system\s*error|service\s*(unavailable|busy)|timeout|timed\s*out|try\s*again|系统错误|请求超时|系统繁忙|服务不可用/i },
  { cls: 'price_band', re: /price\s*(band|limit|range|out)|outside\s*the\s*price|价格(超出|不在|偏差)|限价范围/i },
  { cls: 'insufficient_funds', re: /insufficient|not\s*enough|available\s*margin|balance\s*is\s*not|可用保证金|保证金不足|余额不足|资金不足/i },
  { cls: 'order_size', re: /volume|amount\s*(too|is)|min\s*(size|volume)|max\s*(size|volume)|precision|数量(小于|大于|错误|超出)|下单数量|精度/i },
  { cls: 'account_configuration', re: /hedge\s*mode|one-?way|position\s*mode|margin\s*mode|lever|multi-?assets?|single-?asset|联合保证金|单币种|双向持仓|单向持仓|杠杆/i },
  { cls: 'position_conflict', re: /no\s*position|position\s*(not\s*exist|is\s*empty)|reduce[\s-]*only|close\s*(position|order)\s*(fail|reject)|仓位不存在|无持仓|平仓失败|持仓方向/i },
  { cls: 'risk_limit', re: /risk\s*limit|position\s*limit|exceeds?\s*(the\s*)?(limit|max)|超过(限制|上限)|仓位限制|风控/i },
  { cls: 'market_unavailable', re: /delist|settlement|suspend|halt|offline|下线|结算中|暂停交易|停牌/i },
  { cls: 'invalid_params', re: /invalid|illegal|parameter|missing|required|参数|非法|必填/i },
]

export interface ClassifyInput {
  /** 上游响应原文（已脱敏）。 */
  text: string
  /** v1 的 err_code 或 v5 的 code。 */
  venueCode?: number | undefined
  httpStatus?: number | undefined
}

export interface Classified {
  cls: HtxErrorClass
  problem: Problem
}

/** 原文 + 码 → 分类 → Problem（venue.code 保留上游码，venue.message 保留上游原文）。 */
export function classifyHtxError(input: ClassifyInput): Classified {
  const text = input.text ?? ''
  const code = input.venueCode
  let cls: HtxErrorClass | undefined = code !== undefined ? HTX_ERROR_CLASSES[code] : undefined
  if (cls === undefined) {
    for (const rule of RULES) {
      if (rule.re.test(text)) {
        cls = rule.cls
        break
      }
    }
  }
  if (cls === undefined) cls = 'exchange_rejected'
  const mapping = PROBLEM_FOR_CLASS[cls]
  const problem = makeProblem(mapping.name, mapping.summary, {
    retryable: mapping.retryable,
    venue: { id: VENUE_ID, ...(code !== undefined ? { code } : {}), message: text },
  })
  return { cls, problem }
}

/** 分类名（诊断 / 测试用）。 */
export function classifyOnly(input: ClassifyInput): HtxErrorClass {
  return classifyHtxError(input).cls
}
