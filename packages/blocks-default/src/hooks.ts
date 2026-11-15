// SPDX-License-Identifier: CPAL-1.0
// 数据钩子：块的数据全部经桥（查询取快照 + 订阅收增量），不直连内核。纯规整逻辑在 model-*.ts。
import type { LedgerEntry, Position } from '@gitrader/protocol/types'
import { CODE_CONNECTION_LOST, KernelError, type BlockBridge } from '@gitrader/blocks-sdk'
import { useBridge, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { REFRESH_EVENT } from './actions'
import { Q, T } from './api'
import { ACTIVITY_TYPES, KERNEL_RESTART_EVENT, applyProposal, actorNames, entryToActivity, kernelRestartItem, keyTiers, mergeActivity, normalizeLedger, normalizeProposals, pendingQueue, activityOf, type ActivityItem, type KeyTier, type PendingCard } from './model-activity'
import {
  buildRows, computeTotals, normalizeAccounts, normalizeFills, normalizeOrders, normalizePositions, normalizeSummary, positionsEvent, positionDelta, applyPositionDelta, summaryEvent,
  type AccountLite, type FillLite, type OrderLite, type PositionRow, type SummaryLite, type Totals,
} from './model-positions'
import { buildStatus, deriveUsage, mandateNames, normalizeRisk, normalizeVenues, stateRows, type RiskView, type StatusView, type VenueHealth } from './model-risk'
import type { Rec } from './util'
import { isRec } from './util'
import type { FeedState } from '@gitrader/workbench'
import { t as tr } from '@gitrader/workbench/i18n'

export type Phase = 'loading' | 'ready' | 'error'

/** 每 ms 毫秒刷新一次的当前时间（倒计时用）。 */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// ---- 内核连接（IXD G5 离线）--------------------------------------------------------------
// 块拿不到内核客户端，只有桥；连接态由壳判断（曾连上、断开 > 2 s = 离线，与块头的陈旧小标同一个判断），挂在 <html data-offline> / data-kernel 上。
// 一方块读这两个属性（MutationObserver，不轮询内核）；没有壳的地方（离线预览）属性不存在 = 在线。
const htmlOffline = (): boolean => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-offline')
const htmlClosed = (): boolean => typeof document !== 'undefined' && document.documentElement.getAttribute('data-kernel') === 'closed'

/** Shell-owned market feed state; missing shell state is unknown/stale, never live. */
export function useFeedState(): FeedState {
  const read = (): FeedState => {
    if (typeof document === 'undefined') return 'stale'
    const value = document.documentElement.getAttribute('data-feed')
    return value === 'live' || value === 'down' ? value : 'stale'
  }
  const [feed, setFeed] = useState<FeedState>(read)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined
    const update = () => setFeed(read())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-feed'] })
    return () => observer.disconnect()
  }, [])
  return feed
}

/**
 * 内核是否「离线」（G5）：离线时命令类控件禁用并标「离线」、持仓去涨跌色。onBack：从离线恢复时调一次（重读快照，补上断线期间的变化）。
 * withClosed：会话失效（内核关了连接、不再重连）也算断开——状态条用（它在会话失效卡下面仍然可见）。
 */
export function useOffline(onBack?: () => void, withClosed = false): boolean {
  const read = () => htmlOffline() || (withClosed && htmlClosed())
  const [off, setOff] = useState(read)
  const back = useRef(onBack)
  back.current = onBack
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined
    let was = read()
    setOff(was)
    const mo = new MutationObserver(() => { const now = read(); if (now === was) return; setOff(now); if (was && !now) back.current?.(); was = now })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-offline', 'data-kernel'] })
    return () => mo.disconnect()
  }, [withClosed])
  return off
}

/**
 * 壳挂在 <html> 上的布尔标（属性在 = 真；MutationObserver，不轮询）。现在只有 data-takeover-busy：本页任何入口（风险块、状态条卡、命令面板）发出的接管
 * 从发出到落定都挂着，三个入口都读它禁用（M4 / C8，与 data-offline 同一份 B/C 共享契约）。没有壳的地方（离线预览）属性不存在 = 假。
 */
