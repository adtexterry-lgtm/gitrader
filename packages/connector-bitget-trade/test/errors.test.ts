// SPDX-License-Identifier: CPAL-1.0
// 错误分类表：QD 的跨所分类口径（error_classification.py:31-188）落到协议 Problem 码。
import { describe, expect, it } from 'vitest'
import { makeProblem } from '@gitrader/protocol'
import type { OrderIntent } from '@gitrader/protocol'
import { asProblem, ProblemError, redactSecret, venueProblem } from '../src/errors'
import { classifyBitgetError, isPositionModeMismatch, isUnknownOrderError } from '../src/venue-errors'
import { ACCOUNT_ID, accountRef, makeConnector, problemOf, tradeContext } from './helpers/connector'
import { FakeBitget, NOW } from './helpers/fake-bitget'

const nameOf = (input: { status?: number; code?: string; text: string }): string => classifyBitgetError(input).problem.name
const classOf = (input: { status?: number; code?: string; text: string }): string => classifyBitgetError(input).cls

describe('分类：凭据 / 时钟', () => {
  it('HTTP 401 → credentials', () => {
    expect(classOf({ status: 401, text: 'unauthorized' })).toBe('credentials')
  })
  it('HTTP 403 → credentials', () => {
    expect(classOf({ status: 403, text: 'forbidden' })).toBe('credentials')
  })
  it('code 40009（Bitget 签名错）→ credentials', () => {
    expect(classOf({ status: 200, code: '40009', text: 'Sign signature error' })).toBe('credentials')
  })
  it('code 40002 / 40003 / 40005 / 40018 → credentials', () => {
    for (const code of ['40002', '40003', '40005', '40018']) expect(classOf({ status: 200, code, text: 'x' })).toBe('credentials')
  })
  it('文本 "Invalid API-key" → credentials', () => {
    expect(classOf({ status: 200, text: 'Invalid API-key format' })).toBe('credentials')
  })
  it('文本 "passphrase" → credentials', () => {
    expect(classOf({ status: 200, text: 'The passphrase is incorrect' })).toBe('credentials')
  })
  it('文本 "timestamp" → clock_skew', () => {
    expect(classOf({ status: 200, text: 'Request timestamp expired' })).toBe('clock_skew')
  })
  it('clock_skew 落 3005 且 retryable（重校后可再试）', () => {
    const p = classifyBitgetError({ status: 200, text: 'Invalid timestamp' }).problem
    expect(p.code).toBe(3005)
    expect(p.retryable).toBe(true)
  })
})

describe('分类：限流 / 传输 / 市场', () => {
  it('HTTP 429 → rate_limit', () => {
    expect(classOf({ status: 429, text: 'too many' })).toBe('rate_limit')
  })
  it('HTTP 418 → rate_limit', () => {
    expect(classOf({ status: 418, text: 'teapot' })).toBe('rate_limit')
  })
  it('信封 code 429 → rate_limit', () => {
    expect(classOf({ status: 200, code: '429', text: '429' })).toBe('rate_limit')
  })
  it('rate_limit 落 3003 retryable（与 HL 包一致）', () => {
    const p = classifyBitgetError({ status: 429, text: 'rate limit' }).problem
    expect(p.code).toBe(3003)
    expect(p.retryable).toBe(true)
  })
  it('HTTP 502 → transport（3003 retryable）', () => {
    const p = classifyBitgetError({ status: 502, text: 'bad gateway' }).problem
    expect(p.code).toBe(3003)
    expect(p.retryable).toBe(true)
  })
  it('文本 "market is closed" → market_unavailable', () => {
    expect(classOf({ status: 200, text: 'The market is closed for maintenance' })).toBe('market_unavailable')
  })
  it('文本 "contract delisted" → market_unavailable', () => {
    expect(classOf({ status: 200, text: 'contract delisted' })).toBe('market_unavailable')
  })
  it('文本 "invalid symbol" → invalid_symbol（1001）', () => {
    const p = classifyBitgetError({ status: 200, text: 'invalid symbol: BTCXYZ' }).problem
    expect(p.code).toBe(1001)
    expect(p.name).toBe('INSTRUMENT_UNKNOWN')
  })
})

