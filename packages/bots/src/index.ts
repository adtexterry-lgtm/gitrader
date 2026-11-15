// SPDX-License-Identifier: CPAL-1.0
// @gitrader/bots：四个机器人模板（网格 / 定投 / 马丁 / 趋势）+ 纸面执行引擎。
// 每个模板导出 params（engine-core 策略约定的参数声明）与构造函数；参数不合规即抛，安全上限写在参数校验里。
// 本包不下单、不联网、不读外部状态。
import { runBot } from './engine'
import type { BotRun, RunOptions } from './engine'
import { DcaBot, DCA_PARAMS } from './dca'
import { GridBot, GRID_PARAMS } from './grid'
import { MartingaleBot, MARTINGALE_PARAMS } from './martingale'
import { TrendBot, TREND_PARAMS } from './trend'
import type { BotParamDef, BotRuntime, BotTemplateId } from './types'

export interface BotTemplate {
  id: BotTemplateId
  label: string
  /** 参数声明（key / label / type / default / min / max / options / help），照 engine-core 策略约定。 */
  params: readonly BotParamDef[]
  create(params: Record<string, unknown> | undefined): BotRuntime
}

export const TEMPLATES: Record<BotTemplateId, BotTemplate> = {
  grid: { id: 'grid', label: '网格', params: GRID_PARAMS, create: (p) => new GridBot(p) },
  dca: { id: 'dca', label: '定投', params: DCA_PARAMS, create: (p) => new DcaBot(p) },
  martingale: { id: 'martingale', label: '马丁', params: MARTINGALE_PARAMS, create: (p) => new MartingaleBot(p) },
  trend: { id: 'trend', label: '趋势', params: TREND_PARAMS, create: (p) => new TrendBot(p) },
}

export function templateIds(): BotTemplateId[] {
  return Object.keys(TEMPLATES) as BotTemplateId[]
}

export function createBot(template: BotTemplateId, params?: Record<string, unknown>): BotRuntime {
  const t = TEMPLATES[template]
  if (!t) throw new Error(`unknown bot template "${String(template)}"`)
  return t.create(params)
}

/** 一步跑完：建模板 → 纸面回放。参数不合规时抛 BotParamError，数据不可信时抛 BotStateError。 */
export function runTemplate(
  template: BotTemplateId,
  params: Record<string, unknown> | undefined,
  candles: Parameters<typeof runBot>[1],
  opts: RunOptions = {},
): BotRun {
  return runBot(createBot(template, params), candles, opts)
}

export { runBot, assertCandles, inferIntervalMs } from './engine'
export type { BotRun, EquityPoint, RunOptions } from './engine'
export { GridBot, GRID_PARAMS, buildGridLevels } from './grid'
export { DcaBot, DCA_PARAMS } from './dca'
export { MartingaleBot, MARTINGALE_PARAMS } from './martingale'
export { TrendBot, TREND_PARAMS } from './trend'
export { PaperLedger } from './ledger'
export { BotParamError, BotStateError } from './errors'
export type { BotStateErrorKind } from './errors'
export { validateParams, requireParams } from './params'
export { SAFETY_KEYS, assertSafetyDeclared, capsOf, checkExposure, checkMartingaleLimits, requireSafetyProvided } from './safety'
export { botToStrategy } from './adapter'
export type {
  BoundaryAction,
  BotParams,
  BotParamValue,
  BotCaps,
  BotContext,
  BotFill,
  BotHalt,
  BotHaltCode,
  BotParamDef,
  BotRuntime,
  BotSide,
  BotSnapshot,
  BotTemplateId,
  GridDirection,
  OrderIntent,
} from './types'
