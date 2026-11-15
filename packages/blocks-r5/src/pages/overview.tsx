// SPDX-License-Identifier: CPAL-1.0
// 总览页的四个块（r5）：同 id 同版本覆盖 r4（`id@0.1.0`）。模型、钩子、命令全部复用 blocks-default，这里只出 r5 的视图。
//   positions      持仓与挂单（config.view 缺省 / all）；chart 页的 symbol / ticket 视图归 P2，在下面 POSITIONS_VIEWS 里接线。
//   agent-activity config.view = feed（活动）| keys（Agent）| pending（待批浮层，全站只挂一处）
//   risk           风险卡
//   statusbar      资金卡（全站常驻，持有待批三态）
import { defineBlock, type BlockDefinition, type BlockManifest, type BlockProps } from '@gitrader/blocks-sdk'
import { ActivityView } from '../views/activity'
import { AgentsView } from '../views/agents'
import { FundCardView } from '../views/fundcard'
import { PendingView } from '../views/pending'
import { PositionsView } from '../views/positions'
import { RiskView } from '../views/risk'
import { chartPositionViews, chartPositionsManifest } from './chart'
import { t } from '@gitrader/workbench/i18n'

const V = '0.1.0'
const vendor = { name: 'gitrader' } as const
const fixtures = ['./fixtures/overview.ts']
const viewOf = (config: unknown): string => {
  const v = config && typeof config === 'object' ? (config as { view?: unknown }).view : undefined
  return typeof v === 'string' ? v : ''
}

// positions 块一个 id 三个视图：缺省 / all = 总览持仓卡（本文件）；symbol / ticket = 图表页右列两张卡（P2 的视图，清单并入下面的 manifest，否则桥会拒绝它们的读写）。
const merge = <T,>(...lists: ReadonlyArray<readonly T[] | undefined>): T[] => [...new Set(lists.flatMap((l) => l ?? []))]
type Links = NonNullable<BlockManifest['linkGroups']>
const mergeLinks = (a: Links, b: Links): Links =>
  merge(a.map((x) => x.group), b.map((x) => x.group)).map((group) => ({ group, mode: [...a, ...b].some((x) => x.group === group && x.mode === 'readwrite') ? 'readwrite' as const : 'read' as const }))

export const positionsBlock: BlockDefinition = defineBlock({
  manifest: {
    schema: 'gitrader-block/1', id: 'block.gitrader.positions', name: t('持仓与盈亏'), version: V, vendor, license: 'CPAL-1.0',
    entry: { module: './positions.js', element: 'g5-positions' }, isolation: 'inline',
    size: { minW: 8, minH: 5, defaultW: 15, defaultH: 9 },
    inputs: {
      events: [
        { topic: 'account.positions', maxHz: 4 }, { topic: 'account.summary', maxHz: 2 }, { topic: 'account.fills', maxHz: 4 }, { topic: 'account.orders', maxHz: 4 }, { topic: 'proposal.*' },
        ...chartPositionsManifest.events.filter((e) => !['account.positions', 'account.orders', 'account.fills', 'proposal.*'].includes(e.topic)),
      ],
      queries: merge(['account.list', 'account.summary', 'account.positions', 'account.fills', 'account.orders', 'ledger.query', 'agentkey.list', 'proposal.list'], chartPositionsManifest.queries),
    },
    permissions: merge(['account.read', 'ledger.read'], chartPositionsManifest.permissions),
    actions: merge(['position.close', 'order.place', 'order.cancel'], chartPositionsManifest.actions),
    linkGroups: mergeLinks([{ group: 'symbol', mode: 'readwrite' }, { group: 'account', mode: 'readwrite' }], chartPositionsManifest.linkGroups ?? []),
    fixtures,
  },
  component: (props: BlockProps) => {
    const v = viewOf(props.config)
    return v === 'symbol' ? <chartPositionViews.symbol {...props} /> : v === 'ticket' ? <chartPositionViews.ticket {...props} /> : <PositionsView />
  },
})

