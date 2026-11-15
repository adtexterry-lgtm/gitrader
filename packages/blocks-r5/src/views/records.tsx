// SPDX-License-Identifier: CPAL-1.0
// 记录页（块 audit）：成交 / 委托 / 资金费三个页签，records.query 游标续读，按账户分组（实盘在上），行内展开事件链（ledger.trace），导出。
// 数据只经桥；筛选写回联动（账户 / 标的 / 时间）；执行方 / 来源按内核盖章的 origin，origin 为空写「未知」。
import type { BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useLink } from '@gitrader/blocks-sdk/preact'
import { Menu, toast } from '@gitrader/workbench/ui'
import { Fragment, type ComponentChildren } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { runCommand } from '../../../blocks-default/src/actions'
import { queryRetry, useNow, useOffline } from '../../../blocks-default/src/hooks'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import { usePriceDisplay } from '../../../blocks-default/src/price-display'
import type { InstrumentPriceRule } from '@gitrader/protocol/types'
import { Actor, Card, Empty, ErrorText, Offline, Unwired, VenueIcon, wireState } from '../kit'
import {
  ACTOR_OPTIONS, DEFAULT_FILTERS, RANGES, TABS, actorFilters, agentActorOptions, agentNames, applySymbolFilter, buildRecordChain, exportParams, fmtDay, fmtHms, fmtMoney, fmtPriceBy, fmtQty, fmtRate,
  groupLabel, groupRecords, headTotals, loadedNote, mergeRows, normalizeAccounts, orderPrice, pageOf, pageOfBlocked, queryParams, rangeOfLink, recordSymbols, statusWord, ticketMap, timeBounds, tone,
  typeWord,
  type AccountLite, type ActorView, type BlockedRow, type ChainNode, type Filters, type FillRow, type FundingRow, type OrderRow, type RangeId, type RecGroup, type RecRow, type RecordTab,
} from '../model-records'
import './records.css'
import { t as tr } from '@gitrader/workbench/i18n'

const PAGE = 100
const errOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/** ledger.export 回包里的账单（C3）：给人看的 CSV，文件名由内核按本地时间起；前端补 UTF-8 BOM，Excel 打开中文不乱码。没有 files（条数过多只写盘）返回 null。 */
export function billDownload(value: unknown): { name: string; text: string } | null {
  const v = (value ?? {}) as { billName?: unknown; files?: { bill?: unknown } }
  const bill = v.files?.bill
  if (typeof bill !== 'string') return null
  return { name: typeof v.billName === 'string' && v.billName ? v.billName : tr('gitrader-账单.csv'), text: `\uFEFF${bill.replace(/^\uFEFF/, '')}` }
}
/** 浏览器里把文本存成文件（写法同实验证据包的 saveJson）。 */
function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
const TAB_EMPTY: Record<RecordTab, string> = { fills: tr('这段时间没有成交'), orders: tr('这段时间没有委托'), funding: tr('这段时间没有资金费'), blocked: tr('这段时间没有被拦下的单') }
/** 被拦页签一次取的条数（risk.denials 无游标）；取满时计数写「200+」。 */
const BLOCKED_LIMIT = 200

// ---- 数据 --------------------------------------------------------------------------------

interface Lookups { names: Record<string, string>; tickets: Record<string, string>; accounts: AccountLite[]; agents: Array<{ id: string; label: string }> }

/** 账户 / Agent 名 / 提案票号：都只是补充，读不到不挡表（账户读不到则分组按账户号，全归「其他」）。 */
function useLookups(nonce: number): Lookups | null {
  const bridge = useBridge()
  const [look, setLook] = useState<Lookups | null>(null)
  useEffect(() => {
    let dead = false
    const q = (method: string, params?: unknown) => queryRetry(bridge, method, params, () => !dead).catch(() => undefined)
    Promise.all([q('account.list'), q('agentkey.list'), q('proposal.list', { limit: 200 })]).then(([a, k, p]) => {
      if (!dead) setLook({ accounts: normalizeAccounts(a), names: agentNames(k), tickets: ticketMap(p), agents: agentActorOptions(k) })
    })
    return () => { dead = true }
  }, [bridge, nonce])
  return look
}

/** 被拦行的本地筛：时间界与执行方（risk.denials 不收这些参数）。 */
function blockedPage(page: ReturnType<typeof pageOfBlocked>, f: Filters, now: number): ReturnType<typeof pageOfBlocked> {
  const b = timeBounds(f, now)
  const rows = (page.rows as BlockedRow[]).filter((r) => (b.sinceTs === undefined || r.ts >= b.sinceTs) && (b.untilTs === undefined || r.ts < b.untilTs)
    && (!f.actorType || r.origin?.actorType === f.actorType) && (!f.actor || r.origin?.actor === f.actor))
  return { ...page, rows }
}

