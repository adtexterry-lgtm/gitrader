// SPDX-License-Identifier: CPAL-1.0
// 基础组件（视觉轮 r2，令牌 v5）：页面容器 / 栅格 / Card（面板·英雄区）/ Section / ScrollArea / Stat / 进度 / 空态（图标格）/ 骨架 / 标签 / 徽标 / 按钮 / 行内确认（ConfirmButton 旧 + InlineConfirm G2）/ 分段 / 页签 / 闪烁数字。
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import * as F from '../lib/format.js'
import { Icon } from './Icon.jsx'
import { InfoTip } from './Tooltip.jsx'
import { ErrText } from './ErrText.jsx'
import { cardHover, counter } from '../motion.js'
import { t as tr } from '../lib/i18n.js'

const cx = (...a) => a.filter(Boolean).join(' ')
const CJK = /[㐀-鿿＀-￯]/

//#region 页面容器与栅格

/**
 * 页面容器。title/subtitle/actions 渲染页头（subtitle 自动收成标题旁的 ⓘ 悬停）；fill=true 时内容区撑满且不滚动（页面自己管内部滚动）。
 * 视口即容器：任何宽度都没有页面级滚动条，非 fill 页的页体在内容区内部滚动（滚动条隐藏）。
 */
export function Page({ title, subtitle, actions, fill = false, className = '', children, id }) {
  return (
    <div className={cx('gr-page', fill && 'gr-page--fill', className)} id={id}>
      {title || actions ? (
        <header className="gr-page__head">
          <div className="gr-page__titles">
            {title ? <div className="gr-page__trow"><h1 className="gr-page__title">{title}</h1>{subtitle ? <InfoTip text={subtitle} placement="bottom" className="gr-page__info" /> : null}</div> : null}
          </div>
          {actions ? <div className="gr-page__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="gr-page__body">{children}</div>
    </div>
  )
}

/** 12 列栅格。子元素用 <Col span={8} md={12}>；md = 900–1199，sm = <900（缺省沿用上一档，sm 缺省 12）。 */
export function Grid({ gap, className = '', children }) {
  return <div className={cx('gr-grid', className)} style={gap ? { gap: `var(--gr-s${gap})` } : undefined}>{children}</div>
}
export function Col({ span = 12, md, sm = 12, className = '', children }) {
  return <div className={cx('gr-col', `gr-span-${span}`, `gr-md-span-${md ?? span}`, `gr-sm-span-${sm}`, className)}>{children}</div>
}

//#endregion

//#region Card / Section / ScrollArea

/**
 * 面板（B 级）：L1 底、无边框无阴影、顶边内高光、圆角 12、内边距 14。title 是安静的标签（13 / 400 次要色），meta 右对齐，actions 在其后。
 * hero=true → 英雄区（A 级，每页 ≤ 1）：顶部 1px 橙色光线 + .07 内光、圆角 16、内边距 20。
 * flush=true 去内边距（内嵌表格）。glass / warm / tilt 属性已废弃（空实现，保留一周兼容旧页面）。
 */
export function Card({ title, meta, actions, flush = false, hero = false, glass, warm, tilt, className = '', id, children, ...rest }) {
  const ref = useRef(null)
  useEffect(() => (tilt && ref.current ? cardHover(ref.current, { max: 3, scale: 1 }) : undefined), [tilt])
  return (
    <section ref={ref} className={cx('gr-card', flush && 'gr-card--flush', hero && 'gr-card--hero', tilt && 'tilt', className)} id={id} {...rest}>
      {title != null || meta != null || actions ? <PanelHead title={title} meta={meta} actions={actions} flush={flush} /> : null}
      {children}
    </section>
  )
}
export function PanelHead({ title, meta, actions, flush }) {
  return (
    <div className={cx('gr-panelhead', flush && 'gr-panelhead--flush')}>
      <h2 className="gr-panelhead__title">{title}</h2>
      {meta != null ? <div className="gr-panelhead__meta">{meta}</div> : null}
      {actions ? <div className="gr-panelhead__actions">{actions}</div> : null}
    </div>
  )
}
export const Panel = Card

/** 区块（C 级，无容器）：标题 13 / 400 次要色 + 右侧链接，直接坐在画布上，靠 24–32 间距分组。 */
export function Section({ title, meta, right, className = '', children }) {
  return (
    <section className={cx('gr-section', className)}>
      {title != null || right ? <div className="gr-section__h"><h2 className="gr-section__t">{title}</h2>{meta != null ? <span className="gr-section__m">{meta}</span> : null}{right ? <div className="gr-section__r">{right}</div> : null}</div> : null}
      {children}
    </section>
  )
}

/**
 * 内部滚动区：隐藏滚动条、溢出时顶部 16px / 底部 28px 渐隐遮罩（.can-up / .can-down）、滚动时淡入的 3px 覆盖细条（停止 800ms 后淡出）。
 * 父容器需给高度（flex: 1; min-height: 0 或固定高）。长内容只在这里滚，不要让页面滚。
 */
export function ScrollArea({ className = '', children, onScroll, thumb = true, ...rest }) {
  const ref = useRef(null)
  const th = useRef(null)
  const [edge, setEdge] = useState({ up: false, down: false })
  const timer = useRef(0)
  const update = () => {
    const el = ref.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    setEdge((e) => { const n = { up: el.scrollTop > 2, down: max > 2 && el.scrollTop < max - 2 }; return e.up === n.up && e.down === n.down ? e : n })
    const t = th.current
    if (t && thumb) {
      if (max <= 2) { t.style.opacity = '0'; return }
      const h = Math.max(24, (el.clientHeight * el.clientHeight) / el.scrollHeight)
      t.style.height = h + 'px'
      t.style.transform = `translateY(${(el.scrollTop / max) * (el.clientHeight - h)}px)`
    }
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])
  const onScr = (e) => {
    update()
    const t = th.current
    if (t && thumb) { t.style.opacity = '1'; clearTimeout(timer.current); timer.current = setTimeout(() => { if (th.current) th.current.style.opacity = '0' }, 800) }
    if (onScroll) onScroll(e)
  }
  return (
    <div className={cx('gr-scrollarea', edge.up && 'can-up', edge.down && 'can-down', className)}>
      <div ref={ref} className="gr-scrollarea__in" tabIndex={0} onScroll={onScr} {...rest}>{children}</div>
      {thumb ? <i ref={th} className="gr-scrollarea__thumb" aria-hidden="true" /> : null}
    </div>
  )
}

/** 立体橙色圆盘图标容器。全站 ≤ 4 处、每页 ≤ 1：插卡台主控、商店精选、编排总开关、品牌。白色字形 + 凹刻。size: sm(28) | md(40,默认) | lg(44)。 */
export function IconOrb({ name, size = 'md', className = '' }) {
  return <span className={cx('icon-orb', size !== 'md' && 'icon-orb--' + size, className)}><Icon name={name} size={size === 'lg' ? 20 : size === 'sm' ? 14 : 18} /></span>
}
/** G 页面里叫 Orb；与 IconOrb 同一个组件。 */
export const Orb = IconOrb

/** 数字滚动：value 变化时 300 ms 滚到新值；format(v) 把数字格式化成文本（缺省 F.usd）。只给英雄数字与今日盈亏用。 */
export function AnimatedNumber({ value, format = F.usd, className = '' }) {
  const ref = useRef(null)
  const shown = useRef(value)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    if (!F.isNum(value)) { el.textContent = format(value); shown.current = value; return undefined }
    const from = F.isNum(shown.current) ? shown.current : value
    const c = counter(from, value, (v) => { shown.current = v; el.textContent = format(v) })
    return () => c.kill()
  }, [value])
  return <span ref={ref} className={cx('gr-num', className)} />
}