export function useHtmlFlag(attr: string): boolean {
  const read = (): boolean => typeof document !== 'undefined' && document.documentElement.hasAttribute(attr)
  const [on, setOn] = useState(read)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined
    setOn(read())
    const mo = new MutationObserver(() => setOn(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [attr] })
    return () => mo.disconnect()
  }, [attr])
  return on
}

// ---- 卡间跳转（r4，工单 6.3）：window 事件 gitrader:focus { card, proposalId? } ------------------------------------
// 发送方：总览条（待批 / 风险）、持仓卡（有待批）；接收方：待批卡、风险卡。只在一方 inline 块之间用，插件 iframe 收不到（预期）。

export type FocusCardId = 'pending' | 'risk'
export interface FocusDetail { card: FocusCardId; proposalId?: string }
export const FOCUS_EVENT = 'gitrader:focus'

/** 发一次卡间跳转。 */
export function focusCard(card: FocusCardId, proposalId?: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<FocusDetail>(FOCUS_EVENT, { detail: { card, ...(proposalId ? { proposalId } : {}) } }))
}

/** 卡的焦点落点：壳里是卡头标题（h2，tabIndex -1；手机视图折叠时是摘要行按钮），没有壳就是 CardHead 自己渲染的标题。 */
export function focusCardTitle(root: HTMLElement | null): void {
  const tile = root?.closest('.gr-tile-p')
  const el = tile?.querySelector<HTMLElement>('h2.gr-tile-p__title, .gr-tile-p__sum') ?? root?.querySelector<HTMLElement>('.gb-head__t') ?? null
  el?.focus()
}

/** 接收 gitrader:focus：card 对上就先调 onHit（比如选中那张提案），再把焦点给本卡标题。 */
export function useFocusCard(card: FocusCardId, root: { current: HTMLElement | null }, onHit?: (d: FocusDetail) => void): void {
  const hit = useRef(onHit)
  hit.current = onHit
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<FocusDetail>).detail
      if (!d || d.card !== card) return
      hit.current?.(d)
      focusCardTitle(root.current)
    }
    window.addEventListener(FOCUS_EVENT, on)
    return () => window.removeEventListener(FOCUS_EVENT, on)
  }, [card, root])
}

/** 长命令超时后 runCommand 发 window 事件 gitrader:refresh（C9）：持仓 / 风险快照重读一次，不重发命令。 */
function useRefreshEvent(fn: () => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const on = () => ref.current()
    window.addEventListener(REFRESH_EVENT, on)
    return () => window.removeEventListener(REFRESH_EVENT, on)
  }, [])
}

const errOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 查询；壳刚启动、内核连接还没建好（或断线重连中）时，客户端回「连接丢失」，这时退避重试而不是直接报错。
 * 内核给的任何其他错误（含读取失败）立刻抛出，原文不改。
 */
export async function queryRetry<T = unknown>(bridge: BlockBridge, method: string, params?: unknown, alive: () => boolean = () => true, tries = 14): Promise<T> {
  for (let i = 0; ; i += 1) {
    try { return await bridge.query<T>(method, params) } catch (e) {
      if (!(e instanceof KernelError && e.code === CODE_CONNECTION_LOST) || i >= tries || !alive()) throw e
      await sleep(Math.min(3000, 250 * 2 ** i))
    }
  }
}

interface Res<T> { data: T | undefined; error: Error | null; loading: boolean; reload(): void }

/** 只读查询的状态钩子（带连接未就绪时的重试）；reload 重新查，失败保留上一次数据。 */
export function useRes<T = unknown>(method: string, params?: unknown): Res<T> {
  const bridge = useBridge()
  const [st, setSt] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [n, setN] = useState(0)
  const key = JSON.stringify(params ?? null)
  useEffect(() => {
    let dead = false
    queryRetry<T>(bridge, method, params, () => !dead).then(
      (data) => { if (!dead) setSt({ data, error: null, loading: false }) },
      (e: unknown) => { if (!dead) setSt((s) => ({ data: s.data, error: errOf(e), loading: false })) },
    )
    return () => { dead = true }
  }, [bridge, method, key, n])
  return { ...st, reload: useCallback(() => setN((x) => x + 1), []) }
}

// ---- 账户快照：持仓 / 权益 / 成交 / 订单 ----------------------------------------------------

export interface AccountsData {
  phase: Phase
  error: Error | null
  accounts: AccountLite[]
  rows: PositionRow[]
  summaries: Record<string, SummaryLite | null>
  totals: Totals
  reload(): void
}

