// SPDX-License-Identifier: CPAL-1.0
// OrderIntent → Gate 请求体（纯函数）：市价必带滑点带、发价带限价 + ioc、张数符号、text 清洗、能力外类型 1004。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { buildOrder, decodeClientOrderId, describeBody, encodeClientOrderId, newClientOrderId, OrderBuildError, PRICE_ORDERS_PATH, sanitizeText, tifOf } from '../src/orders'
import { parseInstrumentRecords, recordFromInstrument } from '../src/parse'
import type { InstrumentRecord } from '../src/parse'
import { contractRow, NOW } from './helpers/fake-gate'

const records = (): InstrumentRecord[] => parseInstrumentRecords([
  contractRow(),
  contractRow({ name: 'ETH_USDT', order_price_round: '0.01', order_size_min: '0.1', quanto_multiplier: '0.01' }),
], NOW)

const btc = (): InstrumentRecord => records()[0]!
const eth = (): InstrumentRecord => {
  const hit = records().find((r) => r.symbol === 'ETH_USDT')
  if (!hit) throw new Error('ETH record missing')
  return hit
}

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: 'acct_gateio_test' as OrderIntent['accountId'],
  instrumentId: 'gateio:BTC_USDT' as OrderIntent['instrumentId'],
  side: 'buy',
  type: 'limit',
  size: '0.01' as OrderIntent['size'],
  price: '100.1' as OrderIntent['price'],
  ...over,
})

const nameOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem.name
    throw e
  }
  throw new Error('expected OrderBuildError')
}

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (e) {
    if (e instanceof OrderBuildError) return e.problem.code
    throw e
  }
  throw new Error('expected OrderBuildError')
}

describe('市价意图（工单教训 4）', () => {
  it('1. 缺 maxSlippageBps → INVALID_PARAMS（-32602，绝不默认滑点）', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'market', price: undefined, size: '0.01' as never }), btc(), { mid: 100.1 }))).toBe(-32602)
  })

  it('2. maxSlippageBps 为 0 / 负数 → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 0 }), btc(), { mid: 100.1 }))).toBe(-32602)
    expect(codeOf(() => buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: -5 }), btc(), { mid: 100.1 }))).toBe(-32602)
  })

  it('3. 没有参考价 / 报价陈旧 → STALE_PRICE（不拿旧价成交）', () => {
    const withSlip = intent({ type: 'market', price: undefined, maxSlippageBps: 50 })
    expect(nameOf(() => buildOrder(withSlip, btc(), {}))).toBe('STALE_PRICE')
    expect(nameOf(() => buildOrder(withSlip, btc(), { mid: 100.1, stale: true }))).toBe('STALE_PRICE')
  })

  it('4. 买单价带：mid 100.1 + 50bps = 100.6005 → 贴 tick 向下 100.6，tif=ioc', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 50 }), btc(), { mid: 100.1 })
    expect(built.body['price']).toBe('100.6')
    expect(built.body['tif']).toBe('ioc')
    expect(built.body['price']).not.toBe('0')
  })

  it('5. 卖单价带：mid 100.1 − 50bps = 99.5995 → 贴 tick 向上 99.6', () => {
    const built = buildOrder(intent({ side: 'sell', type: 'market', price: undefined, maxSlippageBps: 50 }), btc(), { mid: 100.1 })
    expect(built.body['price']).toBe('99.6')
    expect(built.body['size']).toBe('-100')
  })

  it('6. 市价模拟永远不把 price 写成 "0"（"0" + ioc 是无滑点上限的裸市价）', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 10 }), btc(), { mid: 100.1 })
    expect(built.body['price']).toMatch(/^\d+(\.\d+)?$/)
    expect(Number(built.body['price'])).toBeGreaterThan(0)
  })

  it('7. 只有 bid/ask 时用二者均值做参考', () => {
    const built = buildOrder(intent({ type: 'market', price: undefined, maxSlippageBps: 0.5 }), btc(), { bid: 100, ask: 100.2 })
    // mid = 100.1；+0.005% → 100.105005 → 向下贴 0.1 → 100.1
    expect(built.body['price']).toBe('100.1')
  })
})

