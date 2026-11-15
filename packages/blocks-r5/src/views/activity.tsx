// SPDX-License-Identifier: CPAL-1.0
// 总览 · 活动卡（r5）：账本动作流（时间 · 执行方 · 做了什么 + 结果字 · 撞了哪条规则），来源页签带计数。
// 取数与规整复用 blocks-default（ledger.query / ledger.entry → entryToActivity）；r5 多记一份「条目 → 实验号」，用来出口到 #/lab/<id>。
// 大模型来源的动作永远带 Agent 小标、永远可筛。读取失败显示内核原文。
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useBridge, useSubscribe } from '@gitrader/blocks-sdk/preact'
import type { LedgerEntry } from '@gitrader/protocol/types'
import { F, Icon, copyText, toast } from '@gitrader/workbench/ui'
import { Q, T } from '../../../blocks-default/src/api'
import { queryRetry, useKernelRestartRow, useKeys, useOffline } from '../../../blocks-default/src/hooks'
import {
  ACTIVITY_TYPES, activityCounts, activityOf, agentMiss, entryToActivity, filterActivity, foldAgentMisses, mergeActivity, normalizeLedger, ruleLine, tidyActivity,
  type ActivityItem, type ActorFilterId,
} from '../../../blocks-default/src/model-activity'
import { isRec } from '../../../blocks-default/src/util'
import { approvalRule, visibleResult } from '../../../blocks-default/src/display'
import { usePriceDisplay } from '../../../blocks-default/src/price-display'
import { Card } from '../kit'
import { Ic, Msg, OriginActor, Sk, cardClass, go, stateAttr, useOfflineClock } from './ovkit'
import { PEND_EVENT } from './pending'
import './overview.css'
import { t } from '@gitrader/workbench/i18n'

const FILTERS: ReadonlyArray<{ id: ActorFilterId; label: string }> = [
  { id: 'all', label: t('全部') }, { id: 'human', label: t('人') }, { id: 'engine', label: t('引擎') }, { id: 'llm-agent', label: 'LLM Agent' }, { id: 'system', label: t('系统') },
]
const EMPTY: Record<ActorFilterId, string> = { all: t('还没有活动'), human: t('你还没有操作'), engine: t('引擎还没有动作'), 'llm-agent': t('大模型还没有发起动作'), system: t('系统还没有记录') }

type Phase = 'loading' | 'ready' | 'error'

/** 活动流 + 条目号 → 实验号。 */
export function useFeed(): { items: ActivityItem[]; exp: Record<string, string>; phase: Phase; error: unknown; reload(): void } {
  const bridge = useBridge()
  const [items, setItems] = useState<ActivityItem[]>([])
  const [exp, setExp] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<unknown>(null)
  const [n, setN] = useState(0)
  const note = (entries: readonly LedgerEntry[]) => setExp((m) => {
    const next = { ...m }
    for (const e of entries) { const id = (e as { subject?: { experimentId?: string } }).subject?.experimentId; if (id) next[e.id] = id }
    return next
  })
  useEffect(() => {
    let dead = false
    queryRetry(bridge, Q.ledger, { types: [...ACTIVITY_TYPES], order: 'desc', limit: 150 }, () => !dead).then(
      (r) => {
        if (dead) return
        const entries = normalizeLedger(r)
        const got = activityOf(entries)
        setItems((prev) => got.reduce((acc, it) => mergeActivity(acc, it), prev))
        note(entries)
        setError(null); setPhase('ready')
      },
      (e: unknown) => { if (!dead) { setError(e); setPhase('error') } },
    )
    return () => { dead = true }
  }, [bridge, n])
  useSubscribe(T.ledger, (e) => {
    if (!isRec(e.data)) return
    const entry = e.data as unknown as LedgerEntry
    const it = entryToActivity(entry)
    if (it) { setItems((prev) => mergeActivity(prev, it)); note([entry]) }
  })
  useKernelRestartRow(setItems)
  return { items, exp, phase, error, reload: useCallback(() => setN((x) => x + 1), []) }
}

