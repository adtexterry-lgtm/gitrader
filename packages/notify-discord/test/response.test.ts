// SPDX-License-Identifier: CPAL-1.0
// response.ts 单测：204 / 200+message、429（body 与 Retry-After 头两种来源）、5xx 可重试、4xx 不重试。
import { describe, expect, it } from 'vitest'
import { classifyResponse, parseRetryAfter } from '../src/response'

describe('classifyResponse：成功', () => {
  it('204 No Content（未带 wait 时的官方成功响应）→ ok，无 ref', () => {
    expect(classifyResponse(204, '')).toEqual({ ok: true, retryable: false })
  })

  it('200 + message 对象 → ref 取 message id（官方 ID 是字符串）', () => {
    const verdict = classifyResponse(200, JSON.stringify({ id: '1300000000000000001', content: 'hi' }))
    expect(verdict).toMatchObject({ ok: true, ref: '1300000000000000001' })
  })

  it('200 + 数字 id 也收（同一个值转成字符串）', () => {
    expect(classifyResponse(200, JSON.stringify({ id: 42 }))).toMatchObject({ ok: true, ref: '42' })
  })

  it('200 但 body 为空 / 不是 message → ok，无 ref（不因为读不到 id 就判失败）', () => {
    expect(classifyResponse(200, '')).toEqual({ ok: true, retryable: false })
    expect(classifyResponse(200, 'not json')).toEqual({ ok: true, retryable: false })
  })
})

describe('classifyResponse：429 限流', () => {
  it('body.retry_after 是秒（可为小数）→ 毫秒；global 标记保留', () => {
    const verdict = classifyResponse(429, JSON.stringify({ message: 'You are being rate limited.', retry_after: 64.57, global: true }))
    expect(verdict).toMatchObject({ ok: false, retryable: true, retryAfterMs: 64570, global: true })
    expect(verdict.reason).toBe('rate_limited:global:retry_after_ms=64570')
  })

  it('body 没有 retry_after 时退回 Retry-After 头', () => {
    const verdict = classifyResponse(429, '', { 'Retry-After': '65' })
    expect(verdict).toMatchObject({ ok: false, retryable: true, retryAfterMs: 65000 })
  })

  it('两处都没有 → 仍然 retryable，但给不出等待时间', () => {
    const verdict = classifyResponse(429, '')
    expect(verdict).toMatchObject({ ok: false, retryable: true })
    expect(verdict.retryAfterMs).toBeUndefined()
  })
})

describe('classifyResponse：失败分类', () => {
  it('5xx 可重试，reason 带状态码与官方 message', () => {
    const verdict = classifyResponse(502, JSON.stringify({ message: 'Bad Gateway', code: 0 }))
    expect(verdict).toMatchObject({ ok: false, retryable: true })
    expect(verdict.reason).toBe('http_502:code=0:Bad Gateway')
  })

  it('401 + 50027（Invalid webhook token）不重试，reason 带官方错误码', () => {
    const verdict = classifyResponse(401, JSON.stringify({ message: 'Invalid Webhook Token', code: 50027 }))
    expect(verdict).toMatchObject({ ok: false, retryable: false })
    expect(verdict.reason).toBe('http_401:code=50027:Invalid Webhook Token')
  })

  it('404 + 10015（Unknown webhook）不重试 —— 官方限流页要求 404 后不要再打同一个 webhook', () => {
    const verdict = classifyResponse(404, JSON.stringify({ message: 'Unknown Webhook', code: 10015 }))
    expect(verdict).toMatchObject({ ok: false, retryable: false })
    expect(verdict.reason).toContain('10015')
  })

  it('400 + 50035（Invalid form body）不重试：参数错，重发不会变对', () => {
    const verdict = classifyResponse(400, JSON.stringify({ message: 'Invalid Form Body', code: 50035 }))
    expect(verdict).toMatchObject({ ok: false, retryable: false })
    expect(verdict.reason).toContain('50035')
  })

  it('非 JSON 的 4xx 也给出可读 reason（压成一行、带上状态码）', () => {
    const verdict = classifyResponse(403, 'Forbidden\n\nreason: missing access')
    expect(verdict).toMatchObject({ ok: false, retryable: false })
    expect(verdict.reason).toBe('http_403:Forbidden reason: missing access')
  })
})

describe('parseRetryAfter', () => {
  it('秒字符串 → 毫秒；小数与非法值分别处理', () => {
    expect(parseRetryAfter('65')).toBe(65000)
    expect(parseRetryAfter('1.5')).toBe(1500)
    expect(parseRetryAfter('soon')).toBe(undefined)
    expect(parseRetryAfter(undefined)).toBe(undefined)
    expect(parseRetryAfter('-3')).toBe(undefined)
  })
})