describe('分类：价格 / 资金 / 精度 / 参数', () => {
  it('价格带文本 → price_band（1007 retryable）', () => {
    const p = classifyBitgetError({ status: 200, text: 'order price cannot be higher than the maximum buying price' }).problem
    expect(p.code).toBe(1007)
    expect(p.retryable).toBe(true)
  })
  it('code 51137 → price_band', () => {
    expect(classOf({ status: 200, code: '51137', text: '51137' })).toBe('price_band')
  })
  it('余额不足文本 → insufficient_funds（3004）', () => {
    const p = classifyBitgetError({ status: 200, text: 'Insufficient balance' }).problem
    expect(p.code).toBe(3004)
    expect(p.retryable).toBe(false)
  })
  it('code 110004 → insufficient_funds', () => {
    expect(classOf({ status: 200, code: '110004', text: '110004' })).toBe('insufficient_funds')
  })
  it('精度文本 → order_size（1002）', () => {
    const p = classifyBitgetError({ status: 200, text: 'The size is below the minimum size' }).problem
    expect(p.code).toBe(1002)
    expect(p.retryable).toBe(false)
  })
  it('"invalid quantity" → order_size', () => {
    expect(classOf({ status: 200, text: 'invalid quantity' })).toBe('order_size')
  })
  it('缺参文本 → param_invalid（-32602）', () => {
    const p = classifyBitgetError({ status: 200, code: '40001', text: 'Parameter does not exist: symbol' }).problem
    expect(p.code).toBe(-32602)
    expect(p.name).toBe('INVALID_PARAMS')
  })
  it('"invalid parameter" → param_invalid', () => {
    expect(classOf({ status: 200, text: 'invalid parameter: size' })).toBe('param_invalid')
  })
})

describe('分类：持仓 / 风险 / 兜底', () => {
  it('code 40774（持仓模式不匹配）→ account_configuration', () => {
    expect(classOf({ status: 200, code: '40774', text: 'position mode does not match' })).toBe('account_configuration')
  })
  it('持仓冲突文本 → position_conflict（3001）', () => {
    const p = classifyBitgetError({ status: 200, text: 'reduce-only order is rejected: position not sufficient' }).problem
    expect(p.code).toBe(3001)
    expect(p.name).toBe('VENUE_REJECTED')
  })
  it('风险上限文本 → risk_limit（3001）', () => {
    expect(classOf({ status: 200, text: 'exceeds the maximum risk limit' })).toBe('risk_limit')
  })
  it('未知报错 → exchange_rejected（3001 retryable=false）', () => {
    const classified = classifyBitgetError({ status: 200, code: '99999', text: 'something odd happened' })
    expect(classified.cls).toBe('exchange_rejected')
    expect(classified.problem.code).toBe(3001)
    expect(classified.problem.retryable).toBe(false)
  })
  it('每个分类都带 venue.id = bitget 与原 code', () => {
    const p = classifyBitgetError({ status: 200, code: '40774', text: 'x' }).problem
    expect(p.venue?.id).toBe('bitget')
    expect(p.venue?.code).toBe('40774')
  })
  it('每个分类的 name / code 与协议码表一致（抽查四类）', () => {
    expect(nameOf({ status: 200, text: 'insufficient margin' })).toBe('VENUE_INSUFFICIENT_MARGIN')
    expect(nameOf({ status: 200, text: 'invalid symbol' })).toBe('INSTRUMENT_UNKNOWN')
    expect(nameOf({ status: 200, text: 'invalid quantity' })).toBe('PRECISION')
    expect(nameOf({ status: 429, text: 'too many requests' })).toBe('VENUE_UNAVAILABLE')
  })
})

describe('撤单 / 重试判定', () => {  it('"Order does not exist" → 认作未知订单（改打计划委托端点）', () => {
    const p = makeProblem('VENUE_REJECTED', 'x', { venue: { id: 'bitget', code: '40701', message: 'Order does not exist' } })
    expect(isUnknownOrderError(p)).toBe(true)
  })
  it('普通业务错误不算未知订单', () => {
    const p = makeProblem('VENUE_REJECTED', 'x', { venue: { id: 'bitget', code: '40774', message: 'position mode mismatch' } })
    expect(isUnknownOrderError(p)).toBe(false)
  })
  it('40774 → 需要换持仓字段重试', () => {
    const p = makeProblem('VENUE_REJECTED', 'x', { venue: { id: 'bitget', code: '40774', message: 'x' } })
    expect(isPositionModeMismatch(p)).toBe(true)
  })
  it('其它错误不触发换字段', () => {
    const p = makeProblem('VENUE_REJECTED', 'x', { venue: { id: 'bitget', code: '40001', message: 'Parameter does not exist' } })
    expect(isPositionModeMismatch(p)).toBe(false)
  })
})