/** 提案行的票号（P1-9）：提案类条目的 what 里带票号（如「提出提案 T-20261024-0001」）；没有就不是可点的提案行。 */
export function ticketOf(it: Pick<ActivityItem, 'type' | 'what'>): string | null {
  return it.type.startsWith('proposal.') ? it.what.match(/T-[\w-]+/)?.[0] ?? null : null
}
/** 点提案行：先请待批浮层展开（没有待批时状态机忽略），再请它选中这张票。 */
const selectPending = (ticket: string): void => {
  window.dispatchEvent(new CustomEvent(PEND_EVENT, { detail: { action: 'open' } }))
  window.dispatchEvent(new CustomEvent(PEND_EVENT, { detail: { action: 'select', ticket } }))
}

function Row({ it, names, exp }: { it: ActivityItem & { repeat?: number }; names: Record<string, string>; exp: string | undefined }) {
  const [open, setOpen] = useState(false)
  const more = !!(it.why || it.upstream)
  const ticket = ticketOf(it)
  const live = more || !!ticket
  const res = visibleResult(it.what, it.result)
  // Agent 自己的失败（不需要人决定）：不标红，下面挂一句「它会自己调整」（ux-fix2 B2 第 2 层）
  const miss = agentMiss(it)
  const resCls = res ? (res.label === t('待批') ? 'g5-res g5-acc' : res.tone === 'err' && !miss ? 'g5-res g5-danger' : 'g5-res') : ''
  return <div className="g5-ar" data-type={it.type} data-seq={it.seq} data-open={open ? '1' : undefined} data-agent-miss={miss ? '' : undefined}
    {...(live ? { role: 'button', tabIndex: 0, ...(more ? { 'aria-expanded': open } : {}), 'data-ticket': ticket ?? undefined, onClick: (e: Event) => { if ((e.target as Element).closest('button, a')) return; if (ticket) selectPending(ticket); if (more) setOpen(!open) }, onKeyDown: (e: KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (ticket) selectPending(ticket); if (more) setOpen(!open) } } } : {})}>
    <span className="g5-tm g5-al">{F.hms(it.ts)}</span>
    <OriginActor origin={it.origin} names={names} />
    <span className="g5-tx">
      <span className="g5-l1">{it.what}{res ? <span className={resCls}>{res.label}</span> : null}{exp ? <button type="button" className="g5-res g5o-lnk" data-act="to-lab" onClick={() => go(`#/lab/${encodeURIComponent(exp)}`)}>{t('实验 ')}{exp}</button> : null}</span>
      {it.rules.map((r, i) => <span key={i} className={`g5-l2${approvalRule(r) ? ' g5-await' : ''}`}>{approvalRule(r) ? <Icon name="clock" size={12} /> : <Ic n="block" s={12} />}{ruleLine(r)}</span>)}
      {it.notes?.map((n, i) => <span key={`n${i}`} className="g5-l2 g5o-why" data-note="">{n}</span>)}
      {miss ? <span className="g5-l2 g5o-agent" data-agent-note="">{(it.repeat ?? 1) > 1 ? t('Agent 自己的调用，连续 {0} 次没通过；它会按原因自己调整，不用你处理', it.repeat) : t('Agent 自己的调用没通过；它会按原因自己调整，不用你处理')}</span> : null}
      {open && it.why ? <span className="g5-l2 g5o-why">{it.why}</span> : null}
      {open && it.upstream ? <span className="g5-l2 g5o-why">{it.upstream}<button type="button" className="g5-btn g5-btn-ghost" data-act="copy-upstream" onClick={() => { void copyText(it.upstream as string).then((ok) => (ok ? toast.ok(t('已复制原文')) : toast.err(t('复制失败')))) }}>{t('复制原文')}</button></span> : null}
    </span>
  </div>
}

