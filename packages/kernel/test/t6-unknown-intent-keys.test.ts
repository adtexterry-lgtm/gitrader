// SPDX-License-Identifier: CPAL-1.0
// T6 / ADR-21（R3-25）：调用方时间字段早 60 s 以上或晚 5 s 以上被拒；容差内只当备注；未知键不进账本载荷、不进摘要，回执点名。
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import { normalizeIntent } from '../src/normalize'
import { digestOf } from '../src/util/hash'
import type { Instrument, OrderIntent } from '../src/proto'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const limit = (h: Harness, extra: Record<string, unknown> = {}) => ({ accountId: h.paper.accountId, instrumentId: BTC, side: 'buy', type: 'limit', price: '70000', size: '0.001', ...extra }) as unknown as OrderIntent

describe('T6 caller timestamps and unknown intent keys', () => {
  it('unknown keys are dropped with a warning and never reach the ledger payload', async () => {
    h = await makeHarness()
    const now = h.clock.now()
    const r = await h.k.trading.place({ intent: limit(h, { ts: now - 1_000, createdAt: now, clientTs: String(now), note: 'free text', debug: { x: 1 } }) }, h.human())
    expect(r.order).toBeDefined()
    expect(r.warnings?.join(' ')).toMatch(/已忽略未知字段：.*ts.*createdAt.*clientTs.*note.*debug/)
    const intentEntry = [...h.k.ledger.iterate()].find((e) => e.type === 'order.intent')!
    const payloadIntent = (intentEntry.payload as { intent: Record<string, unknown> }).intent
    for (const key of ['ts', 'createdAt', 'clientTs', 'note', 'debug']) expect(payloadIntent).not.toHaveProperty(key)
  })

  it.each([
    ['ts one hour early', { ts: -3_600_000 }],
    ['ts one hour late', { ts: 3_600_000 }],
    ['createdAt 61 s early', { createdAt: -61_000 }],
    ['timestamp 6 s late', { timestamp: 6_000 }],
    ['sentAt ISO one hour early', { sentAt: 'iso:-3600000' }],
  ] as const)('rejects a caller timestamp out of tolerance: %s', async (_name, offset) => {
    h = await makeHarness()
    const now = h.clock.now()
    const [key, delta] = Object.entries(offset)[0] as [string, number | string]
    const value = typeof delta === 'string' ? new Date(now + Number(delta.slice(4))).toISOString() : now + delta
    await expect(h.k.trading.place({ intent: limit(h, { [key]: value }) }, h.human())).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringMatching(/caller timestamp .*调用方时间与内核时钟相差过大/s) } })
    expect([...h.k.ledger.iterate()].some((e) => e.type === 'order.intent')).toBe(false)
  })

  it('accepts timestamps inside the tolerance (60 s early, 5 s late)', async () => {
    h = await makeHarness()
    const now = h.clock.now()
    expect((await h.k.trading.place({ intent: limit(h, { ts: now - 59_000 }) }, h.human())).order).toBeDefined()
    expect((await h.k.trading.place({ intent: limit(h, { ts: now + 4_000, price: '69000' }) }, h.human())).order).toBeDefined()
  })

  it('digest is stable regardless of unknown keys', async () => {
    h = await makeHarness()
    const inst = h.k.bus.instrument(BTC) as Instrument
    const base = { ...limit(h), clientOrderId: 'ab'.repeat(16) } as OrderIntent
    const a = normalizeIntent(base, inst, { defaultMaxSlippageBps: 50 })
    const warnings: string[] = []
    const b = normalizeIntent({ ...base, ts: 1, foo: 'bar' } as unknown as OrderIntent, inst, { defaultMaxSlippageBps: 50, warnings })
    expect(digestOf(b)).toBe(digestOf(a))
    expect(warnings).toHaveLength(1)
  })
})
