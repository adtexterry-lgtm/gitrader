// SPDX-License-Identifier: CPAL-1.0
// 总览 · 持仓卡（r5）：持仓 / 挂单两页签，按账户分组（实盘在上、纸面在下，小计不跨组相加），每行常显 平仓 / 止损 / 展开。
// 数据与命令全部复用 blocks-default（useAccountsData / closePosition / placeStop / cancelOrder），内核收到的命令与 r4 相同：
// position.close（平仓 / 部分平仓）、order.place（stop_market + reduceOnly 止损）、order.cancel（撤旧止损 / 撤单）。改止损不原子：先挂新单、再撤旧单。
// 内核离线期间数字照旧可看、去涨跌色（卡降灰），行内动作禁用。命令错误原文原样显示。
import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useBridge, useLink, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { F, toast } from '@gitrader/workbench/ui'
import { cancelOrder, closePosition, placeStop } from '../../../blocks-default/src/actions'
import { Q, T } from '../../../blocks-default/src/api'
import { queryRetry, useAccountsData, useFeedState, useNow, useOffline, usePositionLedger, useRes } from '../../../blocks-default/src/hooks'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import { actorNames, normalizeProposals } from '../../../blocks-default/src/model-activity'
import {
  buildPositionChain, checkStopPrice, groupRows, isNew, liqDistancePct, nearLiq, partialSize, pendingOf, roePct, stopIntent,
  type AccountLite, type PositionRow,
} from '../../../blocks-default/src/model-positions'
import { fmtLoose, isRec, listOf, str, symbolOf, toNum } from '../../../blocks-default/src/util'
import { Amount, Card, VenueIcon } from '../kit'
import { usePriceDisplay } from '../../../blocks-default/src/price-display'
import { MarkFreshness } from '../../../blocks-default/src/feed'
import { Head, Ic, Msg, OriginActor, Sk, amountTone, cardClass, chartHash, go, stateAttr, useOfflineClock } from './ovkit'
import './overview.css'
import { recordsHash } from '../model-records'
import { t as tr } from '@gitrader/workbench/i18n'

type Tone = 'up' | 'down' | 'neutral'
type RowState = 'armed' | 'closing' | 'closed' | 'stop-updating'
type Tab = 'pos' | 'ord'
/** 平掉的行「已平」至少停留这么久，且持仓事件到了才收起。 */
const CLOSED_HOLD_MS = 1200
/** 「已平」最多停这么久：持仓事件一直没把行拿走就撤掉「已平」，回到正常行。 */
const CLOSED_MAX_MS = 5000

const pct1 = (v: number) => `${v.toFixed(1)}%`
const clean = (t: string) => t.replace(/,/g, '').trim()
const sideText = (row: PositionRow) => `${F.posSideWord(row.side)}${row.leverage ? ` ${row.leverage}×` : ''}`

// ---- 挂单（r4 的 OrderLite 不带数量与价格，这里按原始记录规整一份只给挂单页签用） ---------------------------------------------------------------

export interface OrderRow {
  accountId: string; orderId: string; instrumentId: string; symbol: string; side: string; type: string; reduceOnly: boolean
  size: number | null; price: number | null; triggerPrice: number | null; origin: PositionRow['executor']; status: string; createdAt: number
}
const OPEN_ORDER = new Set(['new', 'submitted', 'open', 'untriggered', 'partially_filled'])
export function openOrders(raw: unknown): OrderRow[] {
  return listOf(raw, 'orders').filter(isRec).flatMap((o) => {
    const accountId = str(o.accountId)
    const instrumentId = str(o.instrumentId)
    if (!accountId || !instrumentId || !OPEN_ORDER.has(String(o.status))) return []
    return [{
      accountId, orderId: str(o.orderId) ?? '', instrumentId, symbol: symbolOf(instrumentId), side: str(o.side) ?? '', type: str(o.type) ?? '', reduceOnly: o.reduceOnly === true,
      size: toNum(o.size), price: toNum(o.price), triggerPrice: toNum(o.triggerPrice), origin: isRec(o.origin) ? (o.origin as unknown as PositionRow['executor']) : null,
      status: str(o.status) ?? '', createdAt: toNum(o.createdAt) ?? 0,
    }]
  })
}
const TYPE_TEXT: Record<string, string> = { limit: tr('限价'), market: tr('市价'), stop_market: tr('止损'), stop_limit: tr('止损限价'), take_profit_market: tr('止盈'), take_profit_limit: tr('止盈限价') }
export const orderTypeText = (o: Pick<OrderRow, 'type' | 'reduceOnly'>): string => `${TYPE_TEXT[o.type] ?? o.type}${o.reduceOnly ? tr('　只减仓') : ''}`

