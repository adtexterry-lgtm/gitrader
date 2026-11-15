// SPDX-License-Identifier: CPAL-1.0
// ⌘K / Ctrl+K 命令面板（IXD 流程 6）：输入行 + 列表（r4 换皮：项 32 高圆角 6、无图标格、无键帽底栏，T31），行为 = A 的 DialogShell（Radix Dialog：
// 焦点陷阱、背景 inert、焦点归还）。输入框是 combobox（aria-activedescendant 指向选中行），↑↓ 选择、回车执行；鼠标按行不抢焦点（焦点始终在输入框，按住回车的连发也只走输入框的 e.repeat 过滤）。
// 接管三档要二次确认：第一次回车只武装（行底红 10% +「回车确认」）；武装后 600 ms 内的回车 / 点击与所有按键连发（e.repeat）一律忽略；
// 选中移走、改查询、5 s 无操作都会解除武装；Esc 先解除武装、再按一次才关。确认后先关面板再执行（要 PIN 时 PIN 单独出现）。
// 结果读 TakeoverRecord（不以「没抛错」当成功）；在 PIN 层取消不报错；其他错误 toast 显示内核原文（接管没完成的常驻提示在风险块）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ATTESTATION_REQUIRED } from '@gitrader/blocks-sdk'
import { buildCommands, rankCommands } from '../core/commands'
import { isMethodMissing } from '../core/host-api'
import { Icon } from '../ui/components/Icon.jsx'
import { DialogShell } from '../ui/components/radix.jsx'
import { toast } from '../ui/components/overlay.jsx'
import { useEscLayer } from '../ui/lib/esc.js'
import { useShell } from './ctx.js'
import { t as tr } from '../ui/lib/i18n.js'

const DEAD_ZONE = 600
const ARM_MS = 5000

/** 接管结果回声（IXD G3 / F3-1：读 TakeoverRecord.ok / remaining / stateAfter）。没平完不出成功 toast。 */
function echo(level, rec) {
  if (rec && rec.ok === false) {
    const n = Array.isArray(rec.remaining) ? rec.remaining.length : 0
    toast.err(n ? tr('全部平仓未完成 · 剩 {0} 个持仓', n) : tr('接管未完成'))
  } else if (level === 'halt_new') toast.ok(tr('已停止新开仓'))
  else if (level === 'cancel_all') toast.ok(tr('{0} · 保留止盈止损', (rec && typeof rec.cancelled === 'number' ? tr('已撤销 {0} 笔挂单', rec.cancelled) : tr('已撤销挂单'))))
  else toast.ok(rec && rec.stateAfter === 'HALTED' ? tr('已全部平仓 · 交易已停止') : tr('已全部平仓'))
}

/** open / onClose：壳控制；onRestore：面板关掉后还焦点（壳决定还给谁，PIN 正开着就不抢）。 */
export function CommandPalette({ open, onClose, onRestore }) {
  return (
    <DialogShell open={open} onOpenChange={(v) => { if (!v) onClose() }} title={tr('命令面板')} hideTitle placement="top" className="gr-palette"
      onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => { e.preventDefault(); onRestore() }}>
      <PaletteBody open={open} onClose={onClose} />
    </DialogShell>
  )
}

