// SPDX-License-Identifier: CPAL-1.0
// 下单票据的纯逻辑（无 DOM）：拒绝回包 → 确认键状态（不可重试就置灰，改输入才解锁）、
// 本单部分成交行、预览回包里的强平价估算文案、账户推送 → 可用额重查的节流。vitest 直接测。
import type { PrecheckEstimates } from '@gitrader/protocol/types'
import { PROBLEM_CODES } from '../../protocol/src/model/problem'
import { humanizeProblem, humanizeRuleHit } from '../../protocol/src/model/problem-text'
import { isRec, str } from '../../blocks-default/src/util'
import type { TicketForm } from './model-chart'
import { fmtPrice, fmtQty } from './model-records'
import { t, tk } from '@gitrader/workbench/i18n'

// ---- 拒绝：确认键置灰与否 ---------------------------------------------------------------

/** 规则命中（`Problem.ruleHits` 的形状，只取写文案要用的字段）。 */
export interface HitLike { code: string; limit?: string; actual?: string; unit?: string }

/** 预览 / 下单回包里的拒绝（两个入口同形）：`message` 是内核原文，不改写。 */
export interface RejectReply {
  message?: string
  /** 问题码（`Problem.name`）；没有就按 INTERNAL 查表。 */
  problem?: string
  /** 回包自带的「能不能重试」；没带时按问题码表推。 */
  retryable?: boolean
  ruleHits?: readonly HitLike[]
}

export interface TicketRejection {
  /** 键上方那一行：中文原因 + 括号里的内核原文。 */
  text: string
  /** false = 同样的输入再提交还是会被拒，确认键置灰。 */
  retryable: boolean
}

const codeRetryable = (problem: string | undefined): boolean =>
  problem !== undefined && problem in PROBLEM_CODES ? PROBLEM_CODES[problem as keyof typeof PROBLEM_CODES].retryable : true

/** 拒绝回包 → 一行原因 + 能不能重试；没有原文（成功 / 取消 / 空回包）返回 null。 */
export function rejectionOf(reply: RejectReply | null | undefined): TicketRejection | null {
  const raw = reply?.message?.trim() ?? ''
  if (!raw) return null
  const hit = reply?.ruleHits?.find((h) => str(h.code) !== undefined)
  const head = tk(hit ? humanizeRuleHit(hit) : humanizeProblem({ name: reply?.problem ?? 'INTERNAL', message: raw }).zh)
  const retryable = typeof reply?.retryable === 'boolean' ? reply.retryable : codeRetryable(reply?.problem)
  return { text: t('{0}（{1}）', head, raw), retryable }
}

/** 票据的拒绝状态：锁在收到拒绝时的那份输入上。 */
export interface TicketStatus {
  rejection: TicketRejection | null
  /** 收到拒绝时的输入指纹（`inputSignature`）。 */
  signature: string
}

/** 输入指纹：数量 / 价格 / 方向 / 类型 / 只减仓 / 账户 / 标的任一变了，指纹就变。 */
export function inputSignature(f: TicketForm): string {
  return [f.accountId, f.instrumentId, f.side, f.type, f.price, f.size, f.reduceOnly ? '1' : '0'].join('|')
}

export const ticketStatus = (rejection: TicketRejection | null, signature: string): TicketStatus => ({ rejection, signature })

/** 输入变了 → 拒绝作废（确认键恢复可点）；没变 → 原样。 */
export function afterInput(s: TicketStatus, signature: string): TicketStatus {
  return s.rejection !== null && s.signature !== signature ? { rejection: null, signature } : s
}

/** 确认键是否置灰：只有「不可重试的拒绝」才锁。 */
export const confirmLocked = (s: TicketStatus): boolean => s.rejection !== null && !s.rejection.retryable

/** 键上方那行原因；没有拒绝时为 null。 */
export const rejectionLine = (s: TicketStatus): string | null => s.rejection?.text ?? null