//#endregion

//#region Stat / Progress

/**
 * 数字 + 副文本。size: hero(44) | lg(28) | md(20) | sm(16)，一律 Geist 400 + 等宽数字（不加粗）。value 变化可闪（flash，只闪字色）。tone: up|down|flat|warn（副文本跟着涨跌着色）。
 * 零值不着色（0.00 一律次要色）；含中文的值用 400，不用 500。unit 是单位（降一级弱色，与数值分开）。
 */
export function Stat({ label, value, sub, unit, tone, size = 'md', flash, align, className = '', hint }) {
  const isZero = typeof value === 'string' && /^[+\-−]?0(\.0+)?%?$/.test(value.replace(/[,\s]/g, ''))
  const t = isZero ? 'flat' : tone
  const cjk = typeof value === 'string' && CJK.test(value)
  const val = <span className={cx('gr-stat__v gr-num', cjk && 'is-cjk', t && 'gr-' + t)}>{value}{unit ? <small className="gr-unit">{unit}</small> : null}</span>
  return (
    <div className={cx('gr-stat', 'gr-stat--' + size, align === 'right' && 'gr-stat--right', className)} title={hint}>
      {label != null ? <div className="gr-stat__k">{label}</div> : null}
      <div className="gr-stat__row">{flash !== undefined ? <Flash value={flash} className="gr-stat__flash">{val}</Flash> : val}{sub != null ? <span className={cx('gr-stat__sub gr-num', (t === 'up' || t === 'down') && 'gr-' + t)}>{sub}</span> : null}</div>
    </div>
  )
}

