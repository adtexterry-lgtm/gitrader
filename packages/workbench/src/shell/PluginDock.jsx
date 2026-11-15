// SPDX-License-Identifier: CPAL-1.0
// 插件区：固定版式下方、可折叠（IXD 流程 10）。内核报告的已装插件块（第三方，iframe 隔离）在这里按清单渲染，桥走 iframe.ts（postMessage + MessageChannel）。
// 壳只画外框：块头 = 插件名 +「插件」标 + 厂商名（插件改不了，冒充不了一方块；钉住锁标只给一方块）、焦点进 iframe 时外框出焦点环、5 s 不握手给「插件没有响应」。
// 清单不合格的插件不渲染，折叠头写「N 个未加载」，悬停看原因。没有插件时整个区域不出现。折叠状态记在本机（存储不可用就只在内存里）。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/components/Icon.jsx'
import { BlockHost, StaleTag } from './BlockHost.jsx'
import { useShell } from './ctx.js'
import { useKernelStatus } from './hooks.js'
import { syncPluginBlocks } from './plugins.js'
import { t } from '../ui/lib/i18n.js'

const KEY = 'gitrader.plugins.open'
// 默认折叠：插件区是次要信息，不抢三个检阅块的高度（用户展开过才记住）
const readOpen = () => { try { return localStorage.getItem(KEY) === '1' } catch (_e) { return false } }
const POLL_MS = 5000

export function PluginDock() {
  const sh = useShell()
  const st = useKernelStatus(sh.kernel)
  const [open, setOpen] = useState(readOpen)
  const [defs, setDefs] = useState([])
  const [bad, setBad] = useState([])
  const known = useRef(new Map())

  useEffect(() => {
    if (st !== 'open') return undefined
    let stop = false
    let timer = null
    const load = async () => {
      try {
        const res = await sh.kernel.query('plugin.blocks')
        if (stop) return
        const { defs: next, problems } = syncPluginBlocks(sh.registry, known.current, res && res.blocks)
        setDefs((cur) => (cur.length === next.length && cur.every((d, i) => d === next[i]) ? cur : next))
        setBad((cur) => { if (JSON.stringify(cur) === JSON.stringify(problems)) return cur; if (problems.length) console.warn('[gitrader] 插件块清单不合格：', problems); return problems })
      } catch (_e) { /* 内核没有这个查询（旧版本）：不显示插件区 */ }
      if (!stop) timer = setTimeout(load, document.hidden ? POLL_MS * 4 : POLL_MS)
    }
    void load()
    return () => { stop = true; clearTimeout(timer) }
  }, [st, sh.kernel, sh.registry])

  const toggle = () => setOpen((v) => { const n = !v; try { localStorage.setItem(KEY, n ? '1' : '0') } catch (_e) { /* 无存储 */ } return n })
  if (defs.length === 0 && bad.length === 0) return null
  const why = bad.map((p) => t('{0}：{1}', p.id, p.issues.map((x) => x.message).join(t('；')))).join('\n')
  return (
    <section className={'gr-dock' + (open ? ' is-open' : '')} aria-label={t('插件')} data-slot="plugins">
      <button type="button" className="gr-dock__head" aria-expanded={open} aria-controls="gr-dock-row" data-act="plugins-toggle" onClick={toggle}>
        <Icon name="chevron-right" size={14} className="gr-dock__chev" />
        <span>{t('插件')}</span>
        <span className="gr-dock__n gr-num">{defs.length}</span>
        {bad.length ? <span className="gr-dock__bad" title={why} data-bad={bad.length}>{t('· {0} 个未加载', bad.length)}</span> : null}
      </button>
      {open && defs.length ? (
        <div className="gr-dock__row" id="gr-dock-row">
          {defs.map((d) => <DockTile key={d.manifest.id} def={d} />)}
        </div>
      ) : null}
    </section>
  )
}

function DockTile({ def }) {
  const item = useMemo(() => ({ instanceId: 'bi_' + def.manifest.id.split('.').pop().replace(/[^a-z0-9]+/gi, '_') + '_p', block: def.manifest.id + '@' + def.manifest.version, channel: 'A', config: {} }), [def])
  const grid = useMemo(() => ({ w: def.manifest.size.defaultW, h: def.manifest.size.defaultH }), [def])
  const vendor = def.manifest.vendor && def.manifest.vendor.name
  return (
    <section className="gr-tile-p gr-dock__tile" data-block={def.manifest.id} aria-label={def.manifest.name}>
      <header className="gr-tile-p__head">
        <h2 className="gr-tile-p__title" tabIndex={-1}>{def.manifest.name}</h2>
        <span className="gr-tile-p__tag" data-plugin="">{t('插件')}</span>
        {vendor ? <span className="gr-tile-p__vendor">{vendor}</span> : null}
        <StaleTag />
      </header>
      <div className="gr-tile-p__body"><BlockHost item={item} def={def} grid={grid} /></div>
    </section>
  )
}
