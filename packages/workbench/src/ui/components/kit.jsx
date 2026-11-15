// SPDX-License-Identifier: CPAL-1.0
// r2 新增的小原语：ButtonGroup（分段钮组）/ RollingNumber（里程表数字）/ Pager（‹ 1 / 2 ›）/ ItemList + Item（整行 + 底细线的列表行）。
// 动效只抄 Transitions.dev 的数值（数字换位 500 ms 错开 70 ms、计数 350 ms），自己写；减少动效时 theme.css 把 transform 过渡全部取消（直接到位）。
import { Button } from './core.jsx'
import { Icon } from './Icon.jsx'
import { t } from '../lib/i18n.js'

const cx = (...a) => a.filter(Boolean).join(' ')
const isDigit = (c) => c >= '0' && c <= '9'

/** 分段钮组：外框 r8 + 细线，组内 1px 竖线分隔（shadcn Button Group 的结构）。子项可以是 Button，也可以是 <span className="gr-btngroup__text"> 这种不可点的段。 */
export function ButtonGroup({ children, label, className = '', vertical = false }) {
  return <div className={cx('gr-btngroup', vertical && 'gr-btngroup--v', className)} role="group" aria-label={label}>{children}</div>
}

/**
 * 里程表数字。value = 已格式化的文本（'22,467.70'、'+115.90'、3）；变了的数位竖着滚到新值（duration ms，从右往左每位错开 stagger ms），其余字符不动。
 * 视觉列全是伪元素：innerText / textContent / 读屏只拿到一份完整文本（藏在 .gr-sr 里），测试照常按文本断言。
 * r4（VISUAL §5 F）：缺省 300 ms、不错开——只有变化的那几位在滚（没变的位 transform 不变，不会动）。
 */
export function RollingNumber({ value, className = '', duration = 300, stagger = 0 }) {
  const text = value == null ? '' : String(value)
  const chars = Array.from(text)
  let fromRight = 0
  const cells = []
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const c = chars[i]
    const key = 'p' + (chars.length - i)
    if (isDigit(c)) {
      cells.unshift(<span key={key} className="gr-roll__d" data-c={c} style={{ '--gr-roll-d': c, '--gr-roll-delay': (fromRight * stagger) + 'ms' }}><span className="gr-roll__s" /></span>)
      fromRight += 1
    } else cells.unshift(<span key={key} className="gr-roll__c" data-c={c} />)
  }
  return (
    <span className={cx('gr-roll', className)} style={{ '--gr-roll-dur': duration + 'ms' }}>
      <span className="gr-sr">{text}</span>
      <span className="gr-roll__v" aria-hidden="true">{cells}</span>
    </span>
  )
}

/** 翻页器 ‹ 1 / 3 ›：count ≤ 1 时不渲染；← → 在组内翻页。index 从 0 起；onChange(新 index)。钩子：.gr-pager、[data-act="pager-prev" | "pager-next"]。 */
export function Pager({ index = 0, count = 0, onChange, label = t('翻页'), className = '' }) {
  if (!(count > 1)) return null
  const go = (d) => { const n = index + d; if (n >= 0 && n < count && onChange) onChange(n) }
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
  }
  return (
    <div className={cx('gr-pager', className)} role="group" aria-label={label} onKeyDown={onKey}>
      <Button variant="ghost" size="xs" iconOnly icon="chevron-left" aria-label={t('上一张')} disabled={index <= 0} onClick={() => go(-1)} data-act="pager-prev" />
      <span className="gr-pager__n gr-num"><RollingNumber value={index + 1} duration={350} stagger={0} /> / {count}</span>
      <Button variant="ghost" size="xs" iconOnly icon="chevron-right" aria-label={t('下一张')} disabled={index >= count - 1} onClick={() => go(1)} data-act="pager-next" />
    </div>
  )
}

/** 列表容器（整行 + 底细线；Linear changelog-row 的节奏）。 */
export function ItemList({ children, label, className = '' }) {
  return <ul className={cx('gr-items', className)} aria-label={label}>{children}</ul>
}

/**
 * 列表行：icon（图标名）· title · meta（第二行弱信息）· right（行尾，不可放可点件——给了 onClick 时整行是一个按钮）。
 * onClick + expanded（布尔）= 可展开行：头部是 <button aria-expanded>，展开时渲染 children。没有可展开内容就别给 onClick（行不可聚焦）。
 */
export function Item({ icon, title, meta, right, onClick, expanded, children, className = '', ...rest }) {
  const head = (
    <>
      {icon ? <span className="gr-item__icon" aria-hidden="true"><Icon name={icon} size={14} /></span> : null}
      <span className="gr-item__main">
        <span className="gr-item__t">{title}</span>
        {meta != null ? <span className="gr-item__m">{meta}</span> : null}
      </span>
      {right != null ? <span className="gr-item__r">{right}</span> : null}
    </>
  )
  return (
    <li className={cx('gr-item', expanded && 'is-open', className)} {...rest}>
      {onClick
        ? <button type="button" className="gr-item__head" aria-expanded={expanded === undefined ? undefined : !!expanded} onClick={onClick}>{head}</button>
        : <div className="gr-item__head">{head}</div>}
      {expanded && children ? <div className="gr-item__body">{children}</div> : null}
    </li>
  )
}