export const agentActivityBlock: BlockDefinition = defineBlock({
  manifest: {
    schema: 'gitrader-block/1', id: 'block.gitrader.agent-activity', name: t('Agent 活动与待批'), version: V, vendor, license: 'CPAL-1.0',
    entry: { module: './agent-activity.js', element: 'g5-agent-activity' }, isolation: 'inline',
    size: { minW: 6, minH: 6, defaultW: 9, defaultH: 10 },
    inputs: {
      events: [
        { topic: 'ledger.entry', maxHz: 5 }, { topic: 'proposal.*' }, { topic: 'mandate.changed' }, { topic: 'risk.state' },
        { topic: 'account.positions', maxHz: 2 }, { topic: 'account.summary', maxHz: 1 }, { topic: 'account.fills', maxHz: 2 }, { topic: 'account.orders', maxHz: 2 },
      ],
      queries: ['ledger.query', 'proposal.list', 'agentkey.list', 'mandate.list', 'account.list', 'risk.state', 'account.summary', 'account.positions', 'market.instruments', 'risk.stats'],
    },
    permissions: ['account.read', 'ledger.read', 'market.read'],
    actions: ['proposal.approve', 'proposal.reject', 'mandate.update', 'agentkey.create', 'agentkey.revoke'],
    pinned: true,
    linkGroups: [{ group: 'account', mode: 'read' }],
    fixtures,
  },
  component: (props: BlockProps) => {
    const v = viewOf(props.config)
    return v === 'pending' ? <PendingView /> : v === 'keys' ? <AgentsView /> : <ActivityView />
  },
})

export const riskBlock: BlockDefinition = defineBlock({
  manifest: {
    schema: 'gitrader-block/1', id: 'block.gitrader.risk', name: t('风险状态'), version: V, vendor, license: 'CPAL-1.0',
    entry: { module: './risk.js', element: 'g5-risk' }, isolation: 'inline',
    size: { minW: 6, minH: 5, defaultW: 9, defaultH: 7 },
    inputs: {
      events: [
        { topic: 'risk.state' }, { topic: 'ledger.entry', maxHz: 5 }, { topic: 'account.positions', maxHz: 2 }, { topic: 'account.summary', maxHz: 1 },
        { topic: 'account.fills', maxHz: 2 }, { topic: 'account.orders', maxHz: 2 }, { topic: 'proposal.*' },
      ],
      queries: ['risk.state', 'ledger.query', 'account.list', 'account.summary', 'account.positions', 'proposal.list', 'reconcile.status', 'agentkey.list'],
    },
    actions: ['takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all', 'trading_state.resume', 'risk.setLlmLiveEntries', 'risk.tighten', 'risk.temporaryRelax', 'risk.relax', 'reconcile.refresh', 'reconcile.resolve'],
    permissions: ['account.read', 'ledger.read', 'takeover.trigger'],
    pinned: true,
    linkGroups: [{ group: 'account', mode: 'read' }],
    fixtures,
  },
  component: () => <RiskView />,
})

export const statusBarBlock: BlockDefinition = defineBlock({
  manifest: {
    schema: 'gitrader-block/1', id: 'block.gitrader.statusbar', name: t('状态条'), version: V, vendor, license: 'CPAL-1.0',
    entry: { module: './statusbar.js', element: 'g5-statusbar' }, isolation: 'inline',
    size: { minW: 24, minH: 1, defaultW: 24, defaultH: 1 },
    inputs: {
      events: [
        { topic: 'venue.status', maxHz: 1 }, { topic: 'risk.state' }, { topic: 'account.summary', maxHz: 1 }, { topic: 'account.positions', maxHz: 2 },
        { topic: 'account.fills', maxHz: 2 }, { topic: 'account.orders', maxHz: 2 }, { topic: 'proposal.*' },
      ],
      queries: ['venue.status', 'risk.state', 'account.list', 'account.summary', 'account.positions', 'proposal.list', 'agentkey.list'],
    },
    actions: ['takeover.halt_new', 'takeover.cancel_all', 'takeover.flatten_all', 'venue.reconnect'],
    permissions: ['account.read', 'takeover.trigger'],
    pinned: true,
    linkGroups: [],
    fixtures,
  },
  component: () => <FundCardView />,
})

export const overviewBlocks: BlockDefinition[] = [positionsBlock, agentActivityBlock, riskBlock, statusBarBlock]