describe('限价意图', () => {
  it('8. 合规限价原样发出，tif 缺省 gtc', () => {
    const built = buildOrder(intent(), btc())
    expect(built.body).toMatchObject({ contract: 'BTC_USDT', size: '100', price: '100.1', tif: 'gtc' })
    expect(built.body['reduce_only']).toBeUndefined()
  })

  it('9. 缺 price → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ price: undefined }), btc()))).toBe(-32602)
  })

  it('10. 价格不是 tick 整数倍且 rounding=reject → PRECISION（1002）', () => {
    expect(codeOf(() => buildOrder(intent({ price: '100.15' as never }), btc()))).toBe(1002)
  })

  it('11. rounding=passive：买单向下贴 tick，并记录 rounded', () => {
    const built = buildOrder(intent({ price: '100.15' as never, rounding: 'passive' }), btc())
    expect(built.body['price']).toBe('100.1')
    expect(built.rounded).toEqual([{ field: 'price', from: '100.15', to: '100.1' }])
  })

  it('12. rounding=passive：卖单向上贴 tick（永不朝成交方向放宽）', () => {
    const built = buildOrder(intent({ side: 'sell', price: '100.15' as never, rounding: 'passive' }), btc())
    expect(built.body['price']).toBe('100.2')
  })

  it('13. 科学计数法被规范化成定点文本（QD _gate_decimal_text 的约束）', () => {
    const built = buildOrder(intent({ price: '1e-2' as never, size: '0.01' as never }), eth())
    expect(built.body['price']).toBe('0.01')
    expect(String(built.body['price'])).not.toContain('e')
  })

  it('14. 非数字价格 → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ price: 'abc' as never }), btc()))).toBe(-32602)
  })

  it('15. tif=ioc 原样发出；tif 缺省 gtc', () => {
    expect(buildOrder(intent({ tif: 'ioc' }), btc()).body['tif']).toBe('ioc')
    expect(tifOf(intent())).toBe('gtc')
  })

  it('16. fok → body.tif fok；alo 或 postOnly → poc；gtd → 1004', () => {
    expect(buildOrder(intent({ tif: 'fok' }), btc()).body['tif']).toBe('fok')
    expect(buildOrder(intent({ tif: 'alo' }), btc()).body['tif']).toBe('poc')
    expect(buildOrder(intent({ postOnly: true }), btc()).body['tif']).toBe('poc')
    expect(codeOf(() => buildOrder(intent({ tif: 'gtd' }), btc()))).toBe(1004)
  })
})

