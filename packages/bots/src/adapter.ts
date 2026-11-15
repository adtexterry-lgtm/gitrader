// SPDX-License-Identifier: CPAL-1.0
// 适配层：把机器人模板包装成 engine-core 策略（evaluate 返回 target ∈ [-1,1]）。
// 原理：evaluate 内用 PaperLedger 回放 K 线，每根 K 线的 target = 机器人当前持仓名义额 ÷ maxExposureNotional。
import type { Candle, ParamDef, Params, SignalSeries, StrategyDef } from '@gitrader/engine-core'
import { createBot, TEMPLATES } from './index'
import type { BotTemplateId } from './types'
import { requireSafetyProvided } from './safety'
import { requireParams } from './params'

/**
 * 把一个机器人模板适配成策略定义。
 * notionalCap 返回 maxExposureNotional，让引擎在任何余额下都不超过这个上限。
 */
export function botToStrategy(templateId: BotTemplateId): StrategyDef {
  const template = TEMPLATES[templateId]
  if (!template) throw new Error(`unknown bot template "${String(templateId)}"`)

  const strategyId = `bot-${templateId}`
  const params = template.params as ParamDef[]

  const def: StrategyDef = {
    id: strategyId,
    name: template.label,
    nameZh: template.label,
    version: '1.0.0',
    desc: `${template.label}机器人模板（${templateId}）`,
    tags: templateId === 'martingale' ? ['high-risk'] : [],
    params,
    defaults: Object.fromEntries(params.map(p => [p.key, p.default])),
    evaluate: (candles: Candle[], params: Params): SignalSeries => {
      return evaluateBot(templateId, candles, params)
    },
    notionalCap: (params: Params): number => {
      const cap = params.maxExposureNotional
      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
        throw new Error('maxExposureNotional must be a positive finite number')
      }
      return cap
    },
    validateParams: (raw: Params): void => {
      // 先检查必填安全上限是否显式提供
      requireSafetyProvided(templateId, raw)
      // 再用本包的严格校验（类型、范围、跨字段）
      requireParams(params, raw)
      // 最后创建 Bot 实例触发构造函数中的跨字段验证（如 DCA 的 maxOrders * notionalPerOrder > maxExposureNotional）
      createBot(templateId, raw)
    },
  }

  return def
}

/**
 * 回放 K 线，每根 K 线输出 target = 当前持仓名义额 ÷ maxExposureNotional。
 * 停机后 target 保持最后仓位（不归零），让引擎维持该仓位直到用户手动停止实例。
 */
function evaluateBot(templateId: BotTemplateId, candles: Candle[], params: Params): SignalSeries {
  if (candles.length === 0) {
    return { target: [], reasons: [], overlays: {}, warmup: 0 }
  }

  const bot = createBot(templateId, params)
  const intervalMs = inferIntervalMs(candles)
  const cap = bot.caps.maxExposureNotional

  const n = candles.length
  const target: number[] = new Array(n)
  const reasons: string[] = new Array(n)

  // 逐根 K 线执行
  for (let i = 0; i < n; i++) {
    const bar = candles[i]!
    const prev = i > 0 ? candles[i - 1]! : null

    // 执行机器人逻辑
    const intents = bot.onBar({ i, bar, prev, intervalMs })
    const reasonParts: string[] = []

    // 撮合意图（限价触达）
    for (const intent of intents) {
      const fillable = intent.side === 'buy' ? bar.l <= intent.price : bar.h >= intent.price
      if (!fillable) continue

      const signed = intent.side === 'buy' ? intent.qty : -intent.qty
      const snapshot = bot.snapshot(intent.price)
      const notional = intent.price * intent.qty
      bot.onFill({
        side: intent.side,
        price: intent.price,
        qty: intent.qty,
        reason: intent.reason,
        t: bar.t,
        i,
        notional,
        fee: 0,
        feeRate: 0,
        position: snapshot.position + signed,
      })
      reasonParts.push(intent.reason)
    }

    // 输出 target
    const snapshot = bot.snapshot(bar.c)
    const notional = Math.abs(snapshot.position) * bar.c
    const sign = snapshot.position >= 0 ? 1 : -1
    target[i] = sign * Math.min(1, notional / cap)
    reasons[i] = reasonParts.join('; ')
  }

  // overlays: 网格线、均线等（网格给线，其他留空）
  const overlays: Record<string, Array<number | null>> = {}
  if (templateId === 'grid') {
    const gridBot = bot as any
    if (gridBot.levels) {
      const levels = gridBot.levels as readonly number[]
      for (let j = 0; j < levels.length; j++) {
        overlays[`grid${j}`] = new Array(n).fill(levels[j])
      }
    }
  }

  return { target, reasons, overlays, warmup: 0 }
}

function inferIntervalMs(candles: readonly Candle[]): number {
  if (candles.length < 2) return 60_000
  const counts = new Map<number, number>()
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i]!.t - candles[i - 1]!.t
    if (Number.isFinite(d) && d > 0) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [d, n] of counts) {
    if (n > bestCount || (n === bestCount && d < best)) {
      best = d
      bestCount = n
    }
  }
  return best > 0 ? best : 60_000
}
