// SPDX-License-Identifier: CPAL-1.0
// 三口径卡：前向（涨跌色）→ 保留期 → 回测（中性色）。每张卡 = 区间收益 + 权益曲线 + 指标；不显示年化、不画预测段。
// 回测卡头有「第 N 次 / 共 N 次」下拉（缺省最新一次）与 曲线 / 成交 / K 线 页签。
// 人面入口（GQ-09）：前向卡头「附加纸面运行」（lab.attach），回测卡头「出证据包」（lab.pack，作用于当前选中的那次）。
import { Menu, PopoverPanel, toast } from '@gitrader/workbench/ui'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { runCommand } from '../../../../blocks-default/src/actions'
import { queryRetry } from '../../../../blocks-default/src/hooks'
import { Unwired } from '../../kit'
import {
  attachCandidates, attachClosed, attachCmd, denyText, packableRun, packConsequence, shortId, toWindowMs, type AttachCandidate,
  backtestRuns, curveValue, forwardView, hasHoldoutWindow, holdoutRun, pickRun, resultView, runLabel, runSummariesMissing, stamp, tradeRows,
  type Curve, type LabDetail, type RunRef, type TierId, type TierView,
} from '../../model-lab'
import { useDetail, useRun } from './data'
import { ErrorMsg, Frame, Ic, Msg, PausedTag, Skeleton } from './parts'
import { t as tr } from '@gitrader/workbench/i18n'

const TITLE: Record<TierId, string> = { forward: tr('前向'), holdout: tr('保留期'), backtest: tr('回测') }
const BASIS: Record<TierId, string> = { forward: tr('纸面'), holdout: tr('样本外'), backtest: tr('样本内') }

type CurveTab = 'curve' | 'trades' | 'kline'
const TABS: readonly { id: CurveTab; label: string }[] = [{ id: 'curve', label: tr('曲线') }, { id: 'trades', label: tr('成交') }, { id: 'kline', label: tr('K 线') }]

// ---- 卡头 ---------------------------------------------------------------------------------------

interface HeadProps { tier: TierId; view?: TierView | null; offline?: boolean; mid?: ComponentChildren; act?: ComponentChildren }
function TierHead({ tier, view, offline, mid, act }: HeadProps) {
  const tone = offline || !view ? 'g5-t3' : view.tone === 'up' ? 'g5-up' : view.tone === 'down' ? 'g5-down' : 'g5-t1'
  return <header className="g5-hd"><div className="lab-hrow">
    <h2 className="g5-al">{TITLE[tier]}</h2>
    <span className="g5-s12 g5-t2">{view?.basis ?? BASIS[tier]}</span>
    {view?.account ? <span className="lab-acct"><span className="g5-s12 g5-t2">{view.account.id}</span>{view.account.paper ? <span className="g5-papermk" title={tr('纸面账户')} /> : null}</span> : null}
    {view?.windowText ? <span className="g5-s12 g5-t3">{view.windowText}</span> : null}
    {mid}
    {view || offline || act ? <div className="g5-r">
      {offline ? <PausedTag /> : null}
      {act}
      {view ? <><span className="g5-s12 g5-t3">{tr('区间收益')}</span><span className={`lab-ret ${tone}`} data-redge={tier}>{view.ret}</span></> : null}
    </div> : null}
  </div></header>
}

// ---- 曲线 ---------------------------------------------------------------------------------------

