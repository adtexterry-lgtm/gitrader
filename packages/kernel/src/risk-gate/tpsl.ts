// SPDX-License-Identifier: CPAL-1.0
// 附带止损止盈的价位与用法检查（ADR-2）：纯函数，空数组 = 合规。
// 返回的 ruleId 是后缀，调用方拼 `${ruleBase}#${ruleId}`。
import { isDecimal } from '@gitrader/protocol'
import type { GateInput, OrderIntent } from '@gitrader/protocol'
import * as d from '../util/dec'

export interface TpslProblem {
  /** 后缀，调用方拼 `${ruleBase}#${ruleId}`。 */
  ruleId: string
  message: string
  limit: string
  actual: string
}

/** 解析触发价；非十进制或缺失返回 undefined。 */
function trigger(raw: string | undefined): d.Dec | undefined {
  if (raw === undefined || !isDecimal(raw)) return undefined
  try {
    return d.D(raw)
  } catch {
    return undefined
  }
}

const LABEL = { stopLoss: '止损价', takeProfit: '止盈价' } as const

/** 止损：买单要求 trigger < ref，卖单要求 trigger > ref；止盈取反。 */
function onWantedSide(leg: 'stopLoss' | 'takeProfit', side: 'buy' | 'sell', v: d.Dec, ref: d.Dec): boolean {
  const below = d.lt(v, ref)
  const stopLossSide = side === 'buy' ? below : !below
  return leg === 'stopLoss' ? stopLossSide : !stopLossSide
}

function sideMessage(leg: 'stopLoss' | 'takeProfit', x: string, y: string): string {
  return leg === 'stopLoss'
    ? `止损价 ${x} 在参考价 ${y} 的盈利一侧，会立刻触发；买入的止损应低于参考价，卖出的止损应高于参考价`
    : `止盈价 ${x} 在参考价 ${y} 的亏损一侧，会立刻触发；买入的止盈应高于参考价，卖出的止盈应低于参考价`
}

export function checkTpsl(a: {
  side: 'buy' | 'sell'
  ref: d.Dec | undefined
  tpsl: OrderIntent['tpsl'] | undefined
  actorClass: GateInput['actorClass']
  fmt?: (x: string) => string
}): Array<{ ruleId: string; message: string; limit: string; actual: string }> {
  const tpsl = a.tpsl
  if (!tpsl) return []
  const fmt = a.fmt ?? ((x: string): string => x)
  const problems: TpslProblem[] = []
  if (tpsl.grouping === 'position' && a.actorClass !== 'human') {
    problems.push({
      ruleId: 'tpsl:grouping',
      message: 'Agent 提案暂不支持按持仓挂止损止盈（grouping: position），请用 grouping: order',
      limit: 'grouping: order',
      actual: 'grouping: position',
    })
  }
  const legs: Array<'stopLoss' | 'takeProfit'> = ['stopLoss', 'takeProfit']
  for (const leg of legs) {
    const raw = tpsl[leg]?.triggerPrice
    if (raw === undefined) continue
    const v = trigger(raw)
    if (v === undefined || d.lte(v, d.ZERO)) {
      problems.push({
        ruleId: `tpsl:${leg}`,
        message: `${LABEL[leg]} ${raw} 不是合法十进制价格或不为正`,
        limit: '> 0',
        actual: raw,
      })
      continue
    }
    if (a.ref === undefined) continue
    if (!onWantedSide(leg, a.side, v, a.ref)) {
      const refText = fmt(d.str(a.ref))
      problems.push({
        ruleId: `tpsl:${leg}`,
        message: sideMessage(leg, fmt(raw), refText),
        limit: refText,
        actual: fmt(raw),
      })
    }
  }
  return problems
}

/**
 * ADR-3：策略要求 Agent 开仓必须带止损时，判断本次意图是否违规（true = 违规）。
 * 纯函数：只认 policyOn（策略字段为 true）、action、actorClass 与是否带 tpsl.stopLoss；字段缺省 = 不要求。
 */
export function checkStopRequired(a: {
  policyOn: boolean
  action: GateInput['action']
  actorClass: GateInput['actorClass']
  hasStop: boolean
}): boolean {
  return a.policyOn && a.action === 'open' && a.actorClass === 'agent' && !a.hasStop
}