interface Snap {
  accounts: AccountLite[]
  positions: Record<string, Position[]>
  summaries: Record<string, SummaryLite | null>
  fills: Record<string, FillLite[]>
  orders: Record<string, OrderLite[]>
}
const EMPTY: Snap = { accounts: [], positions: {}, summaries: {}, fills: {}, orders: {} }

/** detail=false（风险块）：不查成交与订单，只要持仓与权益。 */
export function useAccountsData(detail = true): AccountsData {
  const bridge = useBridge()
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<Error | null>(null)
  const [snap, setSnap] = useState<Snap>(EMPTY)
  const [n, setN] = useState(0)
  useRefreshEvent(() => setN((x) => x + 1))

  useEffect(() => {
    let dead = false
    setPhase((p) => (p === 'ready' ? p : 'loading'))
    ;(async () => {
      const accounts = normalizeAccounts(await queryRetry(bridge, Q.accounts, undefined, () => !dead))
      const per = await Promise.all(accounts.map(async (a) => {
        const p = { accountId: a.accountId }
        const [positions, summary, fills, orders] = await Promise.all([
          queryRetry(bridge, Q.positions, p, () => !dead).then(normalizePositions),
          // 权益 / 成交 / 订单只是补充：它们读不到时持仓表照常显示，对应数字显示 —。
          queryRetry(bridge, Q.summary, p, () => !dead).then(normalizeSummary, () => null),
          detail ? queryRetry(bridge, Q.fills, { ...p, limit: 200 }, () => !dead).then(normalizeFills, () => [] as FillLite[]) : Promise.resolve([] as FillLite[]),
          detail ? queryRetry(bridge, Q.orders, { ...p, limit: 100 }, () => !dead).then(normalizeOrders, () => [] as OrderLite[]) : Promise.resolve([] as OrderLite[]),
        ])
        return { a, positions, summary, fills, orders }
      }))
      if (dead) return
      const next: Snap = { accounts, positions: {}, summaries: {}, fills: {}, orders: {} }
      for (const r of per) {
        next.positions[r.a.accountId] = r.positions
        next.summaries[r.a.accountId] = r.summary
        next.fills[r.a.accountId] = r.fills
        next.orders[r.a.accountId] = r.orders
      }
      setSnap(next)
      setError(null)
      setPhase('ready')
    })().catch((e: unknown) => { if (!dead) { setError(errOf(e)); setPhase('error') } })
    return () => { dead = true }
  }, [bridge, n])

  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (refetch.current) clearTimeout(refetch.current) }, [])
  useSubscribe(T.positions, (e) => {
    const ev = positionsEvent(e.data)
    if (ev) { setSnap((s) => ({ ...s, positions: { ...s.positions, [ev.accountId]: ev.positions } })); return }
    const d = positionDelta(e.data)
    if (!d) return
    setSnap((s) => ({ ...s, positions: { ...s.positions, [d.accountId]: applyPositionDelta(s.positions[d.accountId] ?? [], d) } }))
    // 内核不推 account.summary：持仓变了就稍后重查一次（权益 / 今日盈亏 / 订单跟着更新）
    if (refetch.current) clearTimeout(refetch.current)
    refetch.current = setTimeout(() => setN((x) => x + 1), 400)
  })
  useSubscribe(T.summary, (e) => {
    const ev = summaryEvent(e.data)
    if (ev) setSnap((s) => ({ ...s, summaries: { ...s.summaries, [ev.accountId]: { ...(s.summaries[ev.accountId] ?? { equity: null, available: null, dayStartEquity: null, dayPnl: null }), ...Object.fromEntries(Object.entries(ev.summary).filter(([, v]) => v !== null)) } as SummaryLite } }))
  })
  useSubscribe(T.fills, (e) => {
    // 实盘账户的持仓变化只随成交推送到来（内核对实盘不发 account.positions）：有成交就稍后整体重查（集成修补 H）
    if (refetch.current) clearTimeout(refetch.current)
    refetch.current = setTimeout(() => setN((x) => x + 1), 400)
    const f = detail ? normalizeFills([e.data])[0] : undefined
    if (f) setSnap((s) => ({ ...s, fills: { ...s.fills, [f.accountId]: (s.fills[f.accountId] ?? []).some((x) => x.fillId === f.fillId) ? (s.fills[f.accountId] ?? []) : [...(s.fills[f.accountId] ?? []), f] } }))
  })
  useSubscribe('account.orders', (e) => {
    const o = detail ? normalizeOrders([e.data])[0] : undefined
    if (o) setSnap((s) => ({ ...s, orders: { ...s.orders, [o.accountId]: [...(s.orders[o.accountId] ?? []).filter((x) => !(x.instrumentId === o.instrumentId && x.createdAt === o.createdAt)), o] } }))
  })

  const rows = buildRows(snap.accounts, snap.positions, snap.orders)
  const now = useNow(30000)
  const totals = computeTotals({ accounts: snap.accounts, summaries: snap.summaries, fills: snap.fills, rows }, now)
  return { phase, error, accounts: snap.accounts, rows, summaries: snap.summaries, totals, reload: useCallback(() => setN((x) => x + 1), []) }
}

