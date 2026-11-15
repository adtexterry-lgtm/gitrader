// SPDX-License-Identifier: CPAL-1.0
// GET /api/health（存活探针）与 GET /api/ready（主体鉴权后的组件就绪）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let port = 0
let sessionToken = ''

beforeEach(async () => {
  h = await makeHarness()
  const r = await h.k.start({ port: 0 })
  port = r.port
  sessionToken = h.k.auth.exchangeBoot(r.bootToken).sessionToken
})
afterEach(async () => { await h.cleanup() })

interface JsonResponse { status: number; body: Record<string, unknown> }

async function get(path: string, token?: string): Promise<JsonResponse> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('GET /api/health', () => {
  it('存活探针：不带令牌也 200，status === "ok"、uptimeSec ≥ 0', async () => {
    const r = await get('/api/health')
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('ok')
    expect(typeof r.body.uptimeSec).toBe('number')
    expect(r.body.uptimeSec as number).toBeGreaterThanOrEqual(0)
    expect(typeof r.body.version).toBe('string')
    expect(typeof r.body.ts).toBe('number')
    expect(JSON.stringify(r.body)).not.toMatch(/pid|token/)
  })

  it('带会话令牌同样 200，字段一致', async () => {
    const r = await get('/api/health', sessionToken)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('ok')
    expect(r.body.uptimeSec as number).toBeGreaterThanOrEqual(0)
  })
})

describe('GET /api/ready', () => {
  it('不带令牌 → 401（与 /api/metrics 一致）', async () => {
    expect((await get('/api/ready')).status).toBe(401)
    expect((await get('/api/metrics')).status).toBe(401)
  })

  it('带会话令牌 → 200，ready === true，components 报告内核 / 账本 / 交易状态', async () => {
    const r = await get('/api/ready', sessionToken)
    expect(r.status).toBe(200)
    expect(r.body.ready).toBe(true)
    const components = r.body.components as Record<string, unknown>
    expect(components.kernel).toBe(true)
    expect(components.ledger).toBe(true)
    expect(components.tradingState).toBe('ACTIVE')
    expect(components.halted).toBe(false)
  })
})
