// SPDX-License-Identifier: CPAL-1.0
// 参数空间：把每个参数的合法取值域写成数据（number / integer / select / boolean），
// 搜索算法只认这一个形状，不再各自解析策略的 ParamDef。

export type ParamValue = number | boolean | string

export type ParamSpec =
  | { type: 'number'; min: number; max: number; step?: number }
  | { type: 'integer'; min: number; max: number; step?: number }
  | { type: 'select'; options: ParamValue[] }
  | { type: 'boolean' }

export type ParamSpace = Record<string, ParamSpec>

export type Params = Record<string, ParamValue>

/** 每个维度缺省取多少个候选值（与 engine-core 的 sweep 轴缺省 20 不同：寻优要留预算给更多维度）。 */
export const DEFAULT_POINTS_PER_DIM = 11

const EPS = 1e-9

/** 去掉浮点噪声：只保留 12 位小数，够 K 线级参数用，且让种子复现逐位可比。 */
function tidy(x: number): number {
  if (!Number.isFinite(x)) return x
  return Math.round(x * 1e12) / 1e12
}

function isNumericSpec(spec: ParamSpec): spec is Extract<ParamSpec, { type: 'number' | 'integer' }> {
  return spec.type === 'number' || spec.type === 'integer'
}

/**
 * 校验参数空间，返回参数名列表（保持声明顺序）。
 * 抛错而不是猜：空空间、min > max、非有限数、step ≤ 0、integer 的非整数 step、
 * select 空 / 重复 / 非法的选项值、未知 type 都是写错了，静默修会把错误藏到寻优结果里。
 */
export function validateSpace(space: ParamSpace): string[] {
  const keys = Object.keys(space)
  if (keys.length === 0) throw new TypeError('space must declare at least one parameter')
  for (const key of keys) {
    const spec = space[key]
    if (spec === undefined) throw new TypeError(`space.${key}: missing spec`)
    if (spec.type === 'boolean') continue
    if (spec.type === 'select') {
      if (!Array.isArray(spec.options) || spec.options.length === 0) {
        throw new RangeError(`space.${key}: select needs a non-empty options list`)
      }
      const seen = new Set<string>()
      for (const value of spec.options) {
        const kind = typeof value
        if (kind !== 'number' && kind !== 'string' && kind !== 'boolean') {
          throw new TypeError(`space.${key}: option values must be number, string or boolean`)
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new RangeError(`space.${key}: option values must be finite`)
        }
        const tag = `${kind}:${String(value)}`
        if (seen.has(tag)) throw new RangeError(`space.${key}: duplicated option ${String(value)}`)
        seen.add(tag)
      }
      continue
    }
    if (!isNumericSpec(spec)) {
      throw new TypeError(`space.${key}: unknown parameter type ${String((spec as { type?: unknown }).type)}`)
    }
    if (!Number.isFinite(spec.min) || !Number.isFinite(spec.max)) {
      throw new RangeError(`space.${key}: min and max must be finite`)
    }
    if (spec.min > spec.max) throw new RangeError(`space.${key}: min must not exceed max`)
    if (spec.step !== undefined && !(Number.isFinite(spec.step) && spec.step > 0)) {
      throw new RangeError(`space.${key}: step must be a positive finite number`)
    }
    if (spec.type === 'integer') {
      if (!Number.isInteger(spec.min) || !Number.isInteger(spec.max)) {
        throw new RangeError(`space.${key}: integer bounds must be integers`)
      }
      if (spec.step !== undefined && !Number.isInteger(spec.step)) {
        throw new RangeError(`space.${key}: integer step must be an integer`)
      }
    }
  }
  return keys
}

/**
 * 一个维度上的候选值（有序，去重）。
 * - boolean → [false, true]；select → options 原序。
 * - number / integer 且 step > 0：min, min+step, …（≤ max + 1e-9），integer 取整。
 * - 没给 step：min…max 等距取 maxPoints 个（maxPoints < 2 或 min === max 时只有 min）。
 * - 去重后超过 maxPoints：按 engine-core sweep.ts 同一规则等距挑下标，保端点。
 */
