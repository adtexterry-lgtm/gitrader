// SPDX-License-Identifier: CPAL-1.0
// 测试用策略定义：全部走真实的 loader（校验 + 工作线程），和产品里「文件夹即安装」同一条路。
import { join } from 'node:path'
import { loadStrategyFile } from '../src/strategy/loader'
import type { StrategyDef } from '../src/strategy/types'
import { EXAMPLE_STRATEGIES, FIXTURE_STRATEGIES } from './harness'

export async function loadDef(path: string): Promise<StrategyDef> {
  const r = await loadStrategyFile(path)
  if (!r.def) throw new Error(`strategy file ${path} did not load: ${JSON.stringify(r.errors)}`)
  return r.def
}

export const EMA = await loadDef(join(FIXTURE_STRATEGIES, 'ema-cross.ts'))
export const MEAN = await loadDef(join(EXAMPLE_STRATEGIES, 'mean-reversion.ts'))
export const BREAKOUT = await loadDef(join(EXAMPLE_STRATEGIES, 'breakout.ts'))
export const GRID = await loadDef(join(EXAMPLE_STRATEGIES, 'grid.ts'))
export const DCA = await loadDef(join(EXAMPLE_STRATEGIES, 'dca.ts'))
export const ALL = [EMA, MEAN, BREAKOUT, GRID, DCA]
const byId = new Map(ALL.map((d) => [d.id, d]))
export const get = (id: string): StrategyDef => byId.get(id)!
