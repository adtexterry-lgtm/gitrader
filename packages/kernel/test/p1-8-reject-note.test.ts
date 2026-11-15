// SPDX-License-Identifier: CPAL-1.0
// P1-8 / ADR-9：拒绝带理由（note），并与批准对称写 attestation（digest 覆盖 proposalId、decision、note；installKey 签名）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderIntent } from '../src/proto'
import { InstallKey } from '../src/install-key'
import { digestOf } from '../src/util/hash'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const liveIntent = (): OrderIntent => ({ accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never, leverage: 2, reason: 'funding flipped' } as OrderIntent)

async function pendingProposal() {
  await enableLive(h)
  const a = await makeAgent(h, 'confirm')
  return h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'r' }, a.ctx('propose'))
}
const digestFor = (proposalId: string, note: string) => digestOf({ proposalId, decision: 'rejected', note })

describe('拒绝理由 + attestation（P1-8）', () => {
  it('reject with note records attestation and note', async () => {
    const p = await pendingProposal()
    const done = h.k.trading.reject(p.ticket, h.sessionProof(), h.human('ui:reject'), '价格偏离太大')
    expect(done.status).toBe('rejected')
    const stored = h.k.trading.getProposal(p.ticket)!
    expect(stored.decision).toMatchObject({ by: 'user:usr_local', note: '价格偏离太大', attestation: { method: 'session', by: 'usr_local' } })
    const att = stored.decision!.attestation!
    expect(att.digest).toBe(digestFor(p.proposalId, '价格偏离太大'))
    expect(InstallKey.verify(h.k.installKey.publicKey, att.digest, att.sig)).toBe(true)
    const ev = h.k.ledger.query({ proposalId: p.proposalId, types: ['proposal.decided'], limit: 1 })[0]!
    expect(ev.payload).toMatchObject({ decision: 'rejected', note: '价格偏离太大' })
  })

  it('tampered note fails verification', async () => {
    const p = await pendingProposal()
    h.k.trading.reject(p.ticket, h.sessionProof(), h.human('ui:reject'), '原因甲')
    const att = h.k.trading.getProposal(p.ticket)!.decision!.attestation!
    // 篡改 note 后重算摘要：与已签摘要不符；拿篡改摘要去验原签名也过不了
    expect(digestFor(p.proposalId, '原因乙')).not.toBe(att.digest)
    expect(InstallKey.verify(h.k.installKey.publicKey, digestFor(p.proposalId, '原因乙'), att.sig)).toBe(false)
  })

  it('note is truncated to 500 chars', async () => {
    const p = await pendingProposal()
    h.k.trading.reject(p.ticket, h.sessionProof(), h.human('ui:reject'), 'x'.repeat(800))
    const d = h.k.trading.getProposal(p.ticket)!.decision!
    expect(d.note).toBe('x'.repeat(500))
    expect(d.attestation!.digest).toBe(digestFor(p.proposalId, 'x'.repeat(500)))
  })
})
