// SPDX-License-Identifier: CPAL-1.0
// 悬停 / 聚焦显示的文字气泡 + ⓘ 说明图标（极简界面里「必要说明」的唯一载体）。
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Icon } from './Icon.jsx'
import { t } from '../lib/i18n.js'

const cx = (...a) => a.filter(Boolean).join(' ')

/** 悬停 / 聚焦显示的文字气泡（实底 ink-3、r8、12 px；悬停意图 300 ms 后淡入）。placement: top(默认) | bottom | left | right。左右夹紧在视口内 8 px。不要放可交互内容。 */
export function Tooltip({ text, placement = 'top', children, className = '' }) {
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const tip = useRef(null)
  // 视口夹紧：量一次气泡，超出左右 8 px 的部分推回来（Radix Tooltip 在 preact/compat 下打不开，保留自研）
  useLayoutEffect(() => {
    const el = tip.current
    if (!el) return
    el.style.marginLeft = '0px'
    const r = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const shift = r.left < 8 ? 8 - r.left : r.right > vw - 8 ? vw - 8 - r.right : 0
    if (shift) el.style.marginLeft = shift + 'px'
  }, [pos])
  const show = () => {
    const el = ref.current
    if (!el || !text) return
    const r = el.getBoundingClientRect()
    const gap = 6
    const p = placement === 'bottom' ? { x: r.left + r.width / 2, y: r.bottom + gap }
      : placement === 'left' ? { x: r.left - gap, y: r.top + r.height / 2 }
        : placement === 'right' ? { x: r.right + gap, y: r.top + r.height / 2 }
          : { x: r.left + r.width / 2, y: r.top - gap }
    setPos(p)
  }
  const hide = () => setPos(null)
  return (
    <span ref={ref} className={cx('gr-tipwrap', className)} onMouseEnter={show} onMouseLeave={hide} onFocusIn={show} onFocusOut={hide} onClick={hide} onKeyDown={(e) => { if (e.key === 'Escape') hide() }}>
      {children}
      {pos ? <span ref={tip} className={'gr-tip gr-tip--' + placement} role="tooltip" style={{ left: pos.x + 'px', top: pos.y + 'px' }}>{text}</span> : null}
    </span>
  )
}


/** ⓘ：把说明文字收进悬停气泡。页面不要再写灰色解释句，需要说明就用它（Page 的 subtitle、Field 的 hint 已自动改用它）。 */
export function InfoTip({ text, placement = 'top', className = '' }) {
  if (!text) return null
  return (
    <Tooltip text={text} placement={placement} className={cx('gr-infotip', className)}>
      <span className="gr-infotip__i" tabIndex={0} role="img" aria-label={typeof text === 'string' ? text : t('说明')}><Icon name="info" size={13} /></span>
    </Tooltip>
  )
}
