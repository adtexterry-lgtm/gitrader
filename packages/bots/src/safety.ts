// SPDX-License-Identifier: CPAL-1.0
// 安全上限：写进参数校验（不是只写文档）。全模板都有「最大敞口」；马丁另有「最大加仓次数」「最大总名义额」。
// 超限的动作是「拒单 + 停机」，不是「截小数量继续下」——静默截断会让风控账与实际仓位分家。
import { BotParamError } from './errors'
import { numOf, requireDeclared } from './params'
import type { BotCaps, BotHaltCode, BotParamDef, BotParams, BotTemplateId } from './types'

/** 每个模板必须声明的安全参数键。 */
export const SAFETY_KEYS: Record<BotTemplateId, readonly string[]> = {
  grid: ['maxExposureNotional'],
  dca: ['maxExposureNotional', 'maxOrders'],
  martingale: ['maxExposureNotional', 'maxAdds', 'maxTotalNotional'],
  trend: ['maxExposureNotional'],
}

/** 构造模板时自检：安全参数必须在 params 里声明过。 */
export function assertSafetyDeclared(template: BotTemplateId, defs: readonly BotParamDef[]): void {
  requireDeclared(defs, SAFETY_KEYS[template], template)
}

/** 构造模板时自检：调用方必须显式给出每个安全上限，缺一个就拒（默认值只用于界面预填）。 */
export function requireSafetyProvided(template: BotTemplateId, input: Record<string, unknown> | undefined): void {
  for (const key of SAFETY_KEYS[template]) {
    const provided = input !== undefined
      && Object.prototype.hasOwnProperty.call(input, key)
      && input[key] !== undefined
    if (!provided) throw new BotParamError([`${key}: safety cap is required (no default)`], key)
  }
}

/** 从已校验参数里取安全上限。取值失败即抛（不会拿 0 或 undefined 当上限）。 */
export function capsOf(template: BotTemplateId, params: BotParams): BotCaps {
  const maxExposureNotional = numOf(params, 'maxExposureNotional')
  if (maxExposureNotional <= 0) throw new BotParamError(['maxExposureNotional: must be > 0'], 'maxExposureNotional')
  const caps: BotCaps = { maxExposureNotional }
  if (template === 'martingale') {
    caps.maxAdds = numOf(params, 'maxAdds')
    caps.maxTotalNotional = numOf(params, 'maxTotalNotional')
  }
  return caps
}

export type CapVerdict = { ok: true } | { ok: false; code: BotHaltCode; detail: string }

/**
 * 敞口检查：成交后名义额（|新仓位| × 成交价）超过上限就拒。
 * 减少仓位的单子永远不会因为敞口被拒（它让敞口变小）。
 */
export function checkExposure(
  caps: BotCaps,
  position: number,
  price: number,
  signedQty: number,
): CapVerdict {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(signedQty) || signedQty === 0) {
    return { ok: false, code: 'max-exposure', detail: 'exposure check got a non-finite price or qty' }
  }
  const after = Math.abs(position + signedQty) * price
  if (after > caps.maxExposureNotional + 1e-9) {
    return {
      ok: false,
      code: 'max-exposure',
      detail: `exposure ${round(after)} would exceed maxExposureNotional ${caps.maxExposureNotional}`,
    }
  }
  return { ok: true }
}

/** 马丁：加仓次数与累计名义额双闸。addsSoFar 不含首仓。 */
export function checkMartingaleLimits(
  caps: BotCaps,
  addsSoFar: number,
  totalNotional: number,
  nextNotional: number,
): CapVerdict {
  const maxAdds = caps.maxAdds ?? 0
  if (addsSoFar + 1 > maxAdds) {
    return {
      ok: false,
      code: 'martingale-max-adds',
      detail: `add #${addsSoFar + 1} would exceed maxAdds ${maxAdds}`,
    }
  }
  const maxTotal = caps.maxTotalNotional ?? 0
  const after = totalNotional + nextNotional
  if (after > maxTotal + 1e-9) {
    return {
      ok: false,
      code: 'martingale-max-notional',
      detail: `total notional ${round(after)} would exceed maxTotalNotional ${maxTotal}`,
    }
  }
  const maxExposure = caps.maxExposureNotional
  if (after > maxExposure + 1e-9) {
    return {
      ok: false,
      code: 'max-exposure',
      detail: `martingale total notional ${round(after)} would exceed maxExposureNotional ${maxExposure}`,
    }
  }
  return { ok: true }
}

function round(x: number): number {
  return Number(x.toFixed(8))
}
