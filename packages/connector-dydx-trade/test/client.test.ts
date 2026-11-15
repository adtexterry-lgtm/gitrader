// SPDX-License-Identifier: CPAL-1.0
// HTTP 层与错误分类测试：限流预算（含 acquire(0)）、429 退避、GET 可重试 / 非 GET 结果未知（3006）、
// 脱敏、超时、非 JSON 响应、ABCI 码分类。
import { describe, expect, it } from 'vitest'
import { DydxHttp, unlimitedBudget, type BudgetLike, type FetchLike, type FetchResponseLike } from '../src/client'
import { DydxHttpError, DydxNetworkError, DydxTxError, asProblem, redactSecret, txProblemName } from '../src/errors'
import { INDEXER_RATE_LIMIT, INDEXER_RATE_WINDOW_MS } from '../src/constants'

const json = (status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
})

function recorder(): { budget: BudgetLike; acquired: number[]; penalties: (number | undefined)[]; oks: number } {
  const state = { acquired: [] as number[], penalties: [] as (number | undefined)[], oks: 0 }
  const budget: BudgetLike = {
    async acquire(w: number) { state.acquired.push(w) },
    penalize(ms?: number) { state.penalties.push(ms) },
    reportOk() { state.oks += 1 },
    usage: () => ({ used: 0, limit: INDEXER_RATE_LIMIT, windowMs: INDEXER_RATE_WINDOW_MS }),
  }
  return { budget, get acquired() { return state.acquired }, get penalties() { return state.penalties }, get oks() { return state.oks } } as never
}

describe('请求与预算', () => {
  it('成功请求：URL 与 query 正确编码、raw 原文保留', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async (url) => { seen.push(url); return json(200, { ok: 1 }) }
    const http = new DydxHttp({ fetchImpl, indexerBaseUrl: 'https://i.local/', nodeBaseUrl: 'https://n.local' })
    const res = await http.indexerGet<{ ok: number }>('/v4/fills', { address: 'dydx1x', subaccountNumber: 0, limit: undefined })
    expect(seen[0]).toBe('https://i.local/v4/fills?address=dydx1abc&subaccountNumber=0'.replace('dydx1abc', 'dydx1x'))
    expect(res.data.ok).toBe(1)
    expect(res.raw).toBe('{"ok":1}')
  })

  it('索引器请求默认权重 1，链节点读默认权重 0；权重 0 也走 acquire(0)', async () => {
    const rec = recorder()
    const fetchImpl: FetchLike = async () => json(200, {})
    const http = new DydxHttp({ fetchImpl, budget: rec.budget, indexerBaseUrl: 'https://i.local', nodeBaseUrl: 'https://n.local' })
    await http.indexerGet('/v4/orders')
    await http.nodeGet('/cosmos/base/tendermint/v1beta1/blocks/latest')
    await http.nodePost('/cosmos/tx/v1beta1/txs', { a: 1 })
    expect(rec.acquired).toEqual([1, 0, 0])
    expect(rec.oks).toBe(3)
  })

  it('429：退避 + retryAfterMs（秒与 HTTP 日期两种写法）', async () => {
    const rec = recorder()
    let call = 0
    const fetchImpl: FetchLike = async () => {
      call += 1
      return call === 1 ? json(429, { error: 'slow down' }, { 'retry-after': '2' }) : json(429, { error: 'slow' }, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })
    }
    const http = new DydxHttp({ fetchImpl, budget: rec.budget, now: () => Date.parse('2026-10-21T07:27:50Z') })
    await expect(http.indexerGet('/v4/orders')).rejects.toBeInstanceOf(DydxHttpError)
    expect(rec.penalties[0]).toBe(2000)
    await expect(http.indexerGet('/v4/orders')).rejects.toBeInstanceOf(DydxHttpError)
    expect(rec.penalties[1]).toBe(10_000)
  })

  it('非 JSON 响应 → DydxNetworkError（不当成场所拒绝）', async () => {
    const http = new DydxHttp({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) })
    await expect(http.indexerGet('/v4/orders')).rejects.toBeInstanceOf(DydxNetworkError)
  })

  it('自定义超时中断请求（AbortController）→ GET 不算结果未知', async () => {
    const fetchImpl: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const http = new DydxHttp({ fetchImpl, timeoutMs: 5 })
    await expect(http.indexerGet('/v4/orders')).rejects.toMatchObject({ outcomeUnknown: false })
  })

  it('unlimitedBudget 形状可用', async () => {
    const b = unlimitedBudget()
    await b.acquire?.(0)
    expect(b.usage?.().limit).toBe(INDEXER_RATE_LIMIT)
  })
})

