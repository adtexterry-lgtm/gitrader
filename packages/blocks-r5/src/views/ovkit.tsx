// SPDX-License-Identifier: CPAL-1.0
// 总览页六个视图共用的小件（P1）：图标、卡头、一行消息、离线计时、浮层定位、接管（风险卡与资金卡共用同一份状态）。
// 数据钩子与命令全部复用 blocks-default（不另写第二套）；这里只放 r5 的外观件。命令错误原文原样显示，不改写。
import type { ComponentChildren } from 'preact'
import { createPortal } from 'preact/compat'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { BlockBridge } from '@gitrader/blocks-sdk'
import { useBridge } from '@gitrader/blocks-sdk/preact'
import type { TakeoverLevel } from '@gitrader/protocol/types'
import { F, toast } from '@gitrader/workbench/ui'
import { takeover } from '../../../blocks-default/src/actions'
import { useHtmlFlag } from '../../../blocks-default/src/hooks'
import { TAKEOVER_LEVELS } from '../../../blocks-default/src/labels'
import { leftoverOfEntry, takeoverOutcome, type Leftover } from '../../../blocks-default/src/model-risk'
import { fmtLoose, symbolOf } from '../../../blocks-default/src/util'
import type { Origin } from '@gitrader/protocol/types'
import { originActorTypeOf } from '../../../blocks-default/src/model-activity'
import { Actor, ErrorText, Unwired, wireState } from '../kit'
import { failOf, fmtElapsed } from '../model-funds'
import { t as tr } from '@gitrader/workbench/i18n'

// ---- 图标（24 网格，1.5 线；与视觉稿 symbol 同形） ------------------------------------------------------------------------------------------

