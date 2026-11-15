// SPDX-License-Identifier: CPAL-1.0
// 工作台（最小检阅版，视觉轮 r4）：两个列容器（core/presets.ts 的 FIXED_AREAS 分区）——左列 持仓（按内容高，封顶 60%）+ 活动（吃剩余），
// 右列 var(--gr-col-r) 宽：待批、Agent（按内容高）+ 风险（吃剩余，至少露出卡头与接管一排）；右列整体可纵向滚（矮窗口 + 插件区展开时批准仍够得着，G1）。
// 手机视图（< 600 或高 < 480，含横屏）单列：列容器 display: contents，按 待批 → 持仓 → 风险 → Agent → 活动 排，除待批外折成 44 高的摘要行（IXD F1-8 / F1-9）。
// 卡头 = 标题 + 槽（.gr-tile-p__slot：块用 portal 放计数与右侧状态，只放不可交互的内容）+ 陈旧小标（断开 > 2 s「已暂停更新 · mm:ss」）。桌面卡头不画钉住锁标（is-pinned 类保留）。
// 留口（未实现，等总会话通知）：拖拽 / 缩放（core/workspace.ts 的 moveTile / resizeTile 已有纯函数）、标签组、联动通道菜单、弹出窗。
import { useMemo, useState } from 'preact/hooks'
import { FIXED_AREAS, FIXED_CARDS, FIXED_TITLES, PAGE_COLUMNS, PAGE_LAYOUT } from '../core/presets'
import { tilesOf } from '../core/workspace'
import { Icon } from '../ui/components/Icon.jsx'
import { BlockHost, StaleTag } from './BlockHost.jsx'
import { PluginDock } from './PluginDock.jsx'
import { useShell } from './ctx.js'

const LEFT = new Set(['pos', 'feed'])

function TileView({ tile, area, fold, index }) {
  const sh = useShell()
  const item = tile.items[0]
  const def = sh.registry.resolve(item.block)
  const name = (area && FIXED_TITLES[area]) || (def ? def.manifest.name : item.block)
  const grid = useMemo(() => ({ w: tile.w, h: tile.h }), [tile.w, tile.h])
  const [open, setOpen] = useState(false)
  const shut = fold && !open
  return (
    <section className={'gr-tile-p' + (tile.pinned ? ' is-pinned' : '') + (fold ? ' is-fold' : '') + (shut ? ' is-shut' : '')} style={{ '--i': index }}
      data-tile={tile.key} data-area={area} data-card={area ? FIXED_CARDS[area] : undefined} data-block={item.block.split('@')[0]} aria-label={name}>
      {fold ? (
        <button type="button" className="gr-tile-p__head gr-tile-p__sum" aria-expanded={open} data-act={'fold-' + area} onClick={() => setOpen(!open)}>
          <span className="gr-tile-p__title">{name}</span><span className="gr-tile-p__slot" /><StaleTag /><Icon name="chevron-right" size={14} className="gr-tile-p__chev" />
        </button>
      ) : (
        <header className="gr-tile-p__head"><h2 className="gr-tile-p__title" tabIndex={-1}>{name}</h2><span className="gr-tile-p__slot" /><StaleTag /></header>
      )}
      <div className="gr-tile-p__body" hidden={shut}>
        <BlockHost item={item} def={def} grid={grid} />
      </div>
    </section>
  )
}

export function R5Tile({ item }) {
  const sh = useShell()
  const def = sh.registry.resolve(item.block)
  const grid = useMemo(() => ({ w: item.w, h: item.h }), [item.w, item.h])
  return <BlockHost item={item} def={def} grid={grid} />
}

function R5Workbench() {
  const sh = useShell()
  const requestedPage = sh.page || 'workbench'
  const page = Object.hasOwn(PAGE_LAYOUT, requestedPage) ? requestedPage : 'workbench'
  const workspace = sh.workspace
  const items = new Map(workspace.items.map((item) => [item.instanceId, item]))
  const columns = PAGE_COLUMNS[page]
  const renderItems = (ids) => ids.map((id) => {
    const item = items.get(id)
    return item ? <R5Tile key={item.instanceId} item={item} page={page} /> : null
  })
  const full = renderItems(columns.full)
  if (PAGE_LAYOUT[page] === 'single') {
    return <div className="g5-ws g5-one" data-g5-page={page}><div className="g5-col" data-col="full">{full}</div></div>
  }
  if (full.length) {
    // 稿的 .ws.dt：通栏头卡是工作区网格的第一格（跨两列），不在 .g5-ws 外
    return (
      <div className="g5-ws g5-dt" data-g5-page={page}>
        {full}
        <div className="g5-col" data-col="left">{renderItems(columns.left)}</div>
        <div className="g5-col" data-col="right">{renderItems(columns.right)}</div>
      </div>
    )
  }
  return (
    <div className="g5-ws" data-g5-page={page}>
      <div className="g5-col" data-col="left">{renderItems(columns.left)}</div>
      <div className="g5-col" data-col="right">{renderItems(columns.right)}</div>
    </div>
  )
}

function R4Workbench() {
  const sh = useShell()
  const tiles = useMemo(() => tilesOf(sh.workspace), [sh.workspace])
  const view = (t, i) => { const area = FIXED_AREAS[t.key]; return <TileView key={t.key} tile={t} area={area} index={i} fold={sh.mobile && area !== 'pend'} /> }
  const cols = { l: [], r: [] }
  tiles.forEach((t, i) => cols[LEFT.has(FIXED_AREAS[t.key]) ? 'l' : 'r'].push(view(t, i)))
  return (
    <div className="gr-wb">
      <div className="gr-wb__grid">
        <div className="gr-wb__col" data-col="l">{cols.l}</div>
        <div className="gr-wb__col" data-col="r">{cols.r}</div>
      </div>
      <PluginDock />
    </div>
  )
}

export function Workbench() {
  const sh = useShell()
  return sh.ui === 'r5' ? <R5Workbench /> : <R4Workbench />
}