function useOrders(accounts: readonly AccountLite[]): { orders: OrderRow[]; error: unknown; loading: boolean; reload(): void } {
  const bridge = useBridge()
  const [st, setSt] = useState<{ orders: OrderRow[]; error: unknown; loading: boolean }>({ orders: [], error: null, loading: true })
  const [n, setN] = useState(0)
  const key = accounts.map((a) => a.accountId).join(',')
  useEffect(() => {
    if (!key) { setSt({ orders: [], error: null, loading: false }); return undefined }
    let dead = false
    Promise.all(accounts.map((a) => queryRetry(bridge, Q.orders, { accountId: a.accountId, limit: 100 }, () => !dead).then(openOrders))).then(
      (lists) => { if (!dead) setSt({ orders: lists.flat(), error: null, loading: false }) },
      (error: unknown) => { if (!dead) setSt((s) => ({ ...s, error, loading: false })) },
    )
    return () => { dead = true }
  }, [bridge, key, n])
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (t.current) clearTimeout(t.current) }, [])
  useSubscribe('account.orders', () => { if (t.current) clearTimeout(t.current); t.current = setTimeout(() => setN((x) => x + 1), 400) })
  return { ...st, reload: () => setN((x) => x + 1) }
}

// ---- 事件链 ----------------------------------------------------------------------------------------------------------------------------------

function Chain({ row, names }: { row: PositionRow; names: Record<string, string> }) {
  const prices = usePriceDisplay()
  const led = usePositionLedger(row)
  if (led.phase === 'loading') return <div className="g5o-chain" aria-busy="true"><Sk w={160} /><Sk w={200} /><Sk w={120} /></div>
  if (led.phase === 'error') return <div className="g5o-chain g5-msg" title={led.error?.message}>{led.error?.message}</div>
  const steps = buildPositionChain(row, led.entries, led.proposals)
  return <ol className="g5o-chain" aria-label={tr('事件链')}>
    {steps.map((s) => <li key={s.id} data-kind={s.kind}>
      <span className="g5-t3 g5o-tm">{s.ts ? F.hms(s.ts) : ''}</span>
      {s.origin ? <OriginActor origin={s.origin} names={names} /> : null}
      {s.kind === 'origin' ? null : <span className="g5-tb">{prices.copy(s.title, row.instrumentId)}</span>}
      {s.detail ? <span className="g5-t3">{prices.copy(s.detail, row.instrumentId)}</span> : null}
    </li>)}
  </ol>
}

// ---- 展开区：明细 · 事件链 · 部分平仓与止损表单 ------------------------------------------------------------------------------------------------

interface Ctl {
  offline: boolean
  state: RowState | null
  err: string | null
  focusStop: boolean
  onClose(size?: string): Promise<unknown>
  onSaveStop(text: string): Promise<boolean>
  onClearStop(): void
  onLocalErr(msg: string | null): void
  onRecords(): void
}

