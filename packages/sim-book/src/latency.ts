// SPDX-License-Identifier: CPAL-1.0
// 延迟模型：下单 / 改单 / 撤单各自的固定延迟，加可选确定性抖动（种子可复现）。
// 延迟的语义只有一条：命令在「发出时刻 + 延迟」才到达场所，订单要按**到达时刻**的盘口撮合。
//
// 设计参照：nautilus_trader crates/execution/src/models/latency.rs@55c0e820 —— 延迟模型接口分三个操作
//   （insert / update / delete）各自取延迟，固定延迟模型把 base_latency 加到每个操作的额外延迟上
//   （示例：base 100ms + insert 200ms → 实际 300ms），也允许实现方给出动态延迟。
// 本包按自己的协议从零写：单位用毫秒整数（记录的时间戳就是毫秒整数），抖动是本包的扩展（参照只有固定值），
// 用 32 位 xorshift 生成 [0, jitterMs] 或 [-jitterMs, +jitterMs] 的整数，种子固定则序列固定。
export type LatencyOp = 'insert' | 'update' | 'cancel'

export interface LatencyConfig {
  /** 基础延迟（毫秒），加到每个操作上，缺省 0。 */
  baseMs?: number
  /** 下单额外延迟（毫秒），缺省 0。 */
  insertMs?: number
  /** 改单额外延迟（毫秒），缺省 0。 */
  updateMs?: number
  /** 撤单额外延迟（毫秒），缺省 0。 */
  cancelMs?: number
  /** 抖动幅度（毫秒），缺省 0 = 不抖。 */
  jitterMs?: number
  /**
   * 抖动方向：nonneg（缺省）取 [0, jitterMs]；symmetric 取 [-jitterMs, +jitterMs]。
   * 无论哪种，最终延迟都不小于 0（抖动不会把命令送到发出时刻之前）。
   */
  jitterMode?: 'nonneg' | 'symmetric'
  /** 抖动种子（32 位整数），缺省 0x9e3779b9；同种子 + 同调用顺序 = 同一串延迟。 */
  seed?: number
}

const DEFAULT_SEED = 0x9e3779b9
const OPS: readonly LatencyOp[] = ['insert', 'update', 'cancel']

/**
 * 单个延迟字段的上限（毫秒）。1e308 这类值在 `Number.isInteger && >= 0` 下是合法的，
 * 但会让订单到达时刻变成 `ts + 1e308`——等于永不到达，而且不报错（审计 L4-10）。
 * 60 s 已远超任何真实模拟意图；配错了就显式拒。
 */
export const MAX_LATENCY_MS = 60_000

function ms(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${field} 必须是整数毫秒：${String(value)}`)
  }
  if (value < 0) throw new RangeError(`${field} 不能为负：${value}`)
  if (value > MAX_LATENCY_MS) throw new RangeError(`${field} 不能超过 ${MAX_LATENCY_MS} ms：${value}`)
  return value
}

/**
 * 确定性延迟模型。每次取延迟会消耗一个伪随机数（仅当 jitterMs > 0），
 * 所以「同一份种子 + 同一串命令顺序」得到完全相同的延迟序列；回放两次结果一致。
 */
export class LatencyModel {
  readonly baseMs: number
  readonly insertMs: number
  readonly updateMs: number
  readonly cancelMs: number
  readonly jitterMs: number
  readonly jitterMode: 'nonneg' | 'symmetric'
  readonly seed: number
  private state: number
  private drawCount = 0

  constructor(config: LatencyConfig = {}) {
    // 参照的语义：base 加到每个操作上，取的是**总和**。
    this.baseMs = ms(config.baseMs ?? 0, 'baseMs')
    this.insertMs = ms(config.insertMs ?? 0, 'insertMs')
    this.updateMs = ms(config.updateMs ?? 0, 'updateMs')
    this.cancelMs = ms(config.cancelMs ?? 0, 'cancelMs')
    this.jitterMs = ms(config.jitterMs ?? 0, 'jitterMs')
    const mode = config.jitterMode ?? 'nonneg'
    if (mode !== 'nonneg' && mode !== 'symmetric') throw new RangeError(`未知抖动方向：${String(mode)}`)
    this.jitterMode = mode
    const seed = config.seed ?? DEFAULT_SEED
    if (!Number.isInteger(seed)) throw new TypeError(`seed 必须是 32 位整数：${String(seed)}`)
    this.seed = seed >>> 0
    // xorshift 的状态不能为 0。
    this.state = this.seed === 0 ? DEFAULT_SEED : this.seed
  }

  /** 零延迟模型：命令在发出的同一时刻到达场所。 */
  static zero(): LatencyModel {
    return new LatencyModel()
  }

  /** 该操作的固定延迟（不含抖动）。 */
  baseFor(op: LatencyOp): number {
    return this.baseMs + this.extraFor(op)
  }

  /** 取一次该操作的延迟（毫秒，整数，不小于 0）。有抖动时消耗一个随机数。 */
  latency(op: LatencyOp): number {
    if (!OPS.includes(op)) throw new RangeError(`未知延迟操作：${String(op)}`)
    const jitter = this.jitterMs === 0 ? 0 : this.drawJitter()
    const total = this.baseFor(op) + jitter
    return total < 0 ? 0 : total
  }

  /** 命令到达场所的时刻（发出时刻 + 延迟，整数毫秒，永不早于发出时刻）。 */
  arrivalTs(op: LatencyOp, sentTs: number): number {
    if (!Number.isInteger(sentTs)) throw new TypeError(`发出时刻必须是整数毫秒：${String(sentTs)}`)
    const at = sentTs + this.latency(op)
    return at < sentTs ? sentTs : at
  }

  /** 到目前为止消耗了多少个随机数（测试与报告用）。 */
  get draws(): number {
    return this.drawCount
  }

  /** 把随机数序列回到构造时的状态（同一模型可重复取同一串延迟）。 */
  reset(): void {
    this.state = this.seed === 0 ? DEFAULT_SEED : this.seed
    this.drawCount = 0
  }

  private extraFor(op: LatencyOp): number {
    switch (op) {
      case 'insert':
        return this.insertMs
      case 'update':
        return this.updateMs
      case 'cancel':
        return this.cancelMs
    }
  }

  /** 32 位 xorshift：确定性、无依赖、跨平台一致（只用 32 位整数运算）。 */
  private nextUnit(): number {
    let x = this.state >>> 0
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.state = x
    this.drawCount += 1
    return x / 4294967296
  }

  private drawJitter(): number {
    const span = this.jitterMode === 'symmetric' ? this.jitterMs * 2 + 1 : this.jitterMs + 1
    const offset = Math.floor(this.nextUnit() * span)
    return this.jitterMode === 'symmetric' ? offset - this.jitterMs : offset
  }
}

/** 选项里既接受模型实例也接受配置对象。 */
export function toLatencyModel(value: LatencyModel | LatencyConfig | undefined): LatencyModel {
  if (value === undefined) return LatencyModel.zero()
  return value instanceof LatencyModel ? value : new LatencyModel(value)
}
