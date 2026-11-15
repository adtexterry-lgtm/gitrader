// SPDX-License-Identifier: CPAL-1.0
// 错误分类（契约 §2.8）：429 / 401 / 403 / 3004 / 市场关闭 / 单不存在 / 结果未知（只有非 GET）。
import { describe, expect, it } from 'vitest'
import { makeProblem } from '@gitrader/protocol'
import {
  AlpacaApiError, AlpacaHttpError, AlpacaNetworkError, ProblemError, asProblem, redactSecret, throwAsProblem,
} from '../src/errors'
import {
  classifyAlpacaError, isInsufficientError, isMarketClosedError, isRateLimited, isUnknownOrderError,
} from '../src/venue-errors'
import { API_KEY, API_SECRET } from './helpers/fake-alpaca'

const SECRETS = [API_SECRET, API_KEY]

describe('分类表', () => {
  it('429 → VENUE_UNAVAILABLE 可重试', () => {
    const c = classifyAlpacaError({ status: 429, text: 'too many requests' })
    expect(c.problem.code).toBe(3003)
    expect(c.problem.retryable).toBe(true)
    expect(c.klass).toBe('rate_limited')
  })
  it('401 → VENUE_AUTH', () => {
    const c = classifyAlpacaError({ status: 401, code: 40110000, text: '40110000 access key verification failed' })
    expect(c.problem.code).toBe(3005)
    expect(c.klass).toBe('auth')
  })
  it('403 带 auth 线索 → VENUE_AUTH；不带 → VENUE_REJECTED', () => {
    expect(classifyAlpacaError({ status: 403, text: 'forbidden: not authorized' }).problem.code).toBe(3005)
    expect(classifyAlpacaError({ status: 403, text: 'account is restricted' }).problem.code).toBe(3001)
  })
  it('买力 / 可卖数量不足 → 3004', () => {
    const c = classifyAlpacaError({ status: 403, code: 40310000, text: '40310000 insufficient qty available for order' })
    expect(c.problem.code).toBe(3004)
    expect(isInsufficientError(c.problem)).toBe(true)
  })
  it('市场关闭 → 3001 且带可识别标记', () => {
    const c = classifyAlpacaError({ status: 403, text: 'market is closed' })
    expect(c.problem.code).toBe(3001)
    expect(isMarketClosedError(c.problem)).toBe(true)
  })
  it('单不存在（404 / 40410000）→ unknown_order', () => {
    const c = classifyAlpacaError({ status: 404, code: 40410000, text: '40410000 order not found' })
    expect(c.unknownOrder).toBe(true)
    expect(isUnknownOrderError(c.problem)).toBe(true)
  })
  it('非 GET 上的 500 → outcomeUnknown（3006）', () => {
    const c = classifyAlpacaError({ status: 500, text: 'internal server error', mutating: true })
    expect(c.problem.code).toBe(3006)
    expect(c.outcomeUnknown).toBe(true)
    expect(c.problem.retryable).toBe(false)
  })
  it('GET 上的 500 → 不是 3006', () => {
    const c = classifyAlpacaError({ status: 500, text: 'internal server error' })
    expect(c.outcomeUnknown).toBe(false)
    expect(c.problem.code).not.toBe(3006)
  })
  it('条款码缺文本也能归类（422）', () => {
    const c = classifyAlpacaError({ status: 422, code: 42210000, text: '' })
    expect(c.problem.code).toBe(3001)
  })
})

describe('asProblem：从错误对象到 Problem', () => {
  it('ProblemError 原样透出（只做脱敏）', () => {
    const problem = makeProblem('INVALID_PARAMS', 'bad input')
    expect(asProblem(new ProblemError(problem)).code).toBe(-32602)
  })
  it('外来的 ProblemError（另一个类）按形状认', () => {
    const foreign = { problem: { code: 1004, name: 'ORDER_TYPE_UNSUPPORTED', category: 'REJECTED', message: 'nope', retryable: false } }
    expect(asProblem(foreign).code).toBe(1004)
  })
  it('AlpacaHttpError 429 → 带 retryAfterMs 的 3003', () => {
    const p = asProblem(new AlpacaHttpError(429, 'slow down', 'signed', 1500))
    expect(p.code).toBe(3003)
    expect(p.retryAfterMs).toBe(1500)
  })
  it('AlpacaHttpError 非 GET 断连 → 3006', () => {
    expect(asProblem(new AlpacaHttpError(0, 'socket hang up', 'signed', undefined, true)).code).toBe(3006)
  })
  it('AlpacaHttpError 只读 500 → 3003 可重试', () => {
    const p = asProblem(new AlpacaHttpError(500, 'internal error', 'signed'))
    expect(p.code).toBe(3003)
    expect(p.retryable).toBe(true)
  })
  it('AlpacaApiError 带 code 与原文进 venue 段', () => {
    const p = asProblem(new AlpacaApiError(40310000, 'insufficient qty available for order', 'signed', 'body'))
    expect(p.code).toBe(3004)
    expect(p.venue?.code).toBe(40310000)
    expect(p.venue?.message).toContain('insufficient qty')
  })
  it('AlpacaApiError + outcomeUnknown → 3006', () => {
    const p = asProblem(new AlpacaApiError(50010000, 'unknown execution state', 'signed', 'body', true, 500))
    expect(p.code).toBe(3006)
  })
  it('网络错误：只读 → 3003；改变状态 → 3006', () => {
    expect(asProblem(new AlpacaNetworkError('timeout', 'signed')).code).toBe(3003)
    expect(asProblem(new AlpacaNetworkError('timeout', 'signed', undefined, true)).code).toBe(3006)
  })
  it('认不出来的错 → INTERNAL(4001)', () => {
    expect(asProblem(new Error('boom')).code).toBe(4001)
    expect(asProblem('boom').message).toBe('boom')
  })
  it('错误文本里的密钥被替换（含 base64 形态）', () => {
    const encoded = Buffer.from(API_SECRET, 'utf8').toString('base64')
    const p = asProblem(new AlpacaApiError(42210000, `bad secret ${API_SECRET} / ${encoded}`, 'signed', 'x'), { secrets: SECRETS })
    expect(p.venue?.message).not.toContain(API_SECRET)
    expect(p.venue?.message).not.toContain(encoded)
    expect(p.venue?.message).toContain('<redacted>')
  })
  it('redactSecret 跳过空串', () => {
    expect(redactSecret('abc', ['', 'b'])).toBe('a<redacted>c')
  })
  it('throwAsProblem 抛 ProblemError', () => {
    expect(() => throwAsProblem(new Error('x'))).toThrow(ProblemError)
  })
})

describe('辅助判定', () => {
  it('isRateLimited 认 3002 / 3003', () => {
    expect(isRateLimited(makeProblem('VENUE_RATE_LIMITED', 'x'))).toBe(true)
    expect(isRateLimited(makeProblem('VENUE_UNAVAILABLE', 'x'))).toBe(true)
    expect(isRateLimited(makeProblem('VENUE_REJECTED', 'x'))).toBe(false)
  })
  it('isUnknownOrderError 认 404 码与 not found 文本', () => {
    expect(isUnknownOrderError(makeProblem('VENUE_REJECTED', 'order not found'))).toBe(true)
    expect(isUnknownOrderError({ ...makeProblem('VENUE_REJECTED', 'x'), venue: { id: 'alpaca', code: 404, message: 'not found' } })).toBe(true)
    expect(isUnknownOrderError(makeProblem('VENUE_REJECTED', 'insufficient qty'))).toBe(false)
  })
})