type IconName = 'chev' | 'warn' | 'block' | 'lock' | 'shield' | 'check'
const PATHS: Record<IconName, ComponentChildren> = {
  chev: <path d="M7 10l5 5 5-5" />,
  warn: <><path d="M12 4.5l8.5 15h-17L12 4.5z" /><path d="M12 10.5v4" /><path d="M12 17.25v.01" /></>,
  block: <><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  shield: <><path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.8-7 9.5-4.1-1.7-7-5.2-7-9.5V6.3l7-2.8z" /><path d="M9 12l2 2 4-4" /></>,
  check: <path d="M5.5 12.5l4 4 9-9" />,
}
export function Ic({ n, s, label, style, className }: { n: IconName; s?: 12 | 16; label?: string; style?: Record<string, string>; className?: string }) {
  return <svg className={`g5-i${s ? ` g5-i${s}` : ''}${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" aria-hidden={label ? undefined : 'true'} aria-label={label} role={label ? 'img' : undefined} style={style}>{PATHS[n]}</svg>
}

export const Sk = ({ w, h }: { w?: number | string; h?: number }) => <span className="g5-sk" style={{ ...(w != null ? { width: w } : {}), ...(h ? { height: h } : {}) }} />

// ---- 执行方：全部用 kit 的 Actor（Agent 档：claude / openai 登记原件，未登记名走中性圆） ---------------------------------------------------------

/** 一条来源 → 执行方小标。引擎名字可点（去策略页）。 */
export function OriginActor({ origin, names }: { origin: Origin | null; names?: Record<string, string> }) {
  if (!origin) return <span className="g5-t3">—</span>
  const t = originActorTypeOf(origin)
  const key = String(origin.actor)
  const id = key.slice(key.indexOf(':') + 1)
  if (t === 'llm-agent') return <Actor kind="agent" name={names?.[key] ?? 'LLM Agent'} />
  if (t === 'human') return <span className="g5o-me"><Actor kind="human" name={tr('你')} /></span>
  if (t === 'engine') return <button type="button" className="g5o-eng" data-act="to-strategies" title={id} onClick={() => go('#/strategies')}><Actor kind="engine" name={id && id !== key ? id : tr('引擎')} /></button>
  return <Actor kind="system" name={tr('系统')} />
}

// ---- 跳转 -----------------------------------------------------------------------------------------------------------------------------------

export const go = (hash: string): void => { window.location.hash = hash }

/** 金额涨跌语气（给 kit 的 Amount）：离线时一律中性（去涨跌色，正负号保留）；两位小数显示为 0.00 的也中性。 */
export const amountTone = (v: number | null | undefined, off = false): 'up' | 'down' | 'neutral' => {
  if (off || v == null) return 'neutral'
  const t = F.tone(v)
  return t === 'up' ? 'up' : t === 'down' ? 'down' : 'neutral'
}
export const chartHash = (instrumentId: string): string => `#/chart/${instrumentId}`

// ---- 卡头 / 消息 ----------------------------------------------------------------------------------------------------------------------------

export function Head({ title, count, right, children }: { title?: ComponentChildren; count?: number | null; right?: ComponentChildren; children?: ComponentChildren }) {
  return <header className="g5-hd">
    {children ?? <h2 className="g5-al" tabIndex={-1}>{title}</h2>}
    {count != null ? <span className="g5-ct">{count}</span> : null}
    {right != null ? <div className="g5-r">{right}</div> : null}
  </header>
}

/** 卡内一行消息：空 / 读取失败 / 未接通。错误显示内核原文；接口不存在或缺字段只写「未接通」，不给重试。 */
export function Msg({ error, onRetry, children }: { error?: unknown; onRetry?: () => void; children?: ComponentChildren }) {
  if (error) {
    if (wireState(error) === 'off') return <div className="g5o-msg"><Unwired message={failOf(error).message} /></div>
    return <div className="g5o-msg" data-state="error"><span className="g5-al">{tr('读取失败')}</span><ErrorText bare message={failOf(error).message} />{onRetry ? <button type="button" className="g5-btn g5-btn-fill" data-act="read-retry" onClick={onRetry}>{tr('重试')}</button> : null}</div>
  }
  return <div className="g5o-msg"><span className="g5-al">{children}</span></div>
}

/** 离线（壳挂在 <html data-offline>）时卡头右侧的「已暂停更新 · mm:ss」。 */
export function useOfflineClock(off: boolean): string {
  const since = useRef(0)
  const [, tick] = useState(0)
  if (off && !since.current) since.current = Date.now()
  if (!off) since.current = 0
  useEffect(() => {
    if (!off) return undefined
    const id = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [off])
  return off ? tr('已暂停更新 · {0}', fmtElapsed(Date.now() - since.current)) : ''
}

export const cardClass = (grow: boolean, off: boolean): string => [grow ? 'g5-grow' : '', off ? 'g5-off' : ''].filter(Boolean).join(' ')
export const stateAttr = (off: boolean): Record<string, string> => (off ? { 'data-state': 'offline' } : {})

// ---- 菜单浮层（接管 / 档位 / 放宽限额共用）：挂到 body，按锚点定位，点外面或 Esc 收起 ------------------------------------------------------

export function placePop(anchor: { top: number; bottom: number; left: number; right: number; width: number; height: number }, box: { width: number; height: number }, viewport: { width: number; height: number }, gap = 8): { top: number; left: number; maxHeight?: number; flipped: boolean } {
  const below = Math.max(0, viewport.height - 8 - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - gap - 8)
  const flipped = box.height > below && (box.height <= above || above > below)
  const available = flipped ? above : below
  const height = Math.min(box.height, available)
  return {
    top: Math.max(8, Math.min(viewport.height - 8 - height, flipped ? anchor.top - gap - height : anchor.bottom + gap)),
    left: Math.max(8, Math.min(anchor.right - box.width, viewport.width - box.width - 8)),
    ...(box.height > available ? { maxHeight: available } : {}), flipped,
  }
}

export function Pop({ anchor, open, onClose, label, children, width = 280, align = 'end' }: {
  anchor: { current: HTMLElement | null }; open: boolean; onClose(): void; label: string; children: ComponentChildren; width?: number; align?: 'start' | 'end'
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<ReturnType<typeof placePop> | null>(null)
  useLayoutEffect(() => {
    if (!open || !anchor.current) { setPos(null); return }
    const measure = () => {
      if (!anchor.current || !box.current) return
      const r = anchor.current.getBoundingClientRect()
      const el = box.current
      el.style.maxHeight = ''
      const b = el.getBoundingClientRect()
      const next = placePop({ ...r.toJSON(), right: align === 'start' ? r.left + b.width : r.right }, b, { width: window.innerWidth, height: window.innerHeight })
      el.style.maxHeight = next.maxHeight === undefined ? '' : `${next.maxHeight}px`
      setPos(next)
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (box.current) observer?.observe(box.current)
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); observer?.disconnect() }
  }, [open, width, align])
  useEffect(() => {
    if (!open) return undefined
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div ref={box} className="g5-glass g5-menu g5-popover g5o-pop" role="menu" aria-label={label} data-g5="float" data-flipped={pos?.flipped} style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width, maxWidth: 'calc(100vw - 16px)', maxHeight: pos?.maxHeight, overflowY: 'auto', visibility: pos ? 'visible' : 'hidden' }}>{children}</div>,
    document.body,
  )
}

// ---- 接管：风险卡与资金卡是两个块实例，共用这一份状态（执行中两处同时禁用；没平完常驻红条，不出成功提示）-----------------------------------------
// ponytail: 模块级单例——一页只连一个内核，够用。别的入口（命令面板）发起的接管由壳挂在 <html data-takeover-busy> 上，这里一并读。
const tk: { busy: TakeoverLevel | null; left: Leftover[] | null } = { busy: null, left: null }
const tkSubs = new Set<() => void>()
function tkSet(patch: Partial<typeof tk>): void { Object.assign(tk, patch); for (const f of tkSubs) f() }
export function useTakeover(): typeof tk {
  const [, bump] = useState(0)
  useEffect(() => { const f = () => bump((x) => x + 1); tkSubs.add(f); return () => { tkSubs.delete(f) } }, [])
  return tk
}
export function useTakeoverBusy(): boolean { const st = useTakeover(); const shell = useHtmlFlag('data-takeover-busy'); return st.busy !== null || shell }
/** 账本里的接管条目（命令面板、Agent 发起的也算）落到常驻红条上。 */
export function noteTakeoverEntry(e: unknown): void {
  const l = leftoverOfEntry((e ?? {}) as { type?: unknown; payload?: unknown })
  if (l === 'clear') { if (tk.left) tkSet({ left: null }) } else if (l) tkSet({ left: l })
}

/** 发一次接管并读结果：返回 'keep' = 失败、保持武装（原文在 onErr）；undefined = 收起（成功、没平完、PIN 取消）。 */
async function runTakeover(bridge: BlockBridge, level: TakeoverLevel, onErr: (m: string | null) => void, onDone?: () => void): Promise<'keep' | undefined> {
  if (tk.busy) return 'keep'
  tkSet({ busy: level })
  onErr(null)
  try {
    const r = await takeover(bridge, level)
    if (!r.ok) {
      if (r.cancelled) return undefined
      onErr(r.message)
      toast.err(r.message)
      return 'keep'
    }
    const out = takeoverOutcome(level, r.value)
    if (out.ok) { if (level === 'flatten_all') tkSet({ left: null }); toast.ok(out.text); onDone?.() } else tkSet({ left: out.remaining })
    return undefined
  } finally { tkSet({ busy: null }) }
}

/** 接管武装行：[后果] [取消] [确认动词]。确认失败保持武装并在行下显示内核原文。 */
export function ArmedRow({ what, confirm, busyLabel, busy, kill = false, align = true, onCancel, onConfirm, err }: {
  what: string; confirm: string; busyLabel?: string; busy?: boolean; kill?: boolean; /** 卡内左缘对齐标记（弹出卡里不是卡内版面，不打）。 */ align?: boolean; onCancel(): void; onConfirm(): void; err?: string | null
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onCancel])
  return <>
    <div ref={ref} className="g5-armed" role="group" aria-label={what} data-armed="">
      <span className={`g5-what${align ? ' g5-al' : ''}`}>{what}</span>
      <button type="button" className="g5-btn g5-btn-ghost" data-act="arm-cancel" disabled={busy} onClick={onCancel}>{tr('取消')}</button>
      <button type="button" className={`g5-btn ${kill ? 'g5-btn-kill' : 'g5-btn-fill'}`} data-act="arm-confirm" disabled={busy} onClick={onConfirm}>{busy ? busyLabel ?? tr('处理中…') : confirm}</button>
    </div>
    {err ? <div className="g5o-err" role="alert"><ErrorText message={err} /></div> : null}
  </>
}

/** 三档接管。layout = 'bar'（风险卡里一排三钮，点哪个哪个就地武装）或 'menu'（资金卡接管弹出卡里竖排菜单项）。 */
export function TakeoverControls({ layout, offline, consequence, onDone }: { layout: 'bar' | 'menu'; offline: boolean; consequence?: string; onDone?: () => void }) {
  const bridge = useBridge()
  const st = useTakeover()
  const running = useTakeoverBusy()
  const [armed, setArmed] = useState<TakeoverLevel | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const cancel = useCallback(() => { setArmed(null); setErr(null) }, [])
  const level = TAKEOVER_LEVELS.find((t) => t.level === armed)
  if (level && armed) {
    const what = armed === 'flatten_all' && consequence ? tr('{0}：{1}', level.label, consequence) : level.label
    const row = <ArmedRow what={what} confirm={level.confirm} busyLabel={level.busy} busy={st.busy === armed} kill={armed === 'flatten_all'} align={layout === 'bar'} onCancel={cancel} err={err}
      onConfirm={() => { void runTakeover(bridge, armed, setErr, onDone).then((r) => { if (r !== 'keep') cancel() }) }} />
    return layout === 'bar' ? <div className="g5-racts g5o-armed">{row}</div> : row
  }
  const off = (lv: TakeoverLevel) => offline || (running && st.busy !== lv)
  if (layout === 'menu') {
    return <>{TAKEOVER_LEVELS.map((t) => <button key={t.level} type="button" role="menuitem" className={`g5-mi${t.level === 'flatten_all' ? ' g5-danger' : ''}`} style={{ width: '100%' }} data-act={`takeover-${t.level}`} disabled={off(t.level)}
      title={offline ? tr('离线') : running ? tr('接管执行中') : undefined} onClick={() => setArmed(t.level)}>{t.label}</button>)}</>
  }
  return <div className="g5-racts">
    {TAKEOVER_LEVELS.map((t) => <button key={t.level} type="button" className={`g5-btn g5-btn-fill${t.level === 'flatten_all' ? ' g5-danger' : ''}`} data-act={`takeover-${t.level}`} disabled={off(t.level)}
      title={offline ? tr('离线') : running ? tr('接管执行中') : undefined} onClick={() => setArmed(t.level)}>{t.label}</button>)}
  </div>
}

/** 没平完：常驻红条（不靠 toast）——剩几个、哪些标的、多少，+ 再次平仓。 */
export function LeftoverAlert({ left, offline }: { left: Leftover[]; offline: boolean }) {
  const bridge = useBridge()
  const st = useTakeover()
  const running = useTakeoverBusy()
  const [armed, setArmed] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const detail = left.map((x) => `${symbolOf(x.instrumentId)} ${fmtLoose(x.size)}`).join(' · ')
  if (armed) return <ArmedRow what={tr('全部平仓')} confirm={tr('确认平仓')} busyLabel={tr('平仓中…')} kill busy={st.busy === 'flatten_all'} err={err} onCancel={() => { setArmed(false); setErr(null) }}
    onConfirm={() => { void runTakeover(bridge, 'flatten_all', setErr).then((r) => { if (r !== 'keep') setArmed(false) }) }} />
  return <div className="g5-blocked g5o-leftover" role="alert" data-act="takeover-leftover">
    <Ic n="block" s={12} />
    <span>{tr('平仓未完成')}{left.length ? tr(' · 剩 {0} 个持仓', left.length) : ''}</span>
    {left.length ? <span title={left.map((x) => `${x.instrumentId} ${x.size}`).join(tr('；'))}>{detail}</span> : null}
    <button type="button" className="g5-btn g5-btn-ghost" data-act="takeover-retry" disabled={offline || (running && st.busy !== 'flatten_all')} onClick={() => setArmed(true)}>{tr('再次平仓')}</button>
  </div>
}
