// SPDX-License-Identifier: CPAL-1.0
// 估值：把「各家场所的持仓 + 注入的价格源 + 汇率表」折成同一种计价币的 ValuedPosition。
// 设计参照：QuantDinger backend_api_python/app/services/portfolio/{positions.py,pricing.py}（Apache-2.0，
//   只借鉴语义：price_map 注入、market_value / cost_value / pnl 三件套、按 market 聚合）。
//   刻意不同的一处：QD 在取价失败时把 price 写成 0 继续汇总；本包把「缺价」当成必须显式处理的事件——
//   缺省直接报错并列出全部缺价标的，或由调用方 opt-in 'skip' 把它们列进 unpriced，绝不当 0 参与汇总。
import { div, fx, mul as fmul, sub as fsub } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import type { Decimal, Instrument, InstrumentId, Position } from './types'
import { PortfolioError } from './types'
import type { FxTable, MissingPriceMode, PortfolioInput, ValuationResult, ValuedPosition } from './types'
import { dec, sumFx } from './decimal'

const ONE: Fx = fx('1')

/** 取汇率：同币为 1；支持 `FROM/TO` 直接对与 `TO/FROM` 反向对（取倒数）。不做三角换算。 */
function lookupRate(table: FxTable | undefined, from: string, to: string): Fx | undefined {
  if (from === to) return ONE
  const direct = table?.[`${from}/${to}`]
  if (direct !== undefined) {
    const rate = fx(direct)
    if (rate <= 0n) throw new PortfolioError('invalid_input', `fx rate must be positive: ${from}/${to} = ${direct}`)
    return rate
  }
  const inverse = table?.[`${to}/${from}`]
  if (inverse !== undefined) {
    const rate = fx(inverse)
    if (rate <= 0n) throw new PortfolioError('invalid_input', `fx rate must be positive: ${to}/${from} = ${inverse}`)
    return div(ONE, rate)
  }
  return undefined
}

/** 汇率（Decimal）。缺对直接抛 PortfolioError('missing_fx')，不猜、不回 1。 */
export function fxRate(table: FxTable | undefined, from: string, to: string): Decimal {
  const rate = lookupRate(table, from, to)
  if (rate === undefined) throw new PortfolioError('missing_fx', `portfolio: no fx rate for ${from}/${to}`, [`missing_fx: ${from}/${to}`])
  return dec(rate)
}

/** 策略归因解析：`${accountId}|${instrumentId}` -> `${accountId}` -> 'unassigned'。 */
export function resolveStrategy(
  tags: Readonly<Record<string, string>> | undefined,
  accountId: string,
  instrumentId: string,
): string {
  const exact = tags?.[`${accountId}|${instrumentId}`]
  if (exact !== undefined) return exact
  const byAccount = tags?.[accountId]
  if (byAccount !== undefined) return byAccount
  return 'unassigned'
}

interface PricedPosition {
  position: Position
  instrument: Instrument
  price: Fx
  rate: Fx
}

function indexInstruments(instruments: readonly Instrument[]): Map<InstrumentId, Instrument> {
  const map = new Map<InstrumentId, Instrument>()
  for (const instrument of instruments) {
    if (map.has(instrument.instrumentId)) {
      throw new PortfolioError('invalid_input', `portfolio: duplicate instrument ${instrument.instrumentId}`, [
        `invalid_input: duplicate instrument ${instrument.instrumentId}`,
      ])
    }
    map.set(instrument.instrumentId, instrument)
  }
  return map
}

/**
 * 把持仓折成计价币。全部算术走 18 位定点，输出按 LEDGER_DP 落位。
 *
 * 基础数量按场地的口径折：`venueSizeUnit: 'contract'` 时 `size × contractSize`，`'base'` 时就是 `size`
 * （此时 contractSize 只作展示，不参与任何金额）。
 *
 * 必报错的情况（不做静默兜底）：标的缺失、非 linear 结算、size <= 0、同一 (账户, 标的, 方向) 重复、
 * 汇率缺失、以及缺价（除非 onMissingPrice: 'skip'）。前五类与缺价会聚合成一条 PortfolioError('valuation_failed')，
 * details 去重后逐条列出；汇率表里写了 0 或负值属于配置错误，直接抛 PortfolioError('invalid_input')。
 */