// ---- 本单的部分成交 -----------------------------------------------------------------------

export interface FillProgress { orderId: string; size: string; filledSize: string; status: string | null }

interface Scaled { n: bigint; s: number }
const DEC = /^(\d+)(?:\.(\d+))?$/
function scaled(v: unknown): Scaled | null {
  if (typeof v !== 'string') return null
  const m = DEC.exec(v.trim())
  if (!m) return null
  const frac = m[2] ?? ''
  return { n: BigInt(`${m[1]}${frac}`), s: frac.length }
}
function cmpDec(a: Scaled, b: Scaled): number {
  const s = Math.max(a.s, b.s)
  const x = a.n * 10n ** BigInt(s - a.s)
  const y = b.n * 10n ** BigInt(s - b.s)
  return x < y ? -1 : x > y ? 1 : 0
}

/** 下单回执 / 推送载荷 → 本单进度（也认 `{order:{…}}` 这种包一层回执）；认不出返回 null。 */
export function fillProgressOf(raw: unknown): FillProgress | null {
  const rec = isRec(raw) && isRec(raw.order) ? raw.order : raw
  if (!isRec(rec)) return null
  const orderId = str(rec.orderId)
  const size = str(rec.size)
  if (!orderId || !size) return null
  return { orderId, size, filledSize: str(rec.filledSize) ?? '0', status: str(rec.status) ?? null }
}

/** 推送的是不是这一单（`fillProgressOf` 的进度与跟踪中的单对齐用）。 */
export const sameOrder = (a: FillProgress | null, b: FillProgress | null): boolean => a !== null && b !== null && a.orderId === b.orderId

/** 「部分成交 x / y」；成交量为 0、已全成交、或已撤 / 已拒（不会再成交）时为 null。 */
export function partialFillLine(p: FillProgress | null | undefined): string | null {
  if (!p || ['cancelled', 'expired', 'rejected', 'denied'].includes(p.status ?? '')) return null
  const filled = scaled(p.filledSize)
  const total = scaled(p.size)
  if (!filled || !total || total.n === 0n) return null
  if (filled.n === 0n || cmpDec(filled, total) >= 0) return null
  return t('部分成交 {0} / {1}', fmtQty(p.filledSize), fmtQty(p.size))
}

// ---- 强平价估算 ---------------------------------------------------------------------------

/** 预览 / 下单回包里的 `PrecheckEstimates`（`precheck.estimates`，或顶层的 `estimates`）；没有返回 null。 */
export function previewEstimates(raw: unknown): PrecheckEstimates | null {
  if (!isRec(raw)) return null
  const est = isRec(raw.precheck) ? raw.precheck.estimates : raw.estimates
  return isRec(est) ? (est as PrecheckEstimates) : null
}

/** 强平价估算文案：「52,100.0（估算）」；内核没给估算时返回 null（这一行不显示）。 */
export function liqEstimateLine(est: PrecheckEstimates | null | undefined): string | null {
  const px = est?.liquidationPrice
  if (typeof px !== 'string' || scaled(px) === null) return null
  return t('{0}（估算）', fmtPrice(px))
}

// ---- 可用额重查的节流 ---------------------------------------------------------------------

/** 可用额重查的最小间隔（毫秒）。 */
export const AVAILABLE_REFRESH_MS = 1_000

/** 距上次重查还不够间隔时还要等多久（毫秒；0 = 现在就能查）。 */
export const refreshWait = (lastMs: number, nowMs: number, gapMs: number = AVAILABLE_REFRESH_MS): number => Math.max(0, gapMs - (nowMs - lastMs))

/** 推送事件是不是本账户的：载荷没有 accountId 时当作可能相关（照样刷新）。 */
export function forAccount(raw: unknown, accountId: string): boolean {
  if (!isRec(raw)) return true
  const id = str(raw.accountId)
  return id === undefined || id === accountId
}