describe('数量（币 → 张）', () => {
  it('17. 0.01 BTC / 0.0001 → 100 张，不带小数精度头', () => {
    const built = buildOrder(intent({ size: '0.01' as never }), btc())
    expect(built.body['size']).toBe('100')
    expect(built.headers).toEqual({})
    expect(built.sizeContracts).toBe('100')
  })

  it('18. 卖出为负张数', () => {
    expect(buildOrder(intent({ side: 'sell', size: '0.01' as never }), btc()).body['size']).toBe('-100')
  })

  it('19. 低于最小张数 → PRECISION（不足一张不发单）', () => {
    expect(codeOf(() => buildOrder(intent({ size: '0.00001' as never }), btc()))).toBe(1002)
  })

  it('20. 份额化合约（ETH order_size_min=0.1）带 X-Gate-Size-Decimal 头', () => {
    const built = buildOrder(intent({ instrumentId: 'gateio:ETH_USDT' as never, price: '3000' as never, size: '0.005' as never }), eth())
    expect(built.body['size']).toBe('0.5')
    expect(built.headers).toEqual({ 'X-Gate-Size-Decimal': '1' })
  })

  it('21. 份额化合约的整数张也带精度头（与 QD 一致：该合约支持小数）', () => {
    const built = buildOrder(intent({ instrumentId: 'gateio:ETH_USDT' as never, price: '3000' as never, size: '0.5' as never }), eth())
    expect(built.body['size']).toBe('50')
    expect(built.headers['X-Gate-Size-Decimal']).toBe('1')
  })

  it('22. 超细数量按最小可下量截断（0.0035 ETH → 0.3 张）', () => {
    const built = buildOrder(intent({ instrumentId: 'gateio:ETH_USDT' as never, price: '3000' as never, size: '0.0035' as never }), eth())
    expect(built.body['size']).toBe('0.3')
  })

  it('23. notional 折算用 mid 价（0.01 BTC @ mid 100 → 0.0001... 见断言）', () => {
    const built = buildOrder(intent({ size: undefined, notional: '1' as never, price: '100' as never }), btc(), { mid: 100 })
    // notional 1 / 100 = 0.01 BTC → 100 张
    expect(built.body['size']).toBe('100')
    expect(built.sizeBase).toBe('0.01')
  })

  it('24. notional 且限价单没给 price → INVALID_PARAMS；市价 + notional 没参考价 → STALE_PRICE', () => {
    expect(codeOf(() => buildOrder(intent({ size: undefined, notional: '1' as never, price: undefined }), btc(), {}))).toBe(-32602)
    expect(nameOf(() => buildOrder(intent({ type: 'market', size: undefined, notional: '1' as never, price: undefined, maxSlippageBps: 50 }), btc(), {}))).toBe('STALE_PRICE')
  })

  it('25. 既无 size 也无 notional → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ size: undefined }), btc()))).toBe(-32602)
  })

  it('26. size 为 0 / 负数 → INVALID_PARAMS', () => {
    expect(codeOf(() => buildOrder(intent({ size: '0' as never }), btc()))).toBe(-32602)
    expect(codeOf(() => buildOrder(intent({ size: '-1' as never }), btc()))).toBe(-32602)
  })
})

describe('客户端订单号 text（QD gate.py:91-104）', () => {
  it('27. 只留字母数字与 -_.，并补 t- 前缀', () => {
    expect(sanitizeText('abc 123/!@#')).toBe('t-abc123')
    expect(sanitizeText('gt-open-1')).toBe('t-gt-open-1')
  })

  it('28. 已带 t- 前缀不重复加', () => {
    expect(sanitizeText('t-abc')).toBe('t-abc')
  })

  it('29. 截到 28 字符', () => {
    const built = buildOrder(intent({ clientOrderId: 'x'.repeat(60) as never }), btc())
    expect(String(built.body['text'])).toHaveLength(28)
    expect(String(built.body['text']).startsWith('t-')).toBe(true)
  })

  it('30. 清洗后为空时用随机串兜底（绝不发空 text）', () => {
    const text = sanitizeText('###')
    expect(text.startsWith('t-')).toBe(true)
    expect(text.length).toBeGreaterThan(3)
  })

  it('31. newClientOrderId 是 32 位小写十六进制且互不相同', () => {
    const a = newClientOrderId()
    const b = newClientOrderId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })

  it('32. 入参 clientOrderId 写进 body.text 时清洗，回执里保留原号', () => {
    const built = buildOrder(intent({ clientOrderId: 'my order 1' as never }), btc())
    expect(built.body['text']).toBe('t-myorder1')
    expect(built.clientOrderId).toBe('my order 1')
  })
})

