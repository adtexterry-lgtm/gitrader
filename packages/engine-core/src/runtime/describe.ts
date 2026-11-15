// SPDX-License-Identifier: CPAL-1.0
// engine.describe：能力声明（宿主只按能力位判断功能，不按版本号判断；§2.3）。
// 如实声明：只有模式 A（经宿主连接器下单）；数据用工作台的（market.useHost）；回测假设五项里资金费与强平是 false。
import { GEP_SPEC_VERSION, type EngineDescribe } from '../proto'
import type { StrategyRegistry } from '../strategy/registry'
import { getStrategySha256 } from '../strategy/loader'
import { INTERVAL_MS } from '../types'

export const ENGINE_ID = 'gitrader-core'
export const ENGINE_VERSION = '0.1.0'
/** 厂商扩展能力位：工作流 JSON 运行器（校验 / 回测 / 运行 / 运行时值）。契约 §2.4 没有工作流方法，故走 x-gitrader.* 扩展（§2.9）。 */
export const WORKFLOW_CAP = 'x-gitrader.workflow'
/** 厂商扩展能力位：文件夹即安装（策略文件热加载 + x-gitrader.strategy.files 报告）。 */
export const STRATEGY_FOLDER_CAP = 'x-gitrader.strategy-folder'

export function buildDescribe(o: { maxBars: number; maxConcurrentBacktests: number; maxInstances: number }, registry: StrategyRegistry): EngineDescribe {
  return {
    engine: {
      id: ENGINE_ID, name: 'Gitrader Core', version: ENGINE_VERSION,
      vendor: { id: 'gitrader', name: 'Gitrader', kind: 'builtin', verified: true },
      license: 'CPAL-1.0', runtime: 'node',
    },
    protocol: { version: GEP_SPEC_VERSION, transports: ['stdio', 'ws'] },
    capabilities: {
      'execution.modeA': true,
      'execution.modeB': false,
      'market.useHost': true,
      'market.own': false,
      strategy: true,
      'strategy.hotUpdate': true,
      backtest: true,
      'backtest.fillModels': ['next-bar-open'],
      replay: true,
      'events.resume': true,
      'events.retention': { minEvents: 10_000, minMs: 900_000 },
      'risk.cooperative': true,
      'halt.levels': ['halt_new', 'cancel_all', 'flatten_all'],
      'builder.attach': false,
      'decision.log': false,
      [WORKFLOW_CAP]: true,
      [STRATEGY_FOLDER_CAP]: true,
    },
    venues: [],
    data: { intervals: Object.keys(INTERVAL_MS), maxHistoryBars: o.maxBars },
    strategies: registry.list().map((s) => {
      const sha256 = getStrategySha256(s)
      return { id: s.id, name: s.name, version: s.version, kind: 'target-position', paramsSchemaRef: 'strategy.params', ...(sha256 ? { sha256 } : {}) }
    }),
    limits: { maxConcurrentBacktests: o.maxConcurrentBacktests, maxStrategyInstances: o.maxInstances },
    assumptions: {
      backtest: {
        fill: 'next-bar-open', slippageBps: 2, fees: 'venue-taker', funding: false, liquidation: false, maxBars: o.maxBars,
        'x-note': 'Signals are computed on bar close and filled at the next bar open with slippage and taker fees. Funding and liquidation are NOT modelled. The engine ships no strategies, data or factors: strategies are files the user (or their Agent) drops into the strategies folder.',
      },
    },
  }
}
