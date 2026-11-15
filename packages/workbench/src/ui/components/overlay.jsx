// SPDX-License-Identifier: CPAL-1.0
// 浮层：Toast（全局队列）/ Drawer（右滑抽屉）/ Tooltip / Popover + MenuItem。不使用模态弹窗。
// Esc 走 lib/esc.js 的分层栈（G6）：抽屉 > 弹出卡，一次只关最上一层。
import { useEffect, useRef, useState } from 'preact/hooks'
import { useClickAway } from '../lib/hooks.js'
import { useEscLayer } from '../lib/esc.js'
import { Icon } from './Icon.jsx'
import { toastIn, toastOut } from '../motion.js'
import { t as tr } from '../lib/i18n.js'
import { toastParts } from '../lib/toast-parts.js'
import { ErrDetail } from './ErrText.jsx'

const cx = (...a) => a.filter(Boolean).join(' ')

//#region Toast

// 计时规矩（IXD F9-3；ux-fix2 B2：带行动按钮的失败常驻、点掉才走）：成功 / 信息 3 s、失败 8 s，带行动按钮的至少 8 s；指针悬停在 toast 堆上或焦点在里面时全部暂停，离开后按剩余时间继续。
let toasts = []
let seq = 0
let paused = false
const subs = new Set()
const emit = () => { const snap = toasts.slice(); subs.forEach((f) => f(snap)) } // 每次发新数组：原地改 leaving 后宿主 useState 才会重渲染（C 包发现 toast 不自动消失）
const MOBILE = '(max-width: 599px)'
function arm(t) {
  clearTimeout(t.timer)
  t.timer = 0
  if (paused || t.leaving || t.remain === Infinity) return
  t.t0 = Date.now()
  t.timer = setTimeout(() => dismiss(t.id), t.remain)
}
// 指针或焦点此刻真的在 toast 堆上（暂停标记只在这时才算数）
const held = () => { const h = typeof document !== 'undefined' && document.querySelector('.gr-toasts'); return !!h && (h.matches(':hover') || h.contains(document.activeElement)) }
function push(kind, text, ms, action) {
  const dup = toasts.find((x) => x.kind === kind && x.text === String(text) && !x.leaving)
  if (dup) return dup.id // 同类同文案合并为一条
  if (paused && !held()) resumeAll() // 暂停标记是旧的（堆被卸载时 pointerleave 不再来）：新旧 toast 都照常计时（L5）
  const base = ms || (kind === 'err' ? 8000 : 3000)
  const t = { id: ++seq, kind, text: String(text), action: action || null, remain: action ? (kind === 'err' ? Infinity : Math.max(base, 8000)) : base, timer: 0, t0: 0, leaving: false }
  const drop = toasts.filter((x) => !x.leaving).slice(0, -2) // 最多 3 条
  for (const x of drop) { clearTimeout(x.timer); x.leaving = true }
  toasts = toasts.filter((x) => !drop.includes(x)).concat(t)
  arm(t)
  emit()
  return t.id
}
function dismiss(id) {
  const t = toasts.find((x) => x.id === id)
  if (!t || t.leaving) return
  clearTimeout(t.timer)
  t.leaving = true
  emit()
}
function remove(id) {
  toasts = toasts.filter((t) => t.id !== id)
  if (!toasts.length) paused = false // 点掉最后一条且指针不动：堆随即卸载、pointerleave 不会来，暂停标记在这里清掉（L5）
  emit()
}
function pauseAll() {
  if (paused) return
  paused = true
  const now = Date.now()
  for (const t of toasts) if (t.timer) { clearTimeout(t.timer); t.timer = 0; t.remain = Math.max(0, t.remain - (now - t.t0)) }
}
function resumeAll() {
  if (!paused) return
  paused = false
  for (const t of toasts) arm(t)
}

/**
 * 全局 toast：toast.ok('布局已保存') / toast.err(上游原文) / toast.info(...)。成功 3 s，失败 8 s；悬停 / 聚焦时暂停。
 * 第三个参数可给一个行动按钮（这时至少 8 s）：toast.ok('已交给 Agent', 6000, { label: '去看提案', onClick: () => navigate('agents') })。
 * 关系到钱与风控的失败不许只靠 toast（IXD G4）：就地常驻显示原文，toast 只是回声。
 */
export const toast = {
  ok: (text, ms, action) => push('ok', text, ms, action),
  err: (text, ms, action) => push('err', text, ms, action),
  info: (text, ms, action) => push('info', text, ms, action),
  dismiss,
}

