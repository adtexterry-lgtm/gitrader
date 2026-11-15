// SPDX-License-Identifier: CPAL-1.0
// Indexer 响应解析的边界测试：数字是字符串 / number 两种写法、缺失字段、空持仓、单位与符号。
import { describe, expect, it } from 'vitest'
import { dec, decOr, indexerOrderId, instrumentIdOf, intOf, msOf, parseAccount, parseFills, parseOrders, parsePositions, statusOfOrder, tickerOf, uuidv5 } from '../src/account'

describe('基础转换', () => {
  it('dec 接受字符串与 number，规范成十进制串', () => {
    expect(dec('1.50', 'x')).toBe('1.5')
    expect(dec(2, 'x')).toBe('2')
    expect(dec('-0.000', 'x')).toBe('0')
  })

  it('dec 拒绝空串 / 非数字 / 布尔', () => {
    expect(() => dec('', 'x')).toThrow(TypeError)
    expect(() => dec('abc', 'x')).toThrow(TypeError)
    expect(() => dec(true, 'x')).toThrow(TypeError)
  })

  it('decOr 缺省值', () => {
    expect(decOr(undefined, 'x', '7')).toBe('7')
    expect(decOr(null, 'x', '0')).toBe('0')
    expect(decOr('3', 'x', '7')).toBe('3')
  })

  it('intOf 接受字符串整数', () => {
    expect(intOf('42', 'x')).toBe(42)
    expect(intOf(42, 'x')).toBe(42)
    expect(() => intOf('4.5.5', 'x')).toThrow(TypeError)
  })

  it('msOf 解析 ISO 与数字，解析不了给 0', () => {
    expect(msOf('2026-10-21T00:00:00.000Z')).toBe(Date.parse('2026-10-21T00:00:00Z'))
    expect(msOf(1234)).toBe(1234)
    expect(msOf('not a date')).toBe(0)
    expect(msOf(undefined)).toBe(0)
  })

  it('instrumentId 映射与反解', () => {
    expect(instrumentIdOf('BTC-USD')).toBe('dydx:BTC-USD')
    expect(tickerOf('dydx:BTC-USD')).toBe('BTC-USD')
    expect(tickerOf('ETH-USD')).toBe('ETH-USD')
  })
})

describe('账户解析', () => {
  it('hold = total - available，负数归零', () => {
    const { snapshot } = parseAccount({ equity: '100', freeCollateral: '120', assetPositions: { USDC: { symbol: 'USDC', size: '100' } } }, { accountId: 'acc', ts: 1 })
    expect(snapshot.balances[0]!.hold).toBe('0')
    expect(snapshot.margin.initialMargin).toBe('0')
  })

  it('没有 assetPositions 时用 equity 作余额', () => {
    const { snapshot } = parseAccount({ equity: '55.5', freeCollateral: '50' }, { accountId: 'acc', ts: 1 })
    expect(snapshot.balances[0]!.total).toBe('55.5')
    expect(snapshot.margin.initialMargin).toBe('5.5')
  })

  it('零仓位被跳过，空头 size 取绝对值，side=short', () => {
    const { snapshot } = parseAccount({
      equity: '1',
      openPerpetualPositions: {
        'BTC-USD': { size: '0', entryPrice: '1' },
        'ETH-USD': { size: '-2.5', entryPrice: '3000', unrealizedPnl: '-15' },
      },
    }, { accountId: 'acc', ts: 10 })
    expect(snapshot.positions).toHaveLength(1)
    expect(snapshot.positions[0]!.instrumentId).toBe('dydx:ETH-USD')
    expect(snapshot.positions[0]!.size).toBe('2.5')
    expect(snapshot.positions[0]!.side).toBe('short')
    expect(snapshot.positions[0]!.notional).toBe('7500')
    expect(snapshot.positions[0]!.unrealizedPnl).toBe('-15')
  })

  it('字段缺失时给 0 而不是 NaN', () => {
    const { snapshot } = parseAccount({}, { accountId: 'acc', ts: 1 })
    expect(snapshot.margin.equity).toBe('0')
    expect(snapshot.margin.available).toBe('0')
    expect(snapshot.positions).toEqual([])
  })

  it('持仓专用端点解析：仓位符号与名义额', () => {
    const pos = parsePositions([{ market: 'BTC-USD', size: '0.5', entryPrice: '20000', exitPrice: '21000', unrealizedPnl: '500', realizedPnl: '10', netFunding: '-1' }])
    expect(pos[0]!.side).toBe('long')
    expect(pos[0]!.markPrice).toBe('21000')
    expect(pos[0]!.notional).toBe('10500')
  })
})