const GRID_FRAME = [20, 50, 80]
function Plot({ tier, view, offline }: { tier: TierId; view: TierView | null; offline?: boolean }) {
  const c: Curve | null = view?.curve ?? null
  const host = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  // 只有在线的前向着涨跌色；离线去色（内核回来类名自然回来）
  const colored = tier === 'forward' && view !== null && view.tone !== 'neutral' && !offline
  const dir = view?.tone === 'down' ? 'g5-down' : 'g5-up'
  const gid = `lab-g-${tier}`
  const stop = colored ? `var(--gr-${view?.tone === 'down' ? 'down' : 'up'})` : 'var(--gr-text)'

  const move = (clientX: number) => {
    const el = host.current
    if (!el || !c) return
    const r = el.getBoundingClientRect()
    const width = r.width - 6
    const x = Math.min(Math.max(clientX - r.left, 0), width) / width * 1000
    let best = 0
    for (let i = 1; i < c.pts.length; i += 1) if (Math.abs(c.pts[i]!.x - x) < Math.abs(c.pts[best]!.x - x)) best = i
    setHover(best)
  }
  // 读数小卡靠右放不下就翻到点的左边
  useLayoutEffect(() => {
    const el = host.current
    const t = tip.current
    if (hover === null || !c || !el || !t) return
    const px = (el.getBoundingClientRect().width - 6) * (c.pts[hover]!.x / 1000)
    const w = t.offsetWidth
    t.style.left = `${px + 12 + w > el.getBoundingClientRect().width ? px - 12 - w : px + 12}px`
  }, [hover, c])

  const pt = c && hover !== null ? c.pts[hover] : undefined
  const left = pt ? `calc((100% - 6px) * ${pt.x / 1000})` : undefined
  return <div className="lab-plot">
    <div ref={host} className={['g5-pa', colored ? `g5-fw ${dir}` : ''].filter(Boolean).join(' ')} data-plot={tier}
      onMouseMove={(e) => move(e.clientX)} onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
        {c ? <>
          <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-opacity={colored ? 0.1 : 0.04} style={{ stopColor: stop }} /><stop offset="1" stop-opacity={0} style={{ stopColor: stop }} />
          </linearGradient></defs>
          {c.grid.map((g) => <path className="g5-eq-grid" d={`M0 ${g.y.toFixed(2)}H1000`} key={g.label} />)}
          <path className="g5-eq-base" d={`M0 ${c.base.toFixed(2)}H1000`} />
          <path className="g5-eq-area" d={c.area} fill={`url(#${gid})`} />
          <path className={['g5-eq-line', colored ? `g5-fw ${dir}` : 'g5-nu'].join(' ')} d={c.line} />
        </> : GRID_FRAME.map((y) => <path className="g5-eq-grid" d={`M0 ${y}H1000`} key={y} />)}
      </svg>
      {c ? <i className="g5-end" style={{ top: `${c.end.y}%` }} /> : null}
      {pt ? <>
        <i className="lab-vx" style={{ left }} />
        <i className="g5-dot" style={{ left, top: `${pt.y}%` }} />
        <div ref={tip} className="g5-mcard g5-glass g5-chart lab-tip" role="tooltip">
          <div className="g5-m1">{stamp(pt.t)}</div>
          <div className="g5-m2"><span className="lab-tv">{curveValue(pt.v)}</span>{view?.ccy ? <span className="g5-s12 g5-t3">{view.ccy}</span> : null}</div>
        </div>
      </> : null}
    </div>
    <div className="lab-ya">{c?.grid.map((g) => <span style={{ top: `${g.y}%` }} key={g.label}>{g.label}</span>)}</div>
    <div className="lab-xa">{c ? <><span>{c.startLabel}</span><span>{c.endLabel}</span></> : null}</div>
  </div>
}

const Metrics = ({ rows, group }: { rows: TierView['left']; group: string }) =>
  <dl className="lab-dl lab-mx">{rows.map((r) => <div key={r.key}><dt>{r.key}</dt><dd data-n={group}>{r.value}</dd></div>)}</dl>

function CurveBody({ tier, view, offline }: { tier: TierId; view: TierView; offline: boolean }) {
  return <div className="lab-tb3"><Plot tier={tier} view={view} offline={offline} /><Metrics rows={view.left} group="m" /><Metrics rows={view.right} group="o" /></div>
}

/** 加载：只画坐标框，不画假曲线。 */
function SkeletonBody({ tier }: { tier: TierId }) {
  const sk = (n: number, w: number) => Array.from({ length: n }, (_, i) => <div key={i}><dt><Skeleton widths={[32]} /></dt><dd><Skeleton widths={[w]} /></dd></div>)
  return <div className="lab-tb3" aria-hidden="true"><Plot tier={tier} view={null} /><dl className="lab-dl lab-mx">{sk(4, 48)}</dl><dl className="lab-dl lab-mx">{sk(2, 32)}</dl></div>
}

// ---- 成交表（回测页签） ---------------------------------------------------------------------------

function Trades({ raw }: { raw: unknown }) {
  const rows = tradeRows(raw)
  if (!rows.length) return <Msg><span className="g5-al">{tr('没有成交')}</span></Msg>
  return <div className="g5-tw g5-scroll lab-tw"><table className="g5-tbl">
    <thead><tr><th>{tr('时间')}</th><th>{tr('方向')}</th><th className="g5-n" data-n="tp">{tr('价格')}</th><th className="g5-n" data-n="ts">{tr('数量')}</th><th className="g5-n" data-n="tl">{tr('盈亏')}</th><th className="g5-n" data-n="tf">{tr('手续费')}</th><th className="g5-fill">{tr('原因')}</th></tr></thead>
    <tbody>{rows.map((r) => <tr className="g5-row g5-h40" key={`${r.at}:${r.side}:${r.price}`}>
      <td className="g5-t2">{stamp(r.at)}</td><td>{r.side}</td>
      <td className="g5-n" data-n="tp">{r.price}</td><td className="g5-n" data-n="ts">{r.size}</td><td className="g5-n" data-n="tl">{r.pnl}</td><td className="g5-n" data-n="tf">{r.fee}</td>
      <td className="g5-fill g5-t2">{r.reason}</td>
    </tr>)}</tbody>
  </table></div>
}