function Detail({ row, names, ctl }: { row: PositionRow; names: Record<string, string>; ctl: Ctl }) {
  const prices = usePriceDisplay()
  const full = String(row.position.size ?? row.size)
  const [qty, setQty] = useState(full)
  const [pick, setPick] = useState<number | null>(100)
  const [stop, setStop] = useState('')
  const [armed, setArmed] = useState(false)
  const [closeErr, setCloseErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const stopRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { if (ctl.focusStop) stopRef.current?.focus() }, [ctl.focusStop])
  const q = clean(qty)
  const qtyOk = /^\d+(\.\d+)?$/.test(q) && Number(q) > 0 && Number(q) <= Math.abs(row.size)
  const chk = stop.trim() === '' ? null : checkStopPrice(row, stop)
  const stopBusy = ctl.state === 'stop-updating'
  const noPct = !partialSize(row, 25) || !partialSize(row, 50)
  const margin = row.leverage ? row.notional / row.leverage : null
  const save = async () => { if (chk && chk.ok && !stopBusy && !ctl.offline && (await ctl.onSaveStop(stop))) setStop('') }
  const confirmClose = async () => {
    setBusy(true); setCloseErr(null)
    try { await ctl.onClose(q === full ? undefined : q); setArmed(false) } catch (e) { setCloseErr((e as Error).message) } finally { setBusy(false) }
  }
  let hint: string
  if (ctl.offline) hint = tr('离线')
  else if (chk && !chk.ok) hint = chk.message
  else if (chk && chk.ok && row.markPrice !== null) hint = tr('距标记价 {0}', pct1((Math.abs(row.markPrice - Number(chk.price)) / row.markPrice) * 100))
  else hint = tr('距标记价')
  return <div className="g5o-detail" data-g5-detail={row.key}>
    <dl className="g5o-kv">
      <div><dt>{tr('账户')}</dt><dd>{row.accountAlias} {row.mode === 'live' ? tr('实盘') : tr('纸面')}</dd></div>
      <div><dt>{tr('开仓价')}</dt><dd>{prices.price(row.entryPrice, row.instrumentId)}</dd></div>
      <div><dt>{tr('名义')}</dt><dd>{F.usd(row.notional)}</dd></div>
      {margin !== null ? <div><dt>{tr('保证金')}</dt><dd>{F.usd(margin)}</dd></div> : null}
      {row.funding !== null ? <div><dt>{tr('资金费')}</dt><dd><Amount value={F.signed(row.funding)} tone={amountTone(row.funding, ctl.offline)} /></dd></div> : null}
      {row.openedAt !== null ? <div><dt>{tr('开仓')}</dt><dd>{F.hm(row.openedAt)}</dd></div> : null}
    </dl>
    <Chain row={row} names={names} />
    <div className="g5o-form">
      <div className="g5o-frm">
        <span className="g5-k">{tr('平仓数量')}</span>
        <label className={`g5-inp g5-s${qtyOk ? '' : ' g5-bad'}`}><input aria-label={tr('平仓数量')} value={qty} inputMode="decimal" onInput={(e) => { setQty((e.target as HTMLInputElement).value); setPick(null); setArmed(false) }} /></label>
        <span className="g5o-pct">{[25, 50, 100].map((p) => <button key={p} type="button" className="g5-chip" aria-pressed={pick === p} data-pct={p} disabled={!partialSize(row, p)}
          onClick={() => { const v = partialSize(row, p); if (v) { setQty(v); setPick(p); setArmed(false) } }}>{p === 100 ? tr('全部') : `${p}%`}</button>)}</span>
      </div>
      <div className="g5o-frm">
        <span className="g5-k" />
        {armed
          ? <span className="g5o-arm"><button type="button" className="g5-btn g5-btn-ghost" data-act="arm-cancel" onClick={() => { setArmed(false); setCloseErr(null) }}>{tr('取消')}</button><button type="button" className="g5-btn g5-btn-kill" data-act="pos-partial-confirm" disabled={busy || ctl.offline} onClick={() => { void confirmClose() }}>{busy ? tr('平仓中…') : tr('确认平仓')}</button></span>
          : <button type="button" className="g5-btn g5-btn-fill" data-act="pos-partial" disabled={ctl.offline || !qtyOk} onClick={() => setArmed(true)}>{tr('按市价平仓')}</button>}
        {noPct ? <span className="g5-s12 g5-t3" data-pct-none="">{tr('无法按比例平仓')}</span> : null}
      </div>
      {closeErr ? <div className="g5o-ferr" role="alert" title={closeErr}>{closeErr}</div> : null}
      <div className="g5o-frm">
        <span className="g5-k">{tr('止损触发价')}</span>
        <label className={`g5-inp g5-s${chk && !chk.ok ? ' g5-bad' : ''}`}><input ref={stopRef} aria-label={tr('止损触发价')} placeholder={tr('触发价')} value={stop} inputMode="decimal"
          onInput={(e) => { setStop((e.target as HTMLInputElement).value); ctl.onLocalErr(null) }} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} /></label>
        <span className="g5-s12 g5-t3" data-bad={chk && !chk.ok ? '' : undefined}>{hint}</span>
      </div>
      <div className="g5o-frm">
        <span className="g5-k" />
        <button type="button" className="g5-btn g5-btn-fill" data-act="stop-save" disabled={ctl.offline || stopBusy || !chk || !chk.ok} onClick={() => { void save() }}>{stopBusy ? tr('更新中…') : tr('保存止损')}</button>
        {row.stop ? <button type="button" className="g5-btn g5-btn-ghost" data-act="stop-clear" disabled={ctl.offline || stopBusy} onClick={ctl.onClearStop}>{tr('清除')}</button> : null}
        <button type="button" className="g5-btn g5-btn-ghost g5-lnk" data-act="to-records" onClick={ctl.onRecords}>{tr('全部记录')}</button>
      </div>
      {ctl.err ? <div className="g5o-ferr" role="alert" title={ctl.err}>{ctl.err}</div> : null}
    </div>
  </div>
}

