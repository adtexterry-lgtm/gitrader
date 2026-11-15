// SPDX-License-Identifier: CPAL-1.0
// 内置布局预设：交易 / 检阅 / 极简。三套都带齐三个钉住块（Agent 活动与待批、风险状态、状态条）。
// 「交易」预设就是契约 §4.4 的示例（默认八块，同屏约四块，其余在标签组里）。
import type { Workspace, WorkspaceItem } from '@gitrader/blocks-sdk'
import { WORKSPACE_SCHEMA } from '@gitrader/blocks-sdk'
import { t } from '../ui/lib/i18n.js'

const V = '0.1.0'
export const BLOCK = {
  chart: `block.gitrader.chart@${V}`,
  positions: `block.gitrader.positions@${V}`,
  orderbook: `block.gitrader.orderbook@${V}`,
  audit: `block.gitrader.audit@${V}`,
  equity: `block.gitrader.equity@${V}`,
  agent: `block.gitrader.agent-activity@${V}`,
  risk: `block.gitrader.risk@${V}`,
  symbols: `block.gitrader.symbols@${V}`,
  authorizations: `block.gitrader.authorizations@${V}`,
  statusbar: `block.gitrader.statusbar@${V}`,
  plugins: `block.gitrader.plugins@${V}`,
  strategies: `block.gitrader.strategies@${V}`,
  lab: `block.gitrader.lab@${V}`,
  venues: `block.gitrader.venues@${V}`,
  notify: `block.gitrader.notify@${V}`,
  reconcile: `block.gitrader.reconcile@${V}`,
} as const

export type PresetId = 'trade' | 'review' | 'minimal'
export interface PresetInfo { id: PresetId; name: string; keywords: string[] }
export const PRESETS: readonly PresetInfo[] = [
  { id: 'trade', name: t('交易'), keywords: ['trade', 'jiaoyi'] },
  { id: 'review', name: t('检阅'), keywords: ['review', 'jianyue'] },
  { id: 'minimal', name: t('极简'), keywords: ['minimal', 'jijian'] },
]

const it = (instanceId: string, block: string, x: number, y: number, w: number, h: number, extra: Partial<WorkspaceItem> = {}): WorkspaceItem => ({ instanceId, block, x, y, w, h, channel: 'A', config: {}, ...extra })

const base = (id: string, name: string, items: WorkspaceItem[]): Workspace => ({
  schema: WORKSPACE_SCHEMA,
  id,
  name,
  grid: { cols: 24, rowHeight: 24 },
  channels: { A: { symbol: 'hyperliquid:BTC' } },
  items,
  statusBar: { block: BLOCK.statusbar, pinned: true, takeover: ['halt_new', 'cancel_all', 'flatten_all'] },
  popouts: [],
})

export function presetWorkspace(id: PresetId): Workspace {
  switch (id) {
    case 'trade':
      return base('ws_trade', t('交易'), [
        it('bi_chart_1', BLOCK.chart, 0, 0, 15, 17, { config: { interval: '15m' } }),
        it('bi_positions_1', BLOCK.positions, 0, 17, 15, 9, { stack: 'bottom', active: true }),
        it('bi_orderbook_1', BLOCK.orderbook, 0, 17, 15, 9, { stack: 'bottom' }),
        it('bi_audit_1', BLOCK.audit, 0, 17, 15, 9, { stack: 'bottom' }),
        it('bi_equity_1', BLOCK.equity, 0, 17, 15, 9, { stack: 'bottom' }),
        it('bi_agent_1', BLOCK.agent, 15, 0, 9, 10, { pinned: true }),
        it('bi_risk_1', BLOCK.risk, 15, 10, 9, 7, { pinned: true }),
        it('bi_symbols_1', BLOCK.symbols, 15, 17, 9, 9, { stack: 'right', active: true }),
        it('bi_authorizations_1', BLOCK.authorizations, 15, 17, 9, 9, { stack: 'right' }),
      ])
    case 'review':
      return base('ws_review', t('检阅'), [
        it('bi_agent_1', BLOCK.agent, 0, 0, 10, 14, { pinned: true }),
        it('bi_risk_1', BLOCK.risk, 0, 14, 10, 12, { pinned: true }),
        it('bi_positions_1', BLOCK.positions, 10, 0, 14, 13, { stack: 'top', active: true }),
        it('bi_audit_1', BLOCK.audit, 10, 0, 14, 13, { stack: 'top' }),
        it('bi_equity_1', BLOCK.equity, 10, 0, 14, 13, { stack: 'top' }),
        it('bi_chart_1', BLOCK.chart, 10, 13, 14, 13, { config: { interval: '1h' } }),
      ])
    case 'minimal':
      return base('ws_minimal', t('极简'), [
        it('bi_chart_1', BLOCK.chart, 0, 0, 17, 18, { config: { interval: '15m' } }),
        it('bi_positions_1', BLOCK.positions, 0, 18, 17, 8),
        it('bi_agent_1', BLOCK.agent, 17, 0, 7, 13, { pinned: true }),
        it('bi_risk_1', BLOCK.risk, 17, 13, 7, 13, { pinned: true }),
      ])
  }
}