export function valuePositions(input: PortfolioInput): ValuationResult {
  const { positions, instruments, valuationCcy, prices, fx: table } = input
  if (!valuationCcy) throw new PortfolioError('invalid_input', 'portfolio: valuationCcy is required')
  const mode: MissingPriceMode = input.onMissingPrice ?? 'throw'
  const byId = indexInstruments(instruments)

  const problems: string[] = []
  const priced: PricedPosition[] = []
  const unpriced: InstrumentId[] = []
  const seen = new Set<string>()
  const seenInstruments = new Set<InstrumentId>()

  for (const position of positions) {
    const instrument = byId.get(position.instrumentId)
    if (instrument === undefined) {
      problems.push(`unknown_instrument: ${position.instrumentId}`)
      continue
    }
    if (instrument.settlement !== 'linear') {
      // 反向合约的名义与盈亏以基础币结算，折算规则不同；本包不做半吊子实现，直接拒绝。
      problems.push(`unsupported_settlement: ${position.instrumentId} (${instrument.settlement})`)
      continue
    }
    const size = fx(position.size)
    if (size <= 0n) {
      problems.push(`invalid_position: ${position.instrumentId} size must be positive, got ${position.size}`)
      continue
    }
    const dedupeKey = `${position.accountId}|${position.instrumentId}|${position.side}`
    if (seen.has(dedupeKey)) {
      problems.push(`duplicate_position: ${dedupeKey}`)
      continue
    }
    seen.add(dedupeKey)

    const rawPrice = prices.price(position.instrumentId)
    const price = rawPrice === undefined ? 0n : fx(rawPrice)
    if (rawPrice === undefined || price <= 0n) {
      if (mode === 'skip') {
        if (!seenInstruments.has(position.instrumentId)) {
          seenInstruments.add(position.instrumentId)
          unpriced.push(position.instrumentId)
        }
        continue
      }
      problems.push(`missing_price: ${position.instrumentId}`)
      continue
    }

    const rate = lookupRate(table, instrument.quote, valuationCcy)
    if (rate === undefined) {
      problems.push(`missing_fx: ${instrument.quote}/${valuationCcy}`)
      continue
    }
    priced.push({ position, instrument, price, rate })
  }

  if (problems.length > 0) {
    // 去重保序：同一缺汇率被三笔持仓同时撞上时，只报一条。
    const unique = [...new Set(problems)]
    throw new PortfolioError('valuation_failed', `portfolio: valuation failed with ${unique.length} problem(s)`, unique)
  }

  const valued: ValuedPosition[] = priced.map(({ position, instrument, price, rate }) => {
    const contractSize = fx(instrument.contractSize)
    const size = fx(position.size)
    // 场地口径：数量是张时才乘面值；数量是币（'base'）时 contractSize 只作展示。
    const baseQty = instrument.venueSizeUnit === 'contract' ? fmul(size, contractSize) : size
    const markValuation = fmul(price, rate)
    const entryPrice = fx(position.entryPrice)
    const entryValuation = fmul(entryPrice, rate)
    const gross = fmul(baseQty, markValuation)
    const cost = fmul(baseQty, entryValuation)
    const long = position.side === 'long'
    const unrealized = long ? fmul(baseQty, fsub(markValuation, entryValuation)) : fmul(baseQty, fsub(entryValuation, markValuation))
    return {
      accountId: position.accountId,
      instrumentId: position.instrumentId,
      venue: instrument.venue,
      base: instrument.base,
      quote: instrument.quote,
      side: position.side,
      size: dec(size),
      contractSize: dec(contractSize),
      baseQuantity: dec(long ? baseQty : -baseQty),
      entryPrice: dec(entryPrice),
      markPrice: dec(price),
      markPriceValuation: dec(markValuation),
      cost: dec(cost),
      grossExposure: dec(gross),
      signedExposure: dec(long ? gross : -gross),
      unrealizedPnl: dec(unrealized),
      realizedPnl: dec(fmul(fx(position.realizedPnl), rate)),
      funding: dec(fmul(fx(position.fundingSinceOpen), rate)),
      venueUnrealizedPnl: dec(fmul(fx(position.unrealizedPnl), rate)),
      strategyId: resolveStrategy(input.strategyTags, position.accountId, position.instrumentId),
    }
  })

  const sum = (pick: (v: ValuedPosition) => Decimal): Decimal => dec(sumFx(valued.map((v) => fx(pick(v)))))
  const grossExposure = sum((v) => v.grossExposure)
  const netExposure = sum((v) => v.signedExposure)
  return {
    valuationCcy,
    positions: valued,
    unpriced,
    cost: sum((v) => v.cost),
    grossExposure,
    netExposure,
    unrealizedPnl: sum((v) => v.unrealizedPnl),
    realizedPnl: sum((v) => v.realizedPnl),
    funding: sum((v) => v.funding),
  }
}