export function ActivityView() {
  const feed = useFeed()
  const prices = usePriceDisplay()
  const keys = useKeys()
  const offline = useOffline(() => { keys.reload(); feed.reload() })
  const clock = useOfflineClock(offline)
  const [filter, setFilter] = useState<ActorFilterId>('all')
  const [pin, setPin] = useState<number | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  // 提案状态回写 + 接管折叠（C13）：创建行不再永远挂「待批」，一次接管只留完成行
  const items = tidyActivity(feed.items)
  const counts = activityCounts(items)
  const top = items.reduce((m, x) => Math.max(m, x.seq), 0)
  const filtered = filterActivity(items, filter).map((it) => ({ ...it, what: prices.copy(it.what, it.instrumentId) }))
  const shown = pin === null ? filtered : filtered.filter((x) => x.seq <= pin)
  const fresh = filtered.length - shown.length
  // 向下滚动时不顶跑阅读位置（冻结在当时最新的那条），顶部出「新动作 N」整行
  const onScroll = (e: Event) => {
    const y = (e.currentTarget as HTMLElement).scrollTop
    if (y > 4 && pin === null) setPin(top)
    else if (y <= 4 && pin !== null) setPin(null)
  }
  // 静止态整行裁切：没往下滚时，列表可视高度向下取整到最后一条完整条目的底边（卡内不出现半行）；滚动后照常
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return undefined
    const fit = () => {
      el.style.maxHeight = ''
      if (pin !== null || el.scrollTop > 0) return
      const rows = Array.from(el.querySelectorAll<HTMLElement>(':scope > .g5-ar'))
      if (!rows.length) return
      const box = el.getBoundingClientRect()
      const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0
      const avail = box.height
      let cut = 0
      let last: HTMLElement | null = null
      for (const r of rows) { const b = r.getBoundingClientRect().bottom - box.top; if (b > avail - pad + 0.5) break; cut = b; last = r }
      if (!last || last === rows[rows.length - 1]) return
      el.style.maxHeight = `${Math.ceil(cut + pad)}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    const parent = el.parentElement
    if (parent) ro.observe(parent)
    void document.fonts?.ready.then(fit)
    return () => { ro.disconnect(); el.style.maxHeight = '' }
  }, [shown.length, feed.phase, filter, pin])

  const tabs = <div className="g5-r g5-tabs g5-gh" role="tablist" aria-label={t('来源')}>
    {FILTERS.map((f) => <button key={f.id} type="button" className="g5-tab" role="tab" data-filter={f.id} aria-selected={filter === f.id} onClick={() => { setFilter(f.id); setPin(null) }}>{f.label}<span className="g5-c">{counts[f.id]}</span></button>)}
  </div>
  let body: ComponentChildren
  if (feed.phase === 'error') body = <Msg error={feed.error} onRetry={feed.reload} />
  else if (feed.phase === 'loading') body = <div className="g5-alist" aria-busy="true" aria-label={t('加载中')}>{[[52, 96, 180], [52, 72, 220], [52, 96, 160], [52, 56, 200], [52, 96, 176], [52, 80, 144]].map((w, i) => <div key={i} className="g5-ar"><span className="g5-tm"><Sk w={w[0]!} /></span><span><Sk w={w[1]!} /></span><span><Sk w={w[2]!} /></span></div>)}</div>
  else if (!shown.length) body = <Msg>{EMPTY[filter]}</Msg>
  else body = <>
    {fresh > 0 ? <button type="button" className="g5-btn g5-btn-fill g5o-fresh" data-act="feed-new" onClick={() => { if (list.current) list.current.scrollTop = 0; setPin(null) }}>{t('新动作 ')}{fresh}<Ic n="chev" s={12} style={{ transform: 'rotate(180deg)' }} /></button> : null}
    <div ref={list} className="g5-alist g5-scroll" onScroll={onScroll}>{foldAgentMisses(shown).map((it) => <Row key={it.id} it={it} names={keys.names} exp={feed.exp[it.id]} />)}</div>
  </>
  const head = <header className="g5-hd">
    <h2 className="g5-al" tabIndex={-1}>{t('活动')}</h2>
    {feed.phase === 'ready' ? <span className="g5-ct">{counts.all}</span> : null}
    {clock ? <span className="g5-s12 g5-t3 g5o-clock">{clock}</span> : null}
    {feed.phase === 'ready' && feed.items.length ? tabs : null}
  </header>
  return <Card head={head} className={cardClass(true, offline)} {...stateAttr(offline)} data-g5-page="overview" data-view="feed" id="act" aria-label={t('活动')}>{body}</Card>
}