interface Paged { rows: RecRow[]; next: string | undefined; total: number | null; phase: 'loading' | 'ready' | 'error'; error: Error | null; more: 'idle' | 'busy'; moreError: Error | null }
const FRESH: Paged = { rows: [], next: undefined, total: null, phase: 'loading', error: null, more: 'idle', moreError: null }

/** 一个页签的游标续读。「现在」在首页取一次并沿用到续读：游标绑定筛选条件（含时间界），续读时重取会被内核判游标不匹配。 */
function usePaged(tab: RecordTab, filters: Filters, look: Lookups | null, nonce: number): Paged & { loadMore(): void } {
  const bridge = useBridge()
  const [st, setSt] = useState<Paged>(FRESH)
  const gen = useRef(0)
  const nowAt = useRef(0)
  const stRef = useRef(st)
  stRef.current = st
  const busy = useRef(false)
  const kind = TABS.find((t) => t.id === tab)!.kind
  const key = JSON.stringify([tab, filters, nonce])
  const lookRef = useRef(look)
  lookRef.current = look
  const ready = look !== null
  useEffect(() => {
    if (!ready) return undefined
    const id = ++gen.current
    busy.current = false
    nowAt.current = Date.now()
    setSt(FRESH)
    // 被拦：risk.denials 只认 {limit, accountId?}，时间 / 执行方在本地筛（标的同其他页签，由页面统一本地筛）
    const blocked = tab === 'blocked'
    const req = blocked
      ? queryRetry(bridge, 'risk.denials', { limit: BLOCKED_LIMIT, ...(filters.accountId ? { accountId: filters.accountId } : {}) }, () => id === gen.current)
      : queryRetry(bridge, 'records.query', queryParams(kind, filters, nowAt.current, undefined, PAGE), () => id === gen.current)
    req.then(
      (raw) => {
        if (id !== gen.current) return
        const page = blocked ? blockedPage(pageOfBlocked(raw, lookRef.current ?? {}), filters, nowAt.current) : pageOf(tab, raw, lookRef.current ?? {})
        setSt(page.error !== null ? { ...FRESH, phase: 'error', error: new Error(page.error) } : { ...FRESH, rows: page.rows, next: page.next, total: page.total, phase: 'ready' })
      },
      (e: unknown) => { if (id === gen.current) setSt({ ...FRESH, phase: 'error', error: errOf(e) }) },
    )
    return () => { gen.current += 1 }
  }, [bridge, key, ready])
  const loadMore = useCallback(() => {
    const cursor = stRef.current.next
    if (!cursor || busy.current) return
    const id = gen.current
    busy.current = true
    setSt((p) => ({ ...p, more: 'busy', moreError: null }))
    queryRetry(bridge, 'records.query', queryParams(kind, filters, nowAt.current, cursor, PAGE), () => id === gen.current).then(
      (raw) => {
        busy.current = false
        if (id !== gen.current) return
        const page = pageOf(tab, raw, lookRef.current ?? {})
        setSt((p) => (page.error !== null ? { ...p, more: 'idle', moreError: new Error(page.error) } : { ...p, rows: mergeRows(p.rows, page.rows), next: page.next, more: 'idle', moreError: null }))
      },
      (e: unknown) => { busy.current = false; if (id === gen.current) setSt((p) => ({ ...p, more: 'idle', moreError: errOf(e) })) },
    )
  }, [bridge, key])
  return { ...st, loadMore }
}

// ---- 小件 ---------------------------------------------------------------------------------

