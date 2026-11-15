// SPDX-License-Identifier: CPAL-1.0
// 合约归一：IB contractDetails → 协议 Instrument（工单「协议唯一标准」，美股 = kind:'spot' / assetClass:'stocks' /
// quote/settle:'USD' / venueSizeUnit:'base' / contractSize:'1' / sessions 填交易时段）。
// 抄作业：QD ibkr_trading/symbols.py:9-24（USStock → STK / SMART / USD；其余市场类型也落美股口径，不猜别的市场）。
// 能力老实（八条 8）：美股现金股票没有资金费、没有永续强平价、杠杆按保证金账户如实（本包不声明杠杆）。
// 公司行动（拆股 / 分红）不在本包范围 → README 写明。
import { asDecimal } from '@gitrader/protocol'
import { cmpDec } from '@gitrader/protocol/decimal'
import type { Instrument, OrderType, TimeInForce } from '@gitrader/protocol'
import { buildSessions } from './calendar'
import type { VenueSessions } from './calendar'
import { IbError } from './errors'
import { instrumentIdOf, VENUE } from './ids'
import { DEFAULT_CURRENCY, DEFAULT_EXCHANGE, SEC_TYPE_STOCK } from './messages'
import type { IbContractDetails } from './messages'

/** 本包实际支持的单型（与 capabilities.ts 一致；下单路径 orders.ts 只许发这些）。 */
export const SUPPORTED_ORDER_TYPES: OrderType[] = ['market', 'limit', 'stop_market', 'stop_limit', 'trailing_stop']
export const SUPPORTED_TIF: TimeInForce[] = ['gtc', 'ioc', 'gtd']

/** 美股现金股票的数量步长：整数股（八条 4：场所没声明可碎股就只收整数，不取整）。 */
export const SHARE_STEP = '1'
export const SHARE_MIN = '1'

export function isStockContract(cd: IbContractDetails): boolean {
  return cd.contract.secType.trim().toUpperCase() === SEC_TYPE_STOCK
}

/** 只接受 STK / SMART / USD（工单最小子集）；其它组合在归一阶段拒绝，不猜。 */
export function assertSupportedContract(cd: IbContractDetails): void {
  if (!isStockContract(cd)) {
    throw IbError.of(
      'ORDER_TYPE_UNSUPPORTED',
      `unsupported IB secType ${JSON.stringify(cd.contract.secType)} for ${cd.contract.symbol} (this build only trades STK)`,
      '本包只做美股现金股票（STK）；期权 / 期货 / 外汇不在最小子集里',
    )
  }
  const exchange = (cd.contract.exchange || cd.contract.primaryExchange || '').toUpperCase()
  if (exchange !== DEFAULT_EXCHANGE && exchange !== '') {
    // SMART 是路由名；具体交易所（NYSE / NASDAQ）也可读，但本包下单统一用 SMART。
    if (!cd.validExchanges.toUpperCase().includes(exchange) && exchange !== 'NYSE' && exchange !== 'NASDAQ' && exchange !== 'ARCA' && exchange !== 'ISLAND') {
      throw IbError.of(
        'INSTRUMENT_UNKNOWN',
        `unsupported IB exchange ${JSON.stringify(cd.contract.exchange)} for ${cd.contract.symbol}`,
        '美股统一用 SMART 路由；具体交易所只作显示',
      )
    }
  }
  if (cd.contract.currency !== DEFAULT_CURRENCY) {
    throw IbError.of(
      'INSTRUMENT_UNKNOWN',
      `unsupported IB currency ${JSON.stringify(cd.contract.currency)} for ${cd.contract.symbol}`,
      '本包只做 USD 计价的美股；其它币种请走对应市场的连接器',
    )
  }
}

/** 一个标的的完整记录：协议 Instrument + 场所日历 + 会话表。 */
export interface InstrumentRecord {
  instrument: Instrument
  sessions: VenueSessions
  contractDetails: IbContractDetails
  /** 场所最小变动价位（IB minTick）。 */
  tick: string
}

export function buildInstrument(cd: IbContractDetails, now: number): InstrumentRecord {
  assertSupportedContract(cd)
  const symbol = cd.contract.symbol.trim().toUpperCase()
  const tz = cd.timeZoneId.trim() === '' ? 'America/New_York' : cd.timeZoneId.trim()
  const sessions = buildSessions(cd.tradingHours, cd.liquidHours, tz)
  const tick = cmpDec(cd.minTick, '0') > 0 ? cd.minTick : asDecimal('0.01')
  const instrument: Instrument = {
    instrumentId: instrumentIdOf(symbol),
    venue: VENUE,
    symbol,
    displaySymbol: symbol,
    kind: 'spot',
    base: symbol,
    quote: DEFAULT_CURRENCY,
    settle: DEFAULT_CURRENCY,
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'stocks',
    status: 'trading',
    price: { tick: asDecimal(tick) },
    size: { step: asDecimal(SHARE_STEP), decimals: 0, min: asDecimal(SHARE_MIN) },
    orderTypes: [...SUPPORTED_ORDER_TYPES],
    tif: [...SUPPORTED_TIF],
    triggerPriceTypes: ['last'],
    fees: { maker: asDecimal('0'), taker: asDecimal('0'), source: 'assumed' },
    sessions: { tz, windows: sessions.windows },
    updatedAt: now,
  }
  if (cd.longName.trim() !== '') instrument.underlying = { description: cd.longName.trim(), synthetic: false }
  return { instrument, sessions, contractDetails: cd, tick }
}

/** 标的簿：以 instrumentId 为键；STK/SMART/USD 归一后的合约由它统一提供。 */
export class InstrumentBook {
  readonly #byId = new Map<string, InstrumentRecord>()

  upsert(cd: IbContractDetails, now: number): InstrumentRecord {
    const record = buildInstrument(cd, now)
    this.#byId.set(record.instrument.instrumentId, record)
    return record
  }

  get(id: string): InstrumentRecord | undefined {
    return this.#byId.get(instrumentIdOf(id)) ?? this.#byId.get(id)
  }

  require(id: string): InstrumentRecord {
    const record = this.get(id)
    if (record === undefined) {
      throw IbError.of(
        'INSTRUMENT_UNKNOWN',
        `no qualified contract for ${JSON.stringify(id)} in this session`,
        '先 reqContractDetails 拉一次合约详情（start() 会刷新已登记的标的），不要凭记忆拼交易所 / 币种',
      )
    }
    return record
  }

  list(includeDelisted = false): Instrument[] {
    const all = [...this.#byId.values()].map((r) => r.instrument)
    return includeDelisted ? all : all.filter((i) => i.status !== 'delisted')
  }

  get size(): number {
    return this.#byId.size
  }
}
