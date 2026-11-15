// SPDX-License-Identifier: CPAL-1.0
// 运行时各部件共享的上下文接口：时钟、发事件、调宿主、日志。部件之间只通过它说话，方便测试时整体替换。
import type { Origin } from '../proto'
import type { EventDraft } from '../gep/session'
import type { HostApi } from './host-api'
import type { LocalGuard } from './guard'
import type { StrategyRegistry } from '../strategy/registry'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface EngineContext {
  readonly engineId: string
  readonly version: string
  now(): number
  emit(d: EventDraft): void
  readonly host: HostApi
  readonly guard: LocalGuard
  /** 引擎当前能用的策略（全部来自策略文件夹）。 */
  readonly strategies: StrategyRegistry
  /** 脱敏日志：字段值经 redact；同时作为 `log` 流事件发给宿主（有损流）。 */
  log(level: LogLevel, message: string, fields?: Record<string, string | number | boolean | null>): void
  /** 引擎发出的来源归因（actor 会被宿主覆盖，仍写上自己的）。 */
  origin(tool: string, causation?: Origin['causation']): Origin
}
