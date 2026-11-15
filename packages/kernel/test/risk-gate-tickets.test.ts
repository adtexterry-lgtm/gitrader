// SPDX-License-Identifier: CPAL-1.0
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalize, type GateDecision, type GateInput, type GateTarget } from '@gitrader/protocol'
import { loadGateConformanceCases } from '../../protocol/conformance/risk-gate/load'
import { InstallKey } from '../src/install-key'
import { RiskGate, type RiskService } from '../src/risk'
import { adjustedGateTarget } from '../src/risk-gate/stages'
import { gateSnapshotDigest, gateTargetDigest } from '../src/risk-gate/assemble'
import { GateTicketAuthority } from '../src/risk-gate/tickets'
import { digestOf } from '../src/util/hash'
import { asDecimal } from '@gitrader/protocol'
import type { Clock } from '../src/util/clock'
import type { TradingStateService } from '../src/trading-state'

const home = mkdtempSync(join(tmpdir(), 'gitrader-k1-'))
afterAll(() => {
  const tempRoot = resolve(tmpdir()) + sep
  const createdHome = resolve(home)
  if (createdHome.startsWith(tempRoot)) rmSync(createdHome, { recursive: true, force: true })
})
const key = InstallKey.loadOrCreate(join(home, 'risk-gate-ticket-test-key.json'), 1_000_000)
const cases = loadGateConformanceCases()

function prepared(decisionKind: 'ALLOW' | 'LIMIT' = 'ALLOW') {
  const fixture = cases.find((item) => item.expect.decision === decisionKind && !item.input.dryRun)
  if (!fixture) throw new Error(`missing ${decisionKind} fixture`)
  const input: GateInput = structuredClone(fixture.input)
  const risk = { signGateDigest: (digest: string) => key.sign(digest) } as unknown as RiskService
  const decision = new RiskGate(risk, {} as TradingStateService).decide(input)
  return { input, decision, actualTarget: adjustedGateTarget(input.target, decision.applied) }
}

function testClock(start: number): { clock: Clock; set: (value: number) => void } {
  let current = start
  return { clock: { now: () => current }, set: (value) => { current = value } }
}

function expectTicketError(run: () => unknown, code: number) {
  try { run(); throw new Error('expected ticket validation to fail') }
  catch (error) {
    if (error instanceof Error && error.message === 'expected ticket validation to fail') throw error
    expect((error as { problem?: { code?: number } }).problem?.code).toBe(code)
  }
}

