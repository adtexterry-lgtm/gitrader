// SPDX-License-Identifier: CPAL-1.0
// 过滤与校验：市场类型 / 场所 / 报价货币过滤（纯函数），以及 QD watchlist.py 的挑选校验语义。
//
// 出处（语义参照，Apache-2.0，只读参照未复制代码）：
//   QuantDinger backend_api_python/app/services/market/watchlist.py:validate_watchlist_pair
//     - 空 symbol → 拒绝
//     - `^\d{6}$`（A 股代码形状）但市场不是 CNStock → 拒绝
//     - `.HK` 结尾但市场不是 HKStock → 拒绝
//     - Crypto 的 symbol 必须是 BASE/QUOTE 对（要求含 "/"）→ 拒绝「裸代码」
//   我们这边没有 QD 的「市场名」概念，改为按标的自带的 assetClass / quote 货币判定；
//   QD 用「有没有 /」判是不是货币对，我们等价地用「quote 货币是否非空且不等于 base」判（USDT 永续的符号本来就没有 /）。
import type { AssetClass, InstrumentKind } from '@gitrader/protocol'
import type { SymbolRecord } from './record'

export interface SymbolFilter {
  /** 只留这些场所（venue id）。 */
  venues?: readonly string[]
  /** 只留这些标的类型（spot / perp / future / option / outcome）。 */
  kinds?: readonly InstrumentKind[]
  /** 只留这些资产类别。 */
  assetClass?: AssetClass | readonly AssetClass[]
  /** 只留这些报价货币（大小写不敏感）。 */
  quote?: string | readonly string[]
  /** 只留来自这些连接器的记录。 */
  sources?: readonly string[]
  /** 是否包含已下架标的，缺省 false（QD 的 is_active = 1 等价物）。 */
  includeDelisted?: boolean
}

const listOf = <T>(v: T | readonly T[] | undefined): readonly T[] | undefined =>
  v === undefined ? undefined : (Array.isArray(v) ? v : [v as T])

/** 记录是否通过过滤（没有过滤条件就是全过）。 */
export function matchesFilter(record: SymbolRecord, filter: SymbolFilter | undefined): boolean {
  if (!filter) return true
  if (filter.includeDelisted !== true && record.status === 'delisted') return false
  const venues = listOf(filter.venues)
  if (venues !== undefined && !venues.includes(record.venue)) return false
  const kinds = listOf(filter.kinds)
  if (kinds !== undefined && !kinds.includes(record.kind)) return false
  const classes = listOf(filter.assetClass)
  if (classes !== undefined && !classes.includes(record.assetClass)) return false
  const quotes = listOf(filter.quote)
  if (quotes !== undefined) {
    const want = quotes.map((q) => q.toUpperCase())
    if (!want.includes(record.quote.toUpperCase())) return false
  }
  const sources = listOf(filter.sources)
  if (sources !== undefined && !sources.includes(record.source)) return false
  return true
}

// ---- 挑选校验（QD watchlist 语义） --------------------------------------------

export const SELECTION_PROBLEM_CODES = [
  'EMPTY_SYMBOL',
  'CN_CODE_NOT_STOCK',
  'HK_CODE_NOT_STOCK',
  'CRYPTO_NOT_A_PAIR',
] as const
export type SelectionProblemCode = (typeof SELECTION_PROBLEM_CODES)[number]

export interface SelectionProblem {
  code: SelectionProblemCode
  message: string
}

/** 符号归一化：去空白 + 大写（QD watchlist.py:normalize_symbol）。 */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

const CN_A_SHARE = /^\d{6}$/

/**
 * 挑选校验：把一条记录当作「要加进自选 / 要下单」的目标，按 QD watchlist 的四条规则判。
 * 通过返回 undefined；不通过返回 { code, message }（调用方决定是拒绝还是提示）。
 */
export function validateSelection(record: SymbolRecord): SelectionProblem | undefined {
  const symbol = normalizeSymbol(record.symbol)
  if (symbol === '') return { code: 'EMPTY_SYMBOL', message: 'Empty symbol' }
  if (CN_A_SHARE.test(symbol) && record.assetClass !== 'stocks') {
    return {
      code: 'CN_CODE_NOT_STOCK',
      message: `Symbol '${symbol}' looks like a Chinese A-share code; asset class must be stocks, not ${record.assetClass}`,
    }
  }
  if (symbol.endsWith('.HK') && record.assetClass !== 'stocks') {
    return {
      code: 'HK_CODE_NOT_STOCK',
      message: `Symbol '${symbol}' looks like a Hong Kong stock; asset class must be stocks, not ${record.assetClass}`,
    }
  }
  if (record.assetClass === 'crypto') {
    const quote = record.quote.trim().toUpperCase()
    const base = record.symbol.trim().toUpperCase()
    if (quote === '' || quote === base) {
      return {
        code: 'CRYPTO_NOT_A_PAIR',
        message: `Crypto symbol '${record.symbol}' must carry a quote currency (a BASE/QUOTE pair)`,
      }
    }
  }
  return undefined
}
