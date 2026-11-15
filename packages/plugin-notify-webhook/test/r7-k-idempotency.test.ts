// SPDX-License-Identifier: CPAL-1.0
// r7 WP-K GQ-52：内核给的 params.idempotencyKey 进请求头 Idempotency-Key；重试的每次 HTTP 尝试用同一个键。
import { describe, expect, it } from 'vitest'
import { notifySend } from '../index.mjs'

const notice = { key: 'k-1', level: 'warn', title: 'T', lines: ['a: 1'], ts: 1760000000000, topic: 'risk.denials' }
function recorder(statuses: number[]) {
  const heads: Record<string, string>[] = []
  const fetch = async (_url: string, init: { headers: Record<string, string> }) => {
    heads.push(init.headers)
    return { status: statuses[Math.min(heads.length - 1, statuses.length - 1)]!, text: async () => '' }
  }
  return { heads, fetch }
}
const deps = (fetch: unknown) => ({ fetch, env: {}, sleep: async () => {} })

describe('webhook Idempotency-Key', () => {
  it('给了键：请求头带它', async () => {
    const r = recorder([200])
    expect(await notifySend({ notice, params: { url: 'http://127.0.0.1:9/hook', idempotencyKey: 'abc' } }, deps(r.fetch))).toMatchObject({ ok: true })
    expect(r.heads[0]!['Idempotency-Key']).toBe('abc')
  })

  it('503 重试：每次尝试同一个键（共 3 次 HTTP 尝试）', async () => {
    const r = recorder([503])
    const result = await notifySend({ notice, params: { url: 'http://127.0.0.1:9/hook', idempotencyKey: 'abc' } }, deps(r.fetch))
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(r.heads).toHaveLength(3)
    expect(new Set(r.heads.map(h => h['Idempotency-Key']))).toEqual(new Set(['abc']))
  })

  it('反例：没给键就没有这个头', async () => {
    const r = recorder([200])
    await notifySend({ notice, params: { url: 'http://127.0.0.1:9/hook' } }, deps(r.fetch))
    expect(r.heads[0]).not.toHaveProperty('Idempotency-Key')
  })
})
