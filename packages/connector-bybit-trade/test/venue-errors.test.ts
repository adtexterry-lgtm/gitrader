// SPDX-License-Identifier: CPAL-1.0
// 错误分类：QD error_classification 的顺序 + Bybit v5 retCode 段 → 协议 Problem。
import { describe, expect, it } from 'vitest'
import { BYBIT_ERROR_CLASSES, classifyBybitError } from '../src/venue-errors'
import { asProblem, BybitHttpError, redactSecret } from '../src/errors'

const problem = (retCode: number, text = `retCode ${retCode}`): { code: number; retryable: boolean; name: string } =>
  classifyBybitError({ text, retCode }).problem as { code: number; retryable: boolean; name: string }

describe('码表覆盖', () => {
  it('凭证类：10003 / 10004 / 10005 / 10007 / 10010', () => {
    for (const code of [10003, 10004, 10005, 10007, 10010]) expect(BYBIT_ERROR_CLASSES[code]).toBe('credentials')
  })

  it('时钟：10002', () => {
    expect(BYBIT_ERROR_CLASSES[10002]).toBe('clock_skew')
  })

  it('限流：10006 / 10018 / 10429 / 20003 / 50011', () => {
    for (const code of [10006, 10018, 10429, 20003, 50011]) expect(BYBIT_ERROR_CLASSES[code]).toBe('rate_limit')
  })

  it('资金：110004 / 110006 / 110007 / 110012 / 110044 / 170131', () => {
    for (const code of [110004, 110006, 110007, 110012, 110044, 170131]) expect(BYBIT_ERROR_CLASSES[code]).toBe('insufficient_funds')
  })

  it('数量 / 精度：110017 / 110094', () => {
    for (const code of [110017, 110094]) expect(BYBIT_ERROR_CLASSES[code]).toBe('order_size')
  })

  it('市场不可用：110063（结算中暂停）/ 110074（合约未上线）', () => {
    for (const code of [110063, 110074]) expect(BYBIT_ERROR_CLASSES[code]).toBe('market_unavailable')
  })

  it('110072（同号订单已在场上）→ exchange_rejected', () => {
    expect(BYBIT_ERROR_CLASSES[110072]).toBe('exchange_rejected')
  })

  it('持仓冲突：110005 / 110008 / 110010 / 110034', () => {
    for (const code of [110005, 110008, 110010, 110034]) expect(BYBIT_ERROR_CLASSES[code]).toBe('position_conflict')
  })

  it('风险限额：110011 / 110013 / 110089 / 110090', () => {
    for (const code of [110011, 110013, 110089, 110090]) expect(BYBIT_ERROR_CLASSES[code]).toBe('risk_limit')
  })

  it('账户配置：110015 / 110024 / 110025 / 110036 / 110043', () => {
    for (const code of [110015, 110024, 110025, 110036, 110043]) expect(BYBIT_ERROR_CLASSES[code]).toBe('account_configuration')
  })

  it('价格带：110003 / 110120 / 110121', () => {
    for (const code of [110003, 110120, 110121]) expect(BYBIT_ERROR_CLASSES[code]).toBe('price_band')
  })
})

describe('分类结果 → 协议 Problem', () => {
  it('凭证类 → 3005 VENUE_AUTH，不可重试', () => {
    const p = problem(10004, 'retCode 10004 error sign')
    expect(p.code).toBe(3005)
    expect(p.retryable).toBe(false)
  })

  it('时钟 → INVALID_PARAMS（-32602），不可重试', () => {
    const p = problem(10002, 'retCode 10002 timestamp outside recvWindow')
    expect(p.name).toBe('INVALID_PARAMS')
    expect(p.retryable).toBe(false)
  })

  it('限流 → 3002 VENUE_RATE_LIMITED，可重试', () => {
    const p = problem(10006, 'retCode 10006 too many visits')
    expect(p.code).toBe(3002)
    expect(p.retryable).toBe(true)
  })

  it('标的未知码 10029 → 1001 INSTRUMENT_UNKNOWN', () => {
    expect(problem(10029, 'retCode 10029 symbol not found').code).toBe(1001)
  })

  it('110063 / 110074 → 3003 VENUE_UNAVAILABLE（可重试）', () => {
    for (const code of [110063, 110074]) {
      const p = problem(code, `retCode ${code} market unavailable`)
      expect(p.code).toBe(3003)
      expect(p.retryable).toBe(true)
    }
  })

  it('资金不足 → 3004 VENUE_INSUFFICIENT_MARGIN', () => {
    expect(problem(110004, 'retCode 110004 insufficient balance').code).toBe(3004)
  })

  it('数量 / 精度 → 1002 PRECISION', () => {
    expect(problem(110094, 'retCode 110094 qty is too small').code).toBe(1002)
  })

  it('价格带 → 1007 PRICE_DRIFT', () => {
    expect(problem(110003, 'retCode 110003 price exceeds the allowable range').code).toBe(1007)
  })

  it('持仓冲突 → 3001 VENUE_REJECTED', () => {
    expect(problem(110005, 'retCode 110005 reduce-only order rejected').code).toBe(3001)
  })

  it('风险限额 → 3001', () => {
    expect(problem(110011, 'retCode 110011 risk limit exceeded').code).toBe(3001)
  })

  it('服务重启 / 交割中 → 3003（可重试）', () => {
    const p = problem(10016, 'retCode 10016 service is restarting')
    expect(p.code).toBe(3003)
    expect(p.retryable).toBe(true)
  })

  it('参数错误 10001 → INVALID_PARAMS（参数形状问题，不是场所拒单）', () => {
    expect(problem(10001, 'retCode 10001 params error').name).toBe('INVALID_PARAMS')
  })

  it('认不出来的 → 3001，不可重试（不猜、不盲发）', () => {
    const p = problem(99999, 'retCode 99999 something new')
    expect(p.code).toBe(3001)
    expect(p.retryable).toBe(false)
  })
})