/** 某个持仓的账本条目（点开事件链时才查）。 */
export function usePositionLedger(row: PositionRow | null): { entries: LedgerEntry[]; proposals: Rec[]; phase: Phase; error: Error | null } {
  const bridge = useBridge()
  const [st, setSt] = useState<{ entries: LedgerEntry[]; proposals: Rec[]; phase: Phase; error: Error | null }>({ entries: [], proposals: [], phase: 'loading', error: null })
  const key = row ? row.key : ''
  useEffect(() => {
    if (!row) return undefined
    let dead = false
    setSt({ entries: [], proposals: [], phase: 'loading', error: null })
    // 账本条目按账户 + 标的取；提案条目不带标的，另读提案列表（读不到不影响成交与来源）。
    const props = queryRetry(bridge, Q.proposals, { limit: 100 }, () => !dead).then(normalizeProposals, () => [] as Rec[])
    queryRetry(bridge, Q.ledger, { accountId: row.accountId, instrumentId: row.instrumentId, ...(row.openedAt ? { sinceTs: row.openedAt - 60000 } : {}), order: 'asc', limit: 200 }, () => !dead).then(
      async (r) => { const proposals = await props; if (!dead) setSt({ entries: normalizeLedger(r), proposals, phase: 'ready', error: null }) },
      (e: unknown) => { if (!dead) setSt({ entries: [], proposals: [], phase: 'error', error: errOf(e) }) },
    )
    return () => { dead = true }
  }, [bridge, key])
  return st
}

// ---- Agent 活动 ----------------------------------------------------------------------

export function useActivity(): { items: ActivityItem[]; phase: Phase; error: Error | null; reload(): void } {
  const bridge = useBridge()
  const [items, setItems] = useState<ActivityItem[]>([])
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<Error | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let dead = false
    queryRetry(bridge, Q.ledger, { types: [...ACTIVITY_TYPES], order: 'desc', limit: 150 }, () => !dead).then(
      (r) => { if (dead) return; const got = activityOf(normalizeLedger(r)); setItems((prev) => got.reduce((acc, it) => mergeActivity(acc, it), prev)); setError(null); setPhase('ready') },
      (e: unknown) => { if (!dead) { setError(errOf(e)); setPhase('error') } },
    )
    return () => { dead = true }
  }, [bridge, n])
  useSubscribe(T.ledger, (e) => {
    if (!isRec(e.data)) return
    const it = entryToActivity(e.data as unknown as LedgerEntry)
    if (it) setItems((prev) => mergeActivity(prev, it))
  })
  useKernelRestartRow(setItems)
  return { items, phase, error, reload: useCallback(() => setN((x) => x + 1), []) }
}

/** 壳发现内核重启（窗口事件）时，往活动流插一条本页内存里的「内核已重启」行（P2-6；不落盘、不写内核）。r4 / r5 两个活动流共用。 */
export function useKernelRestartRow(setItems: (update: (prev: ActivityItem[]) => ActivityItem[]) => void): void {
  useEffect(() => {
    const on = (e: Event) => {
      const ts = Number((e as CustomEvent<{ ts?: number }>).detail?.ts) || Date.now()
      setItems((prev) => mergeActivity(prev, kernelRestartItem(ts, prev)))
    }
    window.addEventListener(KERNEL_RESTART_EVENT, on)
    return () => window.removeEventListener(KERNEL_RESTART_EVENT, on)
  }, [setItems])
}

