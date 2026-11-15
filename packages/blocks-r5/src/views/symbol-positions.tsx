// SPDX-License-Identifier: CPAL-1.0
// 图表页右下「本标的」卡（positions 块的 {view:'symbol'}）：该标的的持仓行（平仓 / 止损 / 展开，沿用 r4 命令）+ 挂单行（撤单走 G2）+ 待批一行 + 全部记录。
// 数据只经桥：account.list / account.positions / account.orders {openOnly} / proposal.list {status:'pending'}；事件只触发重读。
// 命令：position.close（平仓，会话或 PIN）、order.place（止损，reduceOnly 的 stop_market）、order.cancel（撤单）。失败一律原文，PIN 由壳的弹层队列接。
import type { BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useLink, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { accountLabel } from '../../../blocks-default/src/display'
import { usePriceDisplay } from '../../../blocks-default/src/price-display'
import { ErrText, toast } from '@gitrader/workbench/ui'
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { cancelOrder, closePosition, placeStop } from '../../../blocks-default/src/actions'
import { focusCard, queryRetry, useNow, useOffline } from '../../../blocks-default/src/hooks'
import { checkStopPrice, normalizeAccounts, normalizePositions, stopIntent, type AccountLite } from '../../../blocks-default/src/model-positions'
import { isRec, listOf, str, symbolOf } from '../../../blocks-default/src/util'
import { Actor, Card, Empty, ErrorText, Unwired, wireState } from '../kit'
import {
  agentNames, actorView, fmtMoney, fmtPrice, fmtQty, tone, type ActorView,
} from '../model-records'
import { isStopOrder, sideWord, stopWord, toChartPosition, toOpenOrder, type ChartPosition, type OpenOrder } from '../model-chart'
import './chart.css'
import { recordsHash } from '../model-records'
import { t as tr } from '@gitrader/workbench/i18n'

const errOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

// ---- 当前标的 -----------------------------------------------------------------------------

/** 图表页三块共用的「当前标的」：config.instrumentId 优先（只读场景用），否则跟 symbol 联动；都没有 = null。 */
export function useInstrumentId(config: Record<string, unknown> | undefined): string | null {
  const [link] = useLink<string>('symbol')
  const fixed = typeof config?.instrumentId === 'string' && config.instrumentId ? config.instrumentId : null
  return fixed ?? (typeof link === 'string' && link ? link : null)
}

// ---- 数据 ---------------------------------------------------------------------------------

export interface InstrumentInfo { instrumentId: string; displaySymbol: string; base: string | null; quote: string | null; fees: { maker?: string; taker?: string } | null }
const NO_INFO: ReadonlyMap<string, InstrumentInfo> = new Map()
/** 品种表（market.instruments 一次取全）：显示名（BTC-PERP）、基础 / 计价币、费率。读不到不挡主体，名字退回 `BTC` 这种场所内符号。 */
export function useInstruments(): { info: ReadonlyMap<string, InstrumentInfo>; nameOf(id: string): string } {
  const bridge = useBridge()
  const [info, setInfo] = useState<ReadonlyMap<string, InstrumentInfo>>(NO_INFO)
  useEffect(() => {
    let dead = false
    queryRetry<unknown>(bridge, 'market.instruments', { limit: 1000 }, () => !dead).then(
      (raw) => {
        if (dead) return
        const m = new Map<string, InstrumentInfo>()
        for (const i of listOf(raw, 'instruments')) {
          if (!isRec(i) || typeof i.instrumentId !== 'string') continue
          const f = isRec(i.fees) ? i.fees : null
          m.set(i.instrumentId, {
            instrumentId: i.instrumentId, displaySymbol: str(i.displaySymbol) ?? symbolOf(i.instrumentId), base: str(i.base) ?? null, quote: str(i.quote) ?? null,
            fees: f ? { ...(typeof f.maker === 'string' ? { maker: f.maker } : {}), ...(typeof f.taker === 'string' ? { taker: f.taker } : {}) } : null,
          })
        }
        setInfo(m)
      },
      () => { /* 显示名只是补充 */ },
    )
    return () => { dead = true }
  }, [bridge])
  const nameOf = useCallback((id: string) => info.get(id)?.displaySymbol ?? symbolOf(id), [info])
  return { info, nameOf }
}


export interface SymbolSnapshot {
  phase: 'loading' | 'ready' | 'error'
  error: Error | null
  accounts: AccountLite[]
  positions: ChartPosition[]
  orders: OpenOrder[]
  proposals: unknown
  names: Record<string, string>
  reload(): void
}
const EMPTY: Omit<SymbolSnapshot, 'reload'> = { phase: 'loading', error: null, accounts: [], positions: [], orders: [], proposals: [], names: {} }

/** 本标的快照；事件只用来触发（去抖）重读，不在块里拼增量。读不到的补充项（提案 / Agent 名）不挡主体。 */
export function useSymbolSnapshot(instrumentId: string | null): SymbolSnapshot {
  const bridge = useBridge()
  const [st, setSt] = useState<Omit<SymbolSnapshot, 'reload'>>(EMPTY)
  const [n, setN] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const poke = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setN((x) => x + 1), 300) }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useSubscribe('account.positions', poke)
  useSubscribe('account.orders', poke)
  useSubscribe('account.fills', poke)
  useSubscribe('proposal.*', poke)
  useEffect(() => {
    if (!instrumentId) { setSt({ ...EMPTY, phase: 'ready' }); return undefined }
    let dead = false
    ;(async () => {
      const accounts = normalizeAccounts(await queryRetry(bridge, 'account.list', undefined, () => !dead))
      const per = await Promise.all(accounts.map(async (a) => {
        const p = { accountId: a.accountId }
        const [pos, ord] = await Promise.all([
          queryRetry(bridge, 'account.positions', p, () => !dead),
          queryRetry(bridge, 'account.orders', { ...p, openOnly: true }, () => !dead),
        ])
        return {
          positions: normalizePositions(pos).flatMap((x) => { const c = toChartPosition(x, a.accountId); return c && c.instrumentId === instrumentId ? [c] : [] }),
          orders: listOf(ord, 'orders').flatMap((x) => { const o = toOpenOrder(x); return o && o.instrumentId === instrumentId ? [o] : [] }),
        }
      }))
      const [proposals, keys] = await Promise.all([
        queryRetry<unknown>(bridge, 'proposal.list', { status: 'pending' }, () => !dead).catch(() => []),
        queryRetry<unknown>(bridge, 'agentkey.list', undefined, () => !dead).catch(() => []),
      ])
      if (dead) return
      setSt({ phase: 'ready', error: null, accounts, positions: per.flatMap((x) => x.positions), orders: per.flatMap((x) => x.orders), proposals, names: agentNames(keys) })
    })().catch((e: unknown) => { if (!dead) setSt((s) => ({ ...s, phase: 'error', error: errOf(e) })) })
    return () => { dead = true }
  }, [bridge, instrumentId, n])
  return { ...st, reload: useCallback(() => setN((x) => x + 1), []) }
}