/** 进度条：高 3 内凹轨，填充暖白 70%；auto=true 时 > warnAt 警示色、> dangerAt 红；mark = 阈值刻度位置（0–100，1px）。 */
export function ProgressBar({ value, tone, auto = false, warnAt = 60, dangerAt = 85, mark, label, className = '', height }) {
  const v = Math.max(0, Math.min(100, F.isNum(value) ? value : 0))
  const t = tone || (auto ? (v > dangerAt ? 'down' : v > warnAt ? 'warn' : '') : '')
  return (
    <div className={cx('gr-progress', className)} role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(v)} style={height ? { height: height + 'px' } : undefined}>
      <i className={cx('gr-progress__fill', t && 'gr-progress--' + t)} style={{ width: v + '%' }} />
      {F.isNum(mark) ? <b className="gr-progress__mark" style={{ left: Math.max(0, Math.min(100, mark)) + '%' }} /> : null}
    </div>
  )
}

//#endregion

//#region 空态 / 骨架

const ART_BY_ICON = { chart: 'no-positions', trade: 'no-positions', signal: 'no-signals', signals: 'no-signals', sparkle: 'no-proposals', spark: 'no-proposals', offline: 'offline', wallet: 'no-wallet', markets: 'no-data', search: 'no-data', star: 'no-data', inbox: 'no-data', strategy: 'no-signals', reject: 'no-data', lock: 'no-wallet' }
// r2：等轴测插画换成 32px 图标格（插画文件保留在 illustrations/，不再打进包）
const ICON_BY_ART = { 'no-positions': 'trade', 'no-signals': 'signals', 'no-proposals': 'decision', 'no-data': 'data', offline: 'offline', 'no-wallet': 'wallet' }

/** 空态 = 32px 图标格 + 一句话 + 至多一个动作，在容器里水平垂直居中。art: no-positions | no-signals | no-proposals | no-data | offline | no-wallet；icon 可直接给图标名。desc 只放上游原文（两行截断，悬停看全文），不写说明句。 */
export function EmptyState({ art, icon, title, desc, children, compact = false, className = '' }) {
  const name = (icon && !ART_BY_ICON[icon] ? icon : null) || ICON_BY_ART[art || ART_BY_ICON[icon]] || 'data'
  return (
    <div className={cx('gr-empty', compact && 'gr-empty--compact', className)}>
      <span className="gr-empty__icon gr-empty__art" aria-hidden="true"><Icon name={name} size={16} /></span>
      <div className="gr-empty__txt">
        {title ? <div className="gr-empty__t">{title}</div> : null}
        {desc ? <div className="gr-empty__d" title={typeof desc === 'string' ? desc : undefined}>{desc}</div> : null}
        {children ? <div className="gr-empty__act">{children}</div> : null}
      </div>
    </div>
  )
}

