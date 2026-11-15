// SPDX-License-Identifier: CPAL-1.0
import { fx, mul, str } from '@gitrader/protocol/decimal'

export interface AddressBudgetUsage {
  actionCount: number
  fillVolume: string
  estimatedLimit: string
  estimatedCancelLimit: string
  incomplete: true
}

interface Session {
  actionCount: number
  fillVolumeFx: bigint
  fills: Set<string>
  warnings: Set<string>
}

/** In-memory per-account estimate. Missing history and other clients are never inferred. */
export class HlAddressBudget {
  private readonly sessions = new Map<string, Session>()
  private readonly initial = fx('10000')
  private readonly cancelExtra = fx('100000')

  constructor(private readonly onWarn: (message: string) => void = () => {}) {}

  recordActions(address: string | undefined, count: number, kind: 'cancel' | 'other'): void {
    if (!address || !Number.isSafeInteger(count) || count <= 0) return
    const key = address.toLowerCase()
    const session = this.session(key)
    session.actionCount += count
    const volumeLimit = this.initial + session.fillVolumeFx
    const limit = kind === 'cancel' ? this.cancelLimit(volumeLimit) : volumeLimit
    const current = fx(String(session.actionCount))
    const level = current >= limit ? 'exceeded' : current * 10n >= limit * 9n ? 'near' : undefined
    if (!level) return
    const warningKey = `${kind}:${level}`
    if (session.warnings.has(warningKey)) return
    session.warnings.add(warningKey)
    const label = kind === 'cancel' ? 'cancel' : 'request'
    const phrase = level === 'near' ? 'near limit' : 'at or above limit'
    this.onWarn(`Hyperliquid address ${label} estimate ${phrase}: ${session.actionCount} / ${str(limit)}`)
  }

  recordExpiredResponse(address: string | undefined, count: number, kind: 'cancel' | 'other'): void {
    if (!address || !Number.isSafeInteger(count) || count <= 0) return
    this.recordActions(address, count * 4, kind)
  }

  recordFills(address: string, fills: ReadonlyArray<{ instrumentId: string; venueFillId: string; price: string; size: string }>): void {
    const session = this.session(address.toLowerCase())
    for (const fill of fills) {
      let price: bigint
      let size: bigint
      try {
        price = fx(fill.price)
        size = fx(fill.size)
      } catch {
        continue
      }
      if (price <= 0n || size <= 0n) continue
      const id = `${fill.instrumentId}\u0000${fill.venueFillId}`
      if (session.fills.has(id)) continue
      session.fills.add(id)
      session.fillVolumeFx += mul(price, size)
    }
  }

  usage(address: string): AddressBudgetUsage {
    const session = this.session(address.toLowerCase())
    const limit = this.initial + session.fillVolumeFx
    const cancelLimit = this.cancelLimit(limit)
    return {
      actionCount: session.actionCount,
      fillVolume: str(session.fillVolumeFx),
      estimatedLimit: str(limit),
      estimatedCancelLimit: str(cancelLimit),
      incomplete: true,
    }
  }

  private session(address: string): Session {
    let session = this.sessions.get(address)
    if (!session) {
      session = { actionCount: 0, fillVolumeFx: 0n, fills: new Set(), warnings: new Set() }
      this.sessions.set(address, session)
    }
    return session
  }

  private cancelLimit(limit: bigint): bigint {
    const doubled = limit * 2n
    const plusExtra = limit + this.cancelExtra
    return plusExtra < doubled ? plusExtra : doubled
  }
}
