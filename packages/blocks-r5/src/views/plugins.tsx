// SPDX-License-Identifier: CPAL-1.0
// 插件页（r5）：已安装按六类分组 + 「发现」页签。只是插件的管理面；插件自己的界面仍是各自的块。
// 命令：plugin.grant（启用 / 授权；只启用交 permissions: []，新增或放宽权限交声明的全部权限并由现有 PIN 层把关，本页不自己判断）、
// plugin.start / plugin.stop / plugin.uninstall / plugin.reload；列表与详情显示清单里的 license（缺失 = 未声明）；
// 「启用」开关 = 是否在运行（togglePlan，GQ-55）：内核没有停用命令，开关只发 grant / start / stop，失败只提示原文、不锁开关。
import { Fragment } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Icon, toast } from '@gitrader/workbench/ui'
import { runCommand, type CmdResult } from '../../../blocks-default/src/actions'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import { queryRetry, useNow, useOffline } from '../../../blocks-default/src/hooks'
import { Card, Offline, VenueIcon, wireState } from '../kit'
import { RUNNING, enablePlan, normalizePlugins, togglePlan, unverifiedVenues, type Cell, type Compliance, type PluginRow, type PluginsView, type ToggleStep } from '../model-plugins'
import './plugins.css'
import { t as tr } from '@gitrader/workbench/i18n'

type Tab = 'installed' | 'discover'
const SOURCE_LABEL: Record<string, string> = { official: tr('官方'), local: tr('本地'), community: tr('社区') }
const COLS = 11
const DEAD_MS = 600
const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const Unwired = ({ field }: { field: string }) => <span className="g5-ml" data-wire="off"><span className="g5-t3">{tr('未接通')}</span><span className="g5-t3">{field}</span></span>
const Lines = ({ cell }: { cell: Cell<string[]> }) => !cell.wired
  ? <Unwired field={cell.field} />
  : <span className="g5-ml">{cell.value.length ? cell.value.map((v) => <span key={v}>{v}</span>) : <span className="g5-t3">{tr('无')}</span>}</span>

function Health({ row }: { row: PluginRow }) {
  const { label, tone, detail } = row.health
  const head = tone === 'warn' ? <span className="g5-ib g5-warn"><Icon name="alert" size={12} />{label}</span>
    : tone === 'down' ? <span className="g5-ib g5-danger"><Icon name="block" size={12} />{label}</span>
      : <span className={tone === 'ok' ? 'g5-tb' : 'g5-t2'}>{label}</span>
  return <>{head}{detail.wired && detail.value ? <span className="g5-l2">{detail.value}</span> : null}</>
}

const level = (l: Compliance['level'], n: number) => l === 'warn'
  ? <span className="g5-ib g5-warn"><Icon name="alert" size={12} />{tr('警告 ')}{n}</span>
  : <span className="g5-ib g5-danger"><Icon name="block" size={12} />{tr('失败 ')}{n}</span>

function ComplianceCell({ cell }: { cell: Cell<Compliance> }) {
  if (!cell.wired) return <Unwired field={cell.field} />
  return cell.value.level === 'ok' ? <span className="g5-t3">{tr('通过')}</span> : level(cell.value.level, cell.value.count)
}