export function domainValues(spec: ParamSpec, maxPoints: number = DEFAULT_POINTS_PER_DIM): ParamValue[] {
  const limit = Math.max(1, Math.floor(maxPoints))
  if (spec.type === 'boolean') return [false, true]
  if (spec.type === 'select') return spec.options.slice()

  const { min, max, step } = spec
  const raw: ParamValue[] = []
  if (step !== undefined && step > 0) {
    const count = Math.floor((max - min) / step + EPS) + 1
    for (let i = 0; i < count; i++) {
      const value = min + i * step
      raw.push(spec.type === 'integer' ? Math.round(value) : tidy(value))
    }
  } else if (min === max || limit === 1) {
    raw.push(spec.type === 'integer' ? Math.round(min) : tidy(min))
  } else {
    for (let i = 0; i < limit; i++) {
      const value = min + (i * (max - min)) / (limit - 1)
      raw.push(spec.type === 'integer' ? Math.round(value) : tidy(value))
    }
  }

  const seen = new Set<string>()
  const unique: ParamValue[] = []
  for (const value of raw) {
    const tag = `${typeof value}:${String(value)}`
    if (seen.has(tag)) continue
    seen.add(tag)
    unique.push(value)
  }
  if (unique.length <= limit) return unique

  const picked: ParamValue[] = []
  for (let i = 0; i < limit; i++) {
    const idx = limit === 1 ? 0 : Math.round((i * (unique.length - 1)) / (limit - 1))
    const value = unique[idx]
    if (value === undefined) continue
    if (!picked.includes(value)) picked.push(value)
  }
  return picked
}

/** 把任意值拉回合法域：数值取整 / 贴到 step 网格 / 夹到 [min, max]；select 不在选项里就报错。 */
export function snapValue(spec: ParamSpec, value: ParamValue): ParamValue {
  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1) return true
    if (value === 'false' || value === 0) return false
    throw new TypeError('boolean parameter accepts only true / false')
  }
  if (spec.type === 'select') {
    if (!spec.options.some((option) => option === value)) {
      throw new RangeError(`select parameter has no option ${JSON.stringify(value)}`)
    }
    return value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${spec.type} parameter needs a finite number`)
  }
  const { min, max, step } = spec
  let x = Math.min(max, Math.max(min, value))
  if (step !== undefined && step > 0) x = min + Math.round((x - min) / step) * step
  x = Math.min(max, Math.max(min, x))
  return spec.type === 'integer' ? Math.round(x) : tidy(x)
}

/** 参数组合的稳定键：键名排序后拼接，用于去重与种子复现比对（不受对象插入顺序影响）。 */
export function canonicalKey(params: Params): string {
  const keys = Object.keys(params).sort()
  const parts: string[] = []
  for (const key of keys) {
    const value = params[key]
    parts.push(`${key}=${typeof value}:${String(value)}`)
  }
  return parts.join('|')
}

/** 按参数空间随机抽一个合法组合（rand ∈ [0,1)，由调用方的种子发生器提供）。 */
export function randomValue(spec: ParamSpec, rand: () => number): ParamValue {
  if (spec.type === 'boolean') return rand() < 0.5
  if (spec.type === 'select') {
    const idx = Math.min(spec.options.length - 1, Math.floor(rand() * spec.options.length))
    const value = spec.options[idx]
    if (value === undefined) throw new RangeError('select parameter has no options')
    return value
  }
  return snapValue(spec, spec.min + rand() * (spec.max - spec.min))
}

/** 参数组合的笛卡尔积大小（不物化；空空间算 1）。 */
export function spaceSize(space: ParamSpace, maxPoints: number = DEFAULT_POINTS_PER_DIM): number {
  const keys = validateSpace(space)
  let total = 1
  for (const key of keys) {
    const spec = space[key]
    if (spec === undefined) continue
    total *= domainValues(spec, maxPoints).length
  }
  return total
}