// ---- 小件 ---------------------------------------------------------------------------------

const Chev = ({ open }: { open?: boolean }) => <svg className="g5-i" viewBox="0 0 24 24" aria-hidden="true" style={open ? { transform: 'rotate(180deg)' } : undefined}><path d="M7 10l5 5 5-5" /></svg>

const fmtClock = (ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
/** 离线卡头的「已暂停更新 · mm:ss」：只在离线时才挂，避免整页每秒重绘。 */
export function PausedFor({ since }: { since: number }) {
  const now = useNow(1000)
  return <span className="g5-s12 g5-t3">{tr('已暂停更新 · ')}{fmtClock(now - since)}</span>
}
/** 离线起点：进入离线时记一次，恢复时清零。 */
export function useOfflineSince(off: boolean): number {
  const at = useRef(0)
  if (off && !at.current) at.current = Date.now()
  if (!off) at.current = 0
  return at.current
}

/**
 * 两步确认条（G2）：后果写在前；焦点落「取消」；Esc / 取消 / 5 秒无操作解除；600 ms 内的确认点击不算数；执行中隐藏取消；失败原文就地显示、可重试。
 * （与策略页同一套行为；kit 的 ArmRow 触发钮常驻在红底里，不适合「后果 + 取消 + 确认」一条受控的条。）
 */
export function ArmedBar({ what, confirm, busyLabel, busy, error, onConfirm, onCancel, act, tone: barTone = 'kill' }: {
  what: string; confirm: string; busyLabel: string; busy: boolean; error: string | null; onConfirm(): void; onCancel(): void; act: string; tone?: 'kill' | 'primary'
}) {
  const born = useRef(performance.now())
  const cancelBtn = useRef<HTMLButtonElement>(null)
  const hover = useRef(false)
  const timer = useRef(0)
  const idle = useCallback(() => {
    clearTimeout(timer.current)
    if (!hover.current && !busy) timer.current = window.setTimeout(onCancel, 5000)
  }, [busy, onCancel])
  useLayoutEffect(() => { cancelBtn.current?.focus() }, [])
  useEffect(() => { idle(); return () => clearTimeout(timer.current) }, [idle, error])
  return (
    <div className="g5-armed" role="group" aria-label={what} data-armed="" onPointerEnter={() => { hover.current = true; clearTimeout(timer.current) }} onPointerLeave={() => { hover.current = false; idle() }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onCancel() } else idle() }}>
      <span className="g5-what g5-al">{what}</span>
      {error ? <span className="g5-msg g5-danger" role="alert"><ErrText text={error} /></span> : null}
      {busy ? null : <button ref={cancelBtn} type="button" className="g5-btn g5-btn-ghost" data-act={`${act}-cancel`} onClick={onCancel}>{tr('取消')}</button>}
      <button type="button" className={`g5-btn ${barTone === 'primary' ? 'g5-btn-fill' : act === 'close' ? 'g5-btn-kill' : 'g5-btn-fill'}`} data-solid="" data-act={`${act}-confirm`} disabled={busy}
        onClick={() => { if (!busy && performance.now() - born.current >= 600) onConfirm() }}>{busy ? busyLabel : confirm}</button>
    </div>
  )
}