/** 骨架块（ink-3 圆角 6，脉冲一次后静止）。w/h 为 CSS 长度或数字(px)。给 onRetry 时，8 s 后在它后面出「仍在读取」+ 重试（见 SkeletonSlow）。 */
export function Skeleton({ w = '100%', h = 12, className = '', style, onRetry, slowAfter }) {
  const px = (v) => (typeof v === 'number' ? v + 'px' : v)
  const bar = <div className={cx('gr-skel', className)} style={{ width: px(w), height: px(h), ...style }} aria-hidden="true" />
  return onRetry ? <>{bar}<SkeletonSlow onRetry={onRetry} after={slowAfter} /></> : bar
}
/** 多行骨架（lines 行，宽度错落）。onRetry：8 s 后出「仍在读取」+ 重试。 */
export function SkeletonLines({ lines = 4, h = 12, className = '', onRetry, slowAfter }) {
  return (
    <div className={cx('gr-skel-rows', className)} aria-busy="true" aria-label={tr('加载中')}>
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} h={h} w={i % 3 === 2 ? '72%' : i % 3 === 1 ? '90%' : '100%'} />)}
      {onRetry ? <SkeletonSlow onRetry={onRetry} after={slowAfter} /> : null}
    </div>
  )
}
/** 骨架超时提示（IXD F9-4）：挂载 after 毫秒（缺省 8000）后出「仍在读取」+ [重试]；之前什么都不渲染。放在自定义形状的骨架后面。 */
export function SkeletonSlow({ onRetry, after = 8000, className = '' }) {
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { const t = setTimeout(() => setSlow(true), after); return () => clearTimeout(t) }, [after])
  if (!slow) return null
  const retry = async () => { setBusy(true); try { await (onRetry && onRetry()) } finally { setBusy(false) } }
  return (
    <div className={cx('gr-skel-slow', className)} data-skel-slow="">
      <span>{tr('仍在读取')}</span>
      {onRetry ? <Button variant="ghost" size="xs" busy={busy} onClick={retry} data-act="skeleton-retry">{busy ? tr('重试中…') : tr('重试')}</Button> : null}
    </div>
  )
}

//#endregion

//#region 标签 / 徽标 / 键帽 / 状态点

/** 计数徽标：18 高、圆角 4、Mono 11 / 500（只放数字）。tone: 缺省中性 | accent（待批计数：12% 橙底 + 橙字）| down（10% 红 + 红字）| up。 */
export function Badge({ children, tone, title, className = '' }) {
  return <span className={cx('gr-badge gr-num', tone && 'gr-badge--' + tone, className)} title={title}>{children}</span>
}
/** 标签（每卡 / 每行 ≤ 1）：高 18、方角 4、12 / 400。tone: up|down（文字色 + 10% 底）| warn（暖橙字）| 缺省中性；accent / info / outline 一律按中性渲染（橙色只给五个角色）。 */
export function Tag({ tone, outline = false, children, title, className = '' }) {
  const t = tone === 'up' || tone === 'down' || tone === 'warn' ? tone : ''
  return <span className={cx('gr-tag', t && 'gr-tag--' + t, className)} title={title}>{children}</span>
}
/** 方向：着色文字（买入 / 卖出），不要底块。 */
export function SideTag({ side }) {
  return <span className={'gr-side ' + (side === 'buy' ? 'gr-up' : 'gr-down')}>{F.sideWord(side)}</span>
}
export function Kbd({ children }) { return <kbd className="gr-kbd">{children}</kbd> }
/** 状态点（6px）。tone: ok(绿) | pending(橙 + 3px 光环呼吸) | unknown(灰空心) | err(红) | warn(暖橙) | idle(灰)。pulse = 呼吸。 */
export function Dot({ tone = 'idle', pulse = false }) { return <i className={cx('gr-dot', 'gr-dot--' + tone, (pulse || tone === 'pending') && 'is-pulse')} /> }
/** 状态胶囊（顶栏行情状态同款）：无边框，点 + 文字。 */
export function Pill({ tone, children, title, onClick, className = '' }) {
  const body = <>{tone ? <Dot tone={tone} pulse={tone === 'ok'} /> : null}{children}</>
  return onClick
    ? <button type="button" className={cx('gr-pill gr-pill--btn', className)} title={title} onClick={onClick}>{body}</button>
    : <span className={cx('gr-pill', className)} title={title}>{body}</span>
}

