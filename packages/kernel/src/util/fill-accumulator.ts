// SPDX-License-Identifier: CPAL-1.0
// 成交累加器：累加成交量 / 成交额、按币种累加费用、算加权均价、满仓判定与剩余量。
// 数量 / 金额 / 价格一律十进制字符串，内部用 dec.ts 定点运算，不碰浮点；累加器本身不可变，addFill 返回新对象。
import * as d from './dec'

export interface FillLike {
  size: string
  price: string
  fee?: string
  feeCurrency?: string
  id?: string
}

export interface FillAccumulator {
  filledSize: string
  notional: string
  avgPrice: string | null
  fees: Record<string, string>
  count: number
  seen: string[]
}

const ZERO_DEC = d.ZERO
const ZERO_STR = d.str(ZERO_DEC)

/** 费用币种键：去空白、大写；无币种记 'UNKNOWN'。 */
function feeKey(currency: string | undefined): string {
  return (currency ?? '').trim().toUpperCase() || 'UNKNOWN'
}

function parseFillDec(field: 'size' | 'price', value: string): d.Dec {
  try {
    return d.D(value)
  } catch {
    throw new Error(`invalid ${field}: ${value}`)
  }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/executors.py:301-322; adapted.
/** 加权均价 = 成交额 / 成交量；无成交（成交量 ≤ 0）为 null。 */
function weightedAvg(notional: d.Dec, filledSize: d.Dec): string | null {
  if (!d.gt(filledSize, ZERO_DEC)) return null
  return d.str(d.div(notional, filledSize))
}

export function emptyAccumulator(): FillAccumulator {
  return { filledSize: ZERO_STR, notional: ZERO_STR, avgPrice: null, fees: {}, count: 0, seen: [] }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/live_order_support.py:62-112; adapted.
/**
 * 追加一笔成交；同 id 重复追加忽略（返回原对象）；size ≤ 0 或 price ≤ 0 抛 Error。
 * 不改入参（acc 与 fill 都不修改）。
 */
export function addFill(acc: FillAccumulator, fill: FillLike): FillAccumulator {
  const id = fill.id
  if (id !== undefined && id !== '' && acc.seen.includes(id)) return acc

  const size = parseFillDec('size', fill.size)
  const price = parseFillDec('price', fill.price)
  if (!d.gt(size, ZERO_DEC)) throw new Error(`fill size must be > 0: ${fill.size}`)
  if (!d.gt(price, ZERO_DEC)) throw new Error(`fill price must be > 0: ${fill.price}`)

  const fees: Record<string, string> = { ...acc.fees }
  if (fill.fee !== undefined || fill.feeCurrency !== undefined) {
    const amount = d.D(fill.fee ?? '0')
    const currency = fill.feeCurrency ?? ''
    if (!d.isZero(amount) || currency.trim() !== '') {
      const key = feeKey(currency)
      const prev = fees[key]
      fees[key] = d.str(prev === undefined ? amount : d.add(d.D(prev), amount))
    }
  }

  const filledSize = d.add(d.D(acc.filledSize), size)
  const notional = d.add(d.D(acc.notional), d.mul(size, price))
  const seen = acc.seen.slice()
  if (id !== undefined && id !== '') seen.push(id)

  return {
    filledSize: d.str(filledSize),
    notional: d.str(notional),
    avgPrice: weightedAvg(notional, filledSize),
    fees,
    count: acc.count + 1,
    seen,
  }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/sent_order_recovery.py:22-29; adapted.
/**
 * 满仓判定：status 显式 'filled'，或 filledSize ≥ requested × tolerance（缺省 '0.999999'）且 avgPrice > 0。
 */
export function isComplete(
  acc: FillAccumulator,
  requested: string,
  opts: { status?: string; tolerance?: string } = {},
): boolean {
  if ((opts.status ?? '').trim().toLowerCase() === 'filled') return true
  const avgPrice = acc.avgPrice
  if (avgPrice === null) return false
  if (!d.gt(d.D(avgPrice), ZERO_DEC)) return false
  const requestedQty = d.D(requested)
  const tolerance = d.D(opts.tolerance ?? '0.999999')
  return d.gte(d.D(acc.filledSize), d.mul(requestedQty, tolerance))
}

/** 剩余量 = max(requested − filledSize, 0)。 */
export function remaining(acc: FillAccumulator, requested: string): string {
  const left = d.sub(d.D(requested), d.D(acc.filledSize))
  return d.str(d.max(left, ZERO_DEC))
}