describe('asProblem 与脱敏', () => {
  it('ProblemError 原样带出（只脱敏文本）', () => {
    const p = asProblem(new ProblemError(makeProblem('RATE_BUDGET', 'slow down')))
    expect(p.code).toBe(2008)
  })
  it('非 Error 值 → INTERNAL', () => {
    expect(asProblem('boom').code).toBe(4001)
  })
  it('Error → INTERNAL 并保留消息', () => {
    const p = asProblem(new Error('unexpected'))
    expect(p.code).toBe(4001)
    expect(p.message).toBe('unexpected')
  })
  it('venueProblem 带 venue 段', () => {
    const p = venueProblem('VENUE_REJECTED', 'rejected', 'upstream text')
    expect(p.venue).toEqual({ id: 'bitget', message: 'upstream text' })
    expect(p.code).toBe(3001)
  })
  it('redactSecret 替换原文与 base64，空串跳过', () => {
    const secret = 'secret-value'
    const b64 = Buffer.from(secret, 'utf8').toString('base64')
    const out = redactSecret(`a ${secret} b ${b64} c`, [secret, ''])
    expect(out).toBe('a <redacted> b <redacted> c')
  })
  it('redactSecret 接受单个字符串', () => {
    expect(redactSecret('x-abc-x', 'abc')).toBe('x-<redacted>-x')
  })
  it('没有密钥时文本不变', () => {
    expect(redactSecret('hello', [])).toBe('hello')
  })
})

describe('分类：Bitget 官方码补充', () => {
  it('40006 / 40012 / 40014 / 40037 → credentials', () => {
    for (const code of ['40006', '40012', '40014', '40037']) expect(classOf({ status: 200, code, text: 'x' })).toBe('credentials')
  })
  it('code 40008 → clock_skew（3005 retryable）', () => {
    const p = classifyBitgetError({ status: 400, code: '40008', text: 'Request timestamp expired' }).problem
    expect(p).toMatchObject({ code: 3005, name: 'VENUE_AUTH', retryable: true })
  })
  it('40762 / 43012 → insufficient_funds（3004）', () => {
    for (const code of ['40762', '43012']) expect(classOf({ status: 200, code, text: 'x' })).toBe('insufficient_funds')
  })
  it('45110 → min_notional（1003，不再归到 order_size）', () => {
    const p = classifyBitgetError({ status: 200, code: '45110', text: 'less than the minimum amount 5 USDT' }).problem
    expect(p).toMatchObject({ code: 1003, name: 'MIN_NOTIONAL' })
  })
  it('「less than the minimum amount」文本 → min_notional', () => {
    expect(classOf({ status: 200, text: 'order value is less than the minimum amount 5 USDT' })).toBe('min_notional')
  })
  it('「system is abnormal」类文本 → transport（3003 retryable）', () => {
    for (const text of ['System error', 'System busy', 'System is abnormal', 'please try again later']) {
      const p = classifyBitgetError({ status: 400, text }).problem
      expect(p).toMatchObject({ code: 3003, retryable: true })
    }
  })
})

describe('订单不存在的码表', () => {
  it('40109 / 40768 / 43001 / 43025 → isUnknownOrderError', () => {
    for (const code of ['40109', '40768', '43001', '43025']) {
      const p = makeProblem('VENUE_REJECTED', 'x', { venue: { id: 'bitget', code, message: 'x' } })
      expect(isUnknownOrderError(p)).toBe(true)
    }
  })
  it('「Parameter does not exist」（缺参）不算订单不存在', () => {
    const p = makeProblem('INVALID_PARAMS', 'x', { venue: { id: 'bitget', code: '40001', message: 'Parameter does not exist: symbol' } })
    expect(isUnknownOrderError(p)).toBe(false)
  })
  it('「The data of the order cannot be found」算订单不存在', () => {
    const p = makeProblem('VENUE_REJECTED', 'x', { venue: { id: 'bitget', message: 'The data of the order cannot be found, please confirm the order number' } })
    expect(isUnknownOrderError(p)).toBe(true)
  })
})

