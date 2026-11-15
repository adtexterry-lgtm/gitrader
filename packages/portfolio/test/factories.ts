// SPDX-License-Identifier: CPAL-1.0
// 测试用的合成数据工厂：只造协议类型（Instrument / Position）和估值结果（ValuedPosition）。
// 数字全部手算得出，测试里直接写期望值；工厂本身不做任何算术。
import type { AccountId, Decimal, Instrument, Position, VenueId } from '@gitrader/protocol'
import type { ValuedPosition } from '../src/types'
import { PortfolioError } from '../src/types'

/** 抓 PortfolioError 并断言类型；不是本包错误类型就原样抛出（不吞）。 */
export function capturePortfolioError(fn: () => unknown): PortfolioError {
  try {
    fn()
  } catch (error) {
    if (error instanceof PortfolioError) return error
    throw error
  }
  throw new Error('expected PortfolioError, but nothing was thrown')
}

export const D = (text: string): Decimal => text as Decimal

/** 宽松输入：Decimal 字段允许直接写十进制字符串（工厂内部转型，测试不必到处 as Decimal）。 */
type Loose<T> = { [K in keyof T]?: T[K] extends Decimal ? Decimal | string : T[K] }

export function makeInstrument(overrides: Loose<Instrument> = {}): Instrument {
  const instrumentId = overrides.instrumentId ?? 'binance:BTCUSDT'
  const venue = overrides.venue ?? 'binance'
  const base = overrides.base ?? 'BTC'
  const quote = overrides.quote ?? 'USDT'
  const symbol = overrides.symbol ?? `${base}${quote}`
  return {
    instrumentId,
    venue,
    symbol,
    displaySymbol: symbol,
    kind: 'perp',
    base,
    quote,
    settle: quote,
    settlement: 'linear',
    contractSize: D('1'),
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    status: 'trading',
    price: { tick: D('0.01') },
    size: { step: D('0.001'), decimals: 3, min: D('0.001') },
    orderTypes: ['market', 'limit'],
    tif: ['gtc'],
    triggerPriceTypes: ['mark'],
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as Instrument
}

export function makePosition(overrides: Loose<Position> & Pick<Position, 'instrumentId'>): Position {
  const size = overrides.size ?? D('1')
  const markPrice = overrides.markPrice ?? D('1')
  return {
    accountId: 'acct_a1' as AccountId,
    side: 'long',
    size,
    entryPrice: D('1'),
    markPrice,
    notional: D('0'),
    unrealizedPnl: D('0'),
    realizedPnl: D('0'),
    leverage: 1,
    marginMode: 'cross',
    liquidationPrice: null,
    fundingSinceOpen: D('0'),
    openedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as Position
}

/** 估值结果的合成样本：敞口字段自洽（gross = |signed|），只用于测纯聚合函数。 */
export function makeValued(overrides: Omit<Loose<ValuedPosition>, 'signedExposure'> & { signedExposure: Decimal | string }): ValuedPosition {
  const signed = String(overrides.signedExposure)
  const negative = signed.startsWith('-')
  const gross = negative ? signed.slice(1) : signed
  return {
    accountId: 'acct_a1' as AccountId,
    instrumentId: 'binance:BTCUSDT',
    venue: 'binance' as VenueId,
    base: 'BTC',
    quote: 'USDT',
    side: negative ? 'short' : 'long',
    size: gross,
    contractSize: D('1'),
    baseQuantity: negative ? D(`-${gross}`) : gross,
    entryPrice: D('1'),
    markPrice: D('1'),
    markPriceValuation: D('1'),
    cost: gross,
    grossExposure: gross,
    unrealizedPnl: D('0'),
    realizedPnl: D('0'),
    funding: D('0'),
    venueUnrealizedPnl: D('0'),
    strategyId: 'unassigned',
    ...overrides,
  } as ValuedPosition
}