//#endregion

//#region Button / ConfirmButton

const VARIANT_ALIAS = { danger: 'veto', accent: 'secondary' } // 旧名 → v3（r4：text 不再映射到 ghost，是独立的行内文字钮）
/**
 * 按钮（r4 三族）。实心：primary（流光橙 + 白字 600，min-width 88、左右 18，每屏 ≤ 1）｜kill（--gr-kill 实红：确认平仓 / 确认停止）。
 * 填充：secondary（6% → 悬停 9%：接管、按市价平仓…）。无底：ghost（body 字，悬停 6%：拒绝 / 取消）｜veto（r4 起与 ghost 同外观，不再红描边）｜
 * text（r4 新增：28 高、左右 8、字 12、text-2 → 悬停 text + 6%：平仓 / 止损 / 25%）｜link（「全部 ›」）。accent 映射为 secondary，danger → veto。
 * size: lg 40 | md 32(默认) | sm 28 | xs（= --gr-ctl-xs，r4 为 28）。icon: 图标名。busy: 忙碌并禁用。iconOnly: 方形图标钮 28×28（lg 40；必须给 aria-label）。
 */
export function Button({ variant = 'secondary', size = 'md', icon, iconOnly = false, busy = false, disabled, onClick, children, type = 'button', className = '', title, ...rest }) {
  const v = VARIANT_ALIAS[variant] || variant
  const px = size === 'lg' ? 16 : size === 'xs' ? 12 : 14
  // data-solid：实心填色按钮（中文 600 只许出现在 ≥ 16px 或实心按钮上，体检据此放行）
  return (
    <button type={type} className={cx('gr-btn', 'gr-btn--' + v, 'gr-btn--' + size, iconOnly && 'gr-btn--icon', busy && 'is-busy', className)}
      disabled={disabled || busy} onClick={onClick} title={title} data-solid={v === 'kill' || v === 'buy' || v === 'sell' ? '' : undefined} {...rest}>
      {icon ? <Icon name={icon} size={px} /> : null}
      {children}
    </button>
  )
}

// 全局只允许一个待确认动作：后一个 arm 会立刻取消前一个（ConfirmButton 与 InlineConfirm 共用这一格；存的是稳定的 ref，不随渲染变）。
let armedNow = null
const takeArm = (self) => { if (armedNow && armedNow !== self && armedNow.current) armedNow.current(); armedNow = self }
const dropArm = (self) => { if (armedNow === self) armedNow = null }
/**
 * 旧的行内确认按钮（行为不变，保留给还没迁移的调用方；新代码用 InlineConfirm）：点一次原地变成「确认 ✓  ✕」，5 秒内有效，Esc / 点 ✕ / 超时取消。
 * 确认按钮：危险类（variant veto / danger）用 kill（红实心），其余用 primary。两步确认（重置）：给 confirmLabel 与 hint。
 */