describe('任意 HTTP 状态先解析信封（阻断 1）', () => {
  const setup = () => {
    const fake = new FakeBitget()
    const made = makeConnector(fake)
    made.connector.market.seedContracts(fake.contracts, NOW)
    made.connector.market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW)
    made.accounts.seedPosMode('BTCUSDT', 'one_way_mode')
    return { fake, ...made }
  }
  const limitIntent = (over: Record<string, unknown> = {}): OrderIntent => ({
    accountId: ACCOUNT_ID, instrumentId: 'bitget:BTCUSDT', side: 'buy', type: 'limit', size: '0.1', price: '60000', ...over,
  } as unknown as OrderIntent)

  it('POST 400 + 40762 → 3004 且保留 venue.code', async () => {
    const { fake, trading } = setup()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '40762', msg: 'The order amount exceeds the balance', data: null }, 400)
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(3004)
    expect(result.acks[0]!.problem?.venue?.code).toBe('40762')
  })
  it('POST 400 + 40015 System is abnormal → 3006 unknown，只发一次', async () => {
    const { fake, trading } = setup()
    fake.fail('POST', '/api/v2/mix/order/place-order', { code: '40015', msg: 'System is abnormal, please try again later' }, 400)
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(result.acks[0]!.status).toBe('unknown')
    expect(result.acks[0]!.problem?.code).toBe(3006)
    expect(result.acks[0]!.problem?.retryable).toBe(false)
    expect(fake.callsFor('POST', '/api/v2/mix/order/place-order')).toHaveLength(1)
  })
  it('GET 400 + 40015 System is abnormal → 3003 retryable', async () => {
    const { fake, accounts } = setup()
    fake.fail('GET', '/api/v2/mix/account/accounts', { code: '40015', msg: 'System is abnormal, please try again later' }, 400)
    const problem = await problemOf(() => accounts.accountState(accountRef))
    expect(problem).toMatchObject({ code: 3003, retryable: true })
  })
  it('GET 401 + 40009 → 3005；GET 400 + 40008 → 3005 retryable', async () => {
    const one = setup()
    one.fake.fail('GET', '/api/v2/mix/account/accounts', { code: '40009', msg: 'sign signature error' }, 401)
    expect((await problemOf(() => one.accounts.accountState(accountRef))).code).toBe(3005)
    const two = setup()
    two.fake.fail('GET', '/api/v2/mix/account/accounts', { code: '40008', msg: 'Request timestamp expired' }, 400)
    expect(await problemOf(() => two.accounts.accountState(accountRef))).toMatchObject({ name: 'VENUE_AUTH', retryable: true })
  })
  it('POST 400 + 45110 → 1003；POST 400 + Duplicate clientOid → 3006', async () => {
    const one = setup()
    one.fake.fail('POST', '/api/v2/mix/order/place-order', { code: '45110', msg: 'less than the minimum amount 5 USDT' }, 400)
    const a = await one.trading.submit(tradeContext(), [limitIntent()])
    expect(a.acks[0]!.problem?.code).toBe(1003)
    const two = setup()
    two.fake.fail('POST', '/api/v2/mix/order/place-order', { code: '40000', msg: 'Duplicate clientOid' }, 400)
    const b = await two.trading.submit(tradeContext(), [limitIntent()])
    expect(b.acks[0]!.status).toBe('unknown')
    expect(b.acks[0]!.problem?.code).toBe(3006)
  })
  it('400 但 body 不是 JSON → 仍走 BitgetHttpError（GET 3001 / POST 非含糊 3001）', async () => {
    const one = setup()
    one.fake.failWith.set('GET /api/v2/mix/account/accounts', () => new Response('<html>bad</html>', { status: 400 }))
    expect((await problemOf(() => one.accounts.accountState(accountRef))).code).toBe(3001)
    const two = setup()
    two.fake.failWith.set('POST /api/v2/mix/order/place-order', () => new Response('<html>bad</html>', { status: 400 }))
    const result = await two.trading.submit(tradeContext(), [limitIntent()])
    expect(result.acks[0]!.problem?.code).toBe(3001)
  })
  it('POST 502 非 JSON → 3006（408 / 5xx 结果未知）', async () => {
    const { fake, trading } = setup()
    fake.failWith.set('POST /api/v2/mix/order/place-order', () => new Response('<html>bad</html>', { status: 502 }))
    const result = await trading.submit(tradeContext(), [limitIntent()])
    expect(result.acks[0]!.problem?.code).toBe(3006)
  })
})
