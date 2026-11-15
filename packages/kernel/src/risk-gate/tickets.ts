// SPDX-License-Identifier: CPAL-1.0
import { checkGateDecisionConsistency, canonicalize, makeProblem } from '@gitrader/protocol'
import type { GateAction, GateDecision, GateInput, GateTarget, GateTicket } from '@gitrader/protocol'
import type { TradeContext } from '@gitrader/protocol/connector'
import { InstallKey } from '../install-key'
import { KernelError } from '../util/errors'
import { digestOf } from '../util/hash'
import { ulid } from '../util/ids'
import type { Clock } from '../util/clock'
import { gateSnapshotDigest, gateTargetDigest } from './assemble'
import { adjustedGateTarget } from './stages'

interface IssuedTicket { ticket: GateTicket; used: boolean }

function invalid(): never { throw new KernelError(makeProblem('GATE_TICKET_INVALID', 'gate ticket validation failed')) }
function expired(): never { throw new KernelError(makeProblem('GATE_TICKET_EXPIRED', 'gate ticket expired')) }

function ticketShape(ticket: unknown): ticket is GateTicket {
  if (!ticket || typeof ticket !== 'object') return false
  const t = ticket as Record<string, unknown>
  return typeof t.ticketId === 'string' && typeof t.precheckId === 'string' && typeof t.bootId === 'string'
    && typeof t.accountId === 'string' && typeof t.action === 'string' && typeof t.targetDigest === 'string'
    && Number.isSafeInteger(t.issuedAt) && Number.isSafeInteger(t.expiresAt) && typeof t.sig === 'string'
}

export class GateTicketAuthority {
  readonly bootId: string
  private readonly issued = new Map<string, IssuedTicket>()

  constructor(private readonly key: InstallKey, private readonly clock: Clock, bootId?: string) {
    this.bootId = bootId ?? ulid(clock.now())
  }

  issue(input: GateInput, decision: GateDecision, actualTarget: GateTarget): GateTicket {
    try {
    this.pruneExpired(this.clock.now())
    if (input.dryRun || decision.dryRun || !['ALLOW', 'LIMIT'].includes(decision.decision) || decision.verdict !== 'allow') return invalid()
    if (checkGateDecisionConsistency(decision).length > 0) return invalid()
    const { attestation, ...unsignedDecision } = decision
    if (attestation.method !== 'system' || attestation.by !== 'kernel' || digestOf(unsignedDecision) !== attestation.digest
      || !InstallKey.verify(this.key.publicKey, attestation.digest, attestation.sig)) return invalid()
    if (decision.precheckId !== input.precheckId || decision.action !== input.action) return invalid()
    if (decision.targetDigest !== gateTargetDigest(input.target) || decision.snapshotDigest !== gateSnapshotDigest(input)) return invalid()
    const expectedTarget = adjustedGateTarget(input.target, decision.applied)
    if (gateTargetDigest(actualTarget) !== decision.adjustedTargetDigest || gateTargetDigest(expectedTarget) !== decision.adjustedTargetDigest) return invalid()

    const issuedAt = this.clock.now()
    const targetDeadline = actualTarget.kind === 'order' ? actualTarget.intent.expiresAt : undefined
    if (targetDeadline !== undefined && (!Number.isSafeInteger(targetDeadline) || targetDeadline <= issuedAt + 2_000)) return expired()
    const expiresAt = Math.min(issuedAt + 30_000, decision.expiresAt ?? input.now + 30_000, ...(targetDeadline === undefined ? [] : [targetDeadline]))
    if (expiresAt <= issuedAt) return expired()
    const unsignedTicket = {
      ticketId: `tk_${ulid(issuedAt)}`, precheckId: input.precheckId, bootId: this.bootId,
      accountId: input.account.accountId, action: input.action, targetDigest: gateTargetDigest(actualTarget),
      issuedAt, expiresAt,
    }
    const ticket: GateTicket = { ...unsignedTicket, sig: this.key.sign(canonicalize(unsignedTicket)) }
    this.issued.set(ticket.ticketId, { ticket: structuredClone(ticket), used: false })
    return structuredClone(ticket)
    } catch (error) {
      if (error instanceof KernelError) throw error
      return invalid()
    }
  }

  consume(ticket: GateTicket | undefined, accountId: string, action: GateAction, actualTarget: GateTarget): NonNullable<TradeContext['gate']> {
    try {
    if (!ticketShape(ticket) || ticket.bootId !== this.bootId || !InstallKey.verify(this.key.publicKey, canonicalize((({ sig: _sig, ...unsigned }) => unsigned)(ticket)), ticket.sig)) return invalid()
    if (ticket.accountId !== accountId || ticket.action !== action || ticket.targetDigest !== gateTargetDigest(actualTarget)) return invalid()
    const now = this.clock.now()
    if (!Number.isSafeInteger(ticket.issuedAt) || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= ticket.issuedAt || ticket.expiresAt - ticket.issuedAt > 30_000 || ticket.issuedAt > now) return invalid()
    this.pruneExpired(now)
    if (now >= ticket.expiresAt) return expired()
    const targetDeadline = actualTarget.kind === 'order' ? actualTarget.intent.expiresAt : undefined
    if (targetDeadline !== undefined && (!Number.isSafeInteger(targetDeadline) || targetDeadline <= now + 2_000)) return expired()
    const issued = this.issued.get(ticket.ticketId)
    if (!issued || issued.used || canonicalize(issued.ticket) !== canonicalize(ticket)) return invalid()
    issued.used = true
    this.issued.delete(ticket.ticketId)
    return { precheckId: ticket.precheckId, ticketId: ticket.ticketId, expiresAt: ticket.expiresAt }
    } catch (error) {
      if (error instanceof KernelError) throw error
      return invalid()
    }
  }

  private pruneExpired(now: number): void {
    for (const [id, issued] of this.issued) if (now >= issued.ticket.expiresAt) this.issued.delete(id)
  }
}