export function ConfirmButton({ label, confirmLabel = tr('确认'), onConfirm, variant = 'secondary', confirmVariant, size = 'sm', icon, busy = false, disabled, timeout = 5000, hint, className = '', cancelLabel = tr('取消'), dataAct }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef(null)
  const self = useRef(null)
  const disarm = () => { clearTimeout(timer.current); setArmed(false); dropArm(self) }
  self.current = disarm
  const arm = () => {
    takeArm(self)
    setArmed(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => self.current(), timeout)
  }
  useEffect(() => {
    if (!armed) return undefined
    const onKey = (e) => { if (e.key === 'Escape') disarm() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armed])
  useEffect(() => () => { clearTimeout(timer.current); dropArm(self) }, [])
  if (!armed) return <Button variant={variant} size={size} icon={icon} busy={busy} disabled={disabled} className={className} onClick={arm} data-act={dataAct}>{label}</Button>
  const danger = variant === 'veto' || variant === 'danger' || variant === 'kill'
  return (
    <span className={cx('gr-confirm', className)} role="group" aria-label={tr('确认操作')}>
      {hint ? <span className="gr-confirm__hint">{hint}</span> : null}
      <Button variant={confirmVariant || (danger ? 'kill' : 'primary')} size={size} icon="check" busy={busy} data-act={dataAct ? dataAct + '-confirm' : 'confirm'}
        onClick={async () => { const r = onConfirm && (await onConfirm()); if (r !== 'keep') disarm() }}>{confirmLabel}</Button>
      <Button variant="ghost" size={size} iconOnly icon="close" aria-label={cancelLabel} data-act={dataAct ? dataAct + '-cancel' : 'cancel'} onClick={disarm} />
    </span>
  )
}

/**
 * 就地确认（IXD G2，替代 ConfirmButton 的行为）：点一下原地变成 [取消] [确认动词]——
 * ① 取消在前、确认写动词（confirmLabel：「确认平仓」「确认恢复」…）；② 武装瞬间焦点落到「取消」（Enter 连按两次不会执行）；
 * ③ 武装后 deadZone（600 ms）内对确认的点击 / 回车一律忽略，组内所有 e.repeat 按键忽略；④ 闲置 timeout（5 s）失效，指针悬停或焦点在组内时暂停计时，
 * 失效时焦点在组内则回到原触发钮；⑤ 执行中确认钮转圈 + busyLabel，取消钮隐藏（命令已发出）；⑥ onConfirm 抛错 = 失败：保持武装、重新给满 5 s，
 * 组旁就地显示错误原文（error 属性可由调用方直接给）；返回 'keep' = 保持武装；⑦ 全局同时只有一个武装（与 ConfirmButton 共用）；Esc 只在焦点位于组内时解除。
 * 测试钩子：触发钮 data-act={dataAct}，确认 `${dataAct}-confirm`，取消 `${dataAct}-cancel`；根节点 .gr-iconfirm[data-armed]。
 */
export function InlineConfirm({ label, confirmLabel = tr('确认'), onConfirm, variant = 'secondary', confirmVariant, size = 'sm', icon, busy = false, busyLabel, disabled, reason, timeout = 5000, deadZone = 600, error, className = '', cancelLabel = tr('取消'), dataAct, onArmedChange }) {
  const [armed, setArmed] = useState(false)
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState(null)
  // r4：死区期间根上挂 data-dead（只是外观：45% 不透明 + 底部细条；挡点击仍靠下面 confirm() 里的 armedAt 判断）
  const [dead, setDead] = useState(false)
  const deadTimer = useRef(0)
  const root = useRef(null)
  const self = useRef(null)
  const timer = useRef(0)
  const armedAt = useRef(0)
  const hover = useRef(false)
  const back = useRef(false)
  const inside = () => !!(root.current && root.current.contains(document.activeElement))
  const stopIdle = () => { clearTimeout(timer.current); timer.current = 0 }
  const endDead = () => { clearTimeout(deadTimer.current); deadTimer.current = 0; setDead(false) }
  const disarm = () => { stopIdle(); endDead(); back.current = inside(); dropArm(self); setArmed(false); setRunning(false); setErr(null); if (onArmedChange) onArmedChange(false) }
  self.current = disarm
  // 指针悬停 = 暂停；组内的键盘活动（换焦点 / 按键）= 重新计满 5 s（武装时焦点本来就在组内，不能让它永不失效）
  const idle = () => { stopIdle(); if (!hover.current) timer.current = setTimeout(() => self.current(), timeout) }
  const arm = () => {
    takeArm(self)
    armedAt.current = performance.now()
    clearTimeout(deadTimer.current)
    if (deadZone > 0) { setDead(true); deadTimer.current = setTimeout(endDead, deadZone) }
    setErr(null)
    setArmed(true)
    if (onArmedChange) onArmedChange(true)
    idle()
  }
  // 禁用 = 调用方的 disabled 或壳挂在 <html data-offline> 上的离线（A-API 附录的共享契约）。武装态每次渲染都看（C4）：断线、别的入口开始执行时
  // 立即解除武装并禁用；正在执行的不动（命令已发出，结果照常回来）。
  const htmlOff = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-offline')
  const off = !!disabled || htmlOff
  const why = off ? reason || (htmlOff ? tr('离线') : undefined) : undefined
  useEffect(() => { if (armed && off && !running && !busy) disarm() })
  const confirm = async () => {
    if (running || busy || off || performance.now() - armedAt.current < deadZone) return
    stopIdle()
    setRunning(true)
    setErr(null)
    let r
    try { r = onConfirm ? await onConfirm() : undefined } catch (e) {
      setRunning(false)
      setErr(String((e && e.message) || e))
      armedAt.current = performance.now() - deadZone // 失败后重试不再吃死区
      idle()
      return
    }
    if (r === 'keep') { setRunning(false); idle(); return }
    disarm()
  }
  // 武装 → 焦点落「取消」；解除时焦点若在组内 → 回到触发钮（不丢到 body）
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    // 因离线 / 禁用而解除时触发钮是禁用的、接不住焦点：落到组本身（tabIndex -1），不丢到 body
    if (armed) { const c = el.querySelector('[data-iconfirm="cancel"]'); if (c) c.focus() } else if (back.current) { back.current = false; const t = el.querySelector('[data-iconfirm="trigger"]'); if (t && !t.disabled) t.focus(); else el.focus() }
  }, [armed])
  useEffect(() => () => { stopIdle(); clearTimeout(deadTimer.current); dropArm(self) }, [])
  const shownErr = error != null && error !== '' ? error : err
  const isBusy = running || busy
  const danger = variant === 'veto' || variant === 'danger' || variant === 'kill'
  const onKeyDown = (e) => {
    if (e.repeat) { e.preventDefault(); return }
    if (!armed) return
    if (e.key === 'Escape' && !isBusy) { e.preventDefault(); e.stopPropagation(); disarm(); return }
    if (!isBusy) idle()
  }
  return (
    <span ref={root} className={cx('gr-iconfirm', className)} tabIndex={-1} data-armed={armed ? '' : undefined} data-dead={armed && dead ? '' : undefined} style={armed && dead ? { '--gr-iconfirm-dead': deadZone + 'ms' } : undefined} title={why} onKeyDown={onKeyDown}
      onPointerEnter={() => { hover.current = true; if (armed) stopIdle() }} onPointerLeave={() => { hover.current = false; if (armed && !isBusy) idle() }}
      onFocusIn={() => { if (armed && !isBusy) idle() }}>
      {!armed ? (
        <Button variant={variant} size={size} icon={icon} busy={busy} disabled={off} onClick={arm} data-act={dataAct} data-iconfirm="trigger">{label}</Button>
      ) : (
        <span className="gr-iconfirm__group" role="group" aria-label={typeof label === 'string' ? label : tr('确认操作')}>
          {isBusy ? null : <Button variant="ghost" size={size} onClick={disarm} data-act={dataAct ? dataAct + '-cancel' : 'cancel'} data-iconfirm="cancel">{cancelLabel}</Button>}
          <Button variant={confirmVariant || (danger ? 'kill' : 'primary')} size={size} busy={isBusy} disabled={off && !isBusy} onClick={confirm} data-act={dataAct ? dataAct + '-confirm' : 'confirm'} data-iconfirm="confirm">{isBusy ? (busyLabel || confirmLabel) : confirmLabel}</Button>
        </span>
      )}
      {armed && shownErr ? <span className="gr-iconfirm__err" role="alert"><ErrText text={shownErr} /></span> : null}
    </span>
  )
}