// ---- 持仓行 ----------------------------------------------------------------------------------------------------------------------------------

function ArmedClose({ row, busy, err, onCancel, onConfirm }: { row: PositionRow; busy: boolean; err: string | null; onCancel(): void; onConfirm(): void }) {
  return <tr className="g5o-armrow" data-armed-for={row.key}><td colSpan={9}>
    <div className="g5-armed" role="group" aria-label={tr('平掉 {0}', row.symbol)}>
      <span className="g5-what g5-al">{tr('市价平掉 {0} {1}{2}', fmtLoose(row.size), row.symbol, row.notional ? tr('，约 {0}', F.usd(row.notional)) : '')}</span>
      <button type="button" className="g5-btn g5-btn-ghost" data-act="arm-cancel" disabled={busy} onClick={onCancel}>{tr('取消')}</button>
      <button type="button" className="g5-btn g5-btn-kill" data-act="pos-close-confirm" disabled={busy} onClick={onConfirm}>{busy ? tr('平仓中…') : tr('确认平仓')}</button>
    </div>
    {err ? <div className="g5o-ferr" role="alert" title={err}>{err}</div> : null}
  </td></tr>
}

function PosRow({ row, open, names, tone, now, pend, ctl, prices, onToggle, onStop, onChart, onArm }: {
  prices: ReturnType<typeof usePriceDisplay>; row: PositionRow; open: boolean; names: Record<string, string>; tone(v: number): Tone; now: number; pend: string | null; ctl: Ctl
  onToggle(): void; onStop(): void; onChart(): void; onArm(): void
}) {
  const roe = roePct(row)
  const dist = liqDistancePct(row)
  const st = ctl.state
  const armed = st === 'armed' || st === 'closing'
  return <>
    <tr className={`g5-row${row.mode !== 'live' ? ' g5-paper' : ''}`} data-row={row.key} data-state={st ?? undefined} aria-expanded={open}>
      <td><span className="g5-sl g5-al">
        <button type="button" className="g5-sym g5o-lnk" data-act="to-chart" title={tr('打开图表')} onClick={onChart}>{row.symbol}</button>
        <span className="g5-s12 g5-t2">{sideText(row)}</span>
        {isNew(row, now) ? <span className="g5-flag" data-flag="new">{tr('新')}</span> : null}
        {nearLiq(row) ? <span className="g5-flag" data-flag="near-liq">{tr('近强平')}</span> : null}
      </span></td>
      <td className="g5-n" data-n="qty">{fmtLoose(row.size)}</td>
      <td className="g5-n" data-n="entry">{prices.price(row.entryPrice, row.instrumentId)}</td>
      <td className="g5-n" data-n="mark">{prices.price(row.markPrice, row.instrumentId)}<MarkFreshness markTs={row.position.markTs} /></td>
      <td className="g5-n"><span data-n="upnl"><Amount value={F.signed(row.unrealizedPnl)} tone={tone(row.unrealizedPnl)} /></span>{roe !== null ? <span className="g5-l2" data-n="upnl">ROE {F.signedPct(roe)}</span> : null}</td>
      <td className="g5-n">{row.liquidationPrice === null ? <span data-n="liq">{tr('无')}</span> : <><span data-n="liq" title={row.estimated ? tr('近似值（纸面账户）') : undefined}>{prices.price(row.liquidationPrice, row.instrumentId)}</span>{dist !== null ? <span className="g5-l2" data-n="liq">{tr('距 ')}{pct1(dist)}</span> : null}</>}</td>
      <td className={`g5-n${row.stop?.triggerPrice == null ? ' g5-t3' : ''}`} data-n="sl">{st === 'stop-updating' ? tr('更新中…') : row.stop?.triggerPrice != null ? prices.price(row.stop.triggerPrice, row.instrumentId) : tr('未设')}</td>
      <td className="g5-fill"><span className="g5-who"><OriginActor origin={row.executor} names={names} />{pend ? <button type="button" className="g5-flag" data-p="1" data-act="pos-goto-pending" onClick={() => window.dispatchEvent(new CustomEvent('gitrader:focus', { detail: { card: 'pending', proposalId: pend } }))}>{tr('有待批')}</button> : null}</span></td>
      <td className="g5-n">{st === 'closed' ? <span className="g5-t3" data-done="">{tr('已平')}</span> : <span className="g5-acts">
        {ctl.offline ? <span className="g5-s12 g5-t3">{tr('离线')}</span> : null}
        <button type="button" className="g5-btn g5-btn-ghost" data-act="pos-close" disabled={ctl.offline || st === 'stop-updating' || armed} onClick={onArm}>{tr('平仓')}</button>
        <button type="button" className="g5-btn g5-btn-ghost" data-act="pos-stop" disabled={ctl.offline || armed} onClick={onStop}>{tr('止损')}</button>
        <button type="button" className="g5-btn g5-btn-ghost g5-btn-icon" data-act="pos-expand" aria-expanded={open} aria-label={open ? tr('收起') : tr('展开')} onClick={onToggle}><Ic n="chev" style={open ? { transform: 'rotate(180deg)' } : undefined} /></button>
      </span>}</td>
    </tr>
    {open ? <tr className="g5-xrow g5o-xrow"><td colSpan={9}><Detail row={row} names={names} ctl={ctl} /></td></tr> : null}
  </>
}