describe('错误分类（契约 §2.8）', () => {
  it('429 → 3003 可重试 + retryAfterMs', () => {
    const p = asProblem(new DydxHttpError(429, '{"error":"rate"}', 'GET', '/v4/orders', false, 1500))
    expect(p.code).toBe(3003)
    expect(p.retryable).toBe(true)
    expect(p.retryAfterMs).toBe(1500)
  })

  it('418 与 429 同口径', () => {
    expect(asProblem(new DydxHttpError(418, 'teapot', 'GET', '/v4/orders')).code).toBe(3003)
  })

  it('非 GET 5xx → 3006 不可重试（结果未知）', () => {
    const p = asProblem(new DydxHttpError(502, 'bad gateway', 'POST', '/cosmos/tx/v1beta1/txs', true))
    expect(p.code).toBe(3006)
    expect(p.retryable).toBe(false)
    expect(p.message).toMatch(/clientOrderId/)
  })

  it('GET 5xx → 3003 可重试', () => {
    const p = asProblem(new DydxHttpError(503, 'unavailable', 'GET', '/v4/orders', false))
    expect(p.code).toBe(3003)
    expect(p.retryable).toBe(true)
  })

  it('401 / 403 → 3005 认证失败；其它 4xx → 3001', () => {
    expect(asProblem(new DydxHttpError(401, '', 'GET', '/v4/orders')).code).toBe(3005)
    expect(asProblem(new DydxHttpError(400, '{"errors":[{"msg":"bad market"}]}', 'GET', '/v4/orders')).code).toBe(3001)
  })

  it('POST 断连 → 3006；GET 断连 → 3003', () => {
    expect(asProblem(new DydxNetworkError('reset', 'POST', '/x', true)).code).toBe(3006)
    expect(asProblem(new DydxNetworkError('reset', 'GET', '/x', false)).code).toBe(3003)
  })

  it('ABCI 码分类：序列号 / 余额 / gas / 手续费', () => {
    expect(txProblemName(3, '')).toBe('VENUE_REJECTED')
    expect(txProblemName(32, 'account sequence mismatch')).toBe('VENUE_REJECTED')
    expect(txProblemName(5, '')).toBe('VENUE_INSUFFICIENT_MARGIN')
    expect(txProblemName(9999, 'insufficient margin for order')).toBe('VENUE_INSUFFICIENT_MARGIN')
    expect(txProblemName(11, 'out of gas')).toBe('VENUE_REJECTED')
    expect(txProblemName(13, '')).toBe('VENUE_REJECTED')
  })

  it('DydxTxError：message 带 txhash 与 raw_log，分类走码表', () => {
    const p = asProblem(new DydxTxError(5, 'sdk', 'insufficient funds', 'ABCDEF'))
    expect(p.code).toBe(3004)
    expect(p.venue?.id).toBe('dydx')
    expect(p.venue?.code).toBe(5)
    expect(p.venue?.message).toBe('insufficient funds')
  })

  it('TypeError / RangeError → INVALID_PARAMS（本包自己的参数拒绝）', () => {
    expect(asProblem(new TypeError('bad')).code).toBe(-32602)
    expect(asProblem(new RangeError('bad')).code).toBe(-32602)
  })

  it('未知错误 → INTERNAL，不吞掉原文', () => {
    const p = asProblem(new Error('boom'))
    expect(p.code).toBe(4001)
    expect(p.message).toBe('boom')
  })

  it('脱敏：原文与 base64 形态都替换，空串跳过', () => {
    const secret = 'deadbeefdeadbeef'
    const b64 = Buffer.from(secret, 'utf8').toString('base64')
    expect(redactSecret(`x ${secret} y ${b64} z`, [secret])).toBe('x <redacted> y <redacted> z')
    expect(redactSecret('a', '')).toBe('a')
  })

  it('Problem 的 message 与 venue.message 都脱敏', () => {
    const p = asProblem(new DydxTxError(1, 'clob', 'key=SECRET123 rejected', 'h'), { secrets: ['SECRET123'] })
    expect(JSON.stringify(p)).not.toContain('SECRET123')
    expect(p.venue?.message).toContain('<redacted>')
  })
})