function ToastItem({ t, top }) {
  const ref = useRef(null)
  const p = toastParts(t.kind, t.text)
  useEffect(() => { toastIn(ref.current, { from: top ? 'top' : 'bottom' }) }, [])
  useEffect(() => {
    if (!t.leaving) return undefined
    const a = toastOut(ref.current)
    if (!a) { remove(t.id); return undefined }
    let gone = false
    const done = () => { if (!gone) { gone = true; remove(t.id) } }
    a.onfinish = done
    const guard = setTimeout(done, 400) // 动画被暂停（页面不可见）时也要移除
    return () => clearTimeout(guard)
  }, [t.leaving])
  return (
    <div ref={ref} className={cx('gr-toast glass material-glass', t.leaving && 'is-leaving')} role={t.kind === 'err' ? 'alert' : 'status'} data-kind={t.kind}>
      {/* r4：成功 / 信息无状态圆点；ux-fix2 B2：失败带一颗 6px 状态点（种类仍在 data-kind 与 role 上：失败 = alert） */}
      {t.kind === 'err' ? <span className="gr-dot gr-dot--err gr-toast__dot" aria-hidden="true" /> : null}
      <span className="gr-toast__b">
        <span className="gr-toast__x">{p.what}</span>
        {p.next ? <span className="gr-toast__n">{p.next}</span> : null}
        {p.detail ? <ErrDetail detail={p.detail} /> : null}
      </span>
      {t.action ? <button type="button" className="gr-toast__act" onClick={() => { dismiss(t.id); t.action.onClick() }}>{t.action.label}</button> : null}
      <button type="button" className="gr-toast__close" aria-label={tr('关闭提示')} onClick={() => dismiss(t.id)}><Icon name="close" size={13} /></button>
    </div>
  )
}

/** 壳里挂一次。桌面在右下（状态条上方），手机（< 600）在顶部。 */
export function ToastHost() {
  const [list, setList] = useState(toasts)
  const host = useRef(null)
  useEffect(() => { subs.add(setList); return () => { subs.delete(setList) } }, [])
  if (!list.length) return null
  const top = typeof matchMedia === 'function' && matchMedia(MOBILE).matches
  return (
    <div ref={host} className="gr-toasts" aria-live="polite"
      onPointerEnter={pauseAll} onPointerLeave={() => { if (!(host.current && host.current.contains(document.activeElement))) resumeAll() }}
      onFocusIn={pauseAll} onFocusOut={(e) => { if (!(host.current && host.current.contains(e.relatedTarget)) && !(host.current && host.current.matches(':hover'))) resumeAll() }}>
      {list.map((t) => <ToastItem key={t.id} t={t} top={top} />)}
    </div>
  )
}

//#endregion

//#region Drawer

/**
 * 右滑抽屉（详情用）。open 控制显隐；Esc / 点遮罩 / 右上 ✕ 关闭。
 * width：CSS 长度，默认 440px（窄屏自动收成 100vw）。footer 固定在底部。
 */
export function Drawer({ open, onClose, title, subtitle, width = '440px', footer, children }) {
  const ref = useRef(null)
  const lastFocus = useRef(null)
  useEscLayer('drawer', () => onClose(), !!open)
  useEffect(() => {
    if (!open) return undefined
    lastFocus.current = document.activeElement
    const t = setTimeout(() => { if (ref.current) ref.current.focus() }, 30)
    return () => { clearTimeout(t); try { if (lastFocus.current && lastFocus.current.focus) lastFocus.current.focus() } catch (_e) { /* 元素已卸载 */ } }
  }, [open])
  if (!open) return null
  return (
    <div className="gr-drawer-root">
      <div className="gr-drawer__mask" onClick={onClose} />
      <aside className="gr-drawer material-glass" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : tr('详情')} style={{ '--gr-drawer-w': width }}>
        <header className="gr-drawer__head">
          <div className="gr-grow">
            <h2 className="gr-drawer__title">{title}</h2>
            {subtitle ? <div className="gr-drawer__sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="gr-iconbtn" aria-label={tr('关闭')} onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <div className="gr-drawer__body">{children}</div>
        {footer ? <footer className="gr-drawer__foot">{footer}</footer> : null}
      </aside>
    </div>
  )
}

//#endregion

export { Tooltip } from './Tooltip.jsx'

//#region Popover / MenuItem

/**
 * 弹出面板（旧件：放在 position:relative 的包裹元素里，open 时贴在其下方；新代码用 PopoverPanel / Menu）。
 * 点击外部 / Esc 关闭。align: left | right。
 */
export function Popover({ open, onClose, align = 'left', width, className = '', children }) {
  const ref = useRef(null)
  useClickAway(ref, (e) => {
    // 点在触发按钮上由按钮自己切换，避免「先关再开」
    if (e.target && e.target.closest && e.target.closest('[data-popover-anchor]')) return
    onClose()
  }, open)
  useEscLayer('popover', () => onClose(), !!open)
  if (!open) return null
  return <div ref={ref} className={cx('gr-popover material-glass', 'gr-popover--' + align, className)} style={width ? { width } : undefined} role="menu">{children}</div>
}

/** 菜单项。active=当前项（右侧 ✓）；hint=右侧弱文字。 */
export function MenuItem({ icon, active = false, disabled = false, hint, onSelect, children, tone }) {
  return (
    <button type="button" role="menuitem" className={cx('gr-menuitem', active && 'is-active', tone === 'danger' && 'gr-menuitem--danger')} disabled={disabled} onClick={onSelect}>
      {icon ? <Icon name={icon} size={14} /> : null}
      <span className="gr-menuitem__t">{children}</span>
      {hint != null ? <span className="gr-menuitem__h gr-num">{hint}</span> : null}
      {active ? <Icon name="check" size={14} className="gr-menuitem__ck" /> : null}
    </button>
  )
}
export const MenuDivider = () => <div className="gr-menudiv" role="separator" />

//#endregion