describe('分类顺序（QD 的先后）', () => {
  it('凭证优先于其它：同时命中 10003 与 insufficient 文案仍判凭证', () => {
    expect(classifyBybitError({ text: 'retCode 10003 insufficient balance', retCode: 10003 }).class).toBe('credentials')
  })

  it('时钟优先于限流：文案里同时出现 timestamp 与 rate limit 仍判时钟', () => {
    expect(classifyBybitError({ text: 'timestamp outside recvWindow, rate limit', retCode: 10002 }).class).toBe('clock_skew')
  })

  it('只有文案没有 retCode 也能分类（upstream 只回 retMsg 时）', () => {
    expect(classifyBybitError({ text: 'error sign' }).class).toBe('credentials')
    expect(classifyBybitError({ text: 'too many visits' }).class).toBe('rate_limit')
    expect(classifyBybitError({ text: 'ab not enough for new order' }).class).toBe('insufficient_funds')
    expect(classifyBybitError({ text: 'qty is too small' }).class).toBe('order_size')
  })

  it('HTTP 401 → 凭证类；403 + denied → exchange_rejected', () => {
    expect(classifyBybitError({ text: 'denied', httpStatus: 401 }).class).toBe('credentials')
    expect(classifyBybitError({ text: 'denied', httpStatus: 403 }).class).toBe('exchange_rejected')
  })

  it('HTTP 429 → 限流类', () => {
    expect(classifyBybitError({ text: 'slow down', httpStatus: 429 }).class).toBe('rate_limit')
  })

  it('HTTP 5xx → 传输类（可重试）', () => {
    expect(classifyBybitError({ text: 'boom', httpStatus: 503 }).class).toBe('transport')
  })

  it('venue.code 保留上游 retCode，venue.message 保留原文', () => {
    const p = classifyBybitError({ text: 'retCode 110004 insufficient balance', retCode: 110004 }).problem
    expect(p.venue?.code).toBe(110004)
    expect(p.venue?.message).toBe('retCode 110004 insufficient balance')
    expect(p.venue?.id).toBe('bybit')
  })

  it('没有 retCode 时 venue.code 落 HTTP 状态', () => {
    const p = classifyBybitError({ text: 'boom', httpStatus: 503 }).problem
    expect(p.venue?.code).toBe(503)
  })
})

describe('asProblem 的分派', () => {
  it('BybitHttpError 带 429 → 3002 且带 Retry-After', () => {
    const p = asProblem(new BybitHttpError(429, 'slow down', 'signed', 1_500))
    expect(p.code).toBe(3002)
    expect(p.retryAfterMs).toBe(1_500)
  })

  it('BybitHttpError + 10001 → INVALID_PARAMS', () => {
    const p = asProblem(new BybitHttpError(200, '{"retCode":10001,"retMsg":"params error"}', 'signed', undefined, 10001))
    expect(p.name).toBe('INVALID_PARAMS')
  })

  it('未知 Error → INTERNAL（4001）', () => {
    expect(asProblem(new Error('boom')).code).toBe(4001)
  })

  it('非 Error 值也能转（String 化）', () => {
    expect(asProblem('weird').message).toBe('weird')
  })

  it('脱敏：密钥出现在 message 与 venue.message 里都被替换', () => {
    const secret = 'super-secret-value'
    const p = asProblem(new BybitHttpError(400, `{"retMsg":"bad ${secret}"}`, 'signed'), { secrets: [secret] })
    expect(p.venue?.message).not.toContain(secret)
    expect(redactSecret(`x${secret}y`, [secret])).toBe('x<redacted>y')
  })
})
