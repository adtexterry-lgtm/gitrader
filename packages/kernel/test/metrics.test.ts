// SPDX-License-Identifier: CPAL-1.0
// GET /api/metrics（Prometheus 0.0.4 文本格式）与事件总线逐主题计数。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { EVENT_TOPICS, EventBus } from '../src/events'
import { Metrics } from '../src/metrics'

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

const metricsUrl = (): string => `http://127.0.0.1:${port}/api/metrics`

async function get(token?: string): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(metricsUrl(), { headers: token ? { authorization: `Bearer ${token}` } : {} })
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() }
}

describe('GET /api/metrics', () => {
  it('不带令牌 → 401', async () => {
    expect((await get()).status).toBe(401)
  })

  it('带会话令牌 → 200，Prometheus 文本，含基础指标', async () => {
    const r = await get(sessionToken)
    expect(r.status).toBe(200)
    expect(r.contentType.startsWith('text/plain; version=0.0.4')).toBe(true)
    expect(r.body).toContain('gitrader_up 1\n')
    expect(r.body).toContain('gitrader_ledger_entries ')
    expect(r.body).toContain('gitrader_trading_state{state="')
    expect(r.body).toContain('gitrader_events_total{topic="plugin.state"} 0\n')
    expect(r.body.endsWith('\n')).toBe(true)
  })

  it('plugin.state 发布两次后计数为 2', async () => {
    h.k.events.publish('plugin.state', { probe: 1 })
    h.k.events.publish('plugin.state', { probe: 1 })
    const r = await get(sessionToken)
    expect(r.status).toBe(200)
    expect(r.body).toContain('gitrader_events_total{topic="plugin.state"} 2\n')
  })

  it('每个事件主题一行；uptime 是 ≥ 0 的有限数', async () => {
    const r = await get(sessionToken)
    const eventLines = r.body.split('\n').filter((line) => line.startsWith('gitrader_events_total{'))
    expect(eventLines.length).toBe(EVENT_TOPICS.length)
    const m = /^gitrader_uptime_seconds (.+)$/m.exec(r.body)
    expect(m).not.toBeNull()
    const uptimeSeconds = Number(m![1])
    expect(Number.isFinite(uptimeSeconds)).toBe(true)
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0)
  })

  it('状态字段缺失时回退到 0 / unknown；HELP 恰好 7 行', () => {
    const body = new Metrics({ events: new EventBus(), status: () => ({}) }).render()
    expect(body).toContain('gitrader_ledger_entries 0\n')
    expect(body).toContain('gitrader_trading_state{state="unknown"} 1\n')
    expect(body.split('\n').filter((line) => line.startsWith('# HELP ')).length).toBe(8)
  })
})