function GroupRow({ alias, mode, venue, n, subtotal, tone }: { alias: string; mode: string; venue: string; n: number; subtotal: number; tone: Tone }) {
  return <tr className="g5-grp" data-acct={alias}>
    <td colSpan={4}><span className="g5-gname g5-al">
      <span className="g5-t2">{alias}</span><span className="g5-t3">{mode === 'live' ? tr('实盘') : tr('纸面')} {n}</span>
      {mode === 'live' ? <VenueIcon venue={venue} label={VENUE_NAME[venue] ?? venue} /> : <span className="g5-papermk" title={tr('纸面账户')} />}
    </span></td>
    <td className="g5-n"><span data-n="upnl"><Amount value={F.signed(subtotal)} tone={tone} /></span></td><td colSpan={4} />
  </tr>
}

const POS_HEAD = <thead><tr>
  <th className="g5-al">{tr('标的')}</th><th className="g5-n" data-n="qty">{tr('数量')}</th><th className="g5-n" data-n="entry">{tr('开仓价')}</th><th className="g5-n" data-n="mark">{tr('标记价')}</th>
  <th className="g5-n" data-n="upnl">{tr('未实现')}</th><th className="g5-n" data-n="liq">{tr('强平价')}</th><th className="g5-n" data-n="sl">{tr('止损')}</th><th className="g5-fill">{tr('开仓方')}</th><th />
</tr></thead>

function SkelTable() {
  return <div className="g5-tw" aria-busy="true" aria-label={tr('加载中')}><table className="g5-tbl">{POS_HEAD}<tbody>
    {[0, 1, 2, 3].map((i) => <tr key={i} className="g5-row"><td><Sk w={64} /></td><td className="g5-n"><Sk w={32} /></td><td className="g5-n"><Sk w={56} /></td><td className="g5-n"><Sk w={56} /></td><td className="g5-n"><Sk w={48} /></td><td className="g5-n"><Sk w={56} /></td><td className="g5-n"><Sk w={56} /></td><td className="g5-fill"><Sk w={88} /></td><td><Sk w={96} /></td></tr>)}
  </tbody></table></div>
}

// ---- 挂单页签 --------------------------------------------------------------------------------------------------------------------------------

