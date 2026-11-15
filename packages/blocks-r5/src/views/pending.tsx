// SPDX-License-Identifier: CPAL-1.0
// 待批浮层（r5，全站只挂一处）：从资金卡「待批」下方弹出、带尖角、盖在右列上方；最急的一张完整展示 + 卡底队列；可收起成资金卡上的数字。
// 三态写在 <html data-pend="open|collapsed|none">（样式靠它；状态机由资金卡视图持有，浮层只读它并通过 gitrader:pend 事件请求收起）：
//   没有待批 → none；有 → collapsed；最急一张剩余 ≤ 60 s → open（每张只自动展开一次，人手收起后不再抢开）。
// 批准 / 拒绝命令与 r4 相同：proposal.approve / proposal.reject（走壳的 PIN 层）；结果三分：已执行 / 已批准但执行失败（内核原文）/ 没批成（内核原文）。
// 只有内核预检判 deny 时批准置灰禁用、旁边写内核原文；前端算的批后占用（按提案所在的单账户口径）只显示数字，不据此禁用——闸门只在内核。
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import { F, Icon, toast } from '@gitrader/workbench/ui'
import { approveProposal, runCommand } from '../../../blocks-default/src/actions'
import { C, Q } from '../../../blocks-default/src/api'
import { FOCUS_EVENT, useAccountsData, useKeys, useNow, useOffline, usePending, useRes, type FocusDetail } from '../../../blocks-default/src/hooks'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import {
  FUSE_WINDOW_MS, decisionOutcome, fuseRatio, netPosText, positionAfter, protectionLine, queueView, ruleLine, showsApproveLock, type DecisionOutcome, type KeyTier, type PendingCard,
} from '../../../blocks-default/src/model-activity'
import { deriveUsage, normalizeRisk, toneOf, type LimitRow, type Usage } from '../../../blocks-default/src/model-risk'
import type { AccountLite, PositionRow } from '../../../blocks-default/src/model-positions'
import { fmtLoose, formatCountdown, symbolOf, toNum, type Rec } from '../../../blocks-default/src/util'
import { approvalRule } from '../../../blocks-default/src/display'
import { usePriceDisplay } from '../../../blocks-default/src/price-display'
import { Term } from '../../../blocks-default/src/term'
import { VenueIcon } from '../kit'
import { Ic, Msg, OriginActor, Sk } from './ovkit'
import { LimitLine } from './risk'
import './overview.css'
import { t as tr } from '@gitrader/workbench/i18n'

// ---- 三态状态机（纯函数；资金卡视图持有、浮层与测试读它） ----------------------------------------------------------------------------------

export type PendState = 'open' | 'collapsed' | 'none'
export interface PendMachine { state: PendState; /** 已经自动展开过的提案（每张只自动一次）。 */ seen: readonly string[] }
export const AUTO_OPEN_MS = 60_000
export const PEND_EVENT = 'gitrader:pend'
export const INITIAL_PEND: PendMachine = { state: 'none', seen: [] }

const sameSeen = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/** 每秒（或待批变化时）推进一次：没有待批 → none；有且之前是 none → collapsed；最急一张剩余 ≤ 60 s 且没自动开过 → open。无变化返回原对象。 */
export function nextPend(prev: PendMachine, input: { cards: ReadonlyArray<Pick<PendingCard, 'proposalId' | 'expiresAt'>>; now: number }): PendMachine {
  const live = input.cards.filter((c) => c.expiresAt > input.now)
  if (!live.length) return prev.state === 'none' && !prev.seen.length ? prev : INITIAL_PEND
  const urgent = live.reduce((a, b) => (b.expiresAt < a.expiresAt ? b : a))
  let state: PendState = prev.state === 'none' ? 'collapsed' : prev.state
  let seen = prev.seen.filter((id) => live.some((c) => c.proposalId === id))
  if (urgent.expiresAt - input.now <= AUTO_OPEN_MS && !seen.includes(urgent.proposalId)) { state = 'open'; seen = [...seen, urgent.proposalId] }
  return state === prev.state && sameSeen(seen, prev.seen) ? prev : { state, seen }
}
/** 人手切换（没有待批时不可切）。 */
export const togglePend = (prev: PendMachine): PendMachine => (prev.state === 'none' ? prev : { ...prev, state: prev.state === 'open' ? 'collapsed' : 'open' })
export const setPend = (prev: PendMachine, state: 'open' | 'collapsed'): PendMachine => (prev.state === 'none' || prev.state === state ? prev : { ...prev, state })

