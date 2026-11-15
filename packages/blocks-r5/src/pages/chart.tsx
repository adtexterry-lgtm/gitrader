// SPDX-License-Identifier: CPAL-1.0
import { defineBlock, type BlockManifest } from '@gitrader/blocks-sdk'
import { ChartView } from '../views/chart'
import { SymbolPositionsView } from '../views/symbol-positions'
import { SymbolsView } from '../views/symbols'
import { TicketView } from '../views/ticket'
import { t } from '@gitrader/workbench/i18n'

const vendor = { name: 'gitrader' }
const size = (minW: number, minH: number, defaultW: number, defaultH: number) => ({ minW, minH, defaultW, defaultH })

/** 图表页：块 chart（图表卡）与 symbols（标的卡）。右列另两张卡（本标的 / 下单）是 positions 块的 {view:'symbol'} / {view:'ticket'}，见下面的 chartPositionViews。 */
export const chartBlocks = [
  defineBlock({
    manifest: {
      schema: 'gitrader-block/1',
      id: 'block.gitrader.chart',
      name: t('图表'),
      version: '0.1.0',
      vendor,
      license: 'CPAL-1.0',
      entry: { module: './index.js', element: 'g5-chart' },
      isolation: 'inline',
      size: size(8, 8, 15, 17),
      inputs: {
        events: [
          { topic: 'market.candles', maxHz: 4 }, { topic: 'account.fills' }, { topic: 'account.positions' }, { topic: 'account.orders' }, { topic: 'proposal.*' },
        ],
        queries: ['market.candles', 'market.quote', 'market.instruments', 'records.query', 'account.list', 'account.positions', 'account.orders', 'proposal.list', 'agentkey.list', 'venue.status'],
      },
      permissions: ['market.read', 'account.read'],
      linkGroups: [{ group: 'symbol', mode: 'readwrite' }, { group: 'account', mode: 'readwrite' }],
      fixtures: ['./fixtures/chart.ts'],
    },
    component: ChartView,
  }),
  defineBlock({
    manifest: {
      schema: 'gitrader-block/1',
      id: 'block.gitrader.symbols',
      name: t('标的'),
      version: '0.1.0',
      vendor,
      license: 'CPAL-1.0',
      entry: { module: './index.js', element: 'g5-symbols' },
      isolation: 'inline',
      size: size(4, 4, 9, 9),
      inputs: {
        events: [{ topic: 'account.positions' }, { topic: 'market.quote', maxHz: 1 }],
        queries: ['instruments.search', 'market.instruments', 'market.quote', 'market.candles', 'account.list', 'account.positions'],
      },
      permissions: ['market.read', 'account.read'],
      linkGroups: [{ group: 'symbol', mode: 'readwrite' }],
      fixtures: ['./fixtures/chart.ts'],
    },
    component: SymbolsView,
  }),
]

/**
 * positions 块（P1 拥有）按 config.view 分发到这里的两个视图：{view:'symbol'} = 本标的卡，{view:'ticket'} = 下单票据。
 * positions 块的清单要并入下面的 chartPositionsManifest（事件 / 查询 / 命令 / 权限 / 联动），否则桥会拒绝这两张卡的读写。
 */
export const chartPositionViews = { symbol: SymbolPositionsView, ticket: TicketView } as const

export const chartPositionsManifest: Pick<BlockManifest, 'permissions' | 'actions' | 'linkGroups'> & { events: Array<{ topic: string; maxHz?: number }>; queries: string[] } = {
  events: [{ topic: 'account.positions' }, { topic: 'account.orders' }, { topic: 'account.fills' }, { topic: 'proposal.*' }, { topic: 'market.quote', maxHz: 1 }],
  queries: ['account.list', 'account.summary', 'account.positions', 'account.orders', 'proposal.list', 'agentkey.list', 'market.quote', 'market.instruments'],
  actions: ['position.close', 'order.place', 'order.cancel'],
  permissions: ['account.read', 'market.read'],
  linkGroups: [{ group: 'symbol', mode: 'readwrite' }, { group: 'account', mode: 'readwrite' }],
}