/** 壳（AgentRequestCard）把「待批的 Agent 接入请求」条数挂在 <html data-agent-requests> 并发这个事件；状态条的「待批」把它算进去（UX-14：接入请求也是等人批的事）。 */
export const AGENT_REQ_EVENT = 'gitrader:agent-requests'
export function useAgentRequests(): number {
  const read = () => Number(document.documentElement.dataset.agentRequests) || 0
  const [n, setN] = useState(read)
  useEffect(() => {
    const on = () => setN(read())
    on()
    window.addEventListener(AGENT_REQ_EVENT, on)
    return () => window.removeEventListener(AGENT_REQ_EVENT, on)
  }, [])
  return n
}

export function usePending(): { cards: PendingCard[]; phase: Phase; error: Error | null; reload(): void } {
  const bridge = useBridge()
  const [map, setMap] = useState<ReadonlyMap<string, Rec>>(new Map())
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<Error | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let dead = false
    queryRetry(bridge, Q.proposals, { status: 'pending', limit: 50 }, () => !dead).then(
      (r) => { if (dead) return; setMap(() => { let m: ReadonlyMap<string, Rec> = new Map(); for (const p of normalizeProposals(r)) m = applyProposal(m, p); return m }); setError(null); setPhase('ready') },
      (e: unknown) => { if (!dead) { setError(errOf(e)); setPhase('error') } },
    )
    return () => { dead = true }
  }, [bridge, n])
  useSubscribe(T.proposals, (e) => setMap((m) => applyProposal(m, e.data)))
  // 倒计时与「过期两秒还没等到内核的 expired 事件就先拿掉」放在待批区自己的组件里按秒刷新，免得整块每秒重绘。
  const cards = pendingQueue(map)
  return { cards, phase, error, reload: useCallback(() => setN((x) => x + 1), []) }
}

/** 钥匙 / 授权书列表的补拉间隔。 */
const KEY_POLL_MS = 15000

/** 页面可见：没有 document（离线预览 / 非浏览器）视为可见。 */
const pageVisible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * 该不该重拉钥匙 / 授权书列表：不可见时不拉；从没拉过（lastAt <= 0）或距上次已满 everyMs 就拉——重新可见时 lastAt 已过期，于是立即补一次。
 */
export function shouldPollKeys(visible: boolean, lastAt: number, now: number, everyMs = 15000): boolean {
  if (!visible) return false
  if (!(lastAt > 0)) return true
  return now - lastAt >= everyMs
}

export function useKeys(): { keys: KeyTier[]; names: Record<string, string>; phase: Phase; error: Error | null; reload(): void } {
  const k = useRes<unknown>(Q.keys)
  const m = useRes<unknown>(Q.mandates)
  // useRes 挂载时已经查过一次，这里按「刚拉过」起算（CLI 另建的钥匙靠下面的补拉出现，R-51）。
  const loadedAt = useRef(Date.now())
  const reload = useCallback(() => { loadedAt.current = Date.now(); k.reload(); m.reload() }, [k.reload, m.reload])
  useSubscribe(T.mandate, reload)
  useSubscribe(T.proposals, reload)
  useEffect(() => {
    const poll = () => {
      const now = Date.now()
      if (!shouldPollKeys(pageVisible(), loadedAt.current, now, KEY_POLL_MS)) return
      loadedAt.current = now
      k.reload()
      m.reload()
    }
    const t = setInterval(poll, KEY_POLL_MS)
    // 隐藏时周期里不拉（poll 自己判可见）；重新可见时不等下一个周期，立即补一次。
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', poll)
    return () => {
      clearInterval(t)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', poll)
    }
  }, [k.reload, m.reload])
  const keys = keyTiers(k.data, m.data)
  const err = k.error ?? m.error
  const phase: Phase = err ? 'error' : k.loading && !k.data ? 'loading' : 'ready'
  // 名字映射读原始钥匙表（keys 已滤掉吊销的，名字不能经它），吊销的钥匙带后缀「（已撤销）」（R-50）。
  return { keys, names: actorNames(k.data), phase, error: err, reload }
}

// ---- 风险状态 ------------------------------------------------------------------------