describe('挂单解析', () => {
  it('状态过滤：只留 OPEN / UNTRIGGERED / BEST_EFFORT_OPENED', () => {
    const orders = parseOrders([
      { id: 'a', market: 'BTC-USD', status: 'OPEN', side: 'BUY', size: '1', totalFilled: '0', price: '1', type: 'LIMIT' },
      { id: 'b', market: 'BTC-USD', status: 'CANCELED', side: 'BUY', size: '1' },
      { id: 'c', market: 'BTC-USD', status: 'BEST_EFFORT_OPENED', side: 'SELL', size: '1', totalFilled: '0', type: 'LIMIT' },
    ])
    expect(orders.map((o) => o.venueOrderId)).toEqual(['a', 'c'])
  })

  it('市价单的 price 为 null；触发单 isTrigger=true 且保留 triggerPrice', () => {
    const [o] = parseOrders([{ id: 'a', market: 'BTC-USD', status: 'UNTRIGGERED', side: 'BUY', size: '1', totalFilled: '0', type: 'STOP_MARKET', triggerPrice: '9000' }])
    expect(o!.price).toBeNull()
    expect(o!.triggerPrice).toBe('9000')
    expect(o!.isTrigger).toBe(true)
  })

  it('未知订单类型映射成 unknown，不会瞎猜', () => {
    const [o] = parseOrders([{ id: 'a', market: 'BTC-USD', status: 'OPEN', side: 'BUY', size: '1', totalFilled: '0', type: 'SOMETHING_NEW' }])
    expect(o!.type).toBe('unknown')
  })

  it('总成交量大于 size 时剩余量取 0', () => {
    const [o] = parseOrders([{ id: 'a', market: 'BTC-USD', status: 'OPEN', side: 'BUY', size: '1', totalFilled: '2', type: 'LIMIT', price: '5' }])
    expect(o!.size).toBe('0')
  })

  it('statusOfOrder 保留上游原文', () => {
    const st = statusOfOrder({ id: 'o1', status: 'PARTIALLY_FILLED', totalFilled: '0.5' })
    expect(st.status).toBe('PARTIALLY_FILLED')
    expect(st.filledSize).toBe('0.5')
  })
})

describe('Indexer 订单 UUID（官方公式）', () => {
  const ADDRESS = 'dydx14zzueazeh0hj67cghhf9jypslcf9sh2n5k6art'

  it('RFC 4122 公开向量：uuidv5(www.example.com, dns) = 2ed6657d-e927-568b-95e1-2665a8aea6a2', () => {
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('测试网真实行：子账户 uuid 与三条订单 uuid', () => {
    expect(uuidv5(`${ADDRESS}-0`, '0f9da948-a6fb-4c45-9edc-4685c3f3317d')).toBe('8586bcf6-1f58-5ec9-a0bc-e53db273e7b0')
    expect(indexerOrderId(ADDRESS, 0, 353049871, 0, 64)).toBe('5790175f-16b7-5d8b-87b4-9eafd87a5c41')
    expect(indexerOrderId(ADDRESS, 0, 623807637, 0, 64)).toBe('7506b42c-4ea1-5083-b5f3-de5a35630db5')
    expect(indexerOrderId(ADDRESS, 0, 312895216, 0, 64)).toBe('3436bb18-352b-5de9-bc19-811df967d711')
  })

  it('非法 namespace 拒绝', () => {
    expect(() => uuidv5('x', 'not-a-uuid')).toThrow(TypeError)
  })
})

describe('多空判定（优先看 side 字段）', () => {
  it('side=SHORT + size 正数 → short；side=SHORT + 负数 → short，数量取绝对值', () => {
    const a = parsePositions([{ market: 'BTC-USD', side: 'SHORT', size: '0.5', entryPrice: '20000' }])
    const b = parsePositions([{ market: 'BTC-USD', side: 'SHORT', size: '-0.5', entryPrice: '20000' }])
    expect(a[0]!.side).toBe('short')
    expect(a[0]!.size).toBe('0.5')
    expect(b[0]!.side).toBe('short')
    expect(b[0]!.size).toBe('0.5')
  })

  it('没有 side 才看符号；side=LONG + 负数也按 long', () => {
    const noSide = parsePositions([{ market: 'BTC-USD', size: '-0.5', entryPrice: '20000' }])
    const longNegative = parsePositions([{ market: 'BTC-USD', side: 'LONG', size: '-0.5', entryPrice: '20000' }])
    expect(noSide[0]!.side).toBe('short')
    expect(longNegative[0]!.side).toBe('long')
    expect(longNegative[0]!.size).toBe('0.5')
  })

  it('parseAccount 的内嵌持仓同样优先看 side', () => {
    const { snapshot } = parseAccount({
      equity: '1',
      openPerpetualPositions: { 'BTC-USD': { side: 'SHORT', size: '0.5', entryPrice: '20000' } },
    }, { accountId: 'acc', ts: 1 })
    expect(snapshot.positions[0]!.side).toBe('short')
    expect(snapshot.positions[0]!.size).toBe('0.5')
  })
})

describe('成交解析', () => {
  it('MAKER/TAKER 归一，费用符号保留（负数 = 返佣）', () => {
    const fills = parseFills([
      { id: 'f1', orderId: 'o1', market: 'BTC-USD', side: 'SELL', liquidity: 'MAKER', price: '20000', size: '0.1', fee: '-0.02', createdAt: '2026-10-21T00:00:00Z' },
      { id: 'f2', orderId: 'o2', market: 'BTC-USD', side: 'BUY', liquidity: 'TAKER', price: '20000', size: '0.1', fee: '0.05', createdAt: '2026-10-21T00:00:00Z' },
    ])
    expect(fills[0]!.liquidity).toBe('maker')
    expect(fills[0]!.fee).toBe('-0.02')
    expect(fills[1]!.liquidity).toBe('taker')
    expect(fills[1]!.feeCcy).toBe('USDC')
  })

  it('缺 id 时回退键含 orderId / height / size / price', () => {
    const [f] = parseFills([{ orderId: 'o1', market: 'BTC-USD', side: 'BUY', price: '20000', size: '0.5', createdAtHeight: 77 }])
    expect(f!.venueFillId).toBe('o1:77:0.5:20000')
  })

  it('clientOrderId 来自映射：未知写 null，命中写 hex', () => {
    const rows = [{ id: 'f', orderId: 'o', market: 'BTC-USD', side: 'BUY', price: '1', size: '1' }]
    expect(parseFills(rows)[0]!.clientOrderId).toBeNull()
    expect(parseFills(rows, (id) => (id === 'o' ? 'aa11' : null))[0]!.clientOrderId).toBe('aa11')
  })
})
