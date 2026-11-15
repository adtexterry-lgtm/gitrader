// SPDX-License-Identifier: CPAL-1.0
// 数据表格：表头固定、数字列右对齐、行悬停、空态、骨架、可排序、可虚拟滚动（≥500 行用）。行高 36。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { EmptyState, Skeleton } from './core.jsx'
import { Icon } from './Icon.jsx'
import { useLayout } from '../lib/layout.js'
import { t } from '../lib/i18n.js'

const cx = (...a) => a.filter(Boolean).join(' ')
const ROW_H = 36

/** 排序状态钩子：返回 [sort, onSort]；sort = { key, dir:'asc'|'desc' }。首次点击：左对齐列升序，其余降序；再点翻转。 */
export function useSort(columns, initial) {
  const [sort, setSort] = useState(initial || null)
  const onSort = (key) => setSort((s) => {
    if (s && s.key === key) return { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    const col = columns.find((c) => c.key === key)
    return { key, dir: col && col.align === 'l' ? 'asc' : 'desc' }
  })
  return [sort, onSort]
}

/** 按 sort 对 rows 排序（返回新数组）。列的 sortValue(row) 缺省取 row[key]；null/NaN 永远排最后。 */
export function sortRows(rows, columns, sort) {
  if (!sort) return rows
  const col = columns.find((c) => c.key === sort.key)
  if (!col) return rows
  const get = col.sortValue || ((r) => r[col.key])
  const sgn = sort.dir === 'asc' ? 1 : -1
  return rows.slice().sort((a, b) => {
    const x = get(a); const y = get(b)
    const nx = x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x))
    const ny = y === null || y === undefined || (typeof y === 'number' && Number.isNaN(y))
    if (nx && ny) return 0
    if (nx) return 1
    if (ny) return -1
    if (typeof x === 'string' || typeof y === 'string') return sgn * String(x).localeCompare(String(y), 'zh-CN')
    return sgn * (x - y)
  })
}

/**
 * <Table columns rows rowKey ... />
 * columns: [{ key, title, align:'l'|'r'|'c', width, sortable, sortValue(row), render(row,i), className, hint }]
 *   - 缺省对齐：第一列左，其余右（数字列）；文字列请显式 align:'l'
 * rowKey: 字段名或 (row)=>key；onRowClick(row)；selectedKey：高亮行
 * sort/onSort：受控排序（配合 useSort + sortRows）
 * loading：true 且无 rows 时显示骨架行；empty：无数据时的节点（缺省 EmptyState）
 * footer：合计行（一组 <td>，列数与 columns 对齐；表格有数据时才显示，吸底）
 * virtual：true 启用窗口化（容器需有高度：maxHeight 或 fill）；maxHeight：CSS 长度；fill：撑满父容器高度
 */
export function Table({ columns, rows, rowKey = 'id', onRowClick, selectedKey, sort, onSort, loading = false, empty, virtual = false, maxHeight, fill = false, dense = false, className = '', rowClass, skeletonRows = 6, caption, footer }) {
  const wrapRef = useRef(null)
  const [win, setWin] = useState({ top: 0, h: 480 })
  const keyOf = typeof rowKey === 'function' ? rowKey : (r) => r[rowKey]
  const density = useLayout().density
  const rh = dense || density === 'compact' ? (dense && density === 'compact' ? 28 : density === 'compact' ? 30 : 32) : ROW_H

  useEffect(() => {
    if (!virtual) return undefined
    const el = wrapRef.current
    if (!el) return undefined
    let raf = 0
    const upd = () => { raf = 0; setWin({ top: el.scrollTop, h: el.clientHeight }) }
    const on = () => { if (!raf) raf = requestAnimationFrame(upd) }
    el.addEventListener('scroll', on, { passive: true })
    const ro = new ResizeObserver(on)
    ro.observe(el)
    upd()
    return () => { el.removeEventListener('scroll', on); ro.disconnect(); cancelAnimationFrame(raf) }
  }, [virtual])

  const slice = useMemo(() => {
    if (!virtual) return { from: 0, to: rows.length, padTop: 0, padBottom: 0 }
    const over = 8
    const from = Math.max(0, Math.floor((win.top - 30) / rh) - over)
    const to = Math.min(rows.length, Math.ceil((win.top + win.h) / rh) + over)
    return { from, to, padTop: from * rh, padBottom: Math.max(0, (rows.length - to) * rh) }
  }, [virtual, win.top, win.h, rows.length, rh])

  const al = (c, i) => c.align || (i === 0 ? 'l' : 'r')
  const style = {}
  if (maxHeight) style.maxHeight = maxHeight
  else if (virtual && !fill) style.maxHeight = '520px'
  const showSkel = loading && rows.length === 0
  const showEmpty = !loading && rows.length === 0

  return (
    <div ref={wrapRef} className={cx('gr-tablewrap', fill && 'is-fill', className)} style={style}>
      <table className={cx('gr-table', dense && 'gr-table--dense')} style={{ '--gr-row-h': rh + 'px' }}>
        {caption ? <caption className="gr-sr">{caption}</caption> : null}
        <colgroup>{columns.map((c) => <col key={c.key} style={c.width ? { width: typeof c.width === 'number' ? c.width + 'px' : c.width } : undefined} />)}</colgroup>
        <thead>
          <tr>
            {columns.map((c, i) => {
              const a = al(c, i)
              const sortable = c.sortable && onSort
              const on = sort && sort.key === c.key
              return (
                <th key={c.key} className={cx('gr-th-' + a, sortable && 'is-sortable', on && 'is-sorted', c.className)} title={c.hint}
                  aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  onClick={sortable ? () => onSort(c.key) : undefined}>
                  <span className="gr-th__in">{c.title}{sortable ? <Icon name={on && sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={11} className="gr-th__arrow" /> : null}</span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {showSkel ? Array.from({ length: skeletonRows }, (_, r) => (
            <tr key={'s' + r} className="gr-tr-skel">{columns.map((c, i) => <td key={c.key} className={'gr-td-' + al(c, i)}><Skeleton h={10} w={i === 0 ? '60%' : '70%'} style={{ marginLeft: al(c, i) === 'r' ? 'auto' : undefined }} /></td>)}</tr>
          )) : null}
          {virtual && slice.padTop > 0 ? <tr className="gr-tr-pad" aria-hidden="true" style={{ height: slice.padTop + 'px' }}><td colSpan={columns.length} /></tr> : null}
          {rows.slice(slice.from, slice.to).map((row, k) => {
            const key = keyOf(row)
            const i = slice.from + k
            return (
              <tr key={key} className={cx(onRowClick && 'is-click', selectedKey !== undefined && selectedKey === key && 'is-sel', rowClass && rowClass(row))}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row) } : undefined} tabIndex={onRowClick ? 0 : undefined}>
                {columns.map((c, ci) => <td key={c.key} className={cx('gr-td-' + al(c, ci), c.className)}>{c.render ? c.render(row, i) : row[c.key]}</td>)}
              </tr>
            )
          })}
          {virtual && slice.padBottom > 0 ? <tr className="gr-tr-pad" aria-hidden="true" style={{ height: slice.padBottom + 'px' }}><td colSpan={columns.length} /></tr> : null}
        </tbody>
        {footer && rows.length ? <tfoot><tr className="gr-tr-foot">{footer}</tr></tfoot> : null}
      </table>
      {showEmpty ? (empty || <EmptyState icon="inbox" title={t('暂无数据')} />) : null}
    </div>
  )
}