describe('GateTicketAuthority', () => {
  it('issues a canonical signed ALLOW ticket for one synchronous consume', () => {
    const data = prepared()
    const timer = testClock(data.input.now)
    const authority = new GateTicketAuthority(key, timer.clock, 'boot-test')
    const ticket = authority.issue(data.input, data.decision, data.actualTarget)
    const { sig, ...unsigned } = ticket
    expect(InstallKey.verify(key.publicKey, canonicalize(unsigned), sig)).toBe(true)
    expect(authority.consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget)).toEqual({
      precheckId: data.input.precheckId, ticketId: ticket.ticketId, expiresAt: ticket.expiresAt,
    })
    expectTicketError(() => authority.consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget), 2010)
  })

  it('accepts LIMIT only for the adjusted target', () => {
    const data = prepared('LIMIT')
    const authority = new GateTicketAuthority(key, testClock(data.input.now).clock, 'boot-limit')
    const ticket = authority.issue(data.input, data.decision, data.actualTarget)
    const original = data.input.target
    expect(gateTargetDigest(data.actualTarget)).toBe(data.decision.adjustedTargetDigest)
    expectTicketError(() => authority.consume(ticket, data.input.account.accountId, data.input.action, original), 2010)
    expect(authority.consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget).ticketId).toBe(ticket.ticketId)
  })

  it('rejects dry-run, BLOCK, and tampered decision bodies at issue', () => {
    const data = prepared()
    const authority = new GateTicketAuthority(key, testClock(data.input.now).clock, 'boot-invalid')
    expectTicketError(() => authority.issue({ ...data.input, dryRun: true }, data.decision, data.actualTarget), 2010)
    const blocked = { ...data.decision, decision: 'BLOCK', verdict: 'deny' } as GateDecision
    expectTicketError(() => authority.issue(data.input, blocked, data.actualTarget), 2010)
    const tampered = { ...data.decision, policyVersion: data.decision.policyVersion + 1 }
    expectTicketError(() => authority.issue(data.input, tampered, data.actualTarget), 2010)
    const badSignature = { ...data.decision, attestation: { ...data.decision.attestation, sig: 'bad' } }
    expectTicketError(() => authority.issue(data.input, badSignature, data.actualTarget), 2010)
  })

  it('returns a ticket object that cannot mutate the stored issued ticket', () => {
    const data = prepared()
    const clock = testClock(data.input.now).clock
    const authority = new GateTicketAuthority(key, clock, 'boot-a')
    const ticket = authority.issue(data.input, data.decision, data.actualTarget)
    const preserved = structuredClone(ticket)
    ticket.accountId = 'acct_mutated'
    expectTicketError(() => authority.consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget), 2010)
    expect(authority.consume(preserved, data.input.account.accountId, data.input.action, data.actualTarget).ticketId).toBe(preserved.ticketId)
  })

  it('rejects bad signature, boot, account, action, target, and tickets from another authority', () => {
    const data = prepared()
    const clock = testClock(data.input.now).clock
    const authority = new GateTicketAuthority(key, clock, 'boot-a')
    const ticket = authority.issue(data.input, data.decision, data.actualTarget)
    expectTicketError(() => authority.consume({ ...ticket, sig: 'bad' }, data.input.account.accountId, data.input.action, data.actualTarget), 2010)
    expectTicketError(() => new GateTicketAuthority(key, clock, 'boot-b').consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget), 2010)
    expectTicketError(() => authority.consume(ticket, 'acct-other', data.input.action, data.actualTarget), 2010)
    expectTicketError(() => authority.consume(ticket, data.input.account.accountId, 'cancel', data.actualTarget), 2010)
    expectTicketError(() => authority.consume(ticket, data.input.account.accountId, data.input.action, { ...data.actualTarget, kind: 'cancel', targets: [] } as GateTarget), 2010)
    expectTicketError(() => new GateTicketAuthority(key, clock, 'boot-a').consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget), 2010)
    expect(authority.consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget).ticketId).toBe(ticket.ticketId)
  })

  it('rejects a ticket at its expiry boundary', () => {
    const data = prepared()
    const timer = testClock(data.input.now)
    const authority = new GateTicketAuthority(key, timer.clock, 'boot-expiry')
    const ticket = authority.issue(data.input, data.decision, data.actualTarget)
    const { sig: _sig, ...unsigned } = ticket
    const invalidTtl = { ...unsigned, expiresAt: ticket.issuedAt }
    const signedInvalidTtl = { ...invalidTtl, sig: key.sign(canonicalize(invalidTtl)) }
    expectTicketError(() => authority.consume(signedInvalidTtl, data.input.account.accountId, data.input.action, data.actualTarget), 2010)
    timer.set(ticket.expiresAt)
    expectTicketError(() => authority.consume(ticket, data.input.account.accountId, data.input.action, data.actualTarget), 2011)
  })

  it('binds ticket issuance to the gate target and snapshot digests', () => {
    const data = prepared()
    const authority = new GateTicketAuthority(key, testClock(data.input.now).clock, 'boot-digest')
    expect(gateTargetDigest(data.input.target)).toBe(data.decision.targetDigest)
    expect(gateSnapshotDigest(data.input)).toBe(data.decision.snapshotDigest)
    const changed = structuredClone(data.input)
    changed.snapshot.equity = asDecimal('1')
    expectTicketError(() => authority.issue(changed, data.decision, data.actualTarget), 2010)
  })

  it('prunes consumed entries and classifies valid expired versus tampered tickets after pruning', () => {
    const data = prepared()
    const timer = testClock(data.input.now)
    const authority = new GateTicketAuthority(key, timer.clock, 'boot-prune')
    const issued = authority as unknown as { issued: Map<string, unknown> }
    for (let n = 0; n < 4; n++) {
      timer.set(data.input.now + n)
      const input = data.input
      const decision = new RiskGate({ signGateDigest: (digest: string) => key.sign(digest) } as unknown as RiskService, {} as TradingStateService).decide(input)
      const actualTarget = adjustedGateTarget(input.target, decision.applied)
      const t = authority.issue(input, decision, actualTarget)
      authority.consume(t, input.account.accountId, input.action, actualTarget)
    }
    expect(issued.issued.size).toBe(0)

    timer.set(data.input.now + 10)
    const expiredInput = data.input
    const original = new RiskGate({ signGateDigest: (digest: string) => key.sign(digest) } as unknown as RiskService, {} as TradingStateService).decide(expiredInput)
    const { attestation: _attestation, ...decisionBody } = original
    const shortBody = { ...decisionBody, expiresAt: timer.clock.now() + 1 }
    const shortDigest = digestOf(shortBody)
    const expiredDecision = { ...shortBody, attestation: { method: 'system', by: 'kernel', at: timer.clock.now(), digest: shortDigest, sig: key.sign(shortDigest) } } as GateDecision
    const expiredTarget = adjustedGateTarget(expiredInput.target, expiredDecision.applied)
    const expiredTicket = authority.issue(expiredInput, expiredDecision, expiredTarget)
    timer.set(expiredTicket.expiresAt)
    const nextInput = data.input
    const nextDecision = new RiskGate({ signGateDigest: (digest: string) => key.sign(digest) } as unknown as RiskService, {} as TradingStateService).decide(nextInput)
    const nextTarget = adjustedGateTarget(nextInput.target, nextDecision.applied)
    authority.issue(nextInput, nextDecision, nextTarget)
    expect(issued.issued.has(expiredTicket.ticketId)).toBe(false)
    expectTicketError(() => authority.consume(expiredTicket, data.input.account.accountId, data.input.action, expiredTarget), 2011)
    expectTicketError(() => authority.consume({ ...expiredTicket, sig: 'tampered' }, data.input.account.accountId, data.input.action, expiredTarget), 2010)
  })
})