function OrdersTable({ orders, accounts, names, offline, onCancel, busy, err }: {
  orders: OrderRow[]; accounts: readonly AccountLite[]; names: Record<string, string>; offline: boolean; onCancel(o: OrderRow): void; busy: string | null; err: string | null
}) {
  const prices = usePriceDisplay()
  const groups = accounts.map((a) => ({ a, rows: orders.filter((o) => o.accountId === a.accountId) })).filter((g) => g.rows.length)
  groups.sort((x, y) => Number(y.a.mode === 'live') - Number(x.a.mode === 'live'))
  if (!groups.length) return <Msg>{tr('当前没有挂单')}</Msg>
  return <div className="g5-tw">
    <table className="g5-tbl" data-tab="orders"><thead><tr>
      <th className="g5-al">{tr('标的')}</th><th>{tr('类型')}</th><th>{tr('方向')}</th><th className="g5-n" data-n="oq">{tr('数量')}</th><th className="g5-n" data-n="op">{tr('价格')}</th><th className="g5-fill">{tr('下单方')}</th><th />
    </tr></thead><tbody>
      {groups.map((g) => [
        <tr key={`g${g.a.accountId}`} className="g5-grp"><td colSpan={3}><span className="g5-gname g5-al"><span className="g5-t2">{g.a.alias}</span><span className="g5-t3">{g.a.mode === 'live' ? tr('实盘') : tr('纸面')} {g.rows.length}</span>
          {g.a.mode === 'live' ? <VenueIcon venue={g.a.venue} label={VENUE_NAME[g.a.venue] ?? g.a.venue} /> : <span className="g5-papermk" title={tr('纸面账户')} />}</span></td><td colSpan={4} /></tr>,
        ...g.rows.map((o) => <tr key={o.orderId || `${o.accountId}${o.createdAt}`} className={`g5-row g5-h40${g.a.mode !== 'live' ? ' g5-paper' : ''}`} data-order={o.orderId}>
          <td><span className="g5-sym g5-al">{o.symbol}</span></td><td className="g5-t2">{orderTypeText(o)}</td><td>{o.side === 'buy' ? tr('买') : o.side === 'sell' ? tr('卖') : '—'}</td>
          <td className="g5-n" data-n="oq">{o.size === null ? '—' : fmtLoose(o.size)}</td><td className="g5-n" data-n="op">{prices.price(o.triggerPrice ?? o.price, o.instrumentId)}</td>
          <td className="g5-fill"><OriginActor origin={o.origin} names={names} /></td>
          <td className="g5-n"><span className="g5-acts"><button type="button" className="g5-btn g5-btn-ghost" data-act="order-cancel" disabled={offline || busy === o.orderId} onClick={() => onCancel(o)}>{busy === o.orderId ? tr('撤单中…') : tr('撤单')}</button></span></td>
        </tr>),
      ])}
    </tbody></table>
    {err ? <div className="g5o-ferr" role="alert" title={err}>{err}</div> : null}
  </div>
}

// ---- 块 --------------------------------------------------------------------------------------------------------------------------------------