export interface RiskData { raw: unknown; phase: Phase; error: Error | null; risk: RiskView; triggers: LedgerEntry[]; accounts: AccountsData; /** 授权书 id → 钥匙名（C12）：停机行写名字，不露编号。 */ mandateNames: Record<string, string>; reload(): void }

/** onEntry：每条实时账本条目也交给调用方（风险块用它接住别的入口发起的接管结果）。 */
export function useRisk(onEntry?: (e: unknown) => void): RiskData {
  const q = useRes<unknown>(Q.riskState)
  const keysQ = useRes<unknown>(Q.keys)
  const bridge = useBridge()
  const accounts = useAccountsData(false)
  useRefreshEvent(q.reload)
  const [triggers, setTriggers] = useState<LedgerEntry[]>([])
  useEffect(() => {
    let dead = false
    queryRetry(bridge, Q.ledger, { types: ['protector.triggered'], order: 'desc', limit: 20 }, () => !dead).then(
      (r) => { if (!dead) setTriggers((prev) => { const got = normalizeLedger(r); const ids = new Set(prev.map((x) => x.id)); return [...prev, ...got.filter((x) => !ids.has(x.id))] }) },
      () => { /* 触发记录读不到不影响状态与限额 */ },
    )
    return () => { dead = true }
  }, [bridge])
  useSubscribe(T.risk, () => q.reload())
  useSubscribe(T.ledger, (e) => {
    const d = e.data as LedgerEntry
    if (isRec(d) && d.type === 'protector.triggered') setTriggers((prev) => (prev.some((x) => x.id === d.id) ? prev : [d, ...prev].slice(0, 20)))
    onEntry?.(e.data)
  })
  const base = normalizeRisk(q.data)
  const risk: RiskView = base
  const usage = deriveUsage({ summaries: accounts.summaries, rows: accounts.rows })
  const merged = { ...usage, ...Object.fromEntries(Object.entries(base.usage).filter(([, v]) => v !== null && v !== undefined)) }
  return { raw: q.data, phase: q.error ? 'error' : q.loading && !q.data ? 'loading' : 'ready', error: q.error, risk: { ...risk, usage: merged }, triggers, accounts, mandateNames: mandateNames(keysQ.data), reload: q.reload }
}

// ---- 状态条 --------------------------------------------------------------------------

/** error：内核在线、但场所状态一次都没读到时的内核原文（状态条首项照原文显示，接管照常可点——C1，不当成「内核未连接」）。 */
export function useStatus(): { view: StatusView; venues: VenueHealth[]; error: Error | null; reload(): void } {
  const venuesQ = useRes<unknown>(Q.venues)
  const riskQ = useRes<unknown>(Q.riskState)
  const keysQ = useRes<unknown>(Q.keys)
  const [venueLive, setVenueLive] = useState<Record<string, VenueHealth>>({})
  useEffect(() => { setVenueLive({}) }, [venuesQ.data])
  // 延迟与预算会一直变，场所状态事件只在变化时发：每 5 秒补一次快照（页面隐藏时不查）。
  useEffect(() => {
    const t = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) { venuesQ.reload() } }, 5000)
    return () => clearInterval(t)
  }, [venuesQ.reload])
  useSubscribe(T.venues, (e) => { for (const v of normalizeVenues([e.data])) setVenueLive((m) => ({ ...m, [v.id]: v })) })
  useSubscribe(T.risk, () => riskQ.reload())
  const base = normalizeVenues(venuesQ.data)
  const venues = base.map((v) => venueLive[v.id] ?? v).concat(Object.values(venueLive).filter((v) => !base.some((b) => b.id === v.id)))
  const risk = normalizeRisk(riskQ.data)
  const online = !venuesQ.error || venues.length > 0
  const view = buildStatus(venues, risk.known ? risk.state : null, online && !(venuesQ.error && !venuesQ.data))
  const scopes = stateRows(isRec(riskQ.data) ? { ...riskQ.data, mandateNames: mandateNames(keysQ.data) } : riskQ.data).filter((row) => row.state === risk.state)
  if (scopes.length) view.stateLabel += ' · ' + scopes.map((row) => row.label).join(tr('、'))
  return { view, venues, error: view.online ? null : venuesQ.error, reload: venuesQ.reload }
}