const toneClass = (v: unknown, off: boolean): string => { if (off) return 'g5-t2'; const t = tone(v); return t === 'up' ? 'g5-up' : t === 'down' ? 'g5-down' : 'g5-t2' }
const orderWord = (o: OpenOrder): string => (o.reduceOnly && o.triggerPrice !== null ? stopWord(o) : ({ limit: tr('限价'), market: tr('市价'), stop_market: tr('止损'), stop_limit: tr('止损限价') } as Record<string, string>)[o.type] ?? o.type)
const orderPx = (o: OpenOrder): string => (o.triggerPrice !== null ? fmtPrice(o.triggerPrice) : o.price !== null ? fmtPrice(o.price) : tr('市价'))
const orderLine = (o: OpenOrder): string => `${sideWord(o.side)} ${fmtQty(o.size)} @ ${orderPx(o)}`

type Arm = { key: string; kind: 'cancel' | 'close'; what: string; confirm: string; busyLabel: string; busy: boolean; error: string | null }
interface StopEdit { key: string; text: string; busy: boolean; error: string | null }

/** 待批一行：最急的一张（按到期时间）；点「待批 N」去总览待批卡。 */
function pendingOf(proposals: unknown, instrumentId: string, names: Record<string, string>): { n: number; first: { ticket: string; actor: ActorView; what: string; expiresAt: number | null } } | null {
  const hits = listOf(proposals, 'proposals').filter(isRec).filter((p) => p.status === 'pending' && Array.isArray(p.intents) && p.intents.some((l) => isRec(l) && l.instrumentId === instrumentId))
  if (!hits.length) return null
  const exp = (p: Record<string, unknown>) => (typeof p.expiresAt === 'number' ? p.expiresAt : Number.MAX_SAFE_INTEGER)
  const p = [...hits].sort((a, b) => exp(a) - exp(b))[0]!
  const leg = (p.intents as unknown[]).filter(isRec).find((l) => l.instrumentId === instrumentId)!
  const px = leg.price ?? leg.triggerPrice
  const side = leg.side === 'buy' || leg.side === 'sell' ? sideWord(leg.side) : ''
  return {
    n: hits.length,
    first: {
      ticket: str(p.ticket) ?? '', actor: actorView(isRec(p.origin) ? (p.origin as never) : null, names),
      what: `${side} ${fmtQty(leg.size)}${typeof px === 'string' && px ? ` @ ${fmtPrice(px)}` : ''}`.trim(), expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : null,
    },
  }
}