// ---- 附加纸面运行 / 出证据包（弹出卡沿用晋级卡的 lab-pop / lab-deny / g5-armed） -----------------------------

type Pop = { name: 'idle' } | { name: 'busy' } | { name: 'denied'; text: string }
type Opts = { phase: 'loading' } | { phase: 'ready'; list: AttachCandidate[] } | { phase: 'error'; text: string }
interface PopProps { detail: LabDetail; onClose(): void; onDone(): void; onBusy(busy: boolean): void }

function AttachCard({ detail, onClose, onDone, onBusy }: PopProps) {
  const bridge = useBridge()
  const [opts, setOpts] = useState<Opts>({ phase: 'loading' })
  const [pick, setPick] = useState<string | null>(null)
  const [step, setStep] = useState<Pop>({ name: 'idle' })
  useEffect(() => {
    let dead = false
    const alive = () => !dead
    Promise.all([queryRetry(bridge, 'engine.strategies', {}, alive), queryRetry(bridge, 'account.list', {}, alive)]).then(
      ([s, a]) => { if (dead) return; const list = attachCandidates(detail, s, a); setOpts({ phase: 'ready', list }); if (list.length === 1) setPick(list[0]!.key) },
      (e: unknown) => { if (!dead) setOpts({ phase: 'error', text: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { dead = true }
  }, [bridge, detail])
  const list = opts.phase === 'ready' ? opts.list : []
  const chosen = list.find((c) => c.key === pick)
  const go = async () => {
    if (!chosen) return
    setStep({ name: 'busy' })
    onBusy(true)
    const r = await runCommand(bridge, 'lab.attach', attachCmd(detail.experimentId, chosen))
    onBusy(false)
    if (r.ok) { toast.ok(tr('已附加')); onDone(); return }
    setStep(r.cancelled ? { name: 'idle' } : { name: 'denied', text: denyText(r.message, r.problem) })
  }
  const busy = step.name === 'busy'
  return <div className="lab-pop" role="dialog" aria-label={tr('附加纸面运行')}>
    <header className="g5-hd"><h2 className="g5-al">{tr('附加纸面运行')}</h2></header>
    <div className="lab-pb">
      {opts.phase === 'loading' ? <div className="lab-alist" aria-busy="true"><Skeleton widths={[120]} /></div> : null}
      {opts.phase === 'error' ? <div className="lab-deny" role="alert"><Ic n="block" s={12} /><span>{opts.text}</span></div> : null}
      {opts.phase === 'ready' && !list.length ? <div className="lab-alist"><span className="g5-t3" data-empty="">{tr('没有可附加的实例')}</span></div> : null}
      {list.length ? <div className="lab-alist" role="radiogroup" aria-label={tr('实例')}>{list.map((c) => <button type="button" role="radio" aria-checked={c.key === pick} className="lab-aopt" data-inst={c.instanceId} key={c.key} disabled={busy} onClick={() => setPick(c.key)}>
        <span className="g5-t1">{c.alias}</span><span className="g5-papermk" title={tr('纸面账户')} /><span className="g5-s12 g5-t3 lab-aid">{shortId(c.instanceId)}</span>
      </button>)}</div> : null}
      {step.name === 'denied' ? <div className="lab-deny" role="alert"><Ic n="block" s={12} /><span>{step.text}</span></div> : null}
      <div className="g5-pacts">
        <button type="button" className="g5-btn g5-btn-ghost" data-act="attach-cancel" disabled={busy} onClick={onClose}>{tr('取消')}</button>
        <button type="button" className="g5-btn g5-btn-fill" data-act="attach-go" disabled={busy || !chosen} onClick={() => { void go() }}>{busy ? tr('附加中…') : tr('附加')}</button>
      </div>
    </div>
  </div>
}

function PackCard({ detail, runId, needsWindow, onClose, onDone, onBusy }: PopProps & { runId: string; needsWindow: boolean }) {
  const bridge = useBridge()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [step, setStep] = useState<Pop>({ name: 'idle' })
  const born = useRef(performance.now())
  const win = needsWindow ? toWindowMs(from, to) : null
  const busy = step.name === 'busy'
  const go = async () => {
    if (performance.now() - born.current < 600 || (win && !win.ok)) return
    setStep({ name: 'busy' })
    onBusy(true)
    const r = await runCommand(bridge, 'lab.pack', { experimentId: detail.experimentId, runId, ...(win?.ok ? { holdoutWindow: win.window } : {}) })
    onBusy(false)
    if (r.ok) { toast.ok(tr('已出证据包')); onDone(); return }
    setStep(r.cancelled ? { name: 'idle' } : { name: 'denied', text: denyText(r.message, r.problem) })
  }
  const field = (id: string, label: string, value: string, set: (v: string) => void) => <>
    <label className="g5-k" htmlFor={id}>{label}</label>
    <span className={`g5-inp g5-s${win && !win.ok && from && to ? ' g5-bad' : ''}`}><input id={id} type="datetime-local" aria-label={label} value={value} disabled={busy} onInput={(e) => { set((e.target as HTMLInputElement).value); born.current = performance.now() }} /></span>
  </>
  return <div className="lab-pop" role="dialog" aria-label={tr('出证据包')}>
    <header className="g5-hd"><h2 className="g5-al">{tr('出证据包')}</h2><span className="g5-s12 g5-t3">{runId}</span></header>
    <div className="lab-pb">
      {needsWindow ? <div className="lab-pwin">{field(`pk-from-${runId}`, tr('留出起'), from, setFrom)}{field(`pk-to-${runId}`, tr('留出止'), to, setTo)}</div> : null}
      {step.name === 'denied' ? <div className="lab-deny" role="alert"><Ic n="block" s={12} /><span>{step.text}</span></div> : null}
      <div className="g5-armed lab-neutral" role="group" aria-label={packConsequence(detail)}>
        <span className="g5-what g5-al">{packConsequence(detail)}</span>
        {busy ? null : <button type="button" className="g5-btn g5-btn-ghost" data-act="pack-cancel" onClick={onClose}>{tr('取消')}</button>}
        <button type="button" className="g5-btn g5-btn-fill" data-act="pack-go" disabled={busy || (win !== null && !win.ok)} onClick={() => { void go() }}>{busy ? tr('出包中…') : tr('出证据包')}</button>
      </div>
    </div>
  </div>
}

/** 卡头动作钮 + 弹出卡；进行中不让点外面关掉。 */
function HeadPop({ act, label, icon, disabled, title, children }: { act: string; label: string; icon?: 'down'; disabled: boolean; title?: string; children(close: () => void, onBusy: (b: boolean) => void): ComponentChildren }) {
  const [open, setOpen] = useState(false)
  const busy = useRef(false)
  const close = () => setOpen(false)
  const trigger = <button type="button" className="g5-btn g5-btn-ghost" data-act={act} aria-expanded={open} disabled={disabled} title={title} onClick={() => setOpen(true)}>{icon ? <Ic n={icon} /> : null}{label}</button>
  return <PopoverPanel open={open} onOpenChange={(o: boolean) => { if (!o && busy.current) return; setOpen(o) }} side="bottom" align="end" sideOffset={6} className="g5-glass lab-apop" label={label} trigger={trigger}>
    {open ? children(close, (b) => { busy.current = b }) : null}
  </PopoverPanel>
}

// ---- 三种卡 -------------------------------------------------------------------------------------

interface CardProps { detail: LabDetail; offline: boolean; reload?: () => void }

function ForwardCard({ detail, offline, reload }: CardProps) {
  const view = forwardView(detail)
  const act = <HeadPop act="attach" label={tr('附加纸面运行')} disabled={offline || attachClosed(detail)}>
    {(close, onBusy) => <AttachCard detail={detail} onClose={close} onBusy={onBusy} onDone={() => { close(); reload?.() }} />}
  </HeadPop>
  if (!view) return <Frame view="tier" tier="forward" grow offline={offline} head={<TierHead tier="forward" offline={offline} act={act} />}><Msg><span className="g5-al">{tr('前向 0 天')}</span></Msg></Frame>
  return <Frame view="tier" tier="forward" grow offline={offline} head={<TierHead tier="forward" view={view} offline={offline} act={act} />}><CurveBody tier="forward" view={view} offline={offline} /></Frame>
}

/** 一次回测 / 保留期的卡：取 lab.run，期间卡头只有标题。 */
function RunCard({ tier, detail, run, offline, mid, act, tab = 'curve' }: CardProps & { tier: 'holdout' | 'backtest'; run: RunRef; mid?: ComponentChildren; act?: ComponentChildren; tab?: CurveTab }) {
  const { load, reload } = useRun(detail.experimentId, run.runId)
  const raw = load.phase === 'ready' ? load.value : null
  let view: TierView | null = null
  let failure: Error | null = load.phase === 'error' ? load.error : null
  if (raw !== null) { try { view = resultView(tier, run, raw) } catch (e) { failure = e instanceof Error ? e : new Error(String(e)) } }
  const head = <TierHead tier={tier} view={view} offline={offline} mid={mid} act={act} />
  if (failure) return <Frame view="tier" tier={tier} grow offline={offline} head={head}><ErrorMsg error={failure} onRetry={reload} /></Frame>
  if (!view) return <Frame view="tier" tier={tier} grow busy offline={offline} head={head}><SkeletonBody tier={tier} /></Frame>
  return <Frame view="tier" tier={tier} grow offline={offline} head={head}>
    {tab === 'trades' ? <Trades raw={raw} /> : tab === 'kline' ? <Msg><Unwired message={tr('K 线图表块未提供回测来源')} /></Msg> : <CurveBody tier={tier} view={view} offline={offline} />}
  </Frame>
}

function HoldoutCard({ detail, offline }: CardProps) {
  const run = holdoutRun(detail)
  const head = <TierHead tier="holdout" offline={offline} />
  const missing = runSummariesMissing(detail)
  if (missing) return <Frame view="tier" tier="holdout" grow offline={offline} head={head}><ErrorMsg error={missing} /></Frame>
  if (!run) return <Frame view="tier" tier="holdout" grow offline={offline} head={head}><Msg><span className="g5-al">{hasHoldoutWindow(detail) ? tr('保留期还没有结果') : tr('未设保留期')}</span></Msg></Frame>
  return <RunCard tier="holdout" detail={detail} run={run} offline={offline} />
}

function BacktestCard({ detail, offline, reload }: CardProps) {
  const runs = backtestRuns(detail)
  const [picked, setPicked] = useState<string | null>(null)
  const [tab, setTab] = useState<CurveTab>('curve')
  const missing = runSummariesMissing(detail)
  if (missing) return <Frame view="tier" tier="backtest" grow offline={offline} head={<TierHead tier="backtest" offline={offline} />}><ErrorMsg error={missing} /></Frame>
  if (!runs.length) return <Frame view="tier" tier="backtest" grow offline={offline} head={<TierHead tier="backtest" offline={offline} />}><Msg><span className="g5-al">{tr('没有回测记录')}</span></Msg></Frame>
  const index = pickRun(runs, picked)
  const run = runs[index]!
  const mid = <>
    <Menu label={tr('回测次数')} align="start" value={run.runId} onValueChange={(id: string) => setPicked(id)}
      items={runs.map((r, i) => ({ id: r.runId, label: runLabel(i, runs.length) }))}
      trigger={<button type="button" className="g5-dd" aria-label={tr('回测次数')} data-act="pick-run">{runLabel(index, runs.length)}<Ic n="chev" s={12} /></button>} />
    <div className="g5-tabs" role="tablist">{TABS.map((t) => <button type="button" className="g5-tab" role="tab" aria-selected={tab === t.id} data-tab={t.id} key={t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
  </>
  const packable = packableRun(detail, run.runId)
  const act = <HeadPop act="pack" label={tr('出证据包')} disabled={offline || !packable.ok} title={packable.ok ? undefined : packable.reason}>
    {(close, onBusy) => <PackCard detail={detail} runId={run.runId} needsWindow={packable.ok && packable.needsWindow} onClose={close} onBusy={onBusy} onDone={() => { close(); reload?.() }} />}
  </HeadPop>
  return <RunCard key={run.runId} tier="backtest" detail={detail} run={run} offline={offline} mid={mid} act={act} tab={tab} />
}

// ---- 入口 ---------------------------------------------------------------------------------------

export function TierCard({ tier, experimentId }: { tier: TierId; experimentId: string | null }) {
  const { load, reload, offline } = useDetail(experimentId)
  const head = <TierHead tier={tier} offline={offline && load.phase === 'ready'} />
  if (!experimentId) return <Frame view="tier" tier={tier} grow head={head}><Msg><span className="g5-al">{tr('没有选中的实验')}</span></Msg></Frame>
  if (load.phase === 'loading') return <Frame view="tier" tier={tier} grow busy head={<TierHead tier={tier} />}><SkeletonBody tier={tier} /></Frame>
  if (load.phase === 'error') return <Frame view="tier" tier={tier} grow head={<TierHead tier={tier} />}><ErrorMsg error={load.error} onRetry={reload} /></Frame>
  const props = { detail: load.value, offline, reload }
  return tier === 'forward' ? <ForwardCard {...props} /> : tier === 'holdout' ? <HoldoutCard {...props} /> : <BacktestCard {...props} />
}
