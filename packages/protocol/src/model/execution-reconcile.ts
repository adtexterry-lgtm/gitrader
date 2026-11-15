// SPDX-License-Identifier: Apache-2.0
import type { Decimal, Ms } from './decimal'
import type { AccountId, OrderId } from './ids'
import type { Problem } from './problem'
import type { Fill, Side } from './order'

export type ReconcilePriceSource = 'venue_avg_fill_price' | 'local_last_fill_price'

export interface ReconcileEvidence {
  report: string
  id: string
  field: string
  value: string
}

export interface ReconcileFindingView {
  id: string
  code: string
  severity: 'blocker' | 'warn' | 'info'
  detail: string
  advice: { action: string; requiresHuman: boolean; why: string }
  evidence: ReconcileEvidence[]
}

export interface ReconcileSuggestion {
  id: string
  orderId: OrderId
  venueOrderId: string
  clientOrderId: string
  instrumentId: string
  side: Side
  size: Decimal
  price: Decimal
  ts: Ms
  priceSource: ReconcilePriceSource
  basis: string[]
  inferred: true
}

export interface ReconcileAccountView {
  accountId: AccountId
  offerId?: string
  state: 'idle' | 'running' | 'ready' | 'unavailable'
  lastAttemptAt?: Ms
  lastSuccessAt?: Ms
  reportId?: string
  generatedAt?: Ms
  verdict?: 'clean' | 'attention' | 'blocked'
  findings: ReconcileFindingView[]
  suggestions: ReconcileSuggestion[]
  reviews?: ReconcileReviewItem[]
  coverage?: {
    asOf: Ms
    truncated: boolean
    unavailable: string[]
    historyChecked: number
    historyTotal: number
  }
  problem?: Problem
}

export interface ReconcileConfirmInput {
  accountId: AccountId
  offerId: string
  reportId: string
  suggestionId: string
  fee: Decimal
  feeCcy: string
  liquidity: 'maker' | 'taker'
  realizedPnl: Decimal
}

export interface ReconcileConfirmResult {
  fillId: string
  alreadyRecorded: boolean
}

export interface ReconcileConfirmationReceipt {
  input: ReconcileConfirmInput
  fillId: string
  confirmedAt: Ms
  confirmedBy: string
  effectsState: 'pending' | 'complete' | 'failed'
}

export interface ReconcileResolutionInput {
  accountId: AccountId
  itemId: string
  evidenceDigest: string
  action: 'reject' | 'acknowledge'
  reason: string
  requestId: string
}

export interface ReconcileResolutionReceipt {
  resolutionId: string
  input: ReconcileResolutionInput
  resolvedAt: Ms
  resolvedBy: string
}

export interface ReconcileResolveResult {
  receipt: ReconcileResolutionReceipt
  alreadyRecorded: boolean
}

export interface ReconcileReviewItem {
  itemId: string
  accountId: AccountId
  kind: 'inferred_fill' | 'known_difference' | 'late_real_fill' | 'confirmation_effects'
  evidenceDigest: string
  observedAt: Ms
  summary: string
  blocking: boolean
  finding?: ReconcileFindingView
  suggestion?: ReconcileSuggestion
  localFillsDigest?: string
  fill?: Fill
  confirmation?: ReconcileConfirmationReceipt
  resolution?: ReconcileResolutionReceipt
  confirmedFillId?: string
}

export interface ReconcileNoticeData {
  noticeId: string
  accountId: AccountId
  accountAlias: string
  findingId: string
  code: string
  severity: ReconcileFindingView['severity']
  summary: string
  why: string
}