function Countdown({ at }: { at: number }) {
  const now = useNow(1000)
  return <span className="g5-cd g5-t2" data-n="cd">{fmtClock(at - now)}</span>
}

// ---- 视图 ---------------------------------------------------------------------------------

export function SymbolPositionsView({ config }: BlockProps) {
  const bridge = useBridge()
  const instrumentId = useInstrumentId(config)
  const off = useOffline()
  const since = useOfflineSince(off)
  const snap = useSymbolSnapshot(instrumentId)
  const prices = usePriceDisplay()
  const names = useInstruments()
  const [, setAccountLink] = useLink<string>('account')
  const [arm, setArm] = useState<Arm | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [stop, setStop] = useState<StopEdit | null>(null)
  const alias = useMemo(() => new Map(snap.accounts.map((a) => [a.accountId, a])), [snap.accounts])
  useEffect(() => { setArm(null); setOpen(null); setStop(null) }, [instrumentId])

  const keyOf = (p: ChartPosition) => `${p.accountId}|${p.side}`
  const runArm = async () => {
    if (!arm) return
    setArm({ ...arm, busy: true, error: null })
    const [kind, accountId, ref] = arm.key.split('|') as ['cancel' | 'close', string, string]
    const r = kind === 'cancel' ? await cancelOrder(bridge, accountId, ref ?? '') : await closePosition(bridge, { accountId, instrumentId: instrumentId ?? '' })
    if (r.ok) { setArm(null); snap.reload(); return }
    if (r.cancelled) { setArm(null); return }
    toast.err(r.message)
    setArm((a) => (a ? { ...a, busy: false, error: r.message } : a))
  }
  const saveStop = async (p: ChartPosition) => {
    if (!stop) return
    const row = { accountId: p.accountId, instrumentId: p.instrumentId, side: p.side, size: Number(p.size), markPrice: p.markPrice, position: { size: p.size } as never }
    const chk = checkStopPrice(row, stop.text)
    if (!chk.ok) { setStop({ ...stop, error: chk.message }); return }
    setStop({ ...stop, busy: true, error: null })
    const r = await placeStop(bridge, stopIntent(row, chk.price))
    if (r.ok) {
      // r4 同款：先挂新单、成功后再撤旧单（改止损不原子，重叠期间两张都是 reduceOnly，不增加敞口）
      for (const old of snap.orders.filter((o) => o.accountId === p.accountId && o.type === 'stop_market' && isStopOrder(o))) {
        const c = await cancelOrder(bridge, old.accountId, old.orderId)
        if (!c.ok && !c.cancelled) toast.err(tr('新止损已挂上，旧止损没有撤销：{0}', c.message))
      }
      setStop(null)
      snap.reload()
      return
    }
    if (r.cancelled) { setStop({ ...stop, busy: false }); return }
    setStop({ ...stop, busy: false, error: r.message })
  }
  const gotoRecords = () => {
    if (instrumentId) { try { setAccountLink(undefined as never) } catch { /* 清单没给联动写权限时只跳转 */ } }
    location.hash = instrumentId ? recordsHash(instrumentId) : '#/records'
  }

  const head = <header className="g5-hd" data-geo="mine.head"><h2 className="g5-al">{tr('本标的')}</h2>
    <div className="g5-r g5-gh">
      {off ? <PausedFor since={since} /> : null}
      <button type="button" className="g5-btn g5-btn-ghost g5-lnk" data-act="all-records" onClick={gotoRecords}>{tr('全部记录')}</button>
    </div>
  </header>
  const shell = (children: ComponentChildren) => <Card head={head} className="g5-grow" data-page="chart" data-g5-page="chart-mine" data-geo="mine.card">{children}</Card>

  if (snap.phase === 'error' && snap.error) {
    return shell(wireState(snap.error) === 'off'
      ? <div className="g5-pstate"><Unwired message={snap.error.message} /></div>
      : <div className="g5-pstate"><span className="g5-al">{tr('读取失败')}</span><ErrorText bare message={snap.error.message} /><button type="button" className="g5-btn g5-btn-fill" data-act="retry" onClick={snap.reload}>{tr('重试')}</button></div>)
  }
  if (snap.phase === 'loading') return shell(<div className="g5-trw" aria-busy="true"><div className="g5-tr1"><span className="g5-sk g5-sk-a" /></div><div className="g5-tr1 g5-h40"><span className="g5-sk g5-sk-b" /></div></div>)
  const pend = instrumentId ? pendingOf(snap.proposals, instrumentId, snap.names) : null
  if (!snap.positions.length && !snap.orders.length && !pend) return shell(<Empty message={tr('当前没有持仓和挂单')} />)

  const body = <div className="g5-trw">
    {snap.positions.map((p, pi) => {
      const k = keyOf(p)
      const a = alias.get(p.accountId)
      const closing = arm?.kind === 'close' && arm.key === `close|${p.accountId}|${p.side}`
      const stopping = stop?.key === k
      return <div key={k} data-pos={k}>
        <div className="g5-tr1 g5-pos" data-geo={pi === 0 ? 'mine.row1' : undefined}>
          <div className="g5-pv"><div className="g5-l1"><span className="g5-side g5-al">{p.side === 'long' ? tr('多') : tr('空')} {fmtQty(p.size)}</span>
            <span className="g5-kv"><span className="g5-k">{tr('未实现')}</span><span className={`g5-v ${toneClass(p.unrealizedPnl, off)}`} data-n="upnl">{p.unrealizedPnl === null ? tr('未设') : fmtMoney(p.unrealizedPnl, true)}</span></span></div>
            <div className="g5-l2">{tr('开仓 ')}{p.entryPrice === null ? tr('未设') : prices.price(p.entryPrice, p.instrumentId)}{p.leverage ? tr('　{0}×', p.leverage) : ''}{a ? tr('　{0}', a.alias) : ''}</div></div>
          <span className="g5-acts">
            <button type="button" className="g5-btn g5-btn-ghost" data-act="pos-close" disabled={off || !!arm} onClick={() => setArm({ key: `close|${p.accountId}|${p.side}`, kind: 'close', what: tr('市价平掉 {0} {1}', fmtQty(p.size), instrumentId ? names.nameOf(instrumentId) : ''), confirm: tr('确认平仓'), busyLabel: tr('平仓中…'), busy: false, error: null })}>{tr('平仓')}</button>
            <button type="button" className="g5-btn g5-btn-ghost" data-act="pos-stop" disabled={off} onClick={() => setStop(stopping ? null : { key: k, text: '', busy: false, error: null })}>{tr('止损')}</button>
            <button type="button" className="g5-btn g5-btn-ghost g5-btn-icon" data-act="pos-expand" aria-label={tr('展开')} aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}><Chev open={open === k} /></button>
          </span>
        </div>
        {closing && arm ? <ArmedBar act="close" what={arm.what} confirm={arm.confirm} busyLabel={arm.busyLabel} busy={arm.busy} error={arm.error} onConfirm={() => { void runArm() }} onCancel={() => setArm(null)} /> : null}
        {stopping && stop ? <div className="g5-stopf" data-form="stop">
          <label className="g5-inp g5-s"><input value={stop.text} placeholder={tr('止损触发价')} aria-label={tr('止损触发价')} autoFocus onInput={(e) => setStop({ ...stop, text: (e.target as HTMLInputElement).value, error: null })}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveStop(p) }} /></label>
          {stop.error ? <span className="g5-msg g5-danger" role="alert">{stop.error}</span> : null}
          <button type="button" className="g5-btn g5-btn-ghost" data-act="stop-cancel" onClick={() => setStop(null)}>{tr('取消')}</button>
          <button type="button" className="g5-btn g5-btn-fill" data-act="stop-save" disabled={stop.busy || off} onClick={() => { void saveStop(p) }}>{stop.busy ? tr('保存中…') : tr('保存止损')}</button>
        </div> : null}
        {open === k ? <div className="g5-pxd" data-detail={k}>
          <div className="g5-kv"><span className="g5-k">{tr('账户')}</span><span className="g5-v">{a ? `${a.alias} ${a.mode === 'live' ? tr('实盘') : tr('纸面')}` : accountLabel(p.accountId)}</span></div>
          <div className="g5-kv"><span className="g5-k">{tr('名义')}</span><span className="g5-v" data-n="pv1">{p.notional === null ? tr('未设') : fmtMoney(p.notional)}</span></div>
          <div className="g5-kv"><span className="g5-k">{tr('标记价')}</span><span className="g5-v" data-n="pv1">{p.markPrice === null ? tr('未设') : prices.price(p.markPrice, p.instrumentId)}</span></div>
          <div className="g5-kv"><span className="g5-k">{tr('强平价')}</span><span className="g5-v" data-n="pv1">{p.liquidationPrice === null ? tr('无') : `${p.estimated ? tr('约 ') : ''}${prices.price(p.liquidationPrice, p.instrumentId)}`}</span></div>
        </div> : null}
      </div>
    })}
    {snap.orders.map((o) => {
      const cancelling = arm?.kind === 'cancel' && arm.key === `cancel|${o.accountId}|${o.orderId}`
      return <div key={o.orderId} data-order={o.orderId}>
        {cancelling && arm ? <ArmedBar act="cancel" what={arm.what} confirm={arm.confirm} busyLabel={arm.busyLabel} busy={arm.busy} error={arm.error} onConfirm={() => { void runArm() }} onCancel={() => setArm(null)} />
          : <div className="g5-tr1 g5-h40"><span className="g5-tb g5-al">{orderWord(o)}</span><span className="g5-kv"><span className="g5-v">{prices.copy(orderLine(o), o.instrumentId)}</span></span>
            <span className="g5-acts"><button type="button" className="g5-btn g5-btn-ghost" data-act="order-cancel" disabled={off || !!arm}
              onClick={() => setArm({ key: `cancel|${o.accountId}|${o.orderId}`, kind: 'cancel', what: tr('撤销 {0} {1}', orderWord(o), prices.copy(orderLine(o), o.instrumentId)), confirm: tr('确认撤单'), busyLabel: tr('撤单中…'), busy: false, error: null })}>{tr('撤单')}</button></span></div>}
      </div>
    })}
    {pend ? <div className="g5-pendr"><div className="g5-ln">
      <a href="#/" className="g5-t2 g5-al" data-act="pending-goto" onClick={() => focusCard('pending')}>{tr('待批 ')}{pend.n}</a>
      <Actor kind={pend.first.actor.kind === 'unknown' ? 'system' : pend.first.actor.kind} name={pend.first.actor.name} />
      {pend.first.ticket ? <span className="g5-t3 g5-tk">{pend.first.ticket}</span> : null}
      <span className="g5-tb">{pend.first.what}</span>
      {pend.first.expiresAt ? <Countdown at={pend.first.expiresAt} /> : null}
    </div></div> : null}
  </div>
  return shell(<div className={`g5-pbody${off ? ' g5-off' : ''}`} data-state={off ? 'offline' : undefined}>{body}</div>)
}
