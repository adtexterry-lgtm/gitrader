// SPDX-License-Identifier: CPAL-1.0
// 工作流节点库用的指标（EMA / 滚动均值与 σ / 前 N 根极值）。因果：第 i 根只用 ≤ i 的数据。

/** 指数均线序列：前 period-1 个为 null，第 period 个为简单平均种子，之后递推（与 app/server/strategy-ema.mjs 的 emaSeries 同一公式）。 */
export function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i]!;
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** 滚动均值与总体 σ（窗口含当前根）。period 非法（非整数 / < 1）→ 全 null，与 emaSeries 同口径（L4-06）。 */
export function rollingMeanStd(values: number[], period: number): { mean: Array<number | null>; std: Array<number | null> } {
  const mean: Array<number | null> = new Array(values.length).fill(null);
  const std: Array<number | null> = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1) return { mean, std };
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j]!;
    const m = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j]! - m) ** 2;
    mean[i] = m;
    std[i] = Math.sqrt(v / period);
  }
  return { mean, std };
}

/** 前 period 根（不含当前根）的最高 / 最低；不足为 null。period 非法（非整数 / < 1）→ 全 null（L4-06）。 */
export function priorExtreme(values: number[], period: number, kind: 'max' | 'min'): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1) return out;
  for (let i = period; i < values.length; i++) {
    let x = values[i - period]!;
    for (let j = i - period + 1; j < i; j++) x = kind === 'max' ? Math.max(x, values[j]!) : Math.min(x, values[j]!);
    out[i] = x;
  }
  return out;
}

