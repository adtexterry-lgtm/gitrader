// SPDX-License-Identifier: CPAL-1.0
// 设置 · 交易所：场所 / 账户 / 可接入 / 详情四张卡（块 venues 的 view = venues | accounts | catalog | detail）。
// 数据全经桥：config.view（只回句柄名与是否就位）、venue.status、写命令 config.venues.set / venue.reconnect。
// 界面永不收密钥值：凭据栏只编辑 env:VAR 句柄名，填了别的东西就遮蔽并拒发；放宽（启用交易场所、新实盘、切主网）由内核要 PIN，壳弹层处理，块只看最终结果。
import './venues.css'
import { Fragment, type ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import { KernelError, type BlockBridge } from '@gitrader/blocks-sdk'
import type { ConfigView } from '@gitrader/protocol'
import { runCommand } from '../../../blocks-default/src/actions'
import { queryRetry, useNow, useOffline, useRes } from '../../../blocks-default/src/hooks'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import { copyText } from '@gitrader/workbench/ui'
import { cli } from '@gitrader/workbench/launcher'
import { Card, Unwired, VenueIcon, wireState } from '../kit'
import {
  CONN_LABEL, RESTART_CMD, SINGLE_LIVE_VENUES, UNVERIFIED_WHY, accountsOf, applyPatch, availableCatalog, catalogOf, createStore, credentialRows, draftIssues, gate, isHandle,
  liveAccountOf, normalizeConfig, parseBalance, parseVenueStatus, paperCcyFor, patchAddAccount, patchAttachVenue, patchCredentials, patchDeleteAccount, patchPaperBalance, patchVenueEnabled,
  patchVenueEnv, venueName as configuredVenueName, venueRows, type ConnInfo, type Gate, type Store, type VenueRow, type VenuesPatch,
} from '../model-config'
import { getLang, t as tr } from '@gitrader/workbench/i18n'

const venueName = (id: string) => VENUE_NAME[id] ?? configuredVenueName(id)
/** UX-21：表头是单数（英文 Exchange）；卡标题、设置页签仍用复数 Exchanges（同一个中文键「交易所」在词表里是复数）。 */
const venueCol = (): string => (getLang() === 'en' ? 'Exchange' : tr('交易所'))

// ---- 小件（通知页也用）-----------------------------------------------------------------------------------------------

const ICONS: Record<string, ComponentChildren> = {
  warn: <><path d="M12 4.5l8.5 15h-17L12 4.5z" /><path d="M12 10.5v4" /><path d="M12 17.25v.01" /></>,
  block: <><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  chev: <path d="M7 10l5 5 5-5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></>,
  send: <><path d="M4.5 11.5l15-7-5.5 15-2.5-6.5z" /><path d="M11.5 13l8-8.5" /></>,
}
export function Ico({ name, small = false }: { name: keyof typeof ICONS; small?: boolean }) {
  return <svg className={small ? 'g5-i g5-i12' : 'g5-i'} viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>
}

/** gh：右侧末尾是幽灵钮（复制命令 / 添加…），整组右移 8 让钮的文字落在 20 线上（设计稿 .r.gh）。 */
export function Head({ title, count, right, gh }: { title: ComponentChildren; count?: ComponentChildren; right?: ComponentChildren; gh?: boolean }) {
  return <header className="g5-hd"><h2 className="g5-al">{title}</h2>{count != null ? <span className="g5-ct">{count}</span> : null}{right != null ? <div className={cx('g5-r', gh && 'g5-gh')}>{right}</div> : null}</header>
}

export function cx(...parts: Array<string | false | null | undefined>): string { return parts.filter(Boolean).join(' ') }

export const Skel = ({ w, h }: { w: number; h?: number }) => <span className="g5-sk" style={{ width: `${w}px`, ...(h ? { height: `${h}px` } : {}) }} />

/** 同页几张卡共用的小仓：钩子让它在变化时重绘。 */
export function useStore<T extends object>(store: Store<T>): T {
  const [, tick] = useState(0)
  useEffect(() => store.subscribe(() => tick((n) => n + 1)), [store])
  return store.get()
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 离线（壳挂 html[data-offline]）：卡变灰、控件禁用；右上写已暂停多久。 */
export function useElapsed(on: boolean): string {
  const since = useRef(0)
  if (on && since.current === 0) since.current = Date.now()
  if (!on) since.current = 0
  const now = useNow(1000)
  if (!on) return ''
  const s = Math.max(0, Math.floor((now - since.current) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
export function OffNote({ elapsed }: { elapsed: string }) { return <span className="g5-s12 g5-t3">{tr('已暂停更新 · ')}{elapsed}</span> }

export function PageMsg({ children }: { children: ComponentChildren }) { return <div className="g5-pmsg">{children}</div> }

// ---- 配置读取与写入（共享）-----------------------------------------------------------------------------------------------

export interface PageState { config: ConfigView | null; restart: boolean; arm: Arm | null; selected: string | null; statusRev: number }
export interface Arm {
  /** 武装行出现在哪张卡里 */
  card: string
  what: string
  confirm: string
  loosen: boolean
  danger: boolean
  run(): Promise<{ ok: true } | { ok: false; message: string }>
}
export const venuesState = createStore<PageState>({ config: null, restart: false, arm: null, selected: null, statusRev: 0 })

export interface Cfg { config: ConfigView | undefined; loading: boolean; error: Error | undefined; off: boolean; reload(): void; status: Record<string, ConnInfo>; offline: boolean; elapsed: string }
/** 读 config.view（可选 venue.status，5 秒一轮）。写成功后的新配置经共享仓立刻给所有卡。 */
export function useCfg(store: Store<PageState>, withStatus = false): Cfg {
  const bridge = useBridge()
  const st = useStore(store)
  const cfgRes = useRes<unknown>('config.view')
  const [statusRaw, setStatusRaw] = useState<unknown>(undefined)
  const offline = useOffline(() => { cfgRes.reload(); store.set({ statusRev: store.get().statusRev + 1 }) })
  const elapsed = useElapsed(offline)
  useEffect(() => {
    const n = cfgRes.data === undefined ? undefined : normalizeConfig(cfgRes.data)
    // 同页几张卡各读一次：内容相同就不换对象（换了，详情里正在输的草稿会被当成「配置变了」清掉）
    const cur = store.get().config
    if (n?.ok && (!cur || JSON.stringify(cur) !== JSON.stringify(n.config))) store.set({ config: n.config })
  }, [cfgRes.data])
  // venue.status 每 5 秒一轮（不订阅：块清单不申请 account.read）；失败就不显示连接态，不报错
  useEffect(() => {
    if (!withStatus || offline) return undefined
    let dead = false
    // UX-10：读失败就清掉上一轮的快照（以前留着，断网后表格一直写「已连接」，顶栏已是「已断开」）
    const load = () => { queryRetry<unknown>(bridge, 'venue.status', undefined, () => !dead).then((d) => { if (!dead) setStatusRaw(d) }, () => { if (!dead) setStatusRaw(undefined) }) }
    load()
    const t = setInterval(load, 5000)
    return () => { dead = true; clearInterval(t) }
  }, [withStatus, offline, bridge, st.statusRev])
  const norm = cfgRes.data === undefined ? undefined : normalizeConfig(cfgRes.data)
  const config = st.config ?? (norm?.ok ? norm.config : undefined)
  const error = cfgRes.error ?? (norm && !norm.ok ? (norm.failure !== undefined ? new Error(norm.failure) : new KernelError(-32601, tr('config.view 缺字段 {0}', norm.missing))) : undefined)
  return {
    config, loading: cfgRes.loading && !config, error, off: error ? wireState(error) === 'off' : false, reload: cfgRes.reload,
    status: withStatus ? parseVenueStatus(statusRaw) : {}, offline, elapsed,
  }
}

/** 取不到数据时卡里放什么：加载 = 骨架；接口不存在 = 未接通 + 原文，不给重试；其余错误 = 原文 + 重试。 */
export function stateBody(c: Cfg, skeleton: ComponentChildren): ComponentChildren | null {
  if (c.config) return null
  if (c.loading) return skeleton
  if (c.off) return <PageMsg><Unwired message={c.error?.message ?? ''} /></PageMsg>
  return <PageMsg><span className="g5-al">{tr('读取失败')}</span><span className="g5-src">{c.error ? errText(c.error) : ''}</span><button type="button" className="g5-btn g5-btn-fill" onClick={c.reload}>{tr('重试')}</button></PageMsg>
}

type Wrote = { ok: true } | { ok: false; message: string; cancelled: boolean }
/** 写 config.venues.set：成功就把回包里的新配置放进共享仓并标「待重启」；失败原文返回。 */
export async function writeVenues(bridge: BlockBridge, store: Store<PageState>, patch: VenuesPatch): Promise<Wrote> {
  const r = await runCommand<{ config?: unknown; restartRequired?: boolean }>(bridge, 'config.venues.set', { patch })
  if (!r.ok) return { ok: false, message: r.message, cancelled: r.cancelled }
  const n = normalizeConfig(r.value?.config)
  store.set({ ...(n.ok ? { config: n.config } : {}), restart: store.get().restart || r.value?.restartRequired === true })
  return { ok: true }
}

/** 一次要做的改动：收紧直接写；放宽（要 PIN）先武装，确认后才发；内核会拒的（未验证主网）直接给原因、不发。 */
export interface Change { card: string; patch: VenuesPatch; what: string; confirm: string; danger?: boolean }
export async function request(bridge: BlockBridge, store: Store<PageState>, config: ConfigView, c: Change, setNote: (m: string) => void): Promise<void> {
  const g: Gate = gate(config, applyPatch(config, c.patch))
  if (g.kind === 'refuse') { setNote(g.why); return }
  const run = async () => {
    const r = await writeVenues(bridge, store, c.patch)
    if (r.ok) { store.set({ arm: null }); return { ok: true as const } }
    return { ok: false as const, message: r.message }
  }
  if (g.kind === 'pin' || c.danger) { store.set({ arm: { card: c.card, what: c.what, confirm: c.confirm, loosen: g.kind === 'pin', danger: c.danger === true, run } }); return }
  const r = await run()
  if (!r.ok) setNote(r.message)
}

/** 武装行（G2）：确认前 600 ms 死区、焦点落「取消」、Esc 取消、失败保持武装并给内核原文。放宽 = 中性底 + 锁 + 琥珀确认；删除 = 危险红。 */
export function ArmedRow({ arm, onCancel }: { arm: Arm; onCancel(): void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const born = useRef(performance.now())
  const hover = useRef(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const off = useOffline()
  useEffect(() => { born.current = performance.now(); cancel.current?.focus() }, [arm])
  // 离线就解除武装（命令发不出去）；闲置 10 秒自动解除（指针悬停 / 焦点在组内时不计），防止拿着旧快照的补丁晚点才发
  useEffect(() => { if (off && !busy) onCancel() }, [off])
  useEffect(() => {
    const t = setInterval(() => { if (!hover.current && !busy && !wrap.current?.contains(document.activeElement) && performance.now() - born.current > 10_000) onCancel() }, 1000)
    return () => clearInterval(t)
  }, [arm, busy])
  const go = async () => {
    if (busy || off || performance.now() - born.current < 600) return
    setBusy(true)
    setErr('')
    const r = await arm.run()
    setBusy(false)
    if (!r.ok) { setErr(r.message); born.current = performance.now() - 600 }
  }
  return (
    <div ref={wrap} className="g5-armwrap" onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }} onPointerEnter={() => { hover.current = true }} onPointerLeave={() => { hover.current = false }}>
      <div className={cx('g5-armed', arm.loosen && 'g5-loosen')} data-armed="true">
        <span className="g5-what g5-al">{arm.what}</span>
        <button type="button" ref={cancel} className="g5-btn g5-btn-ghost" data-act="arm-cancel" onClick={onCancel}>{tr('取消')}</button>
        <button type="button" className={cx('g5-btn', arm.danger ? 'g5-btn-kill' : 'g5-btn-loosen')} data-act="arm-confirm" disabled={busy || off} onClick={() => { void go() }}>
          {arm.loosen ? <Ico name="lock" /> : null}{arm.confirm}
        </button>
      </div>
      {err ? <div className="g5-why g5-rcpt"><span className="g5-bad"><Ico name="block" small /></span><span className="g5-hdl g5-t3">{err}</span></div> : null}
    </div>
  )
}
const ArmSlot = ({ store, card }: { store: Store<PageState>; card: string }) => {
  const st = useStore(store)
  return st.arm && st.arm.card === card ? <ArmedRow arm={st.arm} onCancel={() => store.set({ arm: null })} /> : null
}

export function RestartFlag({ store }: { store: Store<PageState> }) {
  const st = useStore(store)
  const [copied, setCopied] = useState('')
  if (!st.restart) return null
  return <>
    <span className="g5-flag" data-act="restart-flag"><Ico name="warn" small />{tr('待重启')}</span>
    <button type="button" className="g5-btn g5-btn-ghost g5-lnk" data-act="copy-restart" onClick={() => { void copyText(cli(RESTART_CMD)).then((ok) => setCopied(ok ? '' : cli(RESTART_CMD))) }}><Ico name="copy" />{tr('复制命令')}</button>
    {copied ? <span className="g5-hdl g5-t3">{copied}</span> : null}
  </>
}

export function Switch({ on, label, disabled, onToggle }: { on: boolean; label: string; disabled?: boolean; onToggle(): void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} aria-disabled={disabled ? 'true' : undefined} disabled={disabled} className={cx('g5-sw', on && 'g5-on')} onClick={(e) => { e.stopPropagation(); onToggle() }} />
}

export function Inp({ value, onInput, label, mono, bad, unit, wide = true, disabled, placeholder }: { value: string; onInput(v: string): void; label: string; mono?: boolean; bad?: boolean; unit?: string; wide?: boolean; disabled?: boolean; placeholder?: string }) {
  return <div className={cx('g5-inp', 'g5-s', wide && 'g5-l', bad && 'g5-bad')}>
    <input className={mono ? 'g5-mono' : undefined} type={(bad ? 'password' : 'text') as 'text'} value={value} aria-label={label} aria-invalid={bad ? 'true' : undefined} disabled={disabled} placeholder={placeholder}
      autoComplete="off" spellcheck={false} onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)} />
    {unit ? <span className="g5-u">{unit}</span> : null}
  </div>
}

export const Venue = ({ id, size }: { id: string; size?: 'sm' | 'md' | 'lg' }) => <VenueIcon venue={id} label={venueName(id)} size={size ?? 'sm'} />
export const Unv = () => <span className="g5-unv" title={UNVERIFIED_WHY}><Ico name="warn" small />{tr('未验证')}</span>

const skelRows = (cols: number[], rows = 3, head: ComponentChildren) => (
  <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{head}</thead><tbody>
    {Array.from({ length: rows }, (_, i) => <tr key={i} className="g5-row g5-h40">{cols.map((w, j) => <td key={j} className={j === cols.length - 1 ? 'g5-e' : undefined}><Skel w={w} h={j === 0 && w > 80 ? 20 : undefined} /></td>)}</tr>)}
  </tbody></table></div>
)

// ---- 场所 ------------------------------------------------------------------------------------------------------------------

function ConnCell({ row, offline, onReconnect, busy }: { row: VenueRow; offline: boolean; onReconnect(): void; busy: boolean }) {
  if (!row.enabled) return <span className="g5-t3">{tr('未启用')}</span>
  const c = row.conn
  if (!c) return <span className="g5-t3">—</span>
  return <span className="g5-cell">
    <span className={c.state === 'connected' && !offline ? 'g5-tb' : 'g5-t3'}>{CONN_LABEL[c.state]}</span>
    {c.state === 'connected' && c.p50 != null ? <span className="g5-s12 g5-t3">{c.p50} ms</span> : null}
    {c.state === 'disconnected' ? <button type="button" className="g5-btn g5-btn-ghost g5-lnk" disabled={offline || busy} onClick={(e) => { e.stopPropagation(); onReconnect() }}>{tr('重连')}</button> : null}
  </span>
}

export function VenuesCard() {
  const bridge = useBridge()
  const cfg = useCfg(venuesState, true)
  const st = useStore(venuesState)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const head = (right?: ComponentChildren, count?: number) => <Head title={tr('交易所')} count={count} right={right} gh={st.restart && !cfg.offline} />
  const thead = <tr><th className="g5-al">{venueCol()}</th><th>{tr('类型')}</th><th>{tr('环境')}</th><th className="g5-fill">{tr('连接')}</th><th className="g5-n" data-n="vac">{tr('账户')}</th><th className="g5-e">{tr('启用')}</th></tr>
  const pending = stateBody(cfg, skelRows([96, 28, 40, 88, 12, 28], 3, thead))
  if (!cfg.config) return <Card head={head()} className="g5-pgcard" data-venues-view="venues" data-geo="venues">{pending}</Card>
  const config = cfg.config
  const rows = venueRows(config, cfg.status)
  const selected = st.selected ?? rows[0]?.id
  const right = cfg.offline ? <OffNote elapsed={cfg.elapsed} /> : <RestartFlag store={venuesState} />
  const toggle = (r: VenueRow) => {
    setNote('')
    const on = !r.enabled
    void request(bridge, venuesState, config, { card: 'venues', patch: patchVenueEnabled(config, r.id, on), what: tr('启用 {0} 交易：重启后生效', r.name), confirm: tr('确认启用') }, setNote)
  }
  const reconnect = async (id: string) => {
    setBusy(true)
    const r = await runCommand(bridge, 'venue.reconnect', { venue: id })
    setBusy(false)
    setNote(r.ok ? '' : r.message)
    venuesState.set({ statusRev: venuesState.get().statusRev + 1 })
  }
  return (
    <Card head={head(right, rows.length)} className={cx('g5-pgcard', cfg.offline && 'g5-off')} data-venues-view="venues" data-geo="venues">
      {rows.length === 0 ? <PageMsg><span className="g5-al">{tr('还没有交易所')}</span></PageMsg> : (
        <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{thead}</thead><tbody>
          {rows.map((r) => (
            <tr key={r.id} className="g5-row g5-h40" data-venue={r.id} aria-selected={selected === r.id ? 'true' : undefined} tabIndex={0}
              onClick={() => venuesState.set({ selected: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') venuesState.set({ selected: r.id }) }}>
              <td><span className="g5-cell g5-al"><Venue id={r.id} />{r.verified ? null : <Unv />}</span></td>
              <td>{r.kind === 'trading' ? tr('交易') : tr('行情')}</td>
              <td>{r.environment === 'mainnet' ? tr('主网') : tr('测试网')}</td>
              <td className="g5-fill"><ConnCell row={r} offline={cfg.offline} busy={busy} onReconnect={() => { void reconnect(r.id) }} /></td>
              <td className="g5-n" data-n="vac">{r.accounts}</td>
              <td className="g5-e"><Switch on={r.enabled} label={tr('{0} 启用', r.name)} disabled={cfg.offline} onToggle={() => toggle(r)} /></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {note ? <div className="g5-pmsg"><span className="g5-bad"><Ico name="block" small /></span><span className="g5-hdl g5-t3" data-act="venues-note">{note}</span></div> : null}
      <ArmSlot store={venuesState} card="venues" />
    </Card>
  )
}

// ---- 账户 ------------------------------------------------------------------------------------------------------------------

function CredCell({ config, index }: { config: ConfigView; index: number }) {
  const rows = credentialRows(config, index)
  if (!rows.length) return <span className="g5-t3">{tr('无需')}</span>
  const pieces = (r: (typeof rows)[number]) => <><span className="g5-hdl">{r.handle}</span>{r.state === 'ready' ? <span className="g5-ok">{tr('已就位')}</span> : r.state === 'missing' ? <span className="g5-miss"><Ico name="warn" small />{tr('缺失')}</span> : null}</>
  return rows.length === 1 ? <span className="g5-cell">{pieces(rows[0]!)}</span> : <span className="g5-stack">{rows.map((r) => <span key={r.path}>{pieces(r)}</span>)}</span>
}

export function AccountsCard() {
  const bridge = useBridge()
  const cfg = useCfg(venuesState)
  const [note, setNote] = useState('')
  const thead = <tr><th className="g5-al">{tr('别名')}</th><th>{venueCol()}</th><th>{tr('模式')}</th><th className="g5-fill">{tr('凭据')}</th><th className="g5-e" /></tr>
  const pending = stateBody(cfg, skelRows([56, 96, 28, 160, 88], 3, thead))
  if (!cfg.config) return <Card head={<Head title={tr('账户')} />} className="g5-pgcard" data-venues-view="accounts" data-geo="accts">{pending}</Card>
  const config = cfg.config
  const right = cfg.offline ? <OffNote elapsed={cfg.elapsed} /> : undefined
  return (
    <Card head={<Head title={tr('账户')} count={config.accounts.length} right={right} />} className={cx('g5-pgcard', cfg.offline && 'g5-off')} data-venues-view="accounts" data-geo="accts">
      {config.accounts.length === 0 ? <PageMsg><span className="g5-al">{tr('还没有账户')}</span></PageMsg> : (
        <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{thead}</thead><tbody>
          {config.accounts.map((a, i) => (
            <tr key={a.accountId ?? a.alias} className={cx('g5-row', credentialRows(config, i).length < 2 && 'g5-h40')} data-account={a.alias}>
              <td><span className="g5-tb g5-al">{a.alias}</span></td>
              <td><Venue id={a.venue} /></td>
              <td>{a.mode === 'live' ? <span className="g5-t1">{tr('实盘')}</span> : <span className="g5-cell"><span className="g5-papermk" title={tr('纸面账户')} /><span className="g5-t2">{tr('纸面')}</span></span>}</td>
              <td className="g5-fill"><CredCell config={config} index={i} /></td>
              <td className="g5-e"><span className="g5-acts">
                <button type="button" className="g5-btn g5-btn-ghost" disabled={cfg.offline} data-act="account-edit" onClick={() => venuesState.set({ selected: a.venue })}>{tr('编辑')}</button>
                <button type="button" className="g5-btn g5-btn-ghost" disabled={cfg.offline} data-act="account-delete" onClick={() => {
                  setNote('')
                  void request(bridge, venuesState, config, { card: 'accts', patch: patchDeleteAccount(config, i), what: tr('删除{0}账户 {1}：重启后生效', a.mode === 'live' ? tr('实盘') : tr('纸面'), a.alias), confirm: tr('确认删除'), danger: true }, setNote)
                }}>{tr('删除')}</button>
              </span></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {note ? <div className="g5-pmsg"><span className="g5-bad"><Ico name="block" small /></span><span className="g5-hdl g5-t3">{note}</span></div> : null}
      <ArmSlot store={venuesState} card="accts" />
    </Card>
  )
}

// ---- 可接入 ----------------------------------------------------------------------------------------------------------------

export function CatalogCard() {
  const bridge = useBridge()
  const cfg = useCfg(venuesState)
  const [note, setNote] = useState('')
  const [expOpen, setExpOpen] = useState(false) // UX-24：未验证的交易所默认折叠进「实验性」，不跟已验证的并排
  const thead = <tr><th className="g5-al">{venueCol()}</th><th>{tr('类型')}</th><th className="g5-fill">{tr('凭据')}</th><th className="g5-e" /></tr>
  const pending = stateBody(cfg, skelRows([96, 28, 160, 56], 3, thead))
  if (!cfg.config) return <Card head={<Head title={tr('可接入')} />} className="g5-pgcard g5-grow" data-venues-view="catalog" data-geo="catalog">{pending}</Card>
  const config = cfg.config
  const list = availableCatalog(config)
  const experimental = list.filter((c) => !c.verified)
  const items = [...list.filter((c) => c.verified), ...(experimental.length ? ['exp' as const] : []), ...(expOpen ? experimental : [])]
  const right = cfg.offline ? <OffNote elapsed={cfg.elapsed} /> : undefined
  return (
    <Card head={<Head title={tr('可接入')} count={list.length} right={right} />} className={cx('g5-pgcard', 'g5-grow', cfg.offline && 'g5-off')} data-venues-view="catalog" data-geo="catalog">
      {list.length === 0 ? <PageMsg><span className="g5-al">{tr('连接器都已接入')}</span></PageMsg> : (
        <div className="g5-tw"><table className="g5-tbl g5-mid"><thead>{thead}</thead><tbody>
          {items.map((c) => c === 'exp' ? (
            <tr key="exp" className="g5-row g5-h40" data-catalog-exp>
              <td colSpan={4}><button type="button" className="g5-btn g5-btn-ghost g5-lnk" aria-expanded={expOpen} data-act="catalog-exp" onClick={() => setExpOpen(!expOpen)}><Ico name={expOpen ? 'chev' : 'plus'} small />{tr('实验性 · {0}', experimental.length)}<span className="g5-s12 g5-t3">{tr('0.1.1 未验证，不建议接实盘')}</span></button></td>
            </tr>
          ) : (
            <tr key={c.venue} className="g5-row g5-h40" data-catalog={c.venue}>
              <td><span className="g5-cell g5-al"><Venue id={c.venue} />{c.verified ? null : <Unv />}</span></td>
              <td>{c.kind === 'trading' ? tr('交易') : tr('行情')}</td>
              <td className="g5-fill">{c.credentials.length ? <span className="g5-hdl g5-t3">{c.credentials.join(tr('　'))}</span> : <span className="g5-t3">{tr('无需')}</span>}</td>
              <td className="g5-e"><span className="g5-acts"><button type="button" className="g5-btn g5-btn-ghost" disabled={cfg.offline} data-act="catalog-attach" onClick={() => {
                setNote('')
                void request(bridge, venuesState, config, { card: 'catalog', patch: patchAttachVenue(config, c.venue), what: tr('启用 {0} {1}：重启后生效', venueName(c.venue), c.kind === 'trading' ? tr('交易') : tr('行情')), confirm: tr('确认接入') }, setNote)
              }}>{c.kind === 'trading' ? <Ico name="lock" small /> : null}{tr('接入')}</button></span></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {note ? <div className="g5-pmsg"><span className="g5-bad"><Ico name="block" small /></span><span className="g5-hdl g5-t3">{note}</span></div> : null}
      <ArmSlot store={venuesState} card="catalog" />
    </Card>
  )
}

// ---- 详情 ------------------------------------------------------------------------------------------------------------------

const Stw = ({ children }: { children?: ComponentChildren }) => <span className="g5-stw">{children}</span>
const StateTag = ({ state, bad }: { state: 'ready' | 'missing' | 'unknown'; bad?: boolean }) => bad
  ? <span className="g5-bad"><Ico name="block" small />{tr('不是句柄')}</span>
  : state === 'ready' ? <span className="g5-ok">{tr('已就位')}</span> : state === 'missing' ? <span className="g5-miss"><Ico name="warn" small />{tr('缺失')}</span> : null
const Why = ({ children, icon = 'block' }: { children: ComponentChildren; icon?: keyof typeof ICONS }) => <span className="g5-why"><Ico name={icon} small />{children}</span>

function DetailBody({ cfg, config, venueId }: { cfg: Cfg; config: ConfigView; venueId: string }) {
  const bridge = useBridge()
  const venue = config.venues.find((v) => v.id === venueId)
  const cat = catalogOf(config, venueId)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [balances, setBalances] = useState<Record<string, string>>({})
  const [alias, setAlias] = useState('')
  const [mode, setMode] = useState<'paper' | 'live'>('paper')
  const [fund, setFund] = useState('10,000.00')
  const [addCreds, setAddCreds] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDrafts({}); setBalances({}) }, [config])
  if (!venue) return null
  const row = venueRows(config, cfg.status).find((r) => r.id === venueId)!
  const live = liveAccountOf(config, venueId)
  const accounts = accountsOf(config, venueId)
  const tradingOnly = (cat?.kind ?? 'trading') === 'trading'
  const liveBlocked = !tradingOnly ? tr('该交易所只提供行情') : SINGLE_LIVE_VENUES.has(venueId) && live ? tr('{0} 已有实盘账户 {1}', row.name, live.alias) : ''
  const credKeys = cat?.credentials ?? []
  const off = cfg.offline

  // 凭据句柄草稿：每个已有账户的每个句柄栏
  const draftKey = (i: number, k: string) => `${i}:${k}`
  const issues = draftIssues(drafts)
  const dirtyCreds = Object.entries(drafts).some(([key, v]) => {
    const [i, k] = [Number(key.split(':')[0]), key.slice(key.indexOf(':') + 1)]
    return v !== (config.accounts[i]?.credentials?.[k] ?? '')
  })
  const dirtyBalances = Object.keys(balances).length > 0
  const dirty = dirtyCreds || dirtyBalances
  const balanceBad = Object.values(balances).some((v) => parseBalance(v) === null)
  const addIssues = mode === 'live' ? draftIssues(addCreds) : []
  const aliasTaken = config.accounts.some((a) => a.alias === alias.trim())
  const addReady = alias.trim() !== '' && !aliasTaken && (mode === 'paper' ? parseBalance(fund) !== null : (credKeys.length ? credKeys.every((k) => isHandle(addCreds[k] ?? '')) : (addCreds.signerRef ?? '').trim() !== ''))

  const save = () => {
    setNote('')
    let patch: VenuesPatch = {}
    let base = config
    for (const [key, v] of Object.entries(drafts)) {
      const i = Number(key.split(':')[0])
      const k = key.slice(key.indexOf(':') + 1)
      const acc = base.accounts[i]
      if (!acc || v === (acc.credentials?.[k] ?? '')) continue
      patch = patchCredentials(base, i, { ...(acc.credentials ?? {}), [k]: v })
      base = { ...base, accounts: patch.accounts! }
    }
    for (const [key, v] of Object.entries(balances)) {
      const i = Number(key)
      const b = parseBalance(v)
      if (b === null) continue
      patch = patchPaperBalance(base, i, b)
      base = { ...base, accounts: patch.accounts! }
    }
    if (patch.accounts) void request(bridge, venuesState, config, { card: 'detail', patch, what: tr('保存 {0} 账户设置：重启后生效', row.name), confirm: tr('确认保存') }, setNote)
  }
  const add = () => {
    setNote('')
    let patch = patchAddAccount(config, { alias: alias.trim(), venue: venueId, mode, ...(mode === 'paper' ? { initialBalance: parseBalance(fund) ?? '10000' } : {}) })
    if (mode === 'live') {
      patch = { accounts: patch.accounts!.map((a) => (a.alias === alias.trim()
        ? { ...a, ...(credKeys.length ? { credentials: Object.fromEntries(credKeys.map((k) => [k, addCreds[k] ?? ''])) } : { signerRef: (addCreds.signerRef ?? '').trim() }) }
        : a)) }
    }
    void request(bridge, venuesState, config, { card: 'detail', patch, what: tr('新增{0}账户 {1}：重启后生效', mode === 'live' ? tr('实盘') : tr('纸面'), alias.trim()), confirm: tr('确认添加') }, setNote)
    setAlias('')
  }
  const switchEnv = (environment: 'testnet' | 'mainnet') => {
    if (environment === venue.environment) return
    setNote('')
    void request(bridge, venuesState, config, { card: 'detail', patch: patchVenueEnv(config, venueId, environment), what: tr('{0} 切到{1}：重启后生效', row.name, environment === 'mainnet' ? tr('主网') : tr('测试网')), confirm: tr('确认切换') }, setNote)
  }
  const reconnect = async () => {
    setBusy(true)
    const r = await runCommand(bridge, 'venue.reconnect', { venue: venueId })
    setBusy(false)
    setNote(r.ok ? '' : r.message)
    venuesState.set({ statusRev: venuesState.get().statusRev + 1 })
  }
  const primary = dirty ? tr('保存') : tr('添加账户')
  const primaryDisabled = off || (dirty ? issues.length > 0 || balanceBad : !addReady || addIssues.length > 0)

  return (
    <>
      <div className="g5-fg">
        <span className="g5-k g5-al">{tr('环境')}</span>
        <div className="g5-v"><div className="g5-seg" role="group" aria-label={tr('环境')}>
          <button type="button" aria-pressed={venue.environment === 'testnet'} disabled={off} data-env="testnet" onClick={() => switchEnv('testnet')}>{tr('测试网')}</button>
          <button type="button" aria-pressed={venue.environment === 'mainnet'} disabled={off || !row.verified || !tradingOnly} data-env="mainnet" onClick={() => switchEnv('mainnet')}>{tr('主网')}</button>
        </div></div>
        {!row.verified || !tradingOnly ? <Why>{UNVERIFIED_WHY}</Why> : null}
        <span className="g5-k g5-al">{tr('连接')}</span>
        <div className="g5-v g5-ge">
          {!venue.enabled ? <span className="g5-t3">{tr('未启用')}</span> : row.conn ? <>
            <span className={row.conn.state === 'connected' && !off ? 'g5-tb' : 'g5-t3'}>{CONN_LABEL[row.conn.state]}</span>
            {row.conn.state === 'connected' && row.conn.p50 != null ? <span className="g5-s12 g5-t3">{row.conn.p50} ms</span> : null}
            {row.conn.state === 'disconnected' ? <button type="button" className="g5-btn g5-btn-ghost g5-lnk g5-end" disabled={off || busy} data-act="venue-reconnect" onClick={() => { void reconnect() }}>{tr('重连')}</button> : null}
          </> : <span className="g5-t3">—</span>}
        </div>
        {row.conn?.detail ? <span className="g5-why"><span className="g5-hdl g5-t3">{row.conn.detail}</span></span> : null}
      </div>
      {accounts.map((a) => {
        const i = config.accounts.indexOf(a)
        const creds = credentialRows(config, i)
        return (
          <div key={a.accountId ?? a.alias} data-account-section={a.alias}>
            <div className="g5-sec"><span className="g5-tb g5-al">{a.alias}</span><span>{a.mode === 'live' ? tr('实盘') : tr('纸面')}</span></div>
            <div className="g5-fg">
              {a.mode === 'live' ? creds.map((c) => {
                const editable = c.key !== 'signerRef'
                const dk = draftKey(i, c.key)
                const value = editable ? (drafts[dk] ?? c.handle) : c.handle
                const bad = editable && value !== '' && !isHandle(value)
                return <Fragment key={c.path}>
                  <span className="g5-k g5-al">{editable ? c.key : tr('钥匙库')}</span>
                  <div className="g5-v"><Inp value={value} label={tr('{0} 句柄', c.key)} mono bad={bad} disabled={off || !editable} onInput={(v) => setDrafts({ ...drafts, [dk]: v })} /><Stw><StateTag state={c.state} bad={bad} /></Stw></div>
                </Fragment>
              }) : <>
                <span className="g5-k g5-al">{tr('初始资金')}</span>
                <div className="g5-v"><Inp value={balances[String(i)] ?? fmtMoney(a.paper?.initialBalance)} label={tr('{0} 初始资金', a.alias)} wide={false} unit={a.paper?.ccy} disabled={off}
                  bad={balances[String(i)] !== undefined && parseBalance(balances[String(i)]!) === null} onInput={(v) => setBalances({ ...balances, [String(i)]: v })} /><Stw /></div>
              </>}
            </div>
          </div>
        )
      })}
      <div className="g5-sec"><span className="g5-tb g5-al">{tr('添加账户')}</span></div>
      <div className="g5-fg">
        <span className="g5-k g5-al">{tr('别名')}</span>
        <div className="g5-v"><Inp value={alias} label={tr('别名')} disabled={off} onInput={setAlias} /><Stw>{aliasTaken ? <span className="g5-bad"><Ico name="block" small />{tr('已存在')}</span> : null}</Stw></div>
        <span className="g5-k g5-al">{tr('模式')}</span>
        <div className="g5-v"><div className="g5-seg" role="group" aria-label={tr('模式')}>
          <button type="button" aria-pressed={mode === 'paper'} disabled={off} data-mode="paper" onClick={() => setMode('paper')}><span className="g5-papermk" />{tr('纸面')}</button>
          <button type="button" aria-pressed={mode === 'live'} disabled={off || liveBlocked !== ''} data-mode="live" onClick={() => setMode('live')}>{tr('实盘')}</button>
        </div></div>
        {liveBlocked ? <Why>{liveBlocked}</Why> : null}
        {mode === 'paper' ? <>
          <span className="g5-k g5-al">{tr('初始资金')}</span>
          <div className="g5-v"><Inp value={fund} label={tr('初始资金')} wide={false} unit={paperCcyFor(config, venueId)} disabled={off} bad={parseBalance(fund) === null} onInput={setFund} /><Stw /></div>
        </> : (credKeys.length ? credKeys : ['signerRef']).map((k) => {
          const v = addCreds[k] ?? ''
          const bad = k !== 'signerRef' && v !== '' && !isHandle(v)
          return <Fragment key={k}>
            <span className="g5-k g5-al">{k === 'signerRef' ? tr('钥匙库') : k}</span>
            <div className="g5-v"><Inp value={v} label={tr('{0} 句柄', k)} mono bad={bad} disabled={off} placeholder={k === 'signerRef' ? tr('钥匙库里的名字') : 'env:NAME'} onInput={(x) => setAddCreds({ ...addCreds, [k]: x })} /><Stw><StateTag state="unknown" bad={bad} /></Stw></div>
          </Fragment>
        })}
      </div>
      {note ? <div className="g5-why g5-rcpt g5-pn"><span className="g5-bad"><Ico name="block" small /></span><span className="g5-hdl g5-t3" data-act="detail-note">{note}</span></div> : null}
      <ArmSlot store={venuesState} card="detail" />
      <div className="g5-ffoot g5-pin-b"><span className="g5-lead g5-s12 g5-t3">{tr('重启后生效')}</span>
        <button type="button" className="g5-btn g5-btn-primary" disabled={primaryDisabled} data-act="detail-primary" onClick={dirty ? save : add}>{primary}</button></div>
    </>
  )
}

const fmtMoney = (v: unknown): string => {
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 }) : ''
}

export function DetailCard() {
  const cfg = useCfg(venuesState, true)
  const st = useStore(venuesState)
  const skeleton = <div className="g5-fg g5-pn"><span className="g5-k"><Skel w={32} /></span><div className="g5-v"><Skel w={224} h={32} /></div><span className="g5-k"><Skel w={32} /></span><div className="g5-v"><Skel w={160} /></div></div>
  const pending = stateBody(cfg, skeleton)
  if (!cfg.config) return <Card head={cfg.loading ? <header className="g5-hd"><Skel w={96} h={20} /></header> : <Head title={tr('详情')} />} className="g5-pgcard g5-grow" data-venues-view="detail" data-geo="vdetail">{pending}</Card>
  const config = cfg.config
  const id = st.selected && config.venues.some((v) => v.id === st.selected) ? st.selected : config.venues[0]?.id
  if (!id) return <Card head={<Head title={tr('详情')} />} className="g5-pgcard g5-grow" data-venues-view="detail" data-geo="vdetail"><PageMsg><span className="g5-al">{tr('还没有交易所')}</span></PageMsg></Card>
  const row = venueRows(config, cfg.status).find((r) => r.id === id)!
  const right = cfg.offline ? <OffNote elapsed={cfg.elapsed} /> : <span className="g5-s12 g5-t3">{row.kind === 'trading' ? tr('交易') : tr('行情')}{tr('　账户 ')}{row.accounts}</span>
  const head = <header className="g5-hd"><span className="g5-cell g5-al"><Venue id={id} size="lg" />{row.verified ? null : <Unv />}</span><div className="g5-r">{right}</div></header>
  return <Card head={head} className={cx('g5-pgcard', 'g5-grow', cfg.offline && 'g5-off')} data-venues-view="detail" data-geo="vdetail"><DetailBody key={id} cfg={cfg} config={config} venueId={id} /></Card>
}