export function PositionsView() {
  const bridge = useBridge()
  const d = useAccountsData()
  const offline = useOffline(d.reload)
  const prices = usePriceDisplay()
  const feed = useFeedState()
  const clock = useOfflineClock(offline)
  const ord = useOrders(d.accounts)
  const [account, setAccount] = useLink<string>('account')
  const [, setSymbol] = useLink<string>('symbol')
  const [tab, setTab] = useState<Tab>('pos')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [focusStop, setFocusStop] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, RowState>>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [closeErrs, setCloseErrs] = useState<Record<string, string>>({})
  const [ghosts, setGhosts] = useState<Record<string, { row: PositionRow; at: number }>>({})
  const [cancelBusy, setCancelBusy] = useState<string | null>(null)
  const [cancelErr, setCancelErr] = useState<string | null>(null)
  const keysRes = useRes<unknown>(Q.keys)
  const pendRes = useRes<unknown>(Q.proposals, { status: 'pending', limit: 50 })
  useSubscribe(T.proposals, () => pendRes.reload())
  const proposals = normalizeProposals(pendRes.data)
  // 名字映射读原始钥匙表：吊销的钥匙也带名字（后缀「（已撤销）」），开仓方不退回「LLM Agent」（R-50）。
  const names = useMemo(() => actorNames(keysRes.data), [keysRes.data])
  const now = useNow(30000)
  const live = account ? d.rows.filter((r) => r.accountId === account) : d.rows
  const liveKeys = new Set(live.map((r) => r.key))
  const shown = [...live, ...Object.values(ghosts).filter((g) => !liveKeys.has(g.row.key)).map((g) => g.row)]
  // 「已平」只是等持仓事件的过渡态：到期后行已不在 = 收起；行还在且数量变了（事件到了、没平完）或等满上限 = 撤掉「已平」回到正常行。只排一个到下一截止点的定时器。
  useEffect(() => {
    const ks = Object.keys(ghosts)
    if (!ks.length) return undefined
    const t0 = Date.now()
    const age = (k: string) => t0 - ghosts[k]!.at
    const done = ks.filter((k) => {
      if (age(k) < CLOSED_HOLD_MS) return false
      const cur = live.find((r) => r.key === k)
      return !cur || cur.size !== ghosts[k]!.row.size || age(k) >= CLOSED_MAX_MS
    })
    if (done.length) {
      setGhosts((g) => { const n = { ...g }; for (const k of done) delete n[k]; return n })
      setStates((s) => { const n = { ...s }; for (const k of done) if (n[k] === 'closed') delete n[k]; return n })
      if (openKey && done.includes(openKey) && !liveKeys.has(openKey)) setOpenKey(null)
      return undefined
    }
    const next = Math.min(...ks.map((k) => (age(k) < CLOSED_HOLD_MS ? CLOSED_HOLD_MS : CLOSED_MAX_MS) - age(k)))
    const t = setTimeout(() => setGhosts((g) => ({ ...g })), Math.max(20, next + 20))
    return () => clearTimeout(t)
  })
  // 离线期间去掉涨跌色（正负号保留）
  const tone = (v: number): Tone => amountTone(v, offline || feed !== 'live')
  const setState = (k: string, v: RowState | null, only?: RowState[]) => setStates((s) => {
    if (only && !only.includes(s[k] as RowState)) return s
    const n = { ...s }
    if (v) n[k] = v
    else delete n[k]
    return n
  })
  const setErr = (k: string, v: string | null) => setErrs((e) => { const n = { ...e }; if (v) n[k] = v; else delete n[k]; return n })
  const setCloseErr = (k: string, v: string | null) => setCloseErrs((e) => { const n = { ...e }; if (v) n[k] = v; else delete n[k]; return n })

  const ctlOf = (r: PositionRow): Ctl => ({
    offline, state: states[r.key] ?? null, err: errs[r.key] ?? null, focusStop: focusStop === r.key,
    onLocalErr: (m) => setErr(r.key, m),
    // GQ-37：标的走显式路由 #/records/<标的>（记录页不再采用联动里的标的）；账户仍经联动带过去
    onRecords() { try { setAccount(r.accountId) } catch { /* 没声明联动写权限时只跳页 */ } go(recordsHash(r.instrumentId)) },
    // 平仓 / 部分平仓：失败抛出原文（武装态留着、原文就地显示、可重试）+ toast 回声；PIN 被取消 = 什么都没发生
    async onClose(size) {
      const whole = !size
      if (whole) setState(r.key, 'closing')
      const res = await closePosition(bridge, { accountId: r.accountId, instrumentId: r.instrumentId, ...(size ? { size } : {}) })
      if (res.ok) {
        if (whole) { setGhosts((g) => ({ ...g, [r.key]: { row: r, at: Date.now() } })); setState(r.key, 'closed') }
        setCloseErr(r.key, null)
        return undefined
      }
      if (whole) setState(r.key, res.cancelled ? null : 'armed', ['closing'])
      if (res.cancelled) return undefined
      toast.err(res.message)
      if (whole) setCloseErr(r.key, res.message)
      throw new Error(res.message)
    },
    // 止损：先挂新单、成功后再撤旧单（同一次点击的处理链里连续发出，不加定时器）
    async onSaveStop(text) {
      const chk = checkStopPrice(r, text)
      if (!chk.ok) { setErr(r.key, chk.message); return false }
      const old = r.stop
      setErr(r.key, null)
      setState(r.key, 'stop-updating')
      try {
        const placed = await placeStop(bridge, stopIntent(r, chk.price))
        if (!placed.ok) { if (!placed.cancelled) setErr(r.key, placed.message); return false }
        if (old?.orderId) {
          const c = await cancelOrder(bridge, r.accountId, old.orderId)
          if (!c.ok && !c.cancelled) { setErr(r.key, c.message); toast.err(tr('新止损已挂上，旧止损没有撤销：{0}', c.message)) }
        }
        return true
      } finally { setState(r.key, null, ['stop-updating']) }
    },
    onClearStop() {
      const old = r.stop
      if (!old?.orderId) return
      setErr(r.key, null)
      setState(r.key, 'stop-updating')
      void cancelOrder(bridge, r.accountId, old.orderId).then((c) => { if (!c.ok && !c.cancelled) setErr(r.key, c.message) }).finally(() => setState(r.key, null, ['stop-updating']))
    },
  })

  const toggle = (r: PositionRow) => {
    const next = openKey === r.key ? null : r.key
    setOpenKey(next)
    setFocusStop(null)
    if (next) { try { setSymbol(r.instrumentId) } catch { /* 没声明联动写权限时只展开 */ } }
  }
  const cancelOne = async (o: OrderRow) => {
    setCancelBusy(o.orderId); setCancelErr(null)
    try {
      const r = await cancelOrder(bridge, o.accountId, o.orderId)
      if (r.ok) ord.reload()
      else if (!r.cancelled) { setCancelErr(r.message); toast.err(r.message) }
    } finally { setCancelBusy(null) }
  }

  const ordShown = ord.orders.filter((o) => !account || o.accountId === account).length
  // 有持仓或有挂单才出页签；都没有时只留「持仓 0」一个标题（与稿的空态一致）
  const ready = d.phase === 'ready' && d.accounts.length > 0 && (shown.length > 0 || ordShown > 0 || tab === 'ord')
  const head = ready
    ? <header className="g5-hd">
      <div className="g5-tabs g5-htabs" role="tablist" aria-label={tr('持仓与挂单')}>
        <button type="button" className="g5-tab" role="tab" data-tab="pos" aria-selected={tab === 'pos'} onClick={() => setTab('pos')}><span className="g5-al">{tr('持仓')}</span><span className="g5-c">{live.length}</span></button>
        <button type="button" className="g5-tab" role="tab" data-tab="ord" aria-selected={tab === 'ord'} onClick={() => setTab('ord')}>{tr('挂单')}<span className="g5-c">{ordShown}</span></button>
      </div>
      {clock ? <div className="g5-r"><span className="g5-s12 g5-t3">{clock}</span></div> : null}
    </header>
    : <Head title={tr('持仓')} count={d.phase === 'ready' ? live.length : null} right={clock ? <span className="g5-s12 g5-t3">{clock}</span> : undefined} />

  let body: ComponentChildren
  if (d.phase === 'error') body = <Msg error={d.error} onRetry={d.reload} />
  else if (d.phase === 'loading') body = <SkelTable />
  else if (!d.accounts.length) body = <div className="g5o-msg"><span className="g5-al">{tr('还没有账户')}</span><button type="button" className="g5-btn g5-btn-fill" data-act="open-settings" onClick={() => go('#/settings/keys')}>{tr('打开设置')}</button></div>
  else if (tab === 'ord') {
    body = ord.error && !ord.orders.length ? <Msg error={ord.error} onRetry={ord.reload} /> : ord.loading ? <SkelTable /> : <OrdersTable orders={ord.orders.filter((o) => !account || o.accountId === account)} accounts={d.accounts} names={names} offline={offline} onCancel={(o) => { void cancelOne(o) }} busy={cancelBusy} err={cancelErr} />
  } else if (!shown.length) body = <Msg>{tr('当前没有持仓')}</Msg>
  else {
    const venueOf = new Map(d.accounts.map((a) => [a.accountId, a.venue]))
    body = <div className="g5-tw"><table className="g5-tbl" data-tab="positions">{POS_HEAD}<tbody>
      {groupRows(shown).map((g) => [
        <GroupRow key={`g${g.accountId}`} alias={g.alias} mode={g.mode} venue={venueOf.get(g.accountId) ?? ''} n={g.rows.length} subtotal={g.subtotal} tone={tone(g.subtotal)} />,
        ...g.rows.flatMap((r) => {
          const ctl = ctlOf(r)
          const armed = ctl.state === 'armed' || ctl.state === 'closing'
          return [
            <PosRow key={r.key} prices={prices} row={r} open={openKey === r.key} names={names} tone={tone} now={now} pend={pendingOf(r, proposals)} ctl={ctl}
              onToggle={() => toggle(r)} onChart={() => { try { setSymbol(r.instrumentId) } catch { /* 只跳页 */ } go(chartHash(r.instrumentId)) }}
              onStop={() => { if (openKey !== r.key) toggle(r); setFocusStop(r.key) }} onArm={() => setState(r.key, 'armed')} />,
            ...(armed ? [<ArmedClose key={`a${r.key}`} row={r} busy={ctl.state === 'closing'} err={closeErrs[r.key] ?? null}
              onCancel={() => { setState(r.key, null, ['armed']); setCloseErr(r.key, null) }}
              onConfirm={() => { void ctl.onClose().catch(() => undefined) }} />] : []),
          ]
        }),
      ])}
    </tbody></table></div>
  }
  return <Card head={head} className={cardClass(false, offline)} {...stateAttr(offline)} data-g5-page="overview" data-feed={feed} data-view="positions" id="pos" aria-label={tr('持仓与挂单')}>{body}</Card>
}