//#endregion

//#region Segmented / Tabs

/**
 * 分段控件（r4 外观 = 页签：28 高、左右 8、间距 4、圆角 6；未选 text-3，选中 6% 底 + text；无凹槽、无下划线；不用橙）。
 * options: [{id,label,count?,disabled?,title?}]（count：r4 新增，标签后的计数 12 text-3，.gr-seg__n）。size: md | sm（r4 起同为 28 高）。项不压缩、不截断。
 * manual=true：手动激活（IXD F7-4，有副作用的设置用）——← → 只移焦点，Enter / Space 才提交；缺省是「选择跟随焦点」。
 */
export function Segmented({ value, options, onChange, label, disabled, size = 'md', className = '', fit = false, manual = false }) {
  const onKey = (e) => {
    const i = options.findIndex((o) => o.id === value)
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    if (manual) {
      const btns = Array.from(e.currentTarget.querySelectorAll('.gr-seg__btn:not(:disabled)'))
      const at = btns.indexOf(document.activeElement)
      const next = btns[((at < 0 ? 0 : at) + step + btns.length) % btns.length]
      if (next) next.focus()
      return
    }
    for (let k = 1; k <= options.length; k += 1) {
      const o = options[(i + step * k + options.length * 2) % options.length]
      if (!o.disabled) { onChange(o.id); break }
    }
  }
  return (
    <div className={cx('gr-seg', size === 'sm' && 'gr-seg--sm', fit && 'gr-seg--fit', className)} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} tabIndex={value === o.id ? 0 : -1} className="gr-seg__btn" disabled={disabled || o.disabled} data-v={o.id} title={o.title}
          onClick={() => { if (value !== o.id) onChange(o.id) }}>{o.label}{o.count != null ? <span className="gr-seg__n gr-num">{o.count}</span> : null}</button>
      ))}
    </div>
  )
}