export const DEFAULT_PRESET: PresetId = 'trade'

/**
 * 最小检阅版的固定布局（视觉轮 r4，IA §6.2）：五张卡 + 总览条（状态条块搬到顶部），没有拖拽、没有多预设。
 * 同一个 Agent 块开三个实例，config.view 选显示哪一部分（待批 / Agent / 活动）。条目顺序 = DOM 顺序 = Tab 顺序。
 * 壳按 FIXED_AREAS 分进两个列容器：左 持仓 / 活动，右 待批 / Agent / 风险（坐标只描述同一版式，留给以后的自定义布局）。
 */
export function fixedWorkspace(): Workspace {
  return base('ws_default', t('检阅'), [
    it('bi_positions_1', BLOCK.positions, 0, 0, 15, 11),
    it('bi_agent_feed_1', BLOCK.agent, 0, 11, 15, 15, { pinned: true, config: { view: 'feed' } }),
    it('bi_agent_1', BLOCK.agent, 15, 0, 9, 10, { pinned: true, config: { view: 'pending' } }),
    it('bi_agent_keys_1', BLOCK.agent, 15, 10, 9, 6, { pinned: true, config: { view: 'keys' } }),
    it('bi_risk_1', BLOCK.risk, 15, 16, 9, 10, { pinned: true }),
  ])
}

export type FixedArea = 'pos' | 'feed' | 'pend' | 'agents' | 'risk'
/** 固定版式的区名（instanceId → 区）。桌面：左列 pos / feed，右列 pend / agents / risk；手机（< 600 或高 < 480）单列，待批置顶。 */
export const FIXED_AREAS: Readonly<Record<string, FixedArea>> = { bi_positions_1: 'pos', bi_agent_feed_1: 'feed', bi_agent_1: 'pend', bi_agent_keys_1: 'agents', bi_risk_1: 'risk' }
/** 区 → 卡的 data-card 名（与 comps / 线框同名）。 */
export const FIXED_CARDS: Readonly<Record<FixedArea, string>> = { pos: 'positions', feed: 'feed', pend: 'pending', agents: 'agents', risk: 'risk' }
/** 区 → 卡头标题。 */
export const FIXED_TITLES: Readonly<Record<FixedArea, string>> = { pos: t('持仓'), feed: t('活动'), pend: t('待批'), agents: 'Agent', risk: t('风险') }

export type WorkspacePage = 'workbench' | 'chart' | 'records' | 'funds' | 'plugins' | 'strategies' | 'lab' | 'lab-detail' | 'venues' | 'notify' | 'reconcile'
export type PageArea = 'left' | 'right' | 'full'
type PageColumns = { left: string[]; right: string[]; full: string[] }

/** r5布局类型按视图的固定列数定义；全宽区由 PAGE_COLUMNS 单独放置。 */
export const PAGE_LAYOUT: Readonly<Record<WorkspacePage, 'two' | 'single'>> = {
  workbench: 'two', chart: 'two', records: 'single', funds: 'two', plugins: 'single', strategies: 'two',
  lab: 'single', 'lab-detail': 'two', venues: 'two', notify: 'two', reconcile: 'single',
}

