// SPDX-License-Identifier: CPAL-1.0
// 参数校验。第一道借 engine-core 的公开严格校验（validateStrictParams：未知键 / 类型 / 范围 / 枚举），
// 第二道是本包的跨字段与安全上限校验。与 engine-core 的 resolveParams（宽松补全并夹范围）不同，
// 这里越界一律拒：静默夹范围会让调用方以为自己在跑 A 配置，实际跑的是 B 配置。
import { validateStrictParams } from '@gitrader/engine-core'
import { BotParamError } from './errors'
import type { BotParamDef, BotParams, BotParamValue } from './types'

export interface ParamValidation {
  ok: boolean
  params: BotParams
  errors: string[]
}

/** 严格校验：缺省键补默认值，其余一律报错（错误信息只含键名与限制，不回显调用方给的值）。 */
export function validateParams(defs: readonly BotParamDef[], input: unknown): ParamValidation {
  const res = validateStrictParams(defs, input)
  if (!res.ok) return { ok: false, params: {}, errors: [...res.errors] }
  return { ok: true, params: res.params as BotParams, errors: [] }
}

/** 校验并在不合规时抛 BotParamError。 */
export function requireParams(defs: readonly BotParamDef[], input: unknown): BotParams {
  const res = validateParams(defs, input)
  if (!res.ok) throw new BotParamError(res.errors)
  return res.params
}

// ---- 取值（校验后类型是确定的；这里再挡一次，防内部误用）------------------------------------------

export function numOf(params: BotParams, key: string): number {
  const v: BotParamValue | undefined = params[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BotParamError([`${key}: must be a finite number`], key)
  return v
}

export function intOf(params: BotParams, key: string): number {
  const v = numOf(params, key)
  if (!Number.isInteger(v)) throw new BotParamError([`${key}: must be an integer`], key)
  return v
}

export function strOf(params: BotParams, key: string): string {
  const v: BotParamValue | undefined = params[key]
  if (typeof v !== 'string') throw new BotParamError([`${key}: must be a string`], key)
  return v
}

export function boolOf(params: BotParams, key: string): boolean {
  const v: BotParamValue | undefined = params[key]
  if (typeof v !== 'boolean') throw new BotParamError([`${key}: must be a boolean`], key)
  return v
}

/** 参数键是否在声明里（用于模板自检）。 */
export function hasParam(defs: readonly BotParamDef[], key: string): boolean {
  return defs.some((d) => d.key === key)
}

/** 声明里必须含有的键，缺一个就抛（模板作者写漏安全上限时立刻失败，而不是上线后才发现没有上限）。 */
export function requireDeclared(defs: readonly BotParamDef[], keys: readonly string[], template: string): void {
  const missing = keys.filter((k) => !hasParam(defs, k))
  if (missing.length) throw new BotParamError([`${template}: missing required parameter declaration for ${missing.join(', ')}`])
}