/** 页签（选中 = .06 底 + 白字，高 28 圆角 6；无底条、无下边线）。tabs: [{id,label,count?}]。 */
export function Tabs({ tabs, value, onChange, label, className = '', panelId = 'gr-tabpanel', flush = false, right }) {
  const onKey = (e) => {
    const i = tabs.findIndex((t) => t.id === value)
    if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length].id)
    else if (e.key === 'ArrowLeft') onChange(tabs[(i + tabs.length - 1) % tabs.length].id)
    else return
    e.preventDefault()
  }
  return (
    <div className={cx('gr-tabs', flush && 'gr-tabs--flush', className)}>
      <div className="gr-tablist" role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={'gr-tab-' + t.id} aria-selected={value === t.id} aria-controls={panelId} tabIndex={value === t.id ? 0 : -1} className="gr-tab" data-tab={t.id} onClick={() => onChange(t.id)}>
            {t.label}{t.count > 0 ? <span className="gr-tab__n gr-num">{t.count}</span> : null}
          </button>
        ))}
        {right ? <div className="gr-tablist__right">{right}</div> : null}
      </div>
    </div>
  )
}

//#endregion

//#region Flash

/** 数字变化时闪一下（涨绿跌红，400 ms，只闪文字色，不闪底色）。value 是数值；children 是展示内容。 */
export function Flash({ value, className = '', children, title }) {
  const ref = useRef(null)
  const prev = useRef(value)
  useEffect(() => {
    const el = ref.current
    if (el && F.isNum(value) && F.isNum(prev.current) && value !== prev.current) {
      el.classList.remove('gr-flash-up', 'gr-flash-down')
      void el.offsetWidth
      el.classList.add(value > prev.current ? 'gr-flash-up' : 'gr-flash-down')
    }
    prev.current = value
  }, [value])
  return <span ref={ref} className={cx('gr-flash', className)} title={title}>{children}</span>
}

//#endregion