/** 浮层读 <html data-pend>（没有资金卡 = 没有状态机时视为 none）。 */
export function usePendAttr(): PendState {
  const read = (): PendState => { const v = typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-pend'); return v === 'open' || v === 'collapsed' ? v : 'none' }
  const [s, setS] = useState<PendState>(read)
  useEffect(() => {
    setS(read())
    const mo = new MutationObserver(() => setS(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-pend'] })
    return () => mo.disconnect()
  }, [])
  return s
}

// ---- 批后风控占用（纯函数）-------------------------------------------------------------------------------------------------------------------

export interface OccRow { id: 'exposure' | 'order' | 'leverage'; label: string; ratio: number | null; tone: LimitRow['tone']; used: string; limit: string; after: string; /** 上限取自该钥匙的授权书（比全局更紧）。 */ keyCap?: boolean }
const money = (n: number) => F.usd(n)
const ratioText = (n: number) => `${n.toFixed(2)}×`

/** 批后仓位：下单类、腿都在同一标的、持仓已读到时才算（control 类不画；读不到持仓时不猜）。 */
export function afterOf(c: PendingCard, accounts: { phase: string; rows: readonly PositionRow[] }): { sym: string; from: string; to: string; delta: number | null } | null {
  if (c.control || accounts.phase !== 'ready' || !c.accountId || !c.legs.length) return null
  const inst = c.legs[0]!.instrumentId
  if (!inst || c.legs.some((l) => l.instrumentId !== inst || !l.side || l.size == null)) return null
  const row = accounts.rows.find((r) => r.accountId === c.accountId && r.instrumentId === inst)
  const cur = row ? { side: row.side, size: row.size } : null
  const next = positionAfter(cur, c.legs)
  const mark = row?.markPrice ?? null
  const delta = mark !== null ? (next ? next.size * mark : 0) - (row ? row.notional : 0) : null
  return { sym: symbolOf(inst), from: netPosText(cur), to: netPosText(next), delta }
}

/**
 * 批后风控占用：总敞口（×）· 单笔 · 杠杆。限额取内核 risk.state 的 limits，使用量取当前持仓与权益（与风险卡同源），
 * 批后 = 当前 + 这张提案带来的名义增量。只做显示：超限只是把事实摆出来，批不批、拦不拦都在内核。
 */
export function occupancy(input: { card: PendingCard; limits: Rec; usage: Usage; totalNotional: number; equity: number | null; delta: number | null; /** 提案所属授权书的限额（P1-7）：单笔上限取 min(全局, 该钥匙)。 */ mandateLimits?: Rec | null }): OccRow[] {
  const { card, limits, usage, totalNotional, equity } = input
  const rows: OccRow[] = []
  const delta = input.delta ?? card.notional
  const maxRatio = toNum(limits.maxTotalNotionalRatio)
  if (maxRatio !== null && maxRatio > 0 && equity !== null && equity > 0 && delta !== null) {
    const before = totalNotional / equity
    const after = (totalNotional + delta) / equity
    const ratio = after / maxRatio
    rows.push({ id: 'exposure', label: tr('总敞口'), ratio, tone: toneOf(ratio), used: `${ratioText(before)} → ${ratioText(after)}`, limit: ratioText(maxRatio), after: ratioText(after) })
  }
  const globalOrder = toNum(limits.maxOrderNotional)
  const keyOrder = toNum(input.mandateLimits?.maxOrderNotional)
  const keyCap = keyOrder !== null && keyOrder > 0 && (globalOrder === null || globalOrder <= 0 || keyOrder < globalOrder)
  const maxOrder = keyCap ? keyOrder : globalOrder
  if (maxOrder !== null && maxOrder > 0 && card.notional !== null) {
    const ratio = card.notional / maxOrder
    rows.push({ id: 'order', label: tr('单笔'), ratio, tone: toneOf(ratio), used: money(card.notional), limit: money(maxOrder), after: money(card.notional), ...(keyCap ? { keyCap: true } : {}) })
  }
  const maxLev = toNum(limits.maxLeverage)
  if (maxLev !== null && maxLev > 0 && usage.leverage != null) {
    const ratio = usage.leverage / maxLev
    rows.push({ id: 'leverage', label: tr('杠杆'), ratio, tone: toneOf(ratio), used: `${fmtLoose(usage.leverage)}×`, limit: `${fmtLoose(maxLev)}×`, after: `${fmtLoose(usage.leverage)}×` })
  }
  return rows
}

/** 提案所属钥匙的授权书限额：提案来源 `agent:<keyId>` → 钥匙 → 授权书（与 actorNames 同一口径）。找不到返回 null。 */
export function mandateLimitsOf(card: Pick<PendingCard, 'origin'>, keys: ReadonlyArray<Pick<KeyTier, 'keyId' | 'mandate'>>): Rec | null {
  const actor = card.origin?.actor
  const k = actor ? keys.find((x) => `agent:${x.keyId}` === actor) : undefined
  return (k?.mandate?.limits as Rec | undefined) ?? null
}

/** 占用表的「手续费 ≈ X」一行；预检没给估算就没有这一行。 */
export function feeLine(card: Pick<PendingCard, 'feeEstimate'>): string | null {
  if (!card.feeEstimate) return null
  const n = toNum(card.feeEstimate)
  return tr('手续费 ≈ {0}', n === null ? fmtLoose(card.feeEstimate) : fmtLoose(Math.round(n * 100) / 100))
}

// ---- 队列（纯函数）--------------------------------------------------------------------------------------------------------------------------

/** 队列排序：执行失败的卡退到队尾（其余保持原序），不占住「当前卡」。 */
export function orderQueue<T extends { proposalId: string }>(cards: readonly T[], failedIds: ReadonlySet<string>): T[] {
  return [...cards.filter((c) => !failedIds.has(c.proposalId)), ...cards.filter((c) => failedIds.has(c.proposalId))]
}

/** 活动流点票号 → 选哪张：按票号在待批里找，没有（已决 / 已过期）返回 null。 */
export function pickByTicket(cards: ReadonlyArray<{ proposalId: string; ticket: string }>, ticket: unknown): string | null {
  return typeof ticket === 'string' ? cards.find((c) => c.ticket === ticket)?.proposalId ?? null : null
}

// ---- 浮层 ----------------------------------------------------------------------------------------------------------------------------------

type Outcome = DecisionOutcome | { kind: 'error'; message: string }
interface Held { card: PendingCard; act: 'approve' | 'reject'; outcome?: Outcome }
interface Failed { card: PendingCard; message: string }
const RESULT_TEXT: Record<Outcome['kind'], string> = { executed: tr('已批准 · 已执行'), approved: tr('已批准'), rejected: tr('已拒绝'), failed: tr('已批准 · 执行失败'), error: tr('没有批成') }
const DEAD_ZONE = 500
const HOLD_MS = 1200
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))


function ProposalReason({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return <><span className="g5-tb g5-why-copy" data-expanded={String(expanded || text.length <= 80)}>{text}</span>{text.length > 80 ? <button type="button" className="g5-btn g5-btn-ghost" data-act="reason-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? tr('收起理由') : tr('展开理由')}</button> : null}</>
}

export function PendingView() {
  const prices = usePriceDisplay()
  const displayLegs = (c: PendingCard) => c.control ?? c.legs.map((l) => prices.copy(l.text, l.instrumentId)).join(tr('；'))
  const bridge = useBridge()
  const keys = useKeys()
  const pend = usePending()
  const acct = useAccountsData(false)
  const risk = useRes<unknown>(Q.riskState)
  const offline = useOffline(() => { keys.reload(); pend.reload(); acct.reload(); risk.reload() })
  const state = usePendAttr()
  const now = useNow(1000)
  const popRef = useRef<HTMLElement | null>(null)
  const done = useRef<Set<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null)
  const [held, setHeld] = useState<Held | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [failed, setFailed] = useState<Record<string, Failed>>({})
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [guard, setGuard] = useState(false)
  const swapAt = useRef(0)
  const shown = useRef<string | null>(null)

  const live = pend.cards.filter((c) => c.expiresAt > now - 1000 && !done.current.has(c.proposalId))
  const liveRef = useRef<PendingCard[]>([])
  liveRef.current = live
  const lastIdx = useRef(0)
  const base = held && !live.some((c) => c.proposalId === held.card.proposalId) ? [...live.slice(0, lastIdx.current), held.card, ...live.slice(lastIdx.current)] : live
  // 批准后执行失败的卡不再是 pending，也不占「当前卡」：退到队尾，等人点「关闭」
  const failedIds = new Set(Object.keys(failed))
  const list = orderQueue([...base, ...Object.values(failed).map((f) => f.card).filter((c) => !base.some((x) => x.proposalId === c.proposalId))], failedIds)
  const want = held?.card.proposalId ?? sel
  const at = list.findIndex((c) => c.proposalId === want)
  const anchored = Math.max(0, Math.min(lastIdx.current, list.length - 1))
  const firstOk = list.findIndex((c) => !failedIds.has(c.proposalId))
  const idx = at >= 0 ? at : list[anchored] && failedIds.has(list[anchored]!.proposalId) && firstOk >= 0 ? firstOk : anchored
  const card = list[idx] ?? null
  const { rows: queue, more } = queueView(list, card?.proposalId ?? null)

  // 锚定 + 换卡死区：换卡后 500 ms 内两钮不响应
  useLayoutEffect(() => { lastIdx.current = idx })
  useLayoutEffect(() => {
    const id = card?.proposalId ?? null
    if (id && id !== sel) setSel(id)
    if (id === shown.current) return undefined
    const replaced = shown.current !== null && id !== null
    shown.current = id
    if (!replaced) { setGuard(false); return undefined }
    swapAt.current = performance.now()
    setGuard(true)
    const t = setTimeout(() => setGuard(false), DEAD_ZONE)
    return () => clearTimeout(t)
  }, [card?.proposalId])
  // 持仓卡「有待批」/ 总览条跳过来：选中指定那张
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<FocusDetail>).detail; if (d?.card === 'pending' && d.proposalId && liveRef.current.some((c) => c.proposalId === d.proposalId)) setSel(d.proposalId) }
    window.addEventListener(FOCUS_EVENT, on)
    return () => window.removeEventListener(FOCUS_EVENT, on)
  }, [])
  // 活动流点提案行（P1-9）：gitrader:pend {action:'select', ticket} → 选中那张并滚动到视图
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ action?: string; ticket?: unknown }>).detail
      if (d?.action !== 'select') return
      const id = pickByTicket(liveRef.current, d.ticket)
      if (!id) return
      setSel(id)
      requestAnimationFrame(() => popRef.current?.querySelector('.g5-pitem')?.scrollIntoView?.({ block: 'nearest' }))
    }
    window.addEventListener(PEND_EVENT, on)
    return () => window.removeEventListener(PEND_EVENT, on)
  }, [])
  useEffect(() => { setRejecting(null); setNote('') }, [card?.proposalId])

  // 位置：从「待批」芯片下方弹出，尖角对准芯片，右缘对齐右列（不越出 frame 左右 gutter）
  const place = useCallback(() => {
    const pop = popRef.current
    if (!pop || document.documentElement.getAttribute('data-pend') !== 'open') return
    const frame = pop.offsetParent as HTMLElement | null
    const chip = Array.from(document.querySelectorAll<HTMLElement>('[data-pend-toggle]')).find((el) => el.getClientRects().length > 0)
    if (!frame || !chip) return
    const f = frame.getBoundingClientRect()
    const c = chip.getBoundingClientRect()
    const w = pop.offsetWidth
    const g = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gr-gutter')) || 24
    const cx = c.left + c.width / 2
    let left = f.right - g - w
    if (cx < left + 24 || cx > left + w - 24) left = Math.max(f.left + g, Math.min(cx - 56, f.right - g - w))
    pop.style.left = `${Math.round(left - f.left)}px`
    pop.style.top = `${Math.round(c.bottom - f.top + 12)}px`
    pop.style.setProperty('--arrow-x', `${Math.round(cx - left)}px`)
  }, [])
  useLayoutEffect(() => { place() }, [state, card?.proposalId, queue.length, held?.outcome, place])
  useEffect(() => {
    window.addEventListener('resize', place)
    void document.fonts?.ready.then(place)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (ro && popRef.current?.offsetParent) ro.observe(popRef.current.offsetParent)
    return () => { window.removeEventListener('resize', place); ro?.disconnect() }
  }, [place])
  useEffect(() => {
    if (state !== 'open') return undefined
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') window.dispatchEvent(new CustomEvent(PEND_EVENT, { detail: { action: 'collapse' } })) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [state])

  const act = async (c: PendingCard, kind: 'approve' | 'reject', reason = '') => {
    if (held || offline || performance.now() - swapAt.current < DEAD_ZONE || c.expiresAt <= Date.now()) return
    setHeld({ card: c, act: kind })
    setRejecting(null)
    setErrs((m) => { const n = { ...m }; delete n[c.proposalId]; return n })
    // 拒绝带理由（P1-8）：命令照旧 proposal.reject，多一个 note（空就不带）
    const r = kind === 'approve' ? await approveProposal(bridge, c.proposalId) : await runCommand(bridge, C.reject, { id: c.proposalId, ...(reason.trim() ? { note: reason.trim() } : {}) })
    if (!r.ok) {
      if (r.cancelled) { setHeld(null); return } // PIN 层取消 = 什么都没发生
      toast.err(r.message)
      // 没批成：卡还在待批就回到待批、原文挂在动作行下；卡已经不在了（比如别处已批）就停在结果态给原文
      if (liveRef.current.some((x) => x.proposalId === c.proposalId)) { setHeld(null); setErrs((m) => ({ ...m, [c.proposalId]: r.message })) } else setHeld({ card: c, act: kind, outcome: { kind: 'error', message: r.message } })
      return
    }
    const out = decisionOutcome(kind, r.value)
    if (out.kind === 'failed') { // 已批准但执行失败：不出成功提示；先停在结果态给内核原文 +「知道了」（一键收起），收起后卡退到队尾带原因，不堵后面的卡
      setHeld({ card: c, act: kind, outcome: out })
      return
    }
    setHeld({ card: c, act: kind, outcome: out })
    toast.ok(out.kind === 'rejected' ? tr('已拒绝 {0}', c.ticket) : out.kind === 'executed' ? tr('已批准 {0} · 已执行', c.ticket) : tr('已批准 {0}', c.ticket))
    await wait(HOLD_MS)
    done.current.add(c.proposalId)
    setHeld((h) => (h && h.card.proposalId === c.proposalId ? null : h))
    pend.reload()
  }
  const startReject = (c: PendingCard) => {
    if (held || offline || performance.now() - swapAt.current < DEAD_ZONE || c.expiresAt <= Date.now()) return
    setNote(''); setRejecting(c.proposalId)
  }
  const dismissFailed = (id: string) => {
    done.current.add(id) // 本地隐藏，不发内核命令；刷新后失败卡本来就不是 pending
    setFailed((m) => { const n = { ...m }; delete n[id]; return n })
    setSel(null)
  }
  const pick = (c: PendingCard) => { if (!held && c.proposalId !== card?.proposalId) setSel(c.proposalId) }

  const risks = normalizeRisk(risk.data)
  const after = card ? afterOf(card, acct) : null
  // 占用只显示、按提案所在的单账户口径算（内核限额按单账户判，不能把实盘 + 纸面合算）；不据此禁用任何按钮
  const mine = card?.accountId ?? null
  const myRows = useMemo(() => acct.rows.filter((r) => r.accountId === mine), [acct.rows, mine])
  const mySummaries = useMemo(() => (mine && acct.summaries[mine] ? { [mine]: acct.summaries[mine] } : {}), [acct.summaries, mine])
  const usage = useMemo(() => deriveUsage({ summaries: mySummaries, rows: myRows }), [mySummaries, myRows])
  const equity = mine ? acct.summaries[mine]?.equity ?? null : null
  const occ = card && !card.control && mine && acct.phase === 'ready' ? occupancy({ card, limits: risks.limits, usage, totalNotional: myRows.reduce((x, r) => x + r.notional, 0), equity, delta: after?.delta ?? null, mandateLimits: mandateLimitsOf(card, keys.keys) }) : []
  const fee = card && !card.control ? feeLine(card) : null
  // 只有内核预检判 deny（批后超限也由内核回）才置灰，旁边写内核原文
  const blocked = card && card.verdict === 'deny' ? (card.rules[0] ? ruleLine(card.rules[0]) : tr('预检未通过')) : null
  const acc: AccountLite | undefined = card?.accountId ? acct.accounts.find((a) => a.accountId === card.accountId) : undefined
  const protect = card ? protectionLine(card) : null
  const cardHeld = card && held && held.card.proposalId === card.proposalId ? held : null
  const out = cardHeld?.outcome
  const left = card ? card.expiresAt - now : 0
  const busy = cardHeld && !cardHeld.outcome ? cardHeld.act : null
  const lock = offline || (card ? left <= 0 : true) || busy !== null
  const msg = out && (out.kind === 'failed' || out.kind === 'error') ? out.message : null
  const fail = card ? failed[card.proposalId] : undefined

  let inner: ComponentChildren
  if (pend.phase === 'error' && !pend.cards.length) inner = <Msg error={pend.error} onRetry={pend.reload} />
  else if (pend.phase === 'loading' && !card) inner = <div className="g5-pitem" aria-busy="true"><Sk w={160} /></div>
  else if (!card) inner = <Msg>{tr('没有待批')}</Msg>
  else inner = <>
    <div className="g5-pitem" data-ticket={card.ticket} data-result={out?.kind} data-inflight={live.some((c) => c.proposalId === card.proposalId) ? undefined : '1'}>
      <div className="g5-pfuse">
        <span className="g5-s12 g5-t3 g5-al">{card.ticket}</span>
        <div className="g5-fuse" role="progressbar" aria-label={tr('{0} 剩余时间', card.ticket)} aria-valuemin={0} aria-valuemax={FUSE_WINDOW_MS / 1000} aria-valuenow={Math.max(0, Math.round(left / 1000))}><i style={{ width: `${(Math.round(fuseRatio(card, now) * 1000) / 10).toFixed(1)}%` }} /></div>
        <span className="g5-cd" data-cd={card.proposalId}>{formatCountdown(left)}</span>
      </div>
      <div className="g5-what g5-al">{displayLegs(card)}</div>
      {acc || card.notional !== null ? <div className="g5-pline">
        {acc ? <><span className="g5-tb g5-al">{acc.alias}</span><span className="g5-t1">{acc.mode === 'live' ? tr('实盘') : tr('纸面')}</span>{acc.mode === 'live' ? <VenueIcon venue={acc.venue} label={VENUE_NAME[acc.venue] ?? acc.venue} /> : <span className="g5-papermk" title={tr('纸面账户')} />}</> : null}
        {card.notional !== null ? <span className="g5-kv g5-gap"><span className="g5-k">{tr('名义')}</span><span className="g5-v">{money(card.notional)}</span></span> : null}
      </div> : null}
      {protect ? <div className="g5-pline"><span className="g5-s12 g5-t3 g5-al">{prices.copy(protect, card.legs[0]?.instrumentId)}</span></div> : null}
      {card.priceBounds ? <div className="g5-pline"><span className="g5-s12 g5-t3">{tr('参考价 {0} · 批准时偏离超过 {1} bp 作废', prices.price(card.priceBounds.referencePrice, card.legs[0]?.instrumentId), card.priceBounds.maxDriftBps)}</span></div> : null}
      {after ? <div className="g5-pline"><span className="g5-s12 g5-t3 g5-al">{tr('批后')}</span><span className="g5-tb">{after.sym} {after.from}</span><span className="g5-s12 g5-t3">→</span><span className="g5-t1">{after.to}</span></div> : null}
      {card.rules.map((r, i) => <div key={i} className="g5-pline"><span className={approvalRule(r) ? "g5-blocked g5-await" : "g5-blocked"}>{approvalRule(r) ? <Icon name="clock" size={12} /> : <Ic n="block" s={12} />}{ruleLine(r)}</span></div>)}
      {card.notes?.map((n, i) => <div key={`n${i}`} className="g5-pline" data-note=""><span className="g5-s12 g5-t3">{n}</span></div>)}
      {card.reason || card.origin ? <div className="g5-pline g5-why"><span className="g5-al"><OriginActor origin={card.origin} names={keys.names} /></span>{card.reason ? <ProposalReason key={card.proposalId} text={card.reason} /> : null}</div> : null}
      {card.control ? null : <dl className="g5-prisk">
        <div><dt className="g5-al">{tr('强平价')}</dt><dd data-n="risk">{card.liquidationPrice === null ? tr('无') : tr('约 {0}', prices.price(card.liquidationPrice, card.legs[0]?.instrumentId))}</dd></div>
        <div><dt className="g5-al"><Term name="bp">{tr('滑点上限')}</Term></dt><dd data-n="risk">{card.slippageBps === null ? '—' : `${fmtLoose(card.slippageBps)} bp`}</dd></div>
        <div><dt className="g5-al">{tr('保证金')}</dt><dd data-n="risk">{card.marginRequired === null ? '—' : money(card.marginRequired)}</dd></div>
      </dl>}
      {occ.length || fee ? <div className="g5-pocc"><div className="g5-ph g5-al">{tr('批后风控占用')}</div>{occ.length ? <div className="g5-lims">{occ.map((o) => <LimitLine key={o.id} r={o} used={o.used} of={o.keyCap ? tr('{0}（该钥匙上限）', o.limit) : o.limit} />)}</div> : null}{fee ? <div className="g5-pline" data-n="fee"><span className="g5-s12 g5-t3 g5-al">{fee}</span></div> : null}</div> : null}
      <div className="g5-pacts">
        {fail ? <>
          <span className="g5-blocked" role="status" data-tone="err" data-failed=""><Ic n="warn" s={12} />{RESULT_TEXT.failed}{tr('：')}{ruleLine(fail.message)}</span>
          <button type="button" className="g5-btn g5-btn-fill" data-act="dismiss-failed" onClick={() => dismissFailed(card.proposalId)}>{tr('关闭')}</button>
        </> : out ? <>
          <span className={`g5-blocked${msg ? '' : ' g5-ok'}`} role="status" data-tone={msg ? 'err' : 'ok'}><Ic n={msg ? 'warn' : 'check'} s={12} />{RESULT_TEXT[out.kind]}{msg ? tr('：{0}', msg) : ''}</span>
          {msg ? <button type="button" className="g5-btn g5-btn-fill" data-act="ack" onClick={() => { if (out?.kind === 'failed') { const msgNow = out.message; setFailed((m) => ({ ...m, [card.proposalId]: { card, message: msgNow } })) } setHeld(null); pend.reload() }}>{tr('知道了')}</button> : null}
        </> : <>
          {blocked ? <span className="g5-blocked g5-al" data-blocked=""><Ic n="block" s={12} />{blocked}</span> : null}
          {offline ? <span className="g5-s12 g5-t3">{tr('离线')}</span> : null}
          {errs[card.proposalId] ? <span className="g5-blocked" role="alert" title={errs[card.proposalId]}><Ic n="block" s={12} />{errs[card.proposalId]}</span> : null}
          {rejecting === card.proposalId && !busy ? <>
            <label className="g5-inp g5-s"><input data-act="reject-note" placeholder={tr('理由（可选）')} aria-label={tr('拒绝 {0} 的理由', card.ticket)} maxLength={500} value={note} autoFocus
              onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void act(card, 'reject', note) } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRejecting(null) } }}/></label>
            <button type="button" className="g5-btn g5-btn-fill" data-act="reject-confirm" aria-disabled={guard ? 'true' : undefined} disabled={lock} onClick={() => { void act(card, 'reject', note) }}>{tr('确认拒绝')}</button>
          </> : <button type="button" className="g5-btn g5-btn-fill" data-act="reject" aria-disabled={guard ? 'true' : undefined} disabled={lock && busy !== 'reject'} title={offline ? tr('离线') : undefined} onClick={() => startReject(card)}>{busy === 'reject' ? tr('拒绝中…') : tr('拒绝 {0}', card.ticket)}</button>}
          <button type="button" className="g5-btn g5-btn-primary" data-act="approve" aria-disabled={guard ? 'true' : undefined} disabled={(lock && busy !== 'approve') || !!blocked} title={blocked ?? (offline ? tr('离线') : undefined)} onClick={() => { void act(card, 'approve') }}>{showsApproveLock(card) ? <Ic n="lock" /> : null}{busy === 'approve' ? tr('批准中…') : tr('批准 {0}', card.ticket)}</button>
        </>}
      </div>
    </div>
    {queue.map((x) => <button key={x.proposalId} type="button" className="g5-pq" data-act="queue-pick" data-ticket={x.ticket} onClick={() => pick(x)}>
      <span className="g5-s12 g5-t3 g5-al">{x.ticket}</span><OriginActor origin={x.origin} names={keys.names} /><span className="g5-tb">{displayLegs(x)}</span>{failedIds.has(x.proposalId) ? <span className="g5-res g5-danger">{tr('失败')}</span> : <span className="g5-cd">{formatCountdown(x.expiresAt - now)}</span>}
    </button>)}
    {more ? <div className="g5-pq" data-more=""><span className="g5-s12 g5-t3 g5-al">{tr('另 {0} 张', more)}</span></div> : null}
  </>
  return <section ref={popRef} id="g5-pendpop" className="g5-pendpop g5-glass g5-float" role="dialog" aria-label={tr('待批')} data-g5="float" data-pend={state} data-offline={offline ? '1' : undefined}>
    <header className="g5-hd">
      <h2 className="g5-al" tabIndex={-1}>{tr('待批')}</h2>
      {/* 「待批 N」只数 pending 状态的提案：已批在途的卡留在列表里显示结果，但不计入 N */}
      {pend.phase === 'ready' ? <span className="g5-ct">{live.length}</span> : null}
      <div className="g5-r g5-gh"><button type="button" className="g5-btn g5-btn-ghost g5-btn-icon" data-act="pend-collapse" aria-label={tr('收起')} onClick={() => window.dispatchEvent(new CustomEvent(PEND_EVENT, { detail: { action: 'collapse' } }))}><Ic n="chev" style={{ transform: 'rotate(180deg)' }} /></button></div>
    </header>
    {inner}
  </section>
}
