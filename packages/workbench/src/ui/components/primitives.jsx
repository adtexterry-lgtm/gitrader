// SPDX-License-Identifier: CPAL-1.0
// 原语：Tile 图标块。列表行 / 键值 dl 是纯 CSS 类（components.css：.gr-list / .gr-li / .gr-dl）。
import { Icon } from './Icon.jsx'

/** 中性图标块：28px、凸起底、圆角 7、图标 16（列表行前面）。 */
export function Tile({ name, size = 28, active = false, className = '' }) {
  return <span className={'gr-tile' + (active ? ' is-active' : '') + (className ? ' ' + className : '')} style={size !== 28 ? { width: size + 'px', height: size + 'px' } : undefined} aria-hidden="true"><Icon name={name} size={size >= 28 ? 16 : 14} /></span>
}