const Chev = ({ small }: { small?: boolean }) => <svg className={`g5-i${small ? ' g5-i12' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>
const DownloadIcon = () => <svg className="g5-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5v10.5" /><path d="M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19.5h14" /></svg>
const BlockIcon = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></svg>
const TRI_UP = 'M4 .5L7.5 7h-7z'
const TRI_DOWN = 'M4 7.5L.5 1h7z'

function Dir({ side }: { side: 'buy' | 'sell' }) {
  return <span className="g5-dir"><svg viewBox="0 0 8 8" aria-hidden="true"><path d={side === 'buy' ? TRI_UP : TRI_DOWN} /></svg>{side === 'buy' ? tr('买') : tr('卖')}</span>
}

function Who({ actor }: { actor: ActorView }) {
  if (actor.kind === 'unknown') return <span className="g5-actor g5-unknown">{actor.name}</span>
  const node = <Actor kind={actor.kind} name={actor.name} />
  return actor.kind === 'human' ? <span className="g5-me">{node}</span> : node
}

const toneClass = (v: unknown): string => { const t = tone(v); return t === 'up' ? 'g5-up' : t === 'down' ? 'g5-down' : 'g5-t2' }
const Time = ({ ts }: { ts: number }) => <span className="g5-al"><span className="g5-t3">{fmtDay(ts)}</span> {fmtHms(ts)}</span>

function GroupName({ g, venue }: { g: RecGroup; venue: string }) {
  return <span className="g5-gname g5-al">
    <span className="g5-t2">{g.alias}</span><span className="g5-t3">{groupLabel(g)}</span>
    {g.mode === 'paper' ? <span className="g5-papermk" title={tr('纸面账户')} /> : venue ? <VenueIcon venue={venue} label={VENUE_NAME[venue] ?? venue} /> : null}
  </span>
}

function ChainView({ nodes, loading, error }: { nodes: ChainNode[] | undefined; loading: boolean; error: Error | null }) {
  if (error) return <div className="g5-chain"><ErrorText message={error.message} /></div>
  if (loading || !nodes) return <div className="g5-chain" aria-busy="true"><span className="g5-sk" /></div>
  if (!nodes.length) return <div className="g5-chain"><span className="g5-t3">{tr('没有事件记录')}</span></div>
  return <div className="g5-chain" aria-label={tr('事件链')}>
    {nodes.map((n, i) => <span key={n.id} className="g5-cn">
      {i > 0 ? <span className="g5-ln" /> : null}
      <span className="g5-nd" data-tone={n.tone}>{n.label}{n.actor && n.actor.kind !== 'unknown' ? (n.actor.kind === 'agent' ? <span className="g5-actor">{n.actor.name}</span> : <Actor kind={n.actor.kind} name="" />) : null}{n.ts ? <span className="g5-tm">{fmtHms(n.ts)}</span> : null}</span>
    </span>)}
  </div>
}

// ---- 表 ---------------------------------------------------------------------------------

interface TraceState { nodes?: ChainNode[]; error?: Error | null }
interface TableCtx { px(value: unknown, instrumentId: string): string; rule(instrumentId: string): InstrumentPriceRule | undefined; open: string | null; toggle(id: string): void; trace: Record<string, TraceState>; accounts: AccountLite[] }

const ExpandCell = ({ id, ctx }: { id: string; ctx: TableCtx }) => <td className="g5-x">
  <button className="g5-btn g5-btn-ghost g5-btn-icon" data-x aria-label={tr('展开')} aria-expanded={ctx.open === id} onClick={() => ctx.toggle(id)}><Chev /></button>
</td>

function ExpandRow({ id, cols, ctx }: { id: string; cols: number; ctx: TableCtx }) {
  const t = ctx.trace[id]
  return <tr className="g5-xrow"><td colSpan={cols}><ChainView nodes={t?.nodes} loading={!t} error={t?.error ?? null} /></td></tr>
}

function FillsBody({ groups, ctx }: { groups: RecGroup<FillRow>[]; ctx: TableCtx }) {
  return <tbody>{groups.map((g, gi) => <Fragment key={g.accountId}>
    <tr className="g5-grp" data-geo={gi === 0 ? 'records.grp1' : undefined}><td colSpan={7}><GroupName g={g} venue={g.venue} /></td><td className="g5-n"><span className={toneClass(g.total)} data-n="pnl">{fmtMoney(g.total, true)}</span></td><td colSpan={3} /></tr>
    {g.rows.flatMap((r) => {
      const open = ctx.open === r.id
      const rate = r.fee && r.notional ? `${r.liquidity || 'taker'} ${(Number(r.fee) / Number(r.notional) * 100).toFixed(2)}%` : undefined
      return [
        <tr key={r.id} className={`g5-row g5-h40${open ? ' g5-open' : ''}`} data-row={r.id} data-geo={gi === 0 && g.rows[0] === r ? 'records.row1' : undefined}>
          <td><Time ts={r.ts} /></td>
          <td><span className="g5-sym">{r.symbol}</span></td>
          <td><Dir side={r.side} /></td>
          <td className="g5-n" data-n="px">{ctx.px(r.price, r.instrumentId)}</td>
          <td className="g5-n" data-n="qty">{fmtQty(r.size)}</td>
          <td className="g5-n g5-c-ntl" data-n="ntl">{fmtMoney(r.notional)}</td>
          <td className="g5-n" data-n="fee" title={rate}>{fmtMoney(r.fee)}</td>
          <td className="g5-n"><span className={toneClass(r.realizedPnl)} data-n="pnl">{fmtMoney(r.realizedPnl, true)}</span></td>
          <td><Who actor={r.actor} /></td>
          <td className="g5-fill g5-c-src"><span className="g5-s12 g5-t2">{r.source}</span></td>
          <ExpandCell id={r.id} ctx={ctx} />
        </tr>,
        ...(open ? [<ExpandRow key={`${r.id}-x`} id={r.id} cols={11} ctx={ctx} />] : []),
      ]
    })}
  </Fragment>)}</tbody>
}

function OrdersBody({ groups, ctx }: { groups: RecGroup<OrderRow>[]; ctx: TableCtx }) {
  return <tbody>{groups.map((g, gi) => <Fragment key={g.accountId}>
    <tr className="g5-grp" data-geo={gi === 0 ? 'records.grp1' : undefined}><td colSpan={4}><GroupName g={g} venue={g.venue} /></td><td colSpan={7} /></tr>
    {g.rows.flatMap((r) => {
      const open = ctx.open === r.id
      const px = orderPrice(r, ctx.rule(r.instrumentId))
      const st = statusWord(r.status)
      const note = st.tone === 'danger' && r.problem
      return [
        <tr key={r.id} className={`g5-row${note ? '' : ' g5-h40'}${open ? ' g5-open' : ''}`} data-row={r.id} data-geo={gi === 0 && g.rows[0] === r ? 'records.row1' : undefined}>
          <td><Time ts={r.ts} /></td>
          <td><span className="g5-sym">{r.symbol}</span></td>
          <td><span className="g5-t2">{typeWord(r)}</span></td>
          <td><Dir side={r.side} /></td>
          <td className={`g5-n${px.market ? ' g5-t2' : ''}`} data-n="opx">{px.text}</td>
          <td className="g5-n" data-n="oq">{fmtQty(r.size)}</td>
          <td className="g5-n" data-n="of">{fmtQty(r.filledSize)}</td>
          <td><span className={st.tone === 'danger' ? 'g5-danger' : st.tone === 'dim' ? 'g5-t3' : 'g5-tb'}>{st.word}</span>{note ? <span className="g5-l2 g5-ib"><BlockIcon />{r.problem}</span> : null}</td>
          <td><Who actor={r.actor} /></td>
          <td className="g5-fill g5-c-src"><span className="g5-s12 g5-t2">{r.source}</span></td>
          <ExpandCell id={r.id} ctx={ctx} />
        </tr>,
        ...(open ? [<ExpandRow key={`${r.id}-x`} id={r.id} cols={11} ctx={ctx} />] : []),
      ]
    })}
  </Fragment>)}</tbody>
}

function FundingBody({ groups }: { groups: RecGroup<FundingRow>[] }) {
  const miss = (field: string) => <span data-wire="off" title={tr('缺字段 payload.{0}', field)}>—</span>
  return <tbody>{groups.map((g, gi) => <Fragment key={g.accountId}>
    <tr className="g5-grp" data-geo={gi === 0 ? 'records.grp1' : undefined}><td colSpan={4}><GroupName g={g} venue={g.venue} /></td><td className="g5-n"><span className="g5-t2" data-n="fa">{fmtMoney(g.total)}</span></td><td /></tr>
    {g.rows.map((r) => <tr key={r.id} className="g5-row g5-h40" data-row={r.id} data-geo={gi === 0 && g.rows[0] === r ? 'records.row1' : undefined}>
      <td><Time ts={r.ts} /></td>
      <td><span className="g5-sym">{r.symbol}</span></td>
      <td className="g5-n" data-n="fr">{r.rate === null ? miss('rate') : fmtRate(r.rate)}</td>
      <td className="g5-n" data-n="fn">{r.notional === null ? miss('notional') : fmtMoney(r.notional)}</td>
      <td className="g5-n" data-n="fa">{fmtMoney(r.payment, true)}</td>
      <td className="g5-fill" />
    </tr>)}
  </Fragment>)}</tbody>
}

function BlockedBody({ groups }: { groups: RecGroup<BlockedRow>[] }) {
  return <tbody>{groups.map((g, gi) => <Fragment key={g.accountId}>
    <tr className="g5-grp" data-geo={gi === 0 ? 'records.grp1' : undefined}><td colSpan={3}><GroupName g={g} venue={g.venue} /></td><td colSpan={2} /></tr>
    {g.rows.map((r) => <tr key={r.id} className={`g5-row${r.rules.length > 1 ? '' : ' g5-h40'}`} data-row={r.id} data-geo={gi === 0 && g.rows[0] === r ? 'records.row1' : undefined}>
      <td><Time ts={r.ts} /></td>
      <td><span className="g5-sym">{r.symbol}</span></td>
      <td><span className="g5-tb">{r.what}</span></td>
      <td className="g5-fill">{r.rules.length ? r.rules.map((t, i) => <span key={i} className="g5-l2 g5-ib"><BlockIcon />{t}</span>) : <span className="g5-t3">—</span>}</td>
      <td><Who actor={r.actor} /></td>
    </tr>)}
  </Fragment>)}</tbody>
}

const HEADS: Record<RecordTab, Array<[string, string?, string?]>> = {
  fills: [[tr('时间'), 'g5-al'], [tr('标的')], [tr('方向')], [tr('价格'), 'g5-n', 'px'], [tr('数量'), 'g5-n', 'qty'], [tr('名义'), 'g5-n g5-c-ntl', 'ntl'], [tr('手续费'), 'g5-n', 'fee'], [tr('已实现'), 'g5-n', 'pnl'], [tr('执行方')], [tr('来源'), 'g5-fill g5-c-src'], ['']],
  orders: [[tr('时间'), 'g5-al'], [tr('标的')], [tr('类型')], [tr('方向')], [tr('价格 / 触发'), 'g5-n', 'opx'], [tr('数量'), 'g5-n', 'oq'], [tr('已成'), 'g5-n', 'of'], [tr('状态')], [tr('执行方')], [tr('来源'), 'g5-fill g5-c-src'], ['']],
  funding: [[tr('时间'), 'g5-al'], [tr('标的')], [tr('费率'), 'g5-n', 'fr'], [tr('名义'), 'g5-n', 'fn'], [tr('金额'), 'g5-n', 'fa'], ['', 'g5-fill g5-w100']],
  blocked: [[tr('时间'), 'g5-al'], [tr('标的')], [tr('摘要')], [tr('规则'), 'g5-fill'], [tr('执行方')]],
}
const Thead = ({ tab, geo }: { tab: RecordTab; geo?: boolean }) => <thead data-geo={geo ? 'records.thead' : undefined}><tr>{HEADS[tab].map(([t, c, n], i) => <th key={i} className={c} data-n={n}>{t}</th>)}</tr></thead>

const Skeleton = ({ tab }: { tab: RecordTab }) => <div className="g5-tw" aria-busy="true"><table className="g5-tbl">
  <Thead tab={tab} />
  <tbody>{Array.from({ length: 10 }, (_, i) => <tr key={i} className="g5-row g5-h40 g5-skrow">{HEADS[tab].map(([, c], j) => <td key={j} className={c}><span className="g5-sk" /></td>)}</tr>)}</tbody>
</table></div>

// ---- 筛选 -------------------------------------------------------------------------------

const ALL = '__all'

/** 记录页路由里显式带的标的（#/records/BTC）：只有这种显式带入才成为筛选初值；通道里图表页留下的值不自动采用。 */
function routeSymbol(): string | null {
  if (typeof location === 'undefined') return null
  const raw = /^#\/records\/([^/?#]+)/.exec(location.hash)?.[1]
  if (!raw) return null
  try { return decodeURIComponent(raw) } catch { return null }
}

function Filter({ label, current, value, items, onPick, disabled }: { label: string; current: ComponentChildren; value: string; items: Array<{ id: string; label: ComponentChildren; hint?: ComponentChildren }>; onPick(id: string): void; disabled: boolean }) {
  return <Menu label={label} value={value} onValueChange={onPick} items={items} disabled={disabled} className="g5-menu g5-glass" trigger={
    <button className="g5-dd" disabled={disabled} data-filter={label}><span className="g5-k">{label}</span>{current}<Chev small /></button>
  } />
}

// ---- 块 ---------------------------------------------------------------------------------

function RecordsPage({ config }: BlockProps) {
  const bridge = useBridge()
  const wanted = String(config?.tab ?? config?.view ?? '')
  const [tab, setTab] = useState<RecordTab>(TABS.some((t) => t.id === wanted) ? (wanted as RecordTab) : 'fills')
  const [nonce, setNonce] = useState(0)
  const [actorSel, setActorSel] = useState<string | undefined>(undefined)
  const [range, setRange] = useState<RangeId>(DEFAULT_FILTERS.range)
  const [linkAccount, setLinkAccount] = useLink<string>('account')
  const [linkSymbol, setLinkSymbol] = useLink<string>('symbol')
  const [linkRange, setLinkRange] = useLink<{ from: number; to: number }>('timeRange')
  // 标的筛选本地维护：进页缺省「全部」，不自动吃图表页留在联动里的标的。只有路由显式带标的、或进页后用户显式改了联动，才成为筛选值。
  // 裁决（fix-r1 回归）：进页时联动里已有的标的照旧作为筛选初值（总览「进记录」等出口靠它带过去，r5 旅程 Jr5-2 的契约），但一定显示可清除的「已按 X 筛选 ×」，下拉列出全部标的——R-65 的痛点是筛选看不见、清不掉，不是联动本身
  // GQ-37：出口改用显式路由 #/records/<标的>（总览 / 持仓「进记录」），进页不再采用联动里留下的陈旧标的；进页后联动被他处改变仍跟随
  const [symbolFilter, setSymbolFilter] = useState<string | null>(() => routeSymbol())
  const firstLink = useRef(true)
  const lastLink = useRef(linkSymbol)
  useEffect(() => {
    const prev = lastLink.current
    lastLink.current = linkSymbol
    if (firstLink.current) { firstLink.current = false; return }
    if (linkSymbol === prev) return
    setSymbolFilter(linkSymbol ?? null)
  }, [linkSymbol])
  const wroteRange = useRef<string>('')
  const external = linkRange && JSON.stringify(linkRange) !== wroteRange.current ? rangeOfLink(linkRange) : null
  const filters: Filters = useMemo(() => ({
    range: external ? external.range : range,
    ...(external?.custom ? { custom: external.custom } : {}),
    // 标的筛选仍交给内核按页取（分页下本地筛会漏行）；下拉选项另由已取到的行加当前筛选值拼出
    ...(linkAccount ? { accountId: linkAccount } : {}), ...(symbolFilter ? { instrumentId: symbolFilter } : {}), ...actorFilters(actorSel),
  }), [range, external?.custom?.from, external?.custom?.to, linkAccount, symbolFilter, actorSel])

  const offline = useOffline(() => setNonce((n) => n + 1))
  const offSince = useRef(0)
  if (offline && !offSince.current) offSince.current = Date.now()
  if (!offline) offSince.current = 0

  const look = useLookups(nonce)
  const fills = usePaged('fills', filters, look, nonce)
  const orders = usePaged('orders', filters, look, nonce)
  const funding = usePaged('funding', filters, look, nonce)
  const blocked = usePaged('blocked', filters, look, nonce)
  // 标的是本地筛选：服务端仍取全量（账户 / 时间 / 执行方），下拉选项才不会跟着标的筛选收窄。
  const filteredRows = useMemo(() => ({
    fills: applySymbolFilter(fills.rows, symbolFilter),
    orders: applySymbolFilter(orders.rows, symbolFilter),
    funding: applySymbolFilter(funding.rows, symbolFilter),
    blocked: applySymbolFilter(blocked.rows, symbolFilter),
  }), [fills.rows, orders.rows, funding.rows, blocked.rows, symbolFilter])
  const filtered = {
    fills: { ...fills, rows: filteredRows.fills },
    orders: { ...orders, rows: filteredRows.orders },
    funding: { ...funding, rows: filteredRows.funding },
    blocked: { ...blocked, rows: filteredRows.blocked },
  }
  const paged = filtered[tab]
  const accounts = look?.accounts ?? []

  const [open, setOpen] = useState<string | null>(null)
  const [trace, setTrace] = useState<Record<string, TraceState>>({})
  useEffect(() => { setOpen(null) }, [tab, JSON.stringify(filters), symbolFilter])
  const toggle = useCallback((id: string) => {
    setOpen((cur) => (cur === id ? null : id))
    const row = paged.rows.find((r) => r.id === id)
    const orderId = row?.kind === 'fill' ? row.orderId : row?.kind === 'order' ? row.id : ''
    if (!orderId || trace[id]) return
    queryRetry<unknown>(bridge, 'ledger.trace', { orderId }).then(
      (raw) => setTrace((t) => ({ ...t, [id]: { nodes: buildRecordChain(Array.isArray(raw) ? raw as never[] : [], look?.names ?? {}) } })),
      (e: unknown) => setTrace((t) => ({ ...t, [id]: { error: errOf(e) } })),
    )
  }, [bridge, paged.rows, trace, look])
  const prices = usePriceDisplay()
  // 品种目录没到时按 5 位有效数字截（与下单票退回规则同），保证成交价与总览 / 图表写法一致（release-r1 P1-11）。
  // ponytail: 记录页清单 inputs.queries 未声明 market.instruments（pages/records.tsx，超出本轮范围），目录永远取不到；补上后此退回只在目录未到时生效。
  const rule = (id: string): InstrumentPriceRule => prices.rule(id) ?? { sigFigs: 5 }
  const ctx: TableCtx = { open, toggle, trace, accounts, px: (value, id) => fmtPriceBy(value, rule(id)), rule }

  const scroller = useRef<HTMLDivElement | null>(null)
  const maybeMore = useCallback(() => {
    const el = scroller.current
    if (!el || !paged.next || paged.more === 'busy' || paged.moreError || offline) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) paged.loadMore()
  }, [paged.next, paged.more, paged.moreError, paged.loadMore, offline])
  useEffect(() => { maybeMore() }, [paged.rows.length, paged.next, tab, symbolFilter])
  // 本地标的筛选可能把当前页全滤掉：还有下一页就主动续读，避免把「这一页没有」当成「整段时间没有」。
  useEffect(() => {
    if (!symbolFilter || paged.phase !== 'ready' || paged.rows.length > 0 || !paged.next || paged.more === 'busy' || paged.moreError || offline) return
    paged.loadMore()
  }, [symbolFilter, paged.phase, paged.rows.length, paged.next, paged.more, paged.moreError, paged.loadMore, offline])

  const groups = useMemo(() => groupRecords(paged.rows, accounts), [paged.rows, accounts])
  // 下拉选项由三个页签的全量行生成（不受当前标的筛选影响）；路由带来的标的即使还没出现在行里也保留，便于显示与清除。
  const symbols = useMemo(() => {
    const ids = recordSymbols([...fills.rows, ...orders.rows, ...funding.rows])
    if (symbolFilter && !ids.includes(symbolFilter)) ids.push(symbolFilter)
    return ids
  }, [fills.rows, orders.rows, funding.rows, symbolFilter])
  const symbolName = (id: string): string => id.slice(id.indexOf(':') + 1)

  const setLink = <T,>(set: (v: T) => void, v: T) => { try { set(v) } catch { /* 清单没给联动写权限时只在本页筛 */ } }
  const pickSymbol = (id: string) => {
    const next = id === ALL ? null : id
    setSymbolFilter(next)
    setLink(setLinkSymbol, next === null ? (undefined as never) : next)
    // 清掉筛选后路由也回到 #/records，刷新不再带回来
    if (next === null && routeSymbol() !== null) { try { history.replaceState(null, '', '#/records') } catch { /* 无 history */ } }
  }
  const pickRange = (id: string) => {
    const r = id as RangeId
    setRange(r)
    const b = { from: timeBounds({ range: r }, Date.now()).sinceTs ?? 0, to: Date.now() }
    wroteRange.current = JSON.stringify(b)
    setLink(setLinkRange, b)
  }
  const rangeLabel = external ? tr('自定义') : RANGES.find((r) => r.id === range)?.label ?? ''
  const acct = accounts.find((a) => a.accountId === linkAccount)

  const countOf = (p: Paged): string | undefined => {
    if (p.phase !== 'ready') return undefined
    const n = p.total !== null ? p.total : `${p.rows.length}${p.next || (p === filtered.blocked && blocked.rows.length >= BLOCKED_LIMIT) ? '+' : ''}`
    return `${n}`
  }
  const tabs = <div className="g5-tabs g5-htabs" role="tablist" aria-label={tr('记录')}>
    {TABS.map((t, i) => {
      const c = countOf(filtered[t.id])
      return <button key={t.id} className="g5-tab" role="tab" data-tab={t.id} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
        {i === 0 ? <span className="g5-al">{t.label}</span> : t.label}{c !== undefined ? <span className="g5-c">{c}</span> : null}
      </button>
    })}
  </div>

  const loading = paged.phase === 'loading'
  // 导出的是整段时间的账本，不看当前页签有没有行；账本在范围内为空时由 doExport 提示
  const exportDisabled = offline || loading || paged.phase === 'error'
  const [exporting, setExporting] = useState(false)
  const doExport = async () => {
    setExporting(true)
    try {
      const b = timeBounds(filters, Date.now())
      const first = await queryRetry<Array<{ seq: number }>>(bridge, 'ledger.query', { ...(b.sinceTs !== undefined ? { sinceTs: b.sinceTs } : {}), order: 'asc', limit: 1 })
      const last = b.untilTs !== undefined ? await queryRetry<Array<{ seq: number }>>(bridge, 'ledger.query', { untilTs: b.untilTs, order: 'desc', limit: 1 }) : undefined
      const params = exportParams(first[0], last?.[0])
      if (!params) { toast.err(tr('这段时间没有可导出的记录')); return }
      const r = await runCommand(bridge, 'ledger.export', { ...params, inline: true })
      const dir = r.ok && r.value && typeof (r.value as { dir?: unknown }).dir === 'string' ? (r.value as { dir: string }).dir : ''
      const bill = r.ok ? billDownload(r.value) : null
      if (bill) saveText(bill.name, bill.text)
      // 导出是签名账本的 seq 区间（不能按标的 / 账户裁剪）：有筛选生效时明说导出的是全部
      const narrowed = !!(symbolFilter || linkAccount || actorSel)
      if (r.ok) toast.ok(narrowed ? (bill ? tr('已下载账单（含全部标的与账户）') : tr('已导出（含全部标的与账户）')) : bill ? (dir ? tr('已下载账单；审计原件在 {0}', dir) : tr('已下载账单')) : dir ? tr('已导出到 {0}', dir) : tr('已导出')); else if (!r.cancelled) toast.err(r.message)
    } catch (e) { toast.err(errOf(e).message) } finally { setExporting(false) }
  }

  const totals = tab === 'fills' ? headTotals(groups, 'fee') : tab === 'funding' ? headTotals(groups, 'total') : null
  const partial = loadedNote(paged.rows.length, paged.total, !!paged.next)
  const readout = totals && (totals.live !== null || totals.paper !== null) ? <span className="g5-rd" title={partial}>
    <span className="g5-k">{tab === 'fills' ? tr('手续费') : tr('资金费')}</span>
    {totals.live !== null ? <><span className="g5-k">{tr('实盘')}</span><span className="g5-v" data-redge={totals.paper === null ? 'fee' : undefined}>{fmtMoney(totals.live)}</span></> : null}
    {totals.paper !== null ? <><span className="g5-k">{tr('纸面')}</span><span className="g5-v" data-redge="fee">{fmtMoney(totals.paper)}</span></> : null}
  </span> : null

  const failed = paged.phase === 'error' && paged.error
  const head = <header className="g5-hd" data-geo="records.head">{tabs}
    {!failed ? <div className="g5-r g5-gh">
      {offline ? <PausedFor since={offSince.current} /> : readout}
      <button className="g5-btn g5-btn-ghost" data-act="export" disabled={exportDisabled || exporting} onClick={doExport}><DownloadIcon />{tr('导出全部')}</button>
    </div> : null}
  </header>

  if (failed) return <Card head={head} className="g5-grow" data-page="records" data-g5-page="records" data-geo="records.card"><div className="g5-pstate">{wireState(paged.error) === 'off'
    ? <Unwired message={paged.error!.message} />
    : <><span className="g5-al">{tr('读取失败')}</span><ErrorText bare message={paged.error!.message} /></>}</div></Card>

  const filterDisabled = offline || loading
  const body = <>
    <div className="g5-fbar" data-geo="records.fbar">
      <Filter label={tr('账户')} disabled={filterDisabled} value={linkAccount ?? ALL} onPick={(id) => setLink(setLinkAccount, id === ALL ? (undefined as never) : id)}
        current={acct ? <>{acct.alias}{acct.mode === 'paper' ? <span className="g5-papermk" title={tr('纸面账户')} /> : acct.venue ? <VenueIcon venue={acct.venue} label={VENUE_NAME[acct.venue] ?? acct.venue} /> : null}</> : linkAccount ? linkAccount : tr('全部')}
        items={[{ id: ALL, label: tr('全部') }, ...accounts.map((a) => ({ id: a.accountId, label: <>{a.alias}<span className="g5-s12 g5-t3"> {a.mode === 'paper' ? tr('纸面') : tr('实盘')}</span></> }))]} />
      <Filter label={tr('标的')} disabled={filterDisabled} value={symbolFilter ?? ALL} onPick={pickSymbol}
        current={symbolFilter ? symbolName(symbolFilter) : tr('全部')} items={[{ id: ALL, label: tr('全部标的') }, ...symbols.map((s) => ({ id: s, label: symbolName(s) }))]} />
      <Filter label={tr('执行方')} disabled={filterDisabled} value={actorSel ?? ALL} onPick={(id) => setActorSel(id === ALL ? undefined : id)}
        current={[...ACTOR_OPTIONS, ...(look?.agents ?? [])].find((o) => o.id === actorSel)?.label ?? tr('全部')} items={[{ id: ALL, label: tr('全部') }, ...ACTOR_OPTIONS, ...(look?.agents ?? [])]} />
      <Filter label={tr('时间')} disabled={filterDisabled} value={external ? '' : range} onPick={pickRange} current={rangeLabel} items={RANGES.map((r) => ({ id: r.id, label: r.label }))} />
    </div>
    {loading ? <Skeleton tab={tab} />
      : paged.rows.length === 0 ? <Empty message={TAB_EMPTY[tab]} />
        : <div className="g5-tw g5-scroll" ref={scroller} data-snap data-tab={tab} onScroll={maybeMore}>
          <table className="g5-tbl">
            <Thead tab={tab} geo />
            {tab === 'fills' ? <FillsBody groups={groups as RecGroup<FillRow>[]} ctx={ctx} /> : tab === 'orders' ? <OrdersBody groups={groups as RecGroup<OrderRow>[]} ctx={ctx} /> : tab === 'blocked' ? <BlockedBody groups={groups as RecGroup<BlockedRow>[]} /> : <FundingBody groups={groups as RecGroup<FundingRow>[]} />}
            {paged.moreError ? <tbody><tr className="g5-more"><td colSpan={11}><ErrorText message={paged.moreError.message} /> <button className="g5-btn g5-btn-ghost g5-lnk" onClick={paged.loadMore}>{tr('重试')}</button></td></tr></tbody> : null}
          </table>
        </div>}
  </>
  return <Card head={head} className="g5-grow" data-page="records" data-g5-page="records" data-geo="records.card">{offline ? <Offline>{body}</Offline> : body}</Card>
}

const fmtClock = (ms: number): string => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
/** 离线卡头的「已暂停更新 · mm:ss」：只有离线时才挂，避免整页每秒重绘。 */
function PausedFor({ since }: { since: number }) {
  const now = useNow(1000)
  return <span className="g5-s12 g5-t3">{tr('已暂停更新 · ')}{fmtClock(Math.max(0, now - since))}</span>
}

export { RecordsPage }