function Detail({ row, busy, off, onStartStop, onUninstall }: {
  row: PluginRow; busy: boolean; off: boolean
  onStartStop(): void; onUninstall(): void
}) {
  const c = row.compliance
  const running = RUNNING.has(row.state)
  return <div className="g5-xd">
    <span className="g5-k g5-al">{tr('能力')}</span>
    <span className="g5-v">{row.capabilities.length ? row.capabilities.map((x) => <span key={x}>{x}</span>) : <span className="g5-t3">{tr('无')}</span>}</span>
    <span className="g5-k g5-al">{tr('许可证')}</span>
    <span className="g5-v">{row.license}</span>
    <span className="g5-k g5-al">{tr('合规')}</span>
    <span className="g5-v">{c.wired
      ? (c.value.groups.length ? c.value.groups.map((g) => <span key={g.label} className={'g5-ib' + (g.level === 'warn' ? ' g5-warn' : g.level === 'fail' ? ' g5-danger' : '')}>
        <Icon name={g.level === 'ok' ? 'check' : g.level === 'warn' ? 'alert' : 'block'} size={12} />{g.label}</span>) : <span className="g5-t3">{c.value.level === 'fail' ? tr('内核校验未通过') : tr('无')}</span>)
      : <Unwired field={c.field} />}</span>
    {c.wired ? c.value.notes.map((n, i) => <Fragment key={i}><span /><span className={'g5-src' + (n.level === 'fail' ? ' g5-danger' : '')}>
      <Icon name={n.level === 'fail' ? 'block' : 'alert'} size={12} />{n.id}{tr('　')}{n.detail}</span></Fragment>) : null}
    <span className="g5-k g5-al">{tr('签名')}</span>
    <span className="g5-v">{row.signed ? tr('已签名') : tr('未签名')}{row.trusted ? <span>{tr('受信')}</span> : null}
      <span className="g5-xacts">
        {row.ok && row.enabled ? <button type="button" className="g5-btn g5-btn-ghost" data-act="plugin-startstop" disabled={busy || off} onClick={onStartStop}>{running ? tr('停止') : tr('启动')}</button> : null}
        <button type="button" className="g5-btn g5-btn-ghost g5-danger" data-act="plugin-uninstall" disabled={busy || off} onClick={onUninstall}>{tr('卸载')}</button>
      </span>
    </span>
    {row.health.detail.wired ? null : <><span className="g5-k g5-al">{tr('健康')}</span><span className="g5-v"><Unwired field={row.health.detail.field} /></span></>}
  </div>
}

function ArmedRow({ label, what, confirm, kill, busy, onCancel, onConfirm }: { label: string; what: string; confirm: string; kill?: boolean; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const [ready, setReady] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus() // 武装瞬间焦点落「取消」，Enter 连按两次不会执行
    const t = setTimeout(() => setReady(true), DEAD_MS) // 死区：武装后短时间内的确认点击忽略
    return () => clearTimeout(t)
  }, [])
  return <tr className="g5-armrow"><td colSpan={COLS} className="g5-armtd">
    <div className="g5-armed" role="group" aria-label={label} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}>
      <span className="g5-what g5-al">{what}</span>
      <button type="button" ref={cancel} className="g5-btn g5-btn-ghost" data-act="arm-cancel" onClick={onCancel}>{tr('取消')}</button>
      <button type="button" className={'g5-btn ' + (kill ? 'g5-btn-kill' : 'g5-btn-fill')} data-act="arm-confirm" disabled={!ready || busy} onClick={onConfirm}><Icon name="lock" size={14} />{confirm}</button>
    </div>
  </td></tr>
}

/**
 * 列表区高度吸附到整行（稿的 data-snap）：静止时底边不切半行，也不让「组行」孤零零收尾；滚动后半行是正常的。
 * 量的是卡片的可用高度，所以挂在卡片尺寸变化上，不挂在列表自己（否则自己改高度自己触发）。
 */
function useSnap(list: { current: HTMLElement | null }, deps: unknown[]): void {
  useLayoutEffect(() => {
    const host = list.current?.closest<HTMLElement>('[data-g5="card"]')
    if (!host) return undefined
    const snap = () => {
      const s = list.current
      if (!s) return
      s.style.flex = ''
      s.style.height = ''
      if (!s.offsetParent) return
      const top = s.getBoundingClientRect().top
      const lim = top + s.clientHeight
      let best = 0
      let prev = 0
      s.querySelectorAll('tbody > tr').forEach((tr) => {
        const b = tr.getBoundingClientRect().bottom
        if (b <= lim + 0.5 && b > best) best = tr.classList.contains('g5-grp') ? prev : b
        prev = b
      })
      if (best && best < lim - 0.5) { s.style.flex = 'none'; s.style.height = `${Math.floor(best - top)}px` }
    }
    snap()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(snap)
    ro.observe(host)
    return () => ro.disconnect()
  }, deps)
}

