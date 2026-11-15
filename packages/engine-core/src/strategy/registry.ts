// SPDX-License-Identifier: CPAL-1.0
// 策略注册表：引擎当前能用的策略。引擎本身不带任何策略——全部来自策略文件夹（loader.ts 校验后注册）。
import type { StrategyDef } from './types'

export class StrategyRegistry {
  private readonly m = new Map<string, StrategyDef>()

  get(id: string): StrategyDef | undefined { return this.m.get(id) }
  has(id: string): boolean { return this.m.has(id) }
  list(): StrategyDef[] { return [...this.m.values()].sort((a, b) => a.id.localeCompare(b.id)) }
  ids(): string[] { return [...this.m.keys()].sort() }
  set(def: StrategyDef): void { this.m.set(def.id, def) }
  remove(id: string): boolean { return this.m.delete(id) }
  get size(): number { return this.m.size }
}
