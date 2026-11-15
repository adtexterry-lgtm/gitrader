// SPDX-License-Identifier: CPAL-1.0
// 合约归一（协议唯一标准）与下单裁定（八条 2/3/4/5、十二条第 4 条）。
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import { InstrumentBook, SHARE_STEP, SUPPORTED_ORDER_TYPES, buildInstrument } from '../src/contracts'
import { IbError } from '../src/errors'
import { buildOrders, clientOrderIdFromOrderRef, formatGtd, orderRefOf, orderTypeOf, resolveSize, tifOf } from '../src/orders'
import * as M from '../src/messages'
import { NOW } from './helpers/harness'

const HOURS = '20261021:0400-20261021:2000;20261022:0400-20261022:2000;20261024:CLOSED;'
const LIQUID = '20261021:0930-20261021:1600;20261022:0930-20261022:1600;'

function details(symbol = 'AAPL', over: Partial<M.IbContractDetails> = {}): M.IbContractDetails {
  return {
    reqId: 1,
    contract: M.stockContract(symbol),
    marketName: symbol,
    minTick: asDecimal('0.01'),
    orderTypes: 'MKT,LMT,STP,STP LMT,TRAIL',
    validExchanges: 'SMART,NYSE,NASDAQ',
    longName: `${symbol} Inc.`,
    industry: 'Technology',
    category: 'Computers',
    timeZoneId: 'America/New_York',
    tradingHours: HOURS,
    liquidHours: LIQUID,
    stockType: 'COMMON',
    ...over,
  }
}

const record = buildInstrument(details('AAPL'), NOW)

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    accountId: 'acct_ibkr_paper' as OrderIntent['accountId'],
    instrumentId: 'ibkr:AAPL',
    side: 'buy',
    type: 'limit',
    size: asDecimal('10'),
    price: asDecimal('100.5'),
    ...over,
  }
}

let seq = 100
const ctx = (over: Partial<Parameters<typeof buildOrders>[1]> = {}) => ({
  record,
  now: NOW,
  account: 'DU1234567',
  clientId: 7,
  referencePrice: 100,
  positionSize: asDecimal('0'),
  shortPositionSize: asDecimal('0'),
  restrictions: { tradingBlocked: false, accountBlocked: false },
  nextOrderId: () => (seq += 1),
  newClientOrderId: () => 'deadbeefdeadbeefdeadbeefdeadbeef',
  ...over,
})

describe('contracts · 协议形状', () => {
  it('美股 = spot / stocks / USD / base / contractSize 1', () => {
    const i = record.instrument
    expect(i.kind).toBe('spot')
    expect(i.assetClass).toBe('stocks')
    expect(i.quote).toBe('USD')
    expect(i.settle).toBe('USD')
    expect(i.venueSizeUnit).toBe('base')
    expect(i.contractSize).toBe('1')
    expect(i.instrumentId).toBe('ibkr:AAPL')
    expect(i.symbol).toBe('AAPL')
  })

  it('数量步长是整数股（八条 4：不声明可碎股）', () => {
    expect(record.instrument.size.step).toBe(SHARE_STEP)
    expect(record.instrument.size.decimals).toBe(0)
  })

  it('价格 tick 取场所 minTick（Decimal 文本）', () => {
    expect(record.instrument.price.tick).toBe('0.01')
    expect(record.tick).toBe('0.01')
  })

  it('sessions 来自场所日历（不是写死的 09:30）', () => {
    expect(record.instrument.sessions?.tz).toBe('America/New_York')
    const regular = record.instrument.sessions?.windows.find((w) => w.quality === 'regular')
    expect(regular?.from).toBe('09:30')
    expect(regular?.to).toBe('16:00')
  })

  it('单型只声明本包真会发的那些（八条 8）', () => {
    expect(record.instrument.orderTypes).toEqual(SUPPORTED_ORDER_TYPES)
    expect(record.instrument.orderTypes).not.toContain('take_limit')
    expect(record.instrument.orderTypes).not.toContain('twap')
  })

  it('非 STK 合约拒绝（只做美股现金股票）', () => {
    expect(() => buildInstrument(details('AAPL', { contract: { ...M.stockContract('AAPL'), secType: 'OPT' } }), NOW)).toThrow(IbError)
  })

  it('非 USD 合约拒绝（不猜汇率）', () => {
    expect(() => buildInstrument(details('AAPL', { contract: { ...M.stockContract('AAPL'), currency: 'HKD' } }), NOW)).toThrow(/currency/)
  })

  it('标的簿：未知标的要求先 qualify（INSTRUMENT_UNKNOWN）', () => {
    const book = new InstrumentBook()
    book.upsert(details('AAPL'), NOW)
    expect(book.size).toBe(1)
    expect(book.get('aapl')?.instrument.symbol).toBe('AAPL')
    expect(() => book.require('ibkr:MSFT')).toThrow(/no qualified contract/)
  })

  it('list 只列未退市的标的', () => {
    const book = new InstrumentBook()
    book.upsert(details('AAPL'), NOW)
    expect(book.list()).toHaveLength(1)
    expect(book.list(true)).toHaveLength(1)
  })
})

