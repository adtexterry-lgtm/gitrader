// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, TEST_PIN, type Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

describe('bind 未知引擎（GQ-49）', () => {
  it('ops 入口：未知引擎被拒，且没有签出授权书、没有 engine.bound 账本行', async () => {
    const mandatesBefore = h.k.agents.listMandates().length
    const boundBefore = h.k.ledger.query({ types: ['engine.bound'] }).length
    await h.pinProof() // setup PIN first
    await expect(h.k.ops.call(h.k, 'engine.bind', { principal: h.session, params: { id: 'no-such-engine', accounts: ['paper'] }, pin: TEST_PIN, transport: 'http' } as never))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringMatching(/unknown engine no-such-engine/) } })
    expect(h.k.agents.listMandates().length).toBe(mandatesBefore)
    expect(h.k.ledger.query({ types: ['engine.bound'] }).length).toBe(boundBefore)
    expect(h.k.docs.get('enginebind', 'no-such-engine')).toBeUndefined()
  })
  it('直接调 GepHost.bind 也被拒（纵深防御）', async () => {
    const pin = await h.pinProof()
    const mdt = (await h.k.agents.issueMandate({ subject: { type: 'engine', id: 'ghost' }, level: 'L1', accounts: [h.paper.accountId] } as never, pin, h.human('mandate.issue').origin)).mandateId
    await expect(h.k.gep.bind('ghost', { accounts: [{ accountId: h.paper.accountId as never, mandateId: mdt }], instruments: [BTC] }, pin))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS' } })
    expect(h.k.docs.get('enginebind', 'ghost')).toBeUndefined()
  })
  it('反例：已配置但未连接的引擎仍可预绑定', async () => {
    // python-engine is configured but disabled by default in test harness
    await h.pinProof() // setup PIN first
    const result = await h.k.ops.call(h.k, 'engine.bind', { principal: h.session, params: { id: 'python-engine', accounts: ['paper'] }, pin: TEST_PIN, transport: 'http' } as never)
    expect(result).toMatchObject({ warnings: expect.arrayContaining([expect.stringMatching(/not connected/)]) })
    expect(h.k.docs.get('enginebind', 'python-engine')).toBeDefined()
  })
})
