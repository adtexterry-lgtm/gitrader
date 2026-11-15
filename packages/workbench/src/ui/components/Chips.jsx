// SPDX-License-Identifier: CPAL-1.0
// 筛选胶囊 / 提示条：收编自 G 的页面共用件（商店 / 卡库 / 拦截日志筛选、无模型提示 / 回测失败 / 已装入插卡台）。
// 样式在 components/shared.css（类名沿用 gr-bshared-*，历史原因；后续统一改名）。
import { Icon } from './Icon.jsx'

const cx = (...a) => a.filter(Boolean).join(' ')

/**
 * 带计数、可换行的筛选胶囊。items: [{id,label,count?,disabled?}]。
 * 单选：value=id + onChange(id)；多选：multi 且 value=id[] + onChange(nextArray)。
 */
export function Chips({ items, value, onChange, multi = false, label, className = '' }) {
  const on = (id) => (multi ? Array.isArray(value) && value.includes(id) : value === id)
  const pick = (id) => {
    if (!multi) { if (value !== id) onChange(id); return }
    const cur = Array.isArray(value) ? value : []
    onChange(cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id))
  }
  return (
    <div className={cx('gr-bshared-chips', className)} role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" className={cx('gr-bshared-chip', on(it.id) && 'is-on')} aria-pressed={on(it.id)} disabled={it.disabled} data-chip={it.id} onClick={() => pick(it.id)}>
          {it.label}{it.count != null ? <span className="gr-num gr-bshared-chip__n">{it.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** 提示条：图标 + 标题 + 可选说明 + 右侧操作。tone: ok(默认) | err。 */
export function Notice({ icon = 'check', title, desc, action, tone = 'ok', className = '' }) {
  return (
    <div className={cx('gr-bshared-notice', tone === 'err' && 'gr-bshared-notice--err', className)} role={tone === 'err' ? 'alert' : 'status'}>
      <Icon name={icon} size={16} className="gr-bshared-notice__ico" />
      <div><div className="gr-bshared-notice__t">{title}</div>{desc ? <div className="gr-bshared-notice__d">{desc}</div> : null}</div>
      {action ? <div className="gr-bshared-notice__act">{action}</div> : null}
    </div>
  )
}