function Skeleton() {
  const bar = (w: number) => <span className="g5-sk" style={{ width: `${w}px` }} />
  return <div className="g5-tw" aria-busy="true" aria-label={tr('加载中')}><table className="g5-tbl"><Head /><tbody>
    {[0, 1, 2, 3, 4].map((i) => <Fragment key={i}>
      {i === 0 || i === 3 ? <tr className="g5-grp"><td colSpan={COLS}>{bar(96)}</td></tr> : null}
      <tr className="g5-row g5-pr"><td>{bar(160)}</td><td>{bar(40)}</td><td>{bar(28)}</td><td>{bar(56)}</td><td>{bar(140)}</td><td>{bar(96)}</td><td className="g5-fill">{bar(120)}</td><td>{bar(40)}</td><td>{bar(32)}</td><td className="g5-sx">{bar(28)}</td><td className="g5-sx g5-x" /></tr>
    </Fragment>)}
  </tbody></table></div>
}

function Head() {
  return <thead data-geo="plugins.thead"><tr>
    <th className="g5-al">{tr('名称')}</th><th>{tr('版本')}</th><th>{tr('来源')}</th><th>{tr('许可证')}</th><th>{tr('网络主机')}</th><th>{tr('文件')}</th><th className="g5-fill">{tr('密钥名')}</th><th>{tr('健康')}</th><th>{tr('合规')}</th><th>{tr('启用')}</th><th />
  </tr></thead>
}

/**
 * 取数：plugin.list 与 venue.status 一到手就在这里规整成视图模型（K-r5-0：dir 在此剥掉），页面状态里只放视图模型，
 * 带路径的原始回包不进任何状态 / 缓存。重读失败保留上一次的视图，首次失败才算读取失败。
 */
function usePluginsData(): { view: PluginsView | null; error: Error | null; reload(): void } {
  const bridge = useBridge()
  const [st, setSt] = useState<{ view: PluginsView | null; error: Error | null }>({ view: null, error: null })
  const [n, setN] = useState(0)
  useEffect(() => {
    let dead = false
    void (async () => {
      try {
        const [raw, vs] = await Promise.all([
          queryRetry<unknown>(bridge, 'plugin.list', undefined, () => !dead),
          queryRetry<unknown>(bridge, 'venue.status', undefined, () => !dead).catch(() => null),
        ])
        if (!dead) setSt({ view: normalizePlugins(raw, unverifiedVenues(vs)), error: null })
      } catch (e) { if (!dead) setSt((s) => ({ view: s.view, error: e as Error })) }
    })()
    return () => { dead = true }
  }, [bridge, n])
  return { view: st.view, error: st.error, reload: () => setN((x) => x + 1) }
}