describe('orders · orderRef 确定性单号', () => {
  it('同一个 clientOrderId 永远映射到同一个 orderRef', () => {
    expect(orderRefOf('abc123')).toBe('abc123')
    expect(orderRefOf('abc123')).toBe(orderRefOf('abc123'))
  })

  it('子腿后缀 #tp / #sl，可逆', () => {
    expect(orderRefOf('abc123', 'tp')).toBe('abc123#tp')
    expect(clientOrderIdFromOrderRef('abc123#tp')).toBe('abc123')
    expect(clientOrderIdFromOrderRef('abc123#sl')).toBe('abc123')
    expect(clientOrderIdFromOrderRef('abc123')).toBe('abc123')
  })

  it('外来单（TWS 手动单）orderRef 原样返回', () => {
    expect(clientOrderIdFromOrderRef('manual-order')).toBe('manual-order')
  })

  it('不合规单号拒绝（IB orderRef 字符集）', () => {
    expect(() => orderRefOf('has space')).toThrow(/orderRef/)
    expect(() => orderRefOf('中文')).toThrow(/orderRef/)
  })

  it('orderRef 不超 64 字符', () => {
    const long = 'a'.repeat(56)
    expect(orderRefOf(long, 'tp').length).toBeLessThanOrEqual(64)
  })
})

describe('orders · 单型 / 时效映射', () => {
  it('市价 → 价带 LMT（kind=market）', () => {
    expect(orderTypeOf('market')).toEqual({ type: 'LMT', kind: 'market' })
  })

  it('限价 / 止损 / 止损限价 / 跟踪止损', () => {
    expect(orderTypeOf('limit').type).toBe('LMT')
    expect(orderTypeOf('stop_market').type).toBe('STP')
    expect(orderTypeOf('stop_limit').type).toBe('STP LMT')
    expect(orderTypeOf('trailing_stop').type).toBe('TRAIL')
  })

  it('take_* / twap → 1004（能力老实）', () => {
    for (const t of ['take_market', 'take_limit', 'twap'] as const) {
      try {
        orderTypeOf(t)
        throw new Error('should have thrown')
      } catch (e) {
        expect((e as IbError).problem.code).toBe(1004)
      }
    }
  })

  it('tif：缺省 DAY、gtc/ioc/gtd 原义、fok/alo 拒', () => {
    expect(tifOf(intent())).toBe('DAY')
    expect(tifOf(intent({ tif: 'gtc' }))).toBe('GTC')
    expect(tifOf(intent({ tif: 'ioc' }))).toBe('IOC')
    expect(tifOf(intent({ tif: 'gtd', expiresAt: NOW + 86400_000 }))).toBe('GTD')
    expect(() => tifOf(intent({ tif: 'fok' }))).toThrow(IbError)
    expect(() => tifOf(intent({ tif: 'alo' }))).toThrow(IbError)
  })

  it('GTD 要 expiresAt，UTC 写法 YYYYMMDD-HH:MM:SS', () => {
    expect(() => buildOrders(intent({ tif: 'gtd' }), ctx())).toThrow(/expiresAt/)
    expect(formatGtd(Date.UTC(2026, 9, 23, 20, 0, 0))).toBe('20261023-20:00:00')
    const built = buildOrders(intent({ tif: 'gtd', expiresAt: Date.UTC(2026, 9, 23, 20, 0, 0) }), ctx())
    expect(built.legs[0]!.order.goodTillDate).toBe('20261023-20:00:00')
  })
})