/** 页面区域只描述宿主列；具体卡框、卡头与状态由块视图负责。 */
export const PAGE_COLUMNS: Readonly<Record<WorkspacePage, PageColumns>> = {
  workbench: { left: ['bi_positions_1', 'bi_agent_feed_1'], right: ['bi_risk_1', 'bi_agent_keys_1'], full: [] },
  chart: { left: ['bi_chart_1'], right: ['bi_symbols_1', 'bi_ticket_1', 'bi_symbol_positions_1'], full: [] },
  records: { left: [], right: [], full: ['bi_audit_1'] },
  funds: { left: ['bi_equity_accounts_1', 'bi_equity_curve_1', 'bi_equity_portfolio_1'], right: ['bi_equity_assets_1', 'bi_equity_margin_1', 'bi_equity_changes_1'], full: [] },
  plugins: { left: [], right: [], full: ['bi_plugins_1'] },
  strategies: { left: ['bi_strategies_1'], right: ['bi_engines_1', 'bi_strategy_events_1'], full: [] },
  lab: { left: [], right: [], full: ['bi_lab_list_1'] },
  'lab-detail': { left: ['bi_lab_forward_1', 'bi_lab_holdout_1', 'bi_lab_backtest_1'], right: ['bi_lab_assumptions_1', 'bi_lab_bias_1', 'bi_lab_data_1'], full: ['bi_lab_head_1'] },
  venues: { left: ['bi_venues_1', 'bi_accounts_1', 'bi_catalog_1'], right: ['bi_venue_detail_1'], full: [] },
  notify: { left: ['bi_notify_channels_1', 'bi_notify_rules_1'], right: ['bi_notify_detail_1'], full: [] },
  reconcile: { left: [], right: [], full: ['bi_reconcile_1'] },
}

export const PAGE_AREAS: Readonly<Record<WorkspacePage, Readonly<Record<string, PageArea>>>> = Object.fromEntries(
  Object.entries(PAGE_COLUMNS).map(([page, columns]) => [page, Object.fromEntries([
    ...columns.left.map((id) => [id, 'left']),
    ...columns.right.map((id) => [id, 'right']),
    ...columns.full.map((id) => [id, 'full']),
  ])]),
) as Record<WorkspacePage, Readonly<Record<string, PageArea>>>

const PAGE_NAMES: Record<WorkspacePage, string> = {
  workbench: t('总览'), chart: t('图表'), records: t('记录'), funds: t('资金'), plugins: t('插件'),
  strategies: t('策略'), lab: t('实验'), 'lab-detail': t('实验详情'), venues: t('交易所'), notify: t('通知'),
  reconcile: t('对账'),
}

