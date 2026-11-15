// SPDX-License-Identifier: CPAL-1.0
// 资金页六张卡：账户 / 权益曲线 / 资产 / 保证金 / 权益变动 / 组合。同一个块 block.gitrader.equity，config.view 选显示哪一张。
// 数据全部经桥（查询取快照），不直连内核；纯规整逻辑在 ../model-funds.ts。命令错误原文原样显示，不改写。
import { Fragment, type ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { BlockBridge, BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useLink, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { runCommand } from '../../../blocks-default/src/actions'
import { queryRetry, useOffline } from '../../../blocks-default/src/hooks'
import { Amount, ErrorText, Card, Unwired, VenueIcon, wireState } from '../kit'
import { F, Menu } from '@gitrader/workbench/ui'
import { accountLabel } from '../../../blocks-default/src/display'
import { sumStr } from '../model-records'
import {
  TABS, TAB_TEXT, assetsOf, barPct, changesOf, countOpenOrders, countPositions, curveOf, failOf, fmtAmt as fmtQuantity, fmtElapsed, fmtPct, fmtTicks, groupAccounts, marginOf, marginWarn,
  negStr, networkText, niceTicks, normalizeAccounts as normalizeFundAccounts, okFalse, portfolioView, rangeOf, resetText, rowState, sharePct, timeTicks, toneOf, venueHealth,
  type ChangeRow, type PortfolioRow, type Curve, type FundAccount, type Group, type RowState, type Tab,
} from '../model-funds'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import './funds.css'
import { t as tr } from '@gitrader/workbench/i18n'

const normalizeAccounts = (raw: unknown) => normalizeFundAccounts(raw).map((a) => ({ ...a, alias: accountLabel(a.accountId, a.alias) }))
const fmtAmt = (v: string | null) => F.usd(v)
const fmtSigned = (v: string | null) => F.signed(v)

// ---- 取数 --------------------------------------------------------------------------------

/** 查询；内核「成功」返回 {ok:false, error} 时当失败抛出，错误码与原文保留。 */
async function ask<T = unknown>(bridge: BlockBridge, method: string, params: unknown, alive: () => boolean): Promise<T> {
  const r = await queryRetry<T>(bridge, method, params, alive)
  const f = okFalse(r)
  if (f) throw Object.assign(new Error(f.message), { code: f.code ?? undefined, problemName: f.name ?? undefined })
  return r
}

interface Load<T> { data: T | undefined; error: unknown; loading: boolean; reload(): void }

/** 只读加载：key 变了重查；重查期间保留上一次的数据（只有第一次才显示骨架）；失败保留上一次数据并带上错误。 */
function useLoad<T>(load: (bridge: BlockBridge, alive: () => boolean) => Promise<T>, key: string): Load<T> {
  const bridge = useBridge()
  const [st, setSt] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [n, setN] = useState(0)
  const fn = useRef(load)
  fn.current = load
  useEffect(() => {
    let dead = false
    fn.current(bridge, () => !dead).then(
      (data) => { if (!dead) setSt({ data, error: null, loading: false }) },
      (error: unknown) => { if (!dead) setSt((s) => ({ data: s.data, error, loading: false })) },
    )
    return () => { dead = true }
  }, [bridge, key, n])
  return { ...st, reload: useCallback(() => setN((x) => x + 1), []) }
}

/** 权益 / 成交一变就稍后重查一次（去抖）；内核没推也无妨。 */
function useRefresh(reload: () => void): void {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  const poke = () => { if (t.current) clearTimeout(t.current); t.current = setTimeout(reload, 600) }
  useEffect(() => () => { if (t.current) clearTimeout(t.current) }, [])
  useSubscribe('account.summary', poke)
  useSubscribe('account.fills', poke)
}

/** 离线（壳挂在 <html data-offline>）：卡降灰、命令禁用、卡头右侧写「已暂停更新 · mm:ss」；恢复时重查一次。 */
function useOfflineClock(onBack: () => void): { off: boolean; text: string } {
  const off = useOffline(onBack)
  const since = useRef(0)
  const [, tick] = useState(0)
  if (off && !since.current) since.current = Date.now()
  if (!off) since.current = 0
  useEffect(() => {
    if (!off) return undefined
    const id = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [off])
  return { off, text: off ? tr('已暂停更新 · {0}', fmtElapsed(Date.now() - since.current)) : '' }
}

/** 选中账户：联动组 account 的值；没有就取第一个实盘、再取第一个纸面（影子账户不进资金页）。 */
function useSelected(accounts: readonly FundAccount[]): [FundAccount | null, (id: string) => void] {
  const [linked, setLinked] = useLink<string>('account')
  const shown = accounts.filter((a) => a.mode !== 'shadow')
  const sel = shown.find((a) => a.accountId === linked) ?? shown.find((a) => a.mode === 'live') ?? shown[0] ?? null
  return [sel, setLinked]
}

/** 跟随选中账户的卡：先读账户表定账户，再读这张卡自己的数据。 */
function useForAccount<T>(load: (bridge: BlockBridge, account: FundAccount, alive: () => boolean) => Promise<T>, extraKey = ''): {
  account: FundAccount | null; data: T | undefined; error: unknown; loading: boolean; reload(): void
} {
  const list = useLoad(async (b, alive) => normalizeAccounts(await ask(b, 'account.list', undefined, alive)), '')
  const [account] = useSelected(list.data ?? [])
  const data = useLoad<T | undefined>((b, alive) => (account ? load(b, account, alive) : Promise.resolve(undefined)), `${account?.accountId ?? ''}|${extraKey}`)
  const reload = useCallback(() => { list.reload(); data.reload() }, [list.reload, data.reload])
  // 先看账户表，再看这张卡自己的数据；有过数据后重查失败不顶掉旧数据
  const error = !list.data ? list.error : data.data === undefined ? data.error : null
  const loading = !list.data ? !list.error : !!account && data.data === undefined && !data.error
  return { account, data: data.data, error, loading, reload }
}

// ---- 小件 --------------------------------------------------------------------------------

const Sk = ({ w, h }: { w: number; h?: number }) => <span className="g5-sk" style={{ width: w, ...(h ? { height: h } : {}) }} />
const WarnIcon = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5l8.5 15h-17L12 4.5z" /><path d="M12 10.5v4" /><path d="M12 17.25v.01" /></svg>
const ShieldIcon = () => <svg className="g5-i g5-i16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></svg>

type Pg = { 'data-g5-page': 'funds'; 'data-view': string }
const page = (view: string): Pg => ({ 'data-g5-page': 'funds', 'data-view': view })

function Head({ title, count, sub, right }: { title: string; count?: number | null; sub?: string; right?: ComponentChildren }) {
  return <header className="g5-hd">
    <h2 className="g5-al">{title}</h2>
    {count != null ? <span className="g5-ct">{count}</span> : null}
    {sub ? <span className="g5-s12 g5-t2">{sub}</span> : null}
    {right != null ? <div className="g5-r">{right}</div> : null}
  </header>
}

/** 一行消息：空 / 读取失败 / 未接通。错误显示内核原文；接口不存在或缺字段只写「未接通」，不给重试。 */
function Msg({ error, onRetry, children }: { error?: unknown; onRetry?: () => void; children?: ComponentChildren }) {
  if (error) {
    if (wireState(error) === 'off') return <div className="g5f-msg"><Unwired message={failOf(error).message} /></div>
    return <div className="g5f-msg"><span className="g5-al">{tr('读取失败')}</span><ErrorText bare message={failOf(error).message} />{onRetry ? <button type="button" className="g5-btn g5-btn-fill" data-act="read-retry" onClick={onRetry}>{tr('重试')}</button> : null}</div>
  }
  return <div className="g5f-msg">{children}</div>
}

const cardClass = (grow: boolean, off: boolean): string => [grow ? 'g5-grow' : '', off ? 'g5-off' : ''].filter(Boolean).join(' ')
const offAttr = (off: boolean) => (off ? { 'data-state': 'offline' } : {})

// ---- 账户 --------------------------------------------------------------------------------

interface AccountsData { accounts: FundAccount[]; states: Record<string, RowState> }

async function loadAccounts(b: BlockBridge, alive: () => boolean): Promise<AccountsData> {
  const accounts = normalizeAccounts(await ask(b, 'account.list', undefined, alive)).filter((a) => a.mode !== 'shadow')
  const health = venueHealth(await ask(b, 'venue.status', undefined, alive).catch(() => null))
  const per = await Promise.all(accounts.map(async (a) => {
    const p = { accountId: a.accountId }
    // 每个账户各查各的：一个账户读不到只影响它自己那一行
    const summary = await ask(b, 'account.summary', p, alive).then((value) => ({ value, fail: null }), (e: unknown) => ({ value: null, fail: failOf(e) }))
    const assets = await ask(b, 'account.assets', p, alive).catch(() => null)
    return [a.accountId, rowState(a, { summary: summary.value, summaryFail: summary.fail, assets, health })] as const
  }))
  return { accounts, states: Object.fromEntries(per) }
}

function AccountsCard() {
  const bridge = useBridge()
  const q = useLoad(loadAccounts, '')
  useRefresh(q.reload)
  const clock = useOfflineClock(q.reload)
  const accounts = q.data?.accounts ?? []
  const [selected, select] = useSelected(accounts)
  const [armed, setArmed] = useState<{ id: string; text: string | null; err: string | null; busy: boolean; ready: boolean } | null>(null)
  const [recon, setRecon] = useState<Record<string, { busy: boolean; err: string | null }>>({})
  const groups = q.data ? groupAccounts(accounts, q.data.states) : []
  const first = !q.data && !q.error

  // 武装重置：先读持仓与挂单数，把后果写进确认文案；600 ms 内不接受确认（防连点），8 s 无动作自动取消，Esc 取消
  const arm = (a: FundAccount) => {
    setArmed({ id: a.accountId, text: null, err: null, busy: false, ready: false })
    const p = { accountId: a.accountId }
    Promise.all([ask(bridge, 'account.positions', p, () => true), ask(bridge, 'account.orders', p, () => true)]).then(
      ([pos, ord]) => setArmed((s) => (s && s.id === a.accountId ? { ...s, text: resetText(a, countPositions(pos), countOpenOrders(ord)) } : s)),
      (e: unknown) => setArmed((s) => (s && s.id === a.accountId ? { ...s, text: null, err: failOf(e).message } : s)),
    )
    setTimeout(() => setArmed((s) => (s && s.id === a.accountId ? { ...s, ready: true } : s)), 600)
  }
  useEffect(() => {
    if (!armed || armed.busy) return undefined
    const id = setTimeout(() => setArmed(null), 8000)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setArmed(null) }
    window.addEventListener('keydown', esc)
    return () => { clearTimeout(id); window.removeEventListener('keydown', esc) }
  }, [armed?.id, armed?.busy, armed?.err, armed?.text])
  useEffect(() => { if (clock.off) setArmed(null) }, [clock.off])
  const confirmReset = async () => {
    if (!armed || !armed.ready || armed.text === null || armed.busy) return
    const id = armed.id
    setArmed({ ...armed, busy: true, err: null })
    const r = await runCommand(bridge, 'paper.reset', { accountId: id })
    if (r.ok) { setArmed(null); q.reload(); return }
    // 用户在 PIN 层点取消 = 命令没发生：回到可再确认的状态；其余失败显示内核原文
    setArmed((s) => (s && s.id === id ? { ...s, busy: false, err: r.cancelled ? null : r.message } : s))
  }
  const reconnect = async (venue: string) => {
    setRecon((m) => ({ ...m, [venue]: { busy: true, err: null } }))
    const r = await runCommand(bridge, 'venue.reconnect', { venue })
    setRecon((m) => ({ ...m, [venue]: { busy: false, err: r.ok || r.cancelled ? null : r.message } }))
    if (r.ok) q.reload()
  }
  const toRecords = (a: FundAccount) => { select(a.accountId); window.location.hash = '#/records' }

  const count = q.data ? accounts.length : null
  const head = <Head title={tr('账户')} count={count} right={clock.off ? <span className="g5-s12 g5-t3">{clock.text}</span> : undefined} />
  let body: ComponentChildren
  if (first) {
    body = <div className="g5-tw"><table className="g5-tbl g5-acct">{thead()}<tbody>
      {[0, 1, 2].map((i) => i % 3 === 0
        ? <tr key={i} className="g5-grp"><td colSpan={2}><Sk w={56} /></td><td className="g5-c-net" /><td /><td /><td /><td /><td /></tr>
        : <tr key={i} className="g5-row g5-h40 g5f-r40"><td><Sk w={56} /></td><td className="g5-fill"><Sk w={96} h={16} /></td><td className="g5-c-net"><Sk w={40} /></td><td className="g5-n"><Sk w={64} /></td><td className="g5-n"><Sk w={64} /></td><td><Sk w={88} /></td><td className="g5-n"><Sk w={48} /></td><td className="g5-n"><Sk w={40} /></td></tr>)}
    </tbody></table></div>
  } else if (!q.data) {
    body = <Msg error={q.error} onRetry={q.reload} />
  } else if (!accounts.length) {
    body = <div className="g5f-msg"><span className="g5-al">{tr('还没有账户')}</span><button type="button" className="g5-btn g5-btn-fill" data-act="go-venues" onClick={() => { window.location.hash = '#/settings/venues' }}>{tr('去配置交易所')}</button></div>
  } else {
    body = <div className="g5-tw"><table className="g5-tbl g5-acct">{thead()}<tbody>
      {groups.map((g) => <GroupRows key={g.mode} g={g} selected={selected?.accountId ?? ''} off={clock.off} armed={armed} recon={recon}
        onSelect={select} onRecords={toRecords} onReconnect={reconnect} onArm={arm} onDisarm={() => setArmed(null)} onConfirm={confirmReset} />)}
    </tbody></table></div>
  }
  return <Card head={head} className={cardClass(false, clock.off)} {...page('accounts')} {...offAttr(clock.off)} id="acct" aria-label={tr('账户')}>{body}</Card>
}

function thead() {
  return <thead><tr>
    <th className="g5-al">{tr('账户')}</th><th className="g5-fill">{tr('场所')}</th><th className="g5-c-net">{tr('网络')}</th>
    <th className="g5-n" data-n="eq">{tr('权益')}</th><th className="g5-n" data-n="av">{tr('可用')}</th><th>{tr('保证金率')}</th><th className="g5-n" data-n="td">{tr('今日')}</th><th />
  </tr></thead>
}

type Armed = { id: string; text: string | null; err: string | null; busy: boolean; ready: boolean } | null
interface GroupProps {
  g: Group; selected: string; off: boolean; armed: Armed; recon: Record<string, { busy: boolean; err: string | null }>
  onSelect(id: string): void; onRecords(a: FundAccount): void; onReconnect(venue: string): void; onArm(a: FundAccount): void; onDisarm(): void; onConfirm(): void
}


function GroupRows({ g, selected, off, armed, recon, onSelect, onRecords, onReconnect, onArm, onDisarm, onConfirm }: GroupProps) {
  const { subtotal: s } = g
  const today = toneOf(s.today)
  return <>
    <tr className="g5-grp">
      <td colSpan={2}><span className="g5-gname g5-al"><span className="g5-t2">{g.mode === 'live' ? tr('实盘') : tr('纸面')}</span><span className="g5-t3">{g.rows.length}</span></span></td>
      <td className="g5-c-net" />
      <td className="g5-n">{s.equity !== null ? <span className="g5-t2" data-n="eq">{fmtAmt(s.equity)}</span> : null}</td>
      <td className="g5-n">{s.available !== null ? <span className="g5-t2" data-n="av">{fmtAmt(s.available)}</span> : null}</td>
      <td />
      <td className="g5-n">{s.today !== null ? <span data-n="td"><Amount value={fmtSigned(s.today)} tone={today} /></span> : null}</td>
      <td />
    </tr>
    {g.rows.map(({ account: a, state: st }) => {
      const sel = a.accountId === selected
      const t = st.summary ? toneOf(st.summary.today) : 'neutral'
      const r = recon[a.venue]
      return <Fragment key={a.accountId}>
        <tr className={['g5-row', 'g5-h40', 'g5f-r40', sel ? 'g5f-sel' : ''].filter(Boolean).join(' ')} data-acct={a.accountId} data-mode={a.mode} aria-selected={sel}
          tabIndex={0} onClick={() => onSelect(a.accountId)} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onSelect(a.accountId) } }}>
          <td><span className="g5-t1 g5-al">{accountLabel(a.accountId, a.alias)}</span></td>
          <td className="g5-fill g5f-vm">{a.mode === 'live'
            ? <span className="g5f-ib"><VenueIcon venue={a.venue} label={VENUE_NAME[a.venue] ?? a.venue} />{st.unverified ? <span className="g5-unv" title={tr('未经真网验证，仅限测试网 / 模拟盘')}><WarnIcon />{tr('未验证')}</span> : null}</span>
            : <span className="g5f-ib"><span className="g5-papermk" title={tr('纸面账户')} /><span className="g5-t2">{tr('模拟盘')}</span></span>}</td>
          <td className="g5-c-net"><span className="g5-t2">{networkText(a)}</span></td>
          {st.unreachable
            ? <td className="g5-n" colSpan={2}><span className="g5f-ib g5-s12 g5-t3" data-row-state="unreachable">{tr('场所不可达')}
              <button type="button" className="g5-btn g5-btn-ghost g5-lnk" data-act="reconnect" disabled={off || r?.busy} onClick={(e) => { e.stopPropagation(); onReconnect(a.venue) }}>{r?.busy ? tr('重连中…') : tr('重连')}</button>
              {r?.err ? <ErrorText message={r.err} /> : null}</span></td>
            : <>
              <td className="g5-n" data-n="eq">{st.summary ? fmtAmt(st.summary.equity) : <span className="g5-t3">{fmtAmt(null)}</span>}</td>
              <td className="g5-n" data-n="av">{st.summary ? fmtAmt(st.summary.available) : <span className="g5-t3">{fmtAmt(null)}</span>}</td>
            </>}
          <td>{st.unreachable || st.ratio === null ? null : <span className="g5-mr"><span className="g5-bar"><i className={marginWarn(st.ratio) ? 'g5-w' : undefined} style={{ width: `${barPct(st.ratio)}%` }} /></span><span className={['g5-v', marginWarn(st.ratio) ? 'g5-warn' : ''].filter(Boolean).join(' ')} data-n="mr">{fmtPct(st.ratio)}</span></span>}</td>
          <td className="g5-n">{st.unreachable || !st.summary ? null : <span data-n="td"><Amount value={fmtSigned(st.summary.today)} tone={t} /></span>}</td>
          <td className="g5-n"><span className="g5-acts">
            <button type="button" className="g5-btn g5-btn-ghost" data-act="records" disabled={off} onClick={(e) => { e.stopPropagation(); onRecords(a) }}>{tr('记录')}</button>
            {a.mode === 'paper' ? <button type="button" className="g5-btn g5-btn-ghost" data-act="reset" disabled={off || armed?.id === a.accountId} onClick={(e) => { e.stopPropagation(); onArm(a) }}>{tr('重置')}</button> : null}
          </span></td>
        </tr>
        {armed && armed.id === a.accountId ? <tr className="g5f-xrow"><td colSpan={8}>
          <div className="g5-armed" role="group" aria-label={tr('重置纸面账户')} data-armed="">
            <span className="g5-what g5-al">{armed.err ?? armed.text ?? tr('读取持仓与挂单…')}</span>
            {armed.busy ? null : <button type="button" className="g5-btn g5-btn-ghost" data-act="reset-cancel" onClick={onDisarm}>{tr('取消')}</button>}
            <button type="button" className="g5-btn g5-btn-kill" data-act="reset-confirm" disabled={!armed.ready || armed.text === null || armed.busy} onClick={onConfirm}><ShieldIcon />{armed.busy ? tr('重置中…') : tr('确认重置')}</button>
          </div>
        </td></tr> : null}
      </Fragment>
    })}
  </>
}

