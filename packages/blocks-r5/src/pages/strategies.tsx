// SPDX-License-Identifier: CPAL-1.0
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { EngineEventsView, EnginesView, StrategyListView } from '../views/strategies'
import { t } from '@gitrader/workbench/i18n'

/** 一个块 id、三张卡：config.view = list（缺省）| engines | events；工作区里放三个实例。 */
function StrategiesBlock(props: BlockProps) {
  const view = typeof props.config?.view === 'string' ? props.config.view : 'list'
  // 块根 = 卡片本身：它必须直接是 .g5-col 的 flex 子项，外面不能再套容器（会把列均分）
  return view === 'engines' ? <EnginesView /> : view === 'events' ? <EngineEventsView /> : <StrategyListView />
}

export const strategiesBlocks = [defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.strategies',
    name: t('策略'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-strategies' },
    isolation: 'inline',
    size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
    inputs: {
      events: [{ topic: 'strategy.status' }, { topic: 'engine.health' }, { topic: 'ledger.entry' }],
      queries: ['account.list', 'engine.strategies', 'engine.catalog', 'engine.list', 'lab.list', 'ledger.query'],
    },
    permissions: ['account.read', 'ledger.read'],
    actions: ['engine.call', 'engine.start', 'engine.stop', 'engine.bind'],
    fixtures: ['./fixtures/strategies.ts'],
  },
  component: StrategiesBlock,
})]
