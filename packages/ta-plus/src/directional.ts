// SPDX-License-Identifier: CPAL-1.0
// 方向类：方向运动 +DM / −DM（本包实现）、方向指标 +DI / −DI 与动向指数 DX（转发 engine-core）。
// 口径：Wilder（1978）定义，与 engine-core `adx()` 内部 +DI / −DI 同口径：平滑和的种子 = 第 1..period 根
//       DM / TR 之和，首个值在下标 period；之后 prev − prev/period + x。
// 与 engine-core 的关系（批 9 收尾）：`plusDI` / `minusDI` 与 engine-core `adx().plusDi / minusDi`
//       同口径同值，本包改为直接转发（单一真相源，不再维护第二套 Wilder 累加），`dx` 由这两条序列合成；
//       同值性由 test/engine-core-parity.test.ts 逐项比对。转发**不继承** engine-core 的宽口径
//       （它遇非法周期返回全 null），包装函数仍先 assertPeriod 抛 RangeError。
//       `plusDM` / `minusDM` 是 engine-core 未导出的中间量，仍由本包实现（同一 Wilder 累加）。
// 与 TA-Lib 的差异：`ta_PLUS_DM.c` / `ta_PLUS_DI.c` 的种子是前 period−1 根之和再平滑一步
//       （`PLUS_DM` 首值在下标 period−1），预热段数值不同；本夹具 period 3 时 TA-Lib 的
//       +DI[3] = 200/7 = 28.571428…（批 8 收口按 ta_PLUS_DI.c 独立复算），本包为 100/3；两者随时间收敛。
import { adx } from '../../engine-core/src/strategy/ta/oscillators'
import type { Bar, Series } from './types'
import { assertPeriod, nullSeries } from './internal'

/** 方向运动：+DM 取上移（h−prevH），−DM 取下移（prevL−l），两者只有较大且为正的一方计入。 */
function directionalMovement(bars: Bar[]): { plus: number[]; minus: number[] } {
  const plus = new Array<number>(bars.length).fill(0)
  const minus = new Array<number>(bars.length).fill(0)
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!
    const prev = bars[i - 1]!
    const upMove = bar.h - prev.h
    const downMove = prev.l - bar.l
    if (upMove > downMove && upMove > 0) plus[i] = upMove
    else if (downMove > upMove && downMove > 0) minus[i] = downMove
  }
  return { plus, minus }
}

/** Wilder 累加（和，不是均值）：第 period 项 = Σ x[1..period]，之后 prev − prev/period + x[i]。 */
function wilderSum(values: number[], period: number, from = 1): Series {
  const out = nullSeries(values.length)
  if (values.length <= from + period - 1) return out
  let sum = 0
  for (let i = from; i < from + period; i++) sum += values[i]!
  out[from + period - 1] = sum
  for (let i = from + period; i < values.length; i++) {
    sum = sum - sum / period + values[i]!
    out[i] = sum
  }
  return out
}

/** 平滑后的上升方向运动 +DM（Wilder 累加和）；首个非 null 位置为 period。 */
export function plusDM(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  return wilderSum(directionalMovement(bars).plus, period)
}

/** 平滑后的下降方向运动 −DM（Wilder 累加和）；首个非 null 位置为 period。 */
export function minusDM(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  return wilderSum(directionalMovement(bars).minus, period)
}

/** 上升方向指标 +DI（0..100）；平滑 TR 为 0 处为 null。转发 engine-core `adx().plusDi`（同口径同值）。 */
export function plusDI(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  return adx(bars, period).plusDi
}

/** 下降方向指标 −DI（0..100）；平滑 TR 为 0 处为 null。转发 engine-core `adx().minusDi`（同口径同值）。 */
export function minusDI(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  return adx(bars, period).minusDi
}

/** 动向指数 DX = 100 × |+DI − −DI| ÷ (+DI + −DI)；两者之和为 0 处为 null。由转发的 +DI / −DI 合成。 */
export function dx(bars: Bar[], period = 14): Series {
  assertPeriod(period)
  const { plusDi, minusDi } = adx(bars, period)
  const out = nullSeries(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const p = plusDi[i]
    const m = minusDi[i]
    if (p === null || p === undefined || m === null || m === undefined) continue
    const total = p + m
    if (total === 0) continue
    out[i] = (100 * Math.abs(p - m)) / total
  }
  return out
}