// ---- 权益曲线 ----------------------------------------------------------------------------

function useSize(): [(el: HTMLElement | null) => void, { w: number; h: number }] {
  const [size, setSize] = useState({ w: 0, h: 0 })
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    if (typeof ResizeObserver !== 'undefined') { ro.current = new ResizeObserver(measure); ro.current.observe(el) }
  }, [])
  return [ref, size]
}

const AXIS_W = 64
const AXIS_H = 20

function CurveChart({ curve, w, h }: { curve: Curve; w: number; h: number }) {
  const { segments, first, last } = curve
  if (!first || !last || w < AXIS_W + 40 || h < AXIS_H + 40) return null
  const left = 0
  const right = w - AXIS_W
  const top = 8
  const bottom = h - AXIS_H
  const all = segments.flat()
  let lo = Math.min(...all.map((p) => p.v))
  let hi = Math.max(...all.map((p) => p.v))
  const minSpan = Math.abs(last.v) * 0.005
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2 }
  const pad = (hi - lo || Math.abs(hi) * 0.002 || 1) * 0.08
  lo -= pad
  hi += pad
  const t0 = first.t
  const t1 = last.t === first.t ? first.t + 1 : last.t
  const X = (t: number): number => left + ((t - t0) / (t1 - t0)) * (right - left)
  const Y = (v: number): number => top + (1 - (v - lo) / (hi - lo)) * (bottom - top)
  const ticks = niceTicks(lo, hi, Math.max(2, Math.round((bottom - top) / 40)))
  const yBase = Y(first.v)
  const yLast = Y(last.v)
  const near = (y: number): boolean => Math.abs(y - yBase) < 14 || Math.abs(y - yLast) < 14
  const days = timeTicks(t0, t1).filter((d) => X(d.t) > left + 16 && X(d.t) < right - 16)
  const uid = useRef(`g5f-a${Math.random().toString(36).slice(2, 8)}`).current
  const fmt0 = fmtTicks(ticks)
  const baseLabel = Math.abs(yLast - yBase) >= 14 // 最新值贴着期初时只留最新值，期初仍由左侧「期初」+ 基准虚线标出
  return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={tr('权益曲线')} data-g5-chart="equity">
    <defs><linearGradient id={uid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="g5f-area-top" /><stop offset="1" className="g5f-area-bot" /></linearGradient></defs>
    {ticks.map((v) => <line key={v} className="g5-eq-grid" x1={left} x2={right} y1={Math.round(Y(v)) + 0.5} y2={Math.round(Y(v)) + 0.5} />)}
    {segments.map((s, i) => s.length > 1
      ? <path key={`a${i}`} d={`M${X(s[0]!.t)} ${bottom}${s.map((p) => `L${X(p.t)} ${Y(p.v)}`).join('')}L${X(s[s.length - 1]!.t)} ${bottom}Z`} className="g5-eq-area" fill={`url(#${uid})`} stroke="none" />
      : null)}
    <line className="g5-eq-base g5f-base" x1={left} x2={right} y1={Math.round(yBase) + 0.5} y2={Math.round(yBase) + 0.5} />
    {segments.map((s, i) => <polyline key={`l${i}`} className="g5-eq-line g5-nu" data-segment="" points={s.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')} />)}
    <circle className="g5f-end" cx={X(last.t)} cy={yLast} r={4} />
    {ticks.filter((v) => !near(Y(v))).map((v) => <text key={`t${v}`} x={right + 8} y={Y(v) + 4}>{fmt0(v)}</text>)}
    {baseLabel ? <text x={right + 8} y={yBase + 4} className="g5f-t2">{fmtAmt(first.s)}</text> : null}
    <text x={left + 4} y={yBase - 6}>{tr('期初')}</text>
    <text x={right + 8} y={yLast + 4} className="g5f-t1">{fmtAmt(last.s)}</text>
    {days.map((d) => <text key={d.t} x={X(d.t)} y={h - 4} textAnchor="middle">{d.label}</text>)}
  </svg>
}

function CurveCard() {
  const [tab, setTab] = useState<Tab>('7D')
  const x = useForAccount(async (b, a, alive) => {
    const range = rangeOf(tab, Date.now())
    return { raw: await ask(b, 'account.equity_history', { accountId: a.accountId, ...range }, alive), range }
  }, tab)
  useRefresh(x.reload)
  const clock = useOfflineClock(x.reload)
  const [ref, size] = useSize()
  const curve = x.data ? curveOf(x.data.raw, x.data.range.from, x.data.range.to) : null
  const delta = curve?.first && curve.last ? sumStr([curve.last.s, negStr(curve.first.s)]) : null
  const head = <header className="g5-hd"><div className="g5f-hrow">
    <h2 className="g5-al">{tr('权益')}</h2>
    {x.account ? <span className="g5-s12 g5-t2">{x.account.alias}</span> : null}
    <div className="g5-tabs" role="tablist" aria-label={tr('区间')}>
      {TABS.map((k) => <button key={k} type="button" role="tab" className="g5-tab" aria-selected={k === tab} data-tab={k} onClick={() => setTab(k)}>{TAB_TEXT[k]}</button>)}
    </div>
    <div className="g5-r">{clock.off
      ? <span className="g5-s12 g5-t3">{clock.text}</span>
      : curve?.last ? <><span className="g5f-last">{fmtAmt(curve.last.s)}</span><span className="g5-s12" data-redge="eq"><Amount value={fmtSigned(delta)} tone={toneOf(delta)} /></span></> : null}</div>
  </div></header>
  let body: ComponentChildren
  if (x.loading) body = <div className="g5-ghostplot" />
  else if (x.error) body = <Msg error={x.error} onRetry={x.reload} />
  else if (!x.account || !curve?.last) body = <Msg><span className="g5-al">{tr('还没有权益历史')}</span></Msg>
  else body = <div className="g5f-eqc" ref={ref} data-g5="chart"><CurveChart curve={curve} w={size.w} h={size.h} /></div>
  return <Card head={head} className={cardClass(true, clock.off)} {...page('curve')} {...offAttr(clock.off)} id="eqcard" aria-label={tr('权益')}>{body}</Card>
}

// ---- 资产 --------------------------------------------------------------------------------

function AssetsCard() {
  const x = useForAccount((b, a, alive) => ask(b, 'account.assets', { accountId: a.accountId }, alive))
  useRefresh(x.reload)
  const clock = useOfflineClock(x.reload)
  const rows = x.data ? assetsOf(x.data) : []
  const head = <Head title={tr('资产')} sub={x.account?.alias} right={clock.off ? <span className="g5-s12 g5-t3">{clock.text}</span> : undefined} />
  const cols = <thead><tr><th className="g5-fill g5-al">{tr('资产')}</th><th className="g5-n" data-n="tot">{tr('总额')}</th><th className="g5-n" data-n="av">{tr('可用')}</th><th className="g5-n" data-n="fz">{tr('冻结')}</th><th className="g5-n" data-n="br">{tr('借入')}</th></tr></thead>
  let body: ComponentChildren
  if (x.loading) body = <div className="g5-tw"><table className="g5-tbl">{cols}<tbody><tr className="g5-row g5-h40 g5f-r40"><td className="g5-fill"><Sk w={56} /></td>{[0, 1, 2, 3].map((i) => <td key={i} className="g5-n"><Sk w={64} /></td>)}</tr></tbody></table></div>
  else if (x.error) body = <Msg error={x.error} onRetry={x.reload} />
  else if (!x.account || !rows.length) body = <Msg><span className="g5-al">{tr('还没有资产')}</span></Msg>
  else body = <div className="g5-tw"><table className="g5-tbl">{cols}<tbody>
    {rows.map((r) => <tr key={r.asset} className="g5-row g5-h40 g5f-r40">
      <td className="g5-fill"><span className="g5-sym g5-al">{r.asset}</span></td>
      <td className="g5-n" data-n="tot">{fmtQuantity(r.total)}</td><td className="g5-n" data-n="av">{fmtQuantity(r.available)}</td><td className="g5-n" data-n="fz">{fmtQuantity(r.frozen)}</td>
      <td className="g5-n"><span className="g5-t2" data-n="br">{fmtQuantity(r.borrowed)}</span></td>
    </tr>)}
  </tbody></table></div>
  return <Card head={head} className={cardClass(false, clock.off)} {...page('assets')} {...offAttr(clock.off)} id="assets" aria-label={tr('资产')}>{body}</Card>
}

// ---- 保证金 ------------------------------------------------------------------------------

function MarginCard() {
  const x = useForAccount((b, a, alive) => ask(b, 'account.assets', { accountId: a.accountId }, alive))
  useRefresh(x.reload)
  const clock = useOfflineClock(x.reload)
  const m = x.data ? marginOf(x.data) : null
  const head = <Head title={tr('保证金')} sub={x.account?.alias} right={clock.off ? <span className="g5-s12 g5-t3">{clock.text}</span> : undefined} />
  const warn = marginWarn(m?.ratio ?? null)
  let body: ComponentChildren
  if (x.loading) body = <div className="g5f-mb"><div className="g5-lims">{[0, 1].map((i) => <div key={i} className="g5-lim"><Sk w={24} /><Sk w={160} /><Sk w={64} /><Sk w={72} /></div>)}</div></div>
  else if (x.error) body = <Msg error={x.error} onRetry={x.reload} />
  else if (!x.account || !m) body = <Msg><span className="g5-al">{tr('还没有保证金数据')}</span></Msg>
  else body = <div className="g5f-mb">
    <div className="g5-lims">
      <div className="g5-lim"><span className="g5-k g5-al">{tr('初始')}</span><span className="g5-bar"><i style={{ width: `${m.initialPct}%` }} /></span><span className="g5-v" data-n="mu">{fmtAmt(m.initial)}</span><span className="g5-of">/ {fmtAmt(m.equity)}</span></div>
      <div className="g5-lim"><span className="g5-k g5-al">{tr('维持')}</span><span className="g5-bar"><i className={warn ? 'g5-w' : undefined} style={{ width: `${m.maintPct}%` }} /></span><span className="g5-v" data-n="mu">{fmtAmt(m.maintenance)}</span><span className="g5-of">/ {fmtAmt(m.equity)}</span></div>
    </div>
    <div className="g5f-kv2">
      <div><span className="g5-k g5-al">{tr('可用')}</span><span className="g5-v">{fmtAmt(m.available)}</span></div>
      <div><span className="g5-k">{tr('杠杆')}</span><span className="g5-v">{m.leverage === null ? '—' : `${m.leverage.toFixed(2)}×`}</span></div>
      <div><span className="g5-k g5-al">{tr('保证金率')}</span><span className={`g5-v${warn ? ' g5-warn' : ''}`}>{fmtPct(m.ratio)}</span></div>
    </div>
  </div>
  return <Card head={head} className={cardClass(false, clock.off)} {...page('margin')} {...offAttr(clock.off)} id="margin" aria-label={tr('保证金')}>{body}</Card>
}

// ---- 权益变动 ----------------------------------------------------------------------------

/** 记录接口分页取全（游标由内核给；最多 10 页，一页 500 条）。 */
async function pageAll(b: BlockBridge, params: Record<string, unknown>, alive: () => boolean): Promise<{ items: unknown[] }> {
  const items: unknown[] = []
  let cursor: string | undefined
  for (let i = 0; i < 10; i += 1) {
    const r = await ask<{ items?: unknown[]; next?: string }>(b, 'records.query', { ...params, limit: 500, ...(cursor ? { cursor } : {}) }, alive)
    items.push(...(Array.isArray(r?.items) ? r.items : []))
    cursor = typeof r?.next === 'string' ? r.next : undefined
    if (!cursor) break
  }
  return { items }
}

const DAYS = 7
function ChangesCard() {
  const x = useForAccount(async (b, a, alive): Promise<ChangeRow[] | null> => {
    const to = Date.now()
    const from = to - DAYS * 86_400_000
    const p = { accountId: a.accountId }
    const [hist, fills, funding, positions] = await Promise.all([
      ask(b, 'account.equity_history', { ...p, from, to, step: '1h' }, alive),
      pageAll(b, { ...p, kind: 'fill', sinceTs: from }, alive),
      pageAll(b, { ...p, kind: 'funding', sinceTs: from }, alive),
      ask(b, 'account.positions', p, alive),
    ])
    const curve = curveOf(hist, from, to)
    return changesOf({ first: curve.first, last: curve.last, fills, funding, positions })
  })
  useRefresh(x.reload)
  const clock = useOfflineClock(x.reload)
  const rows = x.data ?? null
  const head = <Head title={tr('权益变动')} right={clock.off ? <span className="g5-s12 g5-t3">{clock.text}</span> : <span className="g5-tb">{DAYS}{tr(' 天')}</span>} />
  let body: ComponentChildren
  if (x.loading) body = <div className="g5f-chg">{[0, 1, 2].map((i) => <div key={i} className="g5f-cr"><Sk w={64} /><Sk w={72} /></div>)}</div>
  else if (x.error) body = <Msg error={x.error} onRetry={x.reload} />
  else if (!rows) body = <Msg><span className="g5-al">{tr('这段时间没有权益变动')}</span></Msg>
  else body = <div className="g5f-chg">{rows.map((r) => <div key={r.key} className={`g5f-cr${r.key === 'end' ? ' g5f-total' : ''}`} data-row={r.key}>
    <span className="g5-k g5-al">{r.label}</span>
    <span className="g5-v"><span data-n="chg">{r.key === 'start' || r.key === 'end' ? fmtAmt(r.value) : <Amount value={fmtSigned(r.value)} tone={r.tone} />}</span></span>
    <span className="g5-d">{r.detail}</span>
  </div>)}</div>
  return <Card head={head} className={cardClass(true, clock.off)} {...page('changes')} {...offAttr(clock.off)} id="chg" aria-label={tr('权益变动')}>{body}</Card>
}

// ---- 组合 --------------------------------------------------------------------------------

const SCOPE_TEXT = { live: tr('实盘'), paper: tr('纸面') } as const
const venueLabel = (key: string): string => VENUE_NAME[key] ?? key
const symLabel = (key: string): string => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key)

/** 一节：分隔行（只有「场所 / 策略 / 标的」一个词）+ 两列定义表。三节在卡内横排（卡在固定高度的列里，竖排放不下）。 */
function PSection({ name, rows, first, render }: { name: string; rows: PortfolioRow[]; first?: boolean; render(r: PortfolioRow): ComponentChildren }) {
  return <div className="g5f-pcol" data-section={name}>
    <div className="g5f-pxh"><span className={first ? 'g5-al' : undefined}>{name}</span><span>{rows.length}</span></div>
    <div className="g5-defs g5f-pdefs">{rows.length ? rows.map((r) => <div key={r.key} data-row={r.key}>{render(r)}</div>) : <div><span className={`g5-k g5-t3${first ? ' g5-al' : ''}`}>{tr('无')}</span></div>}</div>
  </div>
}

function PortfolioCard() {
  const [scope, setScope] = useState<'live' | 'paper' | null>(null)
  const x = useLoad(async (b, alive) => portfolioView(await ask(b, 'portfolio.analysis', scope ? { scope } : {}, alive)), scope ?? '')
  useRefresh(x.reload)
  const clock = useOfflineClock(x.reload)
  const m = x.data
  const scopes = m && m.kind !== 'unavailable' ? m.scopes : []
  const cur = m && m.kind !== 'unavailable' ? m.scope : scope
  const menu = scopes.length === 2 && cur
    ? <Menu label={tr('口径')} value={cur} onValueChange={(id) => { if (id === 'live' || id === 'paper') setScope(id) }} items={scopes.map((s) => ({ id: s, label: SCOPE_TEXT[s] }))} align="end"
      trigger={<button type="button" className="g5-dd" data-act="portfolio-scope" disabled={clock.off}>{SCOPE_TEXT[cur]}<svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg></button>} />
    : null
  const head = <Head title={tr('组合')} sub={m?.kind === 'ready' ? m.ccy : undefined} right={clock.off ? <span className="g5-s12 g5-t3">{clock.text}</span> : menu ?? undefined} />
  let body: ComponentChildren
  if (x.loading) body = <div className="g5f-port" aria-busy="true">{[tr('场所'), tr('策略'), tr('标的')].map((n) => <div key={n} className="g5f-pcol"><div className="g5f-pxh"><Sk w={24} /></div><div className="g5-defs g5f-pdefs">{[0, 1].map((i) => <div key={i}><Sk w={56} /><Sk w={72} /></div>)}</div></div>)}</div>
  else if (x.error && !m) body = <Msg error={x.error} onRetry={x.reload} />
  else if (!m) body = <Msg><span className="g5-al">{tr('没有持仓')}</span></Msg>
  else if (m.kind === 'unavailable') body = <div className="g5f-msg g5f-pna" data-state="unavailable"><span className="g5-al">{tr('无法估值')}</span>{m.details.map((d, i) => <span key={i} className="g5-msg">{d}</span>)}</div>
  else if (m.kind === 'empty') body = <Msg><span className="g5-al">{tr('没有持仓')}</span></Msg>
  else body = <div className="g5f-port">
    <PSection name={tr('场所')} first rows={m.venues} render={(r) => <><span className="g5-k g5-al">{r.key === '__rest' ? <span className="g5-t3">{r.label}</span> : venueLabel(r.key)}</span><span className="g5-v"><span className="g5-t3" data-n="va">{fmtAmt(r.amount)}</span><span data-n="vs">{sharePct(r.share)}</span></span></>} />
    <PSection name={tr('策略')} rows={m.strategies} render={(r) => <><span className={`g5-k${r.key === 'unassigned' || r.key === '__rest' ? ' g5-t3' : ''}`}>{r.label}</span><span className="g5-v"><span data-n="pp"><Amount value={fmtSigned(r.amount)} tone={r.tone} /></span></span></>} />
    <PSection name={tr('标的')} rows={m.instruments} render={(r) => <><span className="g5-k">{r.key === '__rest' ? <span className="g5-t3">{r.label}</span> : <span className="g5-sym">{symLabel(r.key)}</span>}</span><span className="g5-v"><span className="g5-t3" data-n="ia">{fmtAmt(r.amount)}</span><span data-n="is">{sharePct(r.share)}</span></span></>} />
  </div>
  return <Card head={head} className={cardClass(false, clock.off)} {...page('portfolio')} {...offAttr(clock.off)} id="portfolio" aria-label={tr('组合')}>{body}</Card>
}

// ---- 块 ----------------------------------------------------------------------------------

export const FUNDS_VIEWS = ['accounts', 'curve', 'assets', 'margin', 'changes', 'portfolio'] as const
export type FundsView = typeof FUNDS_VIEWS[number]

export function FundsBlock({ config }: Pick<BlockProps, 'config'>) {
  const view = typeof config?.view === 'string' && (FUNDS_VIEWS as readonly string[]).includes(config.view) ? (config.view as FundsView) : 'accounts'
  switch (view) {
    case 'curve': return <CurveCard />
    case 'assets': return <AssetsCard />
    case 'margin': return <MarginCard />
    case 'changes': return <ChangesCard />
    case 'portfolio': return <PortfolioCard />
    default: return <AccountsCard />
  }
}
