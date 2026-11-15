// SPDX-License-Identifier: CPAL-1.0
// 错误分类（contract §2.8）：Gate 的 label / 文本 → 协议 Problem；认不出来的一律 3001，不编码。
import { describe, expect, it } from 'vitest'
import { makeProblem } from '@gitrader/protocol'
import { asProblem, GateHttpError, GateNetworkError, ProblemError, redactSecret, venueProblem } from '../src/errors'
import { classifyGateError, isTimestampError, isUnknownOrderError } from '../src/venue-errors'

const cls = (label: string | undefined, text = '', status = 400) => classifyGateError({ status, ...(label !== undefined ? { label } : {}), text })

describe('label → Problem', () => {
  it('1. INVALID_KEY / INVALID_SIGNATURE / IP_FORBIDDEN → VENUE_AUTH（3005，不可重试）', () => {
    for (const label of ['INVALID_KEY', 'INVALID_SIGNATURE', 'IP_FORBIDDEN', 'READ_ONLY']) {
      const { problem } = cls(label)
      expect(problem.code).toBe(3005)
      expect(problem.retryable).toBe(false)
      expect(problem.venue?.code).toBe(label)
    }
  })

  it('2. REQUEST_EXPIRED / INVALID_TIMESTAMP → VENUE_AUTH 但可重试（重校时钟）', () => {
    const { problem } = cls('REQUEST_EXPIRED', 'request expired')
    expect(problem.code).toBe(3005)
    expect(problem.retryable).toBe(true)
    expect(isTimestampError(problem)).toBe(true)
  })

  it('3. TOO_MANY_REQUESTS → 3003 retryable（与 HL 包一致）', () => {
    const { problem } = cls('TOO_MANY_REQUESTS')
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('4. CONTRACT_NOT_FOUND → INSTRUMENT_UNKNOWN（1001）', () => {
    expect(cls('CONTRACT_NOT_FOUND').problem.code).toBe(1001)
    expect(cls(undefined, 'contract not found: BTC_USDT').problem.name).toBe('INSTRUMENT_UNKNOWN')
  })

  it('5. PRICE_TOO_DEVIATED → PRICE_DRIFT（1007，可重试）', () => {
    const { problem } = cls('PRICE_TOO_DEVIATED', 'order price deviates too much from mark price')
    expect(problem.code).toBe(1007)
    expect(problem.retryable).toBe(true)
  })

  it('6. BALANCE_NOT_ENOUGH / MARGIN_NOT_ENOUGH → VENUE_INSUFFICIENT_MARGIN（3004）', () => {
    expect(cls('BALANCE_NOT_ENOUGH').problem.code).toBe(3004)
    expect(cls('MARGIN_NOT_ENOUGH').problem.code).toBe(3004)
    expect(cls(undefined, 'insufficient margin').problem.code).toBe(3004)
  })

  it('7. ORDER_SIZE_TOO_SMALL / ORDER_PRICE_ROUND → PRECISION（1002）', () => {
    expect(cls('ORDER_SIZE_TOO_SMALL').problem.code).toBe(1002)
    expect(cls('ORDER_PRICE_ROUND', 'order_price_round is 0.1').problem.code).toBe(1002)
  })

  it('8. INVALID_PARAM_VALUE / MISSING_REQUIRED_PARAM → INVALID_PARAMS（-32602）', () => {
    expect(cls('INVALID_PARAM_VALUE').problem.code).toBe(-32602)
    expect(cls('MISSING_REQUIRED_PARAM', 'missing required param').problem.code).toBe(-32602)
  })

  it('9. REDUCE_ONLY / POSITION_NOT_ENOUGH → VENUE_REJECTED（3001）', () => {
    expect(cls('REDUCE_ONLY', 'reduce only order is rejected').problem.code).toBe(3001)
    expect(cls('POSITION_NOT_FOUND', 'position not found').problem.code).toBe(3001)
  })

  it('10. RISK_LIMIT_EXCEEDED → 3001；MARKET_NOT_AVAILABLE → 3003', () => {
    expect(cls('RISK_LIMIT_EXCEEDED').problem.code).toBe(3001)
    expect(cls('MARKET_NOT_AVAILABLE').problem.code).toBe(3003)
  })

  it('11. ORDER_NOT_FOUND → 3001 + isUnknownOrderError 认得出（撤单单据不存在不算故障）', () => {
    const { problem } = cls('ORDER_NOT_FOUND', 'order 1 not found')
    expect(problem.code).toBe(3001)
    expect(isUnknownOrderError(problem)).toBe(true)
  })

  it('12. 不认识的 label（且文本无特征）→ 3001 VENUE_REJECTED，不编造码', () => {
    const { problem, cls: klass } = cls('SOME_NEW_LABEL', 'something happened')
    expect(problem.code).toBe(3001)
    expect(klass).toBe('exchange_rejected')
    expect(problem.venue?.code).toBe('SOME_NEW_LABEL')
  })

  it('13. label 匹配不区分大小写', () => {
    expect(cls('invalid_signature').problem.code).toBe(3005)
  })

  it('14. 401 / 403 状态优先于 label（凭据类）', () => {
    expect(cls(undefined, '', 401).problem.code).toBe(3005)
    expect(cls(undefined, '', 403).problem.code).toBe(3005)
  })

  it('15. 429 / 418 状态优先（限流类）', () => {
    expect(cls(undefined, '', 429).problem.code).toBe(3003)
    expect(cls(undefined, '', 418).problem.code).toBe(3003)
  })

  it('16. 5xx 状态 → transport 类（3003 可重试）', () => {
    const { problem } = cls(undefined, 'bad gateway', 502)
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(true)
  })

  it('17. 上游原文原样进 venue.message（不翻译、不改写）', () => {
    const text = 'order price 100.15 is not multiple of order_price_round 0.1'
    expect(cls('ORDER_PRICE_ROUND', text).problem.venue?.message).toBe(text)
  })
})

describe('asProblem 形状判定', () => {
  it('18. GateHttpError 的 429 带 Retry-After', () => {
    const problem = asProblem(new GateHttpError(429, '{"label":"TOO_MANY_REQUESTS"}', 'signed', 'TOO_MANY_REQUESTS', 1_500))
    expect(problem.code).toBe(3003)
    expect(problem.retryAfterMs).toBe(1_500)
  })

  it('19. GateHttpError 的 outcomeUnknown → 3006（不可重试）', () => {
    const problem = asProblem(new GateHttpError(502, 'boom', 'signed', undefined, undefined, true))
    expect(problem.code).toBe(3006)
    expect(problem.retryable).toBe(false)
  })

  it('20. GateNetworkError：outcomeUnknown 才 3006，否则 3003', () => {
    expect(asProblem(new GateNetworkError('x', 'signed', undefined, true)).code).toBe(3006)
    expect(asProblem(new GateNetworkError('x', 'public', undefined, false)).code).toBe(3003)
  })

  it('21. 脱敏：apiSecret 与 apiKey 都在错误文本里替换掉', () => {
    const problem = asProblem(new GateHttpError(401, 'bad key KEY-123 and secret S-456', 'signed', 'INVALID_KEY'), {
      secrets: ['S-456', 'KEY-123'],
    })
    expect(problem.venue?.message).not.toContain('S-456')
    expect(problem.venue?.message).not.toContain('KEY-123')
    expect(problem.venue?.message).toContain('<redacted>')
  })

  it('22. 外来 ProblemError 按形状转交（不退化成 INTERNAL）', () => {
    const foreign = new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', 'nope'))
    expect(asProblem(foreign).code).toBe(1001)
    const shaped = { problem: makeProblem('PRECISION', 'bad size') }
    expect(asProblem(shaped).code).toBe(1002)
  })

  it('23. venueProblem 统一带 venue.id = gateio', () => {
    expect(venueProblem('VENUE_REJECTED', 'x', 'upstream').venue).toEqual({ id: 'gateio', message: 'upstream' })
  })

  it('24. redactSecret 处理多个 secret 与空串', () => {
    expect(redactSecret('x secret-a y secret-c', ['secret-a', '', 'secret-c'])).toBe('x <redacted> y <redacted>')
    expect(redactSecret('plain', 'not-there')).toBe('plain')
  })

  it('25. 追加 label 的落点：尺寸 / 仓位冲突 / 下市 / 缺头 / TOO_BUSY', () => {
    expect(cls('SIZE_TOO_SMALL').problem.code).toBe(1002)
    expect(cls('SIZE_TOO_LARGE').problem.code).toBe(1002)
    expect(cls('POSITION_EMPTY').problem.code).toBe(3001)
    expect(cls('REDUCE_EXCEEDED').problem.code).toBe(3001)
    expect(cls('CONTRACT_IN_DELISTING').problem.code).toBe(3003)
    expect(cls('MISSING_REQUIRED_HEADER', '', 400).problem.code).toBe(3005)
    expect(cls('POSITION_DUAL_MODE').problem.code).toBe(3001)
    expect(cls('LIQUIDATE_IMMEDIATELY').problem.code).toBe(3001)
    expect(cls('TOO_BUSY', '', 400).problem.code).toBe(3003)
  })
})
