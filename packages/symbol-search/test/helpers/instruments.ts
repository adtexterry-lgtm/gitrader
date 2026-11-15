// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：把最小字段拼成协议 Instrument（只填搜索要用的字段，其余给协议允许的缺省）。
import { asDecimal } from '@gitrader/protocol'
import type { Instrument, InstrumentKind } from '@gitrader/protocol'

export interface InstrumentSeed {
  symbol: string
  venue: string
  name?: string
  kind?: InstrumentKind
  assetClass?: Instrument['assetClass']
  quote?: string
  status?: Instrument['status']
  marketGroup?: string | null
}

export function instrument(seed: InstrumentSeed): Instrument {
  const kind = seed.kind ?? 'spot'
  return {
    instrumentId: `${seed.venue}:${seed.symbol}`,
    venue: seed.venue,
    symbol: seed.symbol,
    displaySymbol: seed.symbol,
    kind,
    base: seed.symbol.split('/')[0] ?? seed.symbol,
    quote: seed.quote ?? (seed.assetClass === 'stocks' ? 'USD' : 'USDT'),
    settle: seed.quote ?? (seed.assetClass === 'stocks' ? 'USD' : 'USDT'),
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: seed.assetClass ?? 'crypto',
    marketGroup: seed.marketGroup ?? null,
    ...(seed.name !== undefined ? { underlying: { description: seed.name, synthetic: false } } : {}),
    status: seed.status ?? 'trading',
    price: { maxDecimals: 2 },
    size: { step: asDecimal('1'), decimals: 0, min: asDecimal('1') },
    orderTypes: [],
    tif: [],
    triggerPriceTypes: [],
    updatedAt: 1_792_468_800_000,
  }
}

/** 两个「已注册数据连接器」的形状（各自的 listInstruments 只看得到自己的标的）。 */
export function connectorOf(venue: string, instruments: Instrument[]): { venue: string; listInstruments: (o?: { includeDelisted?: boolean }) => Instrument[] } {
  return {
    venue,
    listInstruments: (o) => instruments.filter((i) => o?.includeDelisted === true || i.status !== 'delisted'),
  }
}