type PageItemSeed = { instanceId: string; block: string; config?: Record<string, unknown> }
const PAGE_ITEMS: Record<WorkspacePage, PageItemSeed[]> = {
  workbench: [
    { instanceId: 'bi_positions_1', block: BLOCK.positions },
    { instanceId: 'bi_agent_feed_1', block: BLOCK.agent, config: { view: 'feed' } },
    { instanceId: 'bi_agent_keys_1', block: BLOCK.agent, config: { view: 'keys' } },
    { instanceId: 'bi_risk_1', block: BLOCK.risk },
  ],
  chart: [
    { instanceId: 'bi_chart_1', block: BLOCK.chart, config: { source: 'live', interval: '15m', indicators: [] } },
    { instanceId: 'bi_symbols_1', block: BLOCK.symbols },
    { instanceId: 'bi_symbol_positions_1', block: BLOCK.positions, config: { view: 'symbol' } },
    { instanceId: 'bi_ticket_1', block: BLOCK.positions, config: { view: 'ticket' } },
  ],
  records: [{ instanceId: 'bi_audit_1', block: BLOCK.audit }],
  funds: [
    { instanceId: 'bi_equity_accounts_1', block: BLOCK.equity, config: { view: 'accounts' } },
    { instanceId: 'bi_equity_curve_1', block: BLOCK.equity, config: { view: 'curve' } },
    { instanceId: 'bi_equity_assets_1', block: BLOCK.equity, config: { view: 'assets' } },
    { instanceId: 'bi_equity_margin_1', block: BLOCK.equity, config: { view: 'margin' } },
    { instanceId: 'bi_equity_changes_1', block: BLOCK.equity, config: { view: 'changes' } },
    { instanceId: 'bi_equity_portfolio_1', block: BLOCK.equity, config: { view: 'portfolio' } },
  ],
  plugins: [{ instanceId: 'bi_plugins_1', block: BLOCK.plugins }],
  strategies: [
    { instanceId: 'bi_strategies_1', block: BLOCK.strategies, config: { view: 'list' } },
    { instanceId: 'bi_engines_1', block: BLOCK.strategies, config: { view: 'engines' } },
    { instanceId: 'bi_strategy_events_1', block: BLOCK.strategies, config: { view: 'events' } },
  ],
  lab: [{ instanceId: 'bi_lab_list_1', block: BLOCK.lab, config: { view: 'list' } }],
  'lab-detail': [
    { instanceId: 'bi_lab_head_1', block: BLOCK.lab, config: { view: 'head' } },
    { instanceId: 'bi_lab_forward_1', block: BLOCK.lab, config: { view: 'tier', tier: 'forward' } },
    { instanceId: 'bi_lab_holdout_1', block: BLOCK.lab, config: { view: 'tier', tier: 'holdout' } },
    { instanceId: 'bi_lab_backtest_1', block: BLOCK.lab, config: { view: 'tier', tier: 'backtest' } },
    { instanceId: 'bi_lab_assumptions_1', block: BLOCK.lab, config: { view: 'assumptions' } },
    { instanceId: 'bi_lab_bias_1', block: BLOCK.lab, config: { view: 'bias' } },
    { instanceId: 'bi_lab_data_1', block: BLOCK.lab, config: { view: 'data' } },
  ],
  venues: [
    { instanceId: 'bi_venues_1', block: BLOCK.venues, config: { view: 'venues' } },
    { instanceId: 'bi_accounts_1', block: BLOCK.venues, config: { view: 'accounts' } },
    { instanceId: 'bi_catalog_1', block: BLOCK.venues, config: { view: 'catalog' } },
    { instanceId: 'bi_venue_detail_1', block: BLOCK.venues, config: { view: 'detail' } },
  ],
  notify: [
    { instanceId: 'bi_notify_channels_1', block: BLOCK.notify, config: { view: 'channels' } },
    { instanceId: 'bi_notify_rules_1', block: BLOCK.notify, config: { view: 'rules' } },
    { instanceId: 'bi_notify_detail_1', block: BLOCK.notify, config: { view: 'detail' } },
  ],
  reconcile: [{ instanceId: 'bi_reconcile_1', block: BLOCK.reconcile }],
}

function positionFor(page: WorkspacePage, instanceId: string): [number, number, number] {
  const area = PAGE_AREAS[page][instanceId]
  if (!area) throw new Error('Unknown page workspace item')
  const ids = PAGE_COLUMNS[page][area]
  const index = ids.indexOf(instanceId)
  const y = area === 'full' ? index : PAGE_COLUMNS[page].full.length + index
  const x = area === 'right' ? 12 : 0
  const w = area === 'right' || area === 'left' ? 12 : 24
  return [x, y, w]
}

/** r5每页固定工作区；每次构造新Workspace及独立config，不共享用户态对象。 */
export function pageWorkspace(page: string): Workspace {
  const selected: WorkspacePage = Object.hasOwn(PAGE_LAYOUT, page) ? page as WorkspacePage : 'workbench'
  const items = PAGE_ITEMS[selected].map((seed) => {
    const [x, y, w] = positionFor(selected, seed.instanceId)
    const config = seed.config ? structuredClone(seed.config) : {}
    return it(seed.instanceId, seed.block, x, y, w, 1, { config })
  })
  return base(`ws_page_${selected}`, PAGE_NAMES[selected], items)
}