describe('能力外的形状（工单教训 9：1004 / 5002）', () => {
  it('33. 触发单（stop_market）走 PRICE_ORDERS_PATH', () => {
    const built = buildOrder(intent({ type: 'stop_market', price: undefined, triggerPrice: '90' as never }), btc())
    expect(built.kind).toBe('price_order')
    expect(built.path).toBe(PRICE_ORDERS_PATH)
  })

  it('34. 追踪单（trailing_stop）→ 1004', () => {
    expect(codeOf(() => buildOrder(intent({ type: 'trailing_stop' }), btc()))).toBe(1004)
  })

  it('35. 带 tpsl 的父单 → 1004（没有触发单端点，attachToOrder=false）', () => {
    const withTpsl = intent({ tpsl: { takeProfit: { triggerPrice: '110' as never }, grouping: 'order' } })
    expect(codeOf(() => buildOrder(withTpsl, btc()))).toBe(1004)
  })

  it('36. 意图 marginMode 不在 buildOrder 里拒（交给 trading 读现状）', () => {
    expect(buildOrder(intent({ marginMode: 'isolated' }), btc()).kind).toBe('order')
  })

  it('37. 未知标的 → INSTRUMENT_UNKNOWN（1001）', () => {
    expect(codeOf(() => buildOrder(intent({ instrumentId: 'gateio:NOPE_USDT' as never }), undefined))).toBe(1001)
  })

  it('38. 已下市标的 → INSTRUMENT_UNKNOWN', () => {
    const delisted = recordFromInstrument({ ...btc().instrument, status: 'delisted' }, { order_size_min: '1', quanto_multiplier: '0.0001' })
    expect(codeOf(() => buildOrder(intent(), delisted))).toBe(1001)
  })

  it('39. reduce_only 只在 true 时才写进 body', () => {
    expect(buildOrder(intent({ reduceOnly: true }), btc()).body['reduce_only']).toBe(true)
    expect(buildOrder(intent({ reduceOnly: false }), btc()).body['reduce_only']).toBeUndefined()
  })

  it('40. 下单路径固定是 /api/v4/futures/usdt/orders', () => {
    expect(buildOrder(intent(), btc()).path).toBe('/api/v4/futures/usdt/orders')
  })

  it('41. describeBody 按键排序（断言 / 日志稳定）', () => {
    expect(describeBody({ b: 2, a: 1 })).toBe('a=1&b=2')
  })

  it('42. 普通单 body 里的数值字段都是字符串（Gate 要字符串，不要 JSON number）', () => {
    const built = buildOrder(intent(), btc())
    for (const key of ['size', 'price', 'tif', 'contract', 'text']) {
      expect(typeof built.body[key]).toBe('string')
    }
  })

  it('43. recordFromInstrument 补上 orderTypes / tif / triggerPriceTypes，对外 contractSize = 1', () => {
    const record = btc()
    expect(record.instrument.orderTypes).toEqual(['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'])
    expect(record.instrument.tif).toEqual(['gtc', 'ioc', 'fok', 'alo'])
    expect(record.instrument.triggerPriceTypes).toEqual(['mark', 'last', 'index'])
    expect(record.instrument.contractSize).toBe('1')
    expect(record.contractSize).toBe('0.0001')
    expect(record.minSizeBase).toBe('0.0001')
    expect(record.sizeDecimals).toBe(0)
    expect(eth().sizeDecimals).toBe(1)
  })

  it('44. 份额化步长：order_size_min 0.5、乘数 0.01，0.007 币 → 0.7 张（不截成 0.5）', () => {
    const [record] = parseInstrumentRecords([contractRow({ name: 'FRAC_USDT', order_size_min: '0.5', quanto_multiplier: '0.01', order_price_round: '0.01' })], NOW)
    expect(record).toBeDefined()
    const built = buildOrder(intent({ instrumentId: 'gateio:FRAC_USDT' as never, price: '10' as never, size: '0.007' as never }), record!)
    expect(built.body['size']).toBe('0.7')
  })

  it('45. 32 位十六进制号编成 t- + base64url（24 字符）且可逆；其它字符串照清洗规则', () => {
    const id = '0123456789abcdef0123456789abcdef'
    const text = encodeClientOrderId(id)
    expect(text).toBe('t-ASNFZ4mrze8BI0VniavN7w')
    expect(text).toHaveLength(24)
    expect(decodeClientOrderId(text)).toBe(id)
    expect(decodeClientOrderId('t-myorder1')).toBe('t-myorder1')
    expect(decodeClientOrderId('web')).toBe('web')
    expect(decodeClientOrderId('')).toBeNull()
    expect(decodeClientOrderId(undefined)).toBeNull()
    expect(encodeClientOrderId('my order 1')).toBe('t-myorder1')
  })
})