describe('orders · 数量与价格（八条 3 / 4）', () => {
  it('整数股通过', () => {
    expect(resolveSize(intent({ size: asDecimal('25') }), 100, 'AAPL')).toBe('25')
  })

  it('碎股拒（PRECISION，不取整）', () => {
    try {
      resolveSize(intent({ size: asDecimal('1.5') }), 100, 'AAPL')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(1002)
      expect((e as IbError).message).toContain('fractional')
    }
  })

  it('size 与 notional 都不给 → INVALID_PARAMS', () => {
    expect(() => resolveSize({ ...intent(), size: undefined, price: undefined }, 100, 'AAPL')).toThrow(/size or notional/)
  })

  it('notional 按参考价用 bigint 向下折算成整数股', () => {
    expect(resolveSize({ ...intent(), size: undefined, notional: asDecimal('1050') }, 100, 'AAPL')).toBe('10')
    expect(resolveSize({ ...intent(), size: undefined, notional: asDecimal('1050') }, '100.01', 'AAPL')).toBe('10')
  })

  it('notional 不足一股 → PRECISION', () => {
    try {
      resolveSize({ ...intent(), size: undefined, notional: asDecimal('50') }, 100, 'AAPL')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(1002)
    }
  })

  it('价格不是 tick 整数倍 → PRECISION（不偷偷改价）', () => {
    expect(() => buildOrders(intent({ price: asDecimal('100.505') }), ctx())).toThrow(/tick/)
    expect(() => buildOrders(intent({ price: asDecimal('100.5') }), ctx())).not.toThrow()
  })

  it('市价意图缺 maxSlippageBps → INVALID_PARAMS', () => {
    try {
      buildOrders(intent({ type: 'market', price: undefined }), ctx())
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(-32602)
      expect((e as IbError).message).toContain('maxSlippageBps')
    }
  })

  it('市价意图的发单价 = 参考价 + 滑点，tif=IOC（不退回裸市价）', () => {
    const built = buildOrders(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), ctx({ referencePrice: 100 }))
    const o = built.legs[0]!.order
    expect(o.orderType).toBe('LMT')
    expect(o.lmtPrice).toBe('100.5')
    expect(o.tif).toBe('IOC')
  })

  it('卖单市价按参考价 - 滑点；价带价是 tick 整数倍且不越带', () => {
    const built = buildOrders(intent({ type: 'market', price: undefined, maxSlippageBps: 50, side: 'sell' }), ctx({ referencePrice: 100, positionSize: asDecimal('100') }))
    expect(built.legs[0]!.order.lmtPrice).toBe('99.5')
    const buy = buildOrders(intent({ type: 'market', price: undefined, maxSlippageBps: 33 }), ctx({ referencePrice: 100.01 }))
    const price = Number(buy.legs[0]!.order.lmtPrice)
    expect(Math.abs(price * 100 - Math.round(price * 100))).toBeLessThan(1e-9)
    expect(price).toBeLessThanOrEqual(100.01 * 1.0033)
  })

  it('无参考价（无行情权限）→ 市价意图拒单并说明', () => {
    try {
      buildOrders(intent({ type: 'market', price: undefined, maxSlippageBps: 20 }), ctx({ referencePrice: undefined, marketErrorCode: 354 }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(2007)
      expect((e as IbError).message).toContain('354')
    }
  })
})

describe('orders · 时段（八条 1 / 2）', () => {
  it('休市（收盘后）→ 拒单，不排队到次日', () => {
    try {
      buildOrders(intent(), ctx({ now: Date.UTC(2026, 9, 22, 1, 0, 0) }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(-32602)
      expect((e as IbError).message).toContain('outside the venue session')
    }
  })

  it('节假日（日历 CLOSED）→ 拒单', () => {
    expect(() => buildOrders(intent(), ctx({ now: Date.UTC(2026, 9, 24, 14, 30, 0) }))).toThrow(/holiday/)
  })

  it('盘前市价意图 → 拒单（成交价不可控）', () => {
    try {
      buildOrders(intent({ type: 'market', price: undefined, maxSlippageBps: 30 }), ctx({ now: Date.UTC(2026, 9, 21, 12, 0, 0) }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).message).toContain('outside regular hours')
    }
  })

  it('盘前限价但没声明 allowExtendedHours → 拒单', () => {
    expect(() => buildOrders(intent(), ctx({ now: Date.UTC(2026, 9, 21, 12, 0, 0) }))).toThrow(/allowExtendedHours/)
  })

  it('盘前限价 + 显式允许 → 通过（DAY），order.outsideRth=true', () => {
    const built = buildOrders(intent(), ctx({ now: Date.UTC(2026, 9, 21, 12, 0, 0), allowExtendedHours: true }))
    expect(built.legs[0]!.order.tif).toBe('DAY')
    expect(built.legs[0]!.order.outsideRth).toBe(true)
  })

  it('常规时段 order.outsideRth=false', () => {
    expect(buildOrders(intent(), ctx()).legs[0]!.order.outsideRth).toBe(false)
  })

  it('盘前 GTC → 拒（场所只允许 DAY / IOC）', () => {
    expect(() => buildOrders(intent({ tif: 'gtc' }), ctx({ now: Date.UTC(2026, 9, 21, 12, 0, 0), allowExtendedHours: true }))).toThrow(/GTC/)
  })
})

describe('orders · 卖空与账户限制（八条 5 / 6）', () => {
  it('无持仓卖出（开空）→ 拒单并说明可借券未建模', () => {
    try {
      buildOrders(intent({ side: 'sell' }), ctx({ positionSize: asDecimal('0') }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).message).toContain('short selling')
    }
  })

  it('卖出超过可卖量 → 拒单', () => {
    expect(() => buildOrders(intent({ side: 'sell', size: asDecimal('20') }), ctx({ positionSize: asDecimal('10') }))).toThrow(/exceeds the available/)
  })

  it('卖出不超过可卖量 → 通过（平仓方向，openClose 不发）', () => {
    const built = buildOrders(intent({ side: 'sell', size: asDecimal('10') }), ctx({ positionSize: asDecimal('10') }))
    expect(built.legs[0]!.order.action).toBe('SELL')
  })

  it('零持仓 reduceOnly 卖出 → 拒（IB 没有原生 reduce-only）', () => {
    try {
      buildOrders(intent({ side: 'sell', reduceOnly: true }), ctx({ positionSize: asDecimal('0') }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(-32602)
      expect((e as IbError).hint).toContain('reduce-only')
    }
  })

  it('持仓 100 reduceOnly 卖 100 → 通过', () => {
    const built = buildOrders(intent({ side: 'sell', size: asDecimal('100'), reduceOnly: true }), ctx({ positionSize: asDecimal('100') }))
    expect(built.legs[0]!.order.totalQuantity).toBe('100')
  })

  it('reduceOnly 买入：要求空头足够', () => {
    expect(() => buildOrders(intent({ side: 'buy', reduceOnly: true }), ctx({ shortPositionSize: asDecimal('0') }))).toThrow(/reduceOnly buy/)
    const built = buildOrders(intent({ side: 'buy', reduceOnly: true }), ctx({ shortPositionSize: asDecimal('10') }))
    expect(built.legs[0]!.order.action).toBe('BUY')
  })

  it('账户 tradingBlocked / accountBlocked → 拒单（不绕开限制）', () => {
    expect(() => buildOrders(intent(), ctx({ restrictions: { tradingBlocked: true, accountBlocked: false } }))).toThrow(IbError)
    expect(() => buildOrders(intent(), ctx({ restrictions: { tradingBlocked: false, accountBlocked: true } }))).toThrow(/account-level block/)
  })
})

describe('orders · 触发单 / 跟踪止损 / bracket', () => {
  it('止损单要 triggerPrice，写 auxPrice', () => {
    const built = buildOrders(intent({ type: 'stop_market', price: undefined, triggerPrice: asDecimal('95') }), ctx())
    expect(built.legs[0]!.order.orderType).toBe('STP')
    expect(built.legs[0]!.order.auxPrice).toBe('95')
  })

  it('止损限价写 lmtPrice + auxPrice', () => {
    const built = buildOrders(intent({ type: 'stop_limit', price: asDecimal('94.9'), triggerPrice: asDecimal('95') }), ctx())
    expect(built.legs[0]!.order.orderType).toBe('STP LMT')
    expect(built.legs[0]!.order.lmtPrice).toBe('94.9')
    expect(built.legs[0]!.order.auxPrice).toBe('95')
  })

  it('跟踪止损：callbackRatio 0.07 → trailingPercent 7（十进制乘法）', () => {
    const built = buildOrders(intent({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: asDecimal('0.07') } }), ctx())
    expect(built.legs[0]!.order.orderType).toBe('TRAIL')
    expect(built.legs[0]!.order.trailingPercent).toBe('7')
  })

  it('跟踪止损 callbackRatio 0.02 → trailingPercent 2', () => {
    const built = buildOrders(intent({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: asDecimal('0.02') } }), ctx())
    expect(built.legs[0]!.order.trailingPercent).toBe('2')
  })

  it('跟踪止损缺 callbackRatio → INVALID_PARAMS', () => {
    expect(() => buildOrders(intent({ type: 'trailing_stop', price: undefined }), ctx())).toThrow(/callbackRatio/)
  })

  it('跟踪止损带激活条件 → 1004（本包未建模）', () => {
    try {
      buildOrders(intent({ type: 'trailing_stop', price: undefined, trailing: { callbackRatio: asDecimal('0.02'), activationPrice: asDecimal('101') } }), ctx())
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(1004)
    }
  })

  it('mark / index 触发类型 → 1004', () => {
    expect(() => buildOrders(intent({ type: 'stop_market', price: undefined, triggerPrice: asDecimal('95'), triggerType: 'mark' }), ctx())).toThrow(IbError)
  })

  it('bracket：父单 transmit=false，止盈 / 止损子单最后一张 transmit=true', () => {
    const built = buildOrders(
      intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('110'), price: asDecimal('110') }, stopLoss: { triggerPrice: asDecimal('95') }, grouping: 'order' } }),
      ctx(),
    )
    expect(built.legs).toHaveLength(3)
    expect(built.legs.map((l) => l.role)).toEqual(['parent', 'tp', 'sl'])
    expect(built.legs[0]!.order.transmit).toBe(false)
    expect(built.legs[1]!.order.transmit).toBe(false)
    expect(built.legs[2]!.order.transmit).toBe(true)
    expect(built.legs[1]!.order.orderType).toBe('LMT')
    expect(built.legs[2]!.order.orderType).toBe('STP')
    expect(built.legs[1]!.order.orderRef).toBe(`${built.clientOrderId}#tp`)
    expect(built.legs[2]!.order.parentId).toBe(built.legs[0]!.order.orderId)
  })

  it('bracket 三腿 orderId = N / N+1 / N+2，子单 parentId = N', () => {
    let id = 500
    const built = buildOrders(
      intent({ tpsl: { takeProfit: { triggerPrice: asDecimal('110'), price: asDecimal('110') }, stopLoss: { triggerPrice: asDecimal('95') }, grouping: 'order' } }),
      ctx({ nextOrderId: () => id++ }),
    )
    expect(built.legs.map((l) => l.order.orderId)).toEqual([500, 501, 502])
    expect(built.legs.map((l) => l.order.parentId)).toEqual([0, 500, 500])
  })

  it('bracket 的 position 级分组 → 5002（IB 是 order 级）', () => {
    try {
      buildOrders(intent({ tpsl: { stopLoss: { triggerPrice: asDecimal('95') }, grouping: 'position' } }), ctx())
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(5002)
    }
  })

  it('杠杆按单设置 → 5002（IB 现金股票没有按单杠杆）', () => {
    try {
      buildOrders(intent({ leverage: 2 }), ctx())
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IbError).problem.code).toBe(5002)
    }
  })

  it('postOnly → 1004（IB 没有只做 maker）', () => {
    expect(() => buildOrders(intent({ postOnly: true }), ctx())).toThrow(/postOnly/)
  })
})