export function PluginsPageView({ config, setConfig }: { config?: Record<string, unknown>; setConfig?: (c: Record<string, unknown>) => void }) {
  const bridge = useBridge()
  const data = usePluginsData()
  const offline = useOffline(data.reload)
  const now = useNow(1000)
  const since = useRef(0)
  if (offline && !since.current) since.current = Date.now()
  if (!offline) since.current = 0
  const [tab, setTab] = useState<Tab>(config?.tab === 'discover' ? 'discover' : 'installed')
  const [open, setOpen] = useState<string | null>(null)
  const [arming, setArming] = useState<{ id: string; kind: 'enable' | 'uninstall' } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const view = data.view
  const failure = view ? null : data.error
  const loading = !failure && !view

  const scroller = useRef<HTMLDivElement>(null)
  useSnap(scroller, [view, tab, open, arming, offline])
  const pickTab = (t: Tab) => { setTab(t); setConfig?.({ tab: t }) }

  /** 发一条命令：成功 toast + 重读；PIN 层被取消不打扰；失败照内核原文（toast）。返回结果给调用方。 */
  const go = async (id: string, action: string, params: unknown, okText: string): Promise<CmdResult | null> => {
    setBusy(id)
    try {
      const r = await runCommand(bridge, action, params)
      if (r.ok) { toast.ok(okText); data.reload() }
      else if (!r.cancelled) toast.err(r.message)
      return r
    } finally { if (alive.current) setBusy(null) }
  }

  /** 依次发命令，任一步失败（或 PIN 被取消）就停；返回第一步的结果（授权那步决定武装行收不收）。 */
  const runSteps = async (row: PluginRow, steps: ToggleStep[]): Promise<CmdResult | null> => {
    let first: CmdResult | null = null
    for (const s of steps) {
      const r = await go(row.id, s.action, s.params, s.ok)
      first ??= r
      if (!r?.ok) break
    }
    return first
  }
  const toggle = (row: PluginRow) => {
    const plan = togglePlan(row)
    if (plan.needsPin) { setArming({ id: row.id, kind: 'enable' }); return Promise.resolve(null) }
    return runSteps(row, plan.steps)
  }
  const confirmEnable = async (row: PluginRow) => {
    const [grant, ...rest] = togglePlan(row).steps
    if (!grant) return
    const r = await go(row.id, grant.action, grant.params, grant.ok)
    if (r?.ok || r?.cancelled) setArming(null)
    if (r?.ok) await runSteps(row, rest)
  }
  const confirmUninstall = async (row: PluginRow) => { const r = await go(row.id, 'plugin.uninstall', { id: row.id }, tr('已卸载 {0}', row.name)); if (r?.ok || r?.cancelled) { setArming(null); setOpen(null) } }
  const rescan = async () => { const r = await go('*', 'plugin.reload', {}, tr('已重新扫描')); if (r?.ok) pickTab('installed') }

  const off = offline
  const count = view?.count
  const stale = offline && since.current ? tr('已暂停更新 · {0}', mmss(now - since.current)) : null

  const head = <header className="g5-hd" data-geo="plugins.tabs">
    <div className="g5-tabs g5-htabs" role="tablist" aria-label={tr('插件')}>
      <button type="button" className="g5-tab" role="tab" data-tab="installed" aria-selected={tab === 'installed'} onClick={() => pickTab('installed')}><span className="g5-al">{tr('已安装')}</span>{count !== undefined ? <span className="g5-c">{count}</span> : null}</button>
      <button type="button" className="g5-tab" role="tab" data-tab="discover" aria-selected={tab === 'discover'} onClick={() => pickTab('discover')}>{tr('发现')}</button>
    </div>
    {stale ? <div className="g5-r"><span className="g5-s12 g5-t3">{stale}</span></div> : null}
  </header>

  let body
  if (tab === 'discover') {
    body = <div className="g5-pmsg" data-panel="discover"><span className="g5-al">{tr('插件目录尚未开放')}</span><button type="button" className="g5-btn g5-btn-fill" data-act="plugin-rescan" disabled={busy !== null || off} onClick={() => void rescan()}>{tr('重新扫描')}</button></div>
  } else if (loading) {
    body = <Skeleton />
  } else if (failure) {
    const missing = wireState(failure) === 'off'
    body = <div className="g5-pmsg" data-panel="installed" data-wire={missing ? 'off' : undefined}>
      <span className="g5-al">{tr('读取失败')}</span><span className="g5-src">{failure.message}</span>
      {missing ? null : <button type="button" className="g5-btn g5-btn-ghost" data-act="read-retry" onClick={() => { data.reload() }}>{tr('重试')}</button>}
    </div>
  } else if (view && view.count === 0) {
    body = <div className="g5-pmsg" data-panel="installed"><span className="g5-al">{tr('还没有安装插件')}</span><button type="button" className="g5-btn g5-btn-fill" data-act="plugin-rescan" disabled={busy !== null || off} onClick={() => void rescan()}>{tr('重新扫描')}</button></div>
  } else if (view) {
    let firstGrp = true
    let n = 0
    body = <div className="g5-tw g5-scroll" data-panel="installed" ref={scroller}><table className="g5-tbl"><Head /><tbody>
      {view.groups.map((g) => <Fragment key={g.id}>
        <tr className="g5-grp" data-group={g.id} data-geo={firstGrp ? (firstGrp = false, 'plugins.grp-first') : undefined}><td colSpan={COLS}><span className="g5-gname g5-al"><span className="g5-t2">{g.label}</span><span className="g5-t3">{g.rows.length}</span></span></td></tr>
        {g.rows.map((row) => {
          const isOpen = open === row.id
          n += 1
          const no = n
          const plan = togglePlan(row)
          const idle = row.enabled && plan.steps.length === 0 // 已授权的块：没有进程可启停
          const blocked = off || busy !== null || !row.ok || idle
          const why = !row.ok ? row.issues[0] : undefined
          return <Fragment key={row.id}>
            <tr className={'g5-row g5-pr' + (isOpen ? ' g5-open' : '')} data-id={row.id} data-enabled={row.enabled ? '1' : '0'} data-geo={`plugins.row-${no}`}>
              <td><span className="g5-pn g5-al"><span className="g5-ln1">
                {row.venue ? <VenueIcon venue={row.venue} label={row.name} /> : <span className="g5-nm">{row.name}</span>}
                {row.unverified ? <span className="g5-unv"><Icon name="alert" size={12} />{tr('未验证')}</span> : null}
              </span><span className="g5-l2">{row.id}</span></span></td>
              <td><span className="g5-t2">{row.version}</span></td>
              <td>{row.source.wired ? (SOURCE_LABEL[row.source.value] ?? row.source.value) : <Unwired field={row.source.field} />}</td>
              <td><span className="g5-t2">{row.license}</span></td>
              <td><Lines cell={row.hosts} /></td>
              <td><Lines cell={row.files} /></td>
              <td className="g5-fill"><Lines cell={row.secrets} /></td>
              <td><Health row={row} /></td>
              <td><ComplianceCell cell={row.compliance} /></td>
              <td className="g5-sx"><div className="g5-swc">
                <button type="button" role="switch" aria-checked={plan.checked} aria-label={tr('启用 {0}', row.name)} title={why} className="g5-swb" data-act="plugin-toggle" disabled={blocked} onClick={() => void toggle(row)}>
                  {!row.enabled && row.pending.length > 0 ? <Icon name="lock" size={12} /> : null}<span className={'g5-sw' + (plan.checked ? ' g5-on' : '')} />
                </button>
              </div></td>
              <td className="g5-sx g5-x"><button type="button" className="g5-btn g5-btn-ghost g5-btn-icon" aria-expanded={isOpen} aria-label={`${isOpen ? tr('收起') : tr('展开')} ${row.name}`} data-act="plugin-expand" onClick={() => setOpen(isOpen ? null : row.id)}><Icon name="chevron-down" size={14} /></button></td>
            </tr>
            {isOpen ? <tr className="g5-xrow" data-geo={`plugins.x-${no}`}><td colSpan={COLS}><Detail row={row} busy={busy !== null} off={off}
              onStartStop={() => void go(row.id, RUNNING.has(row.state) ? 'plugin.stop' : 'plugin.start', { id: row.id }, RUNNING.has(row.state) ? tr('已停止 {0}', row.name) : tr('已启动 {0}', row.name))}
              onUninstall={() => setArming({ id: row.id, kind: 'uninstall' })} /></td></tr> : null}
            {arming?.id === row.id ? (arming.kind === 'enable'
              ? <ArmedRow label={tr('启用 {0}', row.name)} what={tr('启用 {0}：新增 {1} 项权限（{2}）', row.name, enablePlan(row).added.length, enablePlan(row).added.join(tr('、')))} confirm={tr('启用')} busy={busy !== null} onCancel={() => setArming(null)} onConfirm={() => void confirmEnable(row)} />
              : <ArmedRow label={tr('卸载 {0}', row.name)} what={tr('卸载 {0}', row.name)} confirm={tr('卸载')} kill busy={busy !== null} onCancel={() => setArming(null)} onConfirm={() => void confirmUninstall(row)} />) : null}
          </Fragment>
        })}
      </Fragment>)}
    </tbody></table></div>
  }

  return <Card className="g5-plg g5-grow" aria-label={tr('插件')} data-geo="plugins.card" head={head}>
    {off ? <Offline>{body}</Offline> : body}
  </Card>
}