// 面板内容随弹层挂载 / 卸载：关掉再开 = 全新状态（查询、选中、武装都复位）
function PaletteBody({ open, onClose }) {
  const sh = useShell()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [armed, setArmed] = useState(null) // { id, at }
  const [instruments, setInstruments] = useState([])
  const [experiments, setExperiments] = useState([])
  const input = useRef(null)
  const searchSequence = useRef(0)
  const latestSearch = useRef('')
  const canQuery = open && sh.ui === 'r5' && !!sh.boot?.online && sh.status === 'open' && sh.kernel?.status === 'open' && !sh.dead && !sh.offline
  const connectionOpen = !!canQuery
  const connectionOpenRef = useRef(connectionOpen)
  connectionOpenRef.current = connectionOpen
  const searchQuery = q.trim()

  useEffect(() => {
    if (!canQuery || !sh.kernel) { setExperiments([]); return undefined }
    let current = true
    sh.kernel.query('lab.list', { limit: 500 }).then((result) => {
      if (!current || !connectionOpenRef.current || sh.kernel.status !== 'open') return
      const items = Array.isArray(result?.items) ? result.items : []
      setExperiments(items.filter((item) => item && typeof item.experimentId === 'string' && item.experimentId && typeof item.title === 'string' && item.title)
        .map((item) => ({ id: item.experimentId, title: item.title })))
    }).catch((error) => {
      if (!current) return
      setExperiments([])
      if (!isMethodMissing(error)) toast.err(error && error.message ? error.message : String(error))
    })
    return () => { current = false }
  }, [canQuery, sh.kernel])

  useEffect(() => {
    if (!canQuery || !sh.kernel || !searchQuery) { setInstruments([]); return undefined }
    let current = true
    const requestSequence = searchSequence.current
    const requestedQuery = searchQuery
    // 150 ms 防抖：连续打字只查最后一次（内核按会话限流，同桶不浪费）
    const timer = setTimeout(() => sh.kernel.query('instruments.search', { q: searchQuery, limit: 12 }).then((result) => {
      if (!current || requestSequence !== searchSequence.current || requestedQuery !== latestSearch.current || !connectionOpenRef.current || sh.kernel.status !== 'open') return
      const hits = Array.isArray(result?.hits) ? result.hits : []
      setInstruments(hits.filter((hit) => hit && typeof hit.id === 'string' && hit.id && typeof hit.name === 'string' && hit.name)
        .map((hit) => ({ id: hit.id, name: hit.name })))
    }).catch((error) => {
      if (!current || requestSequence !== searchSequence.current || requestedQuery !== latestSearch.current || !connectionOpenRef.current || sh.kernel.status !== 'open') return
      setInstruments([])
      toast.err(error && error.message ? error.message : String(error))
    }), 150)
    return () => { current = false; clearTimeout(timer) }
  }, [canQuery, sh.kernel, searchQuery])

  const cmds = useMemo(() => buildCommands({
    takeover: async (level) => { echo(level, await sh.api.takeover(level, tr('用户在命令面板触发'))) },
    go: (page, param) => sh.go(page, param),
    r5: sh.ui === 'r5',
    toggleNav: sh.ui === 'r5' ? () => {
      const current = sh.prefs.get().navForm
      sh.prefs.set({ navForm: current === 'top' ? 'rail' : 'top' })
    } : undefined,
    toggleUpdown: sh.ui === 'r5' ? () => {
      const current = sh.prefs.get().updown
      sh.prefs.set({ updown: current === 'intl' ? 'cn' : 'intl' })
    } : undefined,
    standalone: sh.ui === 'r5' && sh.standalone ? {
      available: !!sh.standalone.available && (sh.standaloneState?.mode !== 'standalone' || sh.standaloneState?.hostAvailable === true),
      label: sh.standalone.label,
      run: () => sh.standalone.run(),
    } : undefined,
    instruments,
    experiments,
  }), [sh, instruments, experiments])
  const items = useMemo(() => rankCommands(cmds, q), [cmds, q])
  // 接管类行：离线，或任何入口的接管在跑（壳的跟踪器 = <html data-takeover-busy>，风险块 / 状态条卡读同一个）时置灰（M4）
  const off = (c) => !!c.confirm && (!!sh.offline || !!sh.takeoverBusy)

  useLayoutEffect(() => { if (input.current) input.current.focus() }, []) // 首帧聚焦：Ctrl+K 后立刻打字不丢字
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(null), ARM_MS); return () => clearTimeout(t) }, [armed])
  useEscLayer('palette', () => setArmed(null), !!armed) // 同级后登记的先接：武装中这一下 Esc 只解除武装

  const run = async (c) => {
    try { await c.run() } catch (e) {
      if (e && e.problemName === ATTESTATION_REQUIRED) return // 在 PIN 层点了取消 = 命令没有发生，不报错（F2-7）
      toast.err(e && e.message ? e.message : String(e))
    }
  }
  const pick = (c) => {
    if (!c || off(c)) return
    if (c.confirm && (!armed || armed.id !== c.id)) { setArmed({ id: c.id, at: performance.now() }); return }
    if (c.confirm && performance.now() - armed.at < DEAD_ZONE) return
    onClose()
    void run(c)
  }
  const select = (n) => { if (n !== sel) { setSel(n); setArmed(null) } }
  // ↑↓ 一按就解除武装（哪怕只剩一行、选中没动）：要移开选中的意图比「行没变」更重要（F6-2）
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setArmed(null); select(Math.min(items.length - 1, sel + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setArmed(null); select(Math.max(0, sel - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) pick(items[sel]) }
  }
  return (
    <>
      <div className="gr-palette__in">
        <Icon name="search" size={16} />
        <input ref={input} value={q} placeholder={tr('搜索命令…')} aria-label={tr('命令')} role="combobox" aria-expanded="true" aria-controls="gr-palette-list" aria-autocomplete="list"
          aria-activedescendant={items[sel] ? 'gr-cmd-' + sel : undefined} autocomplete="off" spellcheck={false}
          onInput={(e) => {
            const value = e.currentTarget.value
            const nextSearch = value.trim()
            if (nextSearch !== latestSearch.current) {
              latestSearch.current = nextSearch
              searchSequence.current += 1
              setInstruments([])
            }
            setQ(value); setSel(0); setArmed(null)
          }} onKeyDown={onKey} />
        <span className="gr-palette__esc">Esc</span>
      </div>
      <div className="gr-palette__list" role="listbox" id="gr-palette-list" aria-label={tr('命令')}>
        {items.length === 0 ? <div className="gr-palette__empty">{tr('没有匹配的命令')}</div> : null}
        {items.map((c, i) => {
          const isArmed = !!armed && armed.id === c.id
          return (
            <button key={c.id} id={'gr-cmd-' + i} type="button" role="option" tabIndex={-1} aria-selected={i === sel} aria-disabled={off(c) ? 'true' : undefined} data-cmd={c.id}
              className={'gr-palette__item' + (i === sel ? ' is-sel' : '') + (isArmed ? ' is-armed' : '') + (off(c) ? ' is-off' : '')}
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => select(i)} onClick={() => pick(c)}>
              <span className="gr-palette__t">{c.title}</span>
              {off(c) ? <span className="gr-palette__h">{sh.offline ? tr('离线') : tr('执行中…')}</span>
                : isArmed ? <span key="arm" className="gr-palette__h gr-palette__h--arm">{tr('回车确认')}</span> : null}
            </button>
          )
        })}
      </div>
    </>
  )
}
