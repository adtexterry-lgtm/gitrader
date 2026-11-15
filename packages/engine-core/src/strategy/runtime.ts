// SPDX-License-Identifier: CPAL-1.0
// 策略求值的公共函数（与具体策略无关）：补全参数、求信号、取最近一根已收盘 K 线上的信号。
import type { Candle } from '../types';
import type { ParamDef, ParamValue, Params, SignalSeries, StrategyDef } from './types';

/** 按定义补全默认值、转类型、夹到 [min, max]；未知键丢弃。 */
export function resolveParams(defs: ParamDef[], input: Record<string, unknown> | undefined): Params {
  const out: Params = {};
  for (const d of defs) {
    const raw = input?.[d.key];
    let v: ParamValue = d.default;
    if (d.type === 'boolean') {
      if (typeof raw === 'boolean') v = raw;
      else if (raw === 'true' || raw === 1) v = true;
      else if (raw === 'false' || raw === 0) v = false;
    } else if (d.type === 'select') {
      if (typeof raw === 'string' && d.options?.includes(raw)) v = raw;
    } else {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (Number.isFinite(n)) {
        let x = d.type === 'integer' ? Math.round(n) : n;
        if (d.min !== undefined) x = Math.max(d.min, x);
        if (d.max !== undefined) x = Math.min(d.max, x);
        v = x;
      }
    }
    out[d.key] = v;
  }
  return out;
}


/** 补全参数后求值。 */
export function evaluateStrategy(def: StrategyDef, candles: Candle[], params?: Record<string, unknown>): { params: Params; series: SignalSeries } {
  const resolved = resolveParams(def.params, params);
  return { params: resolved, series: def.evaluate(candles, resolved) };
}

/** 最近一根已收盘 K 线上的信号（实例运行器用）。当前这根还没走完则不用它。 */
export function latestSignal(
  def: StrategyDef, candles: Candle[], params: Record<string, unknown> | undefined, intervalMs: number, now: number,
): { index: number; t: number; price: number; target: number; reason: string; lastChange: string; params: Params; overlays: SignalSeries['overlays'] } | null {
  if (candles.length === 0) return null;
  const { params: resolved, series } = evaluateStrategy(def, candles, params);
  let idx = candles.length - 1;
  if (candles[idx]!.t + intervalMs > now) idx -= 1; // 最后一根还没收盘
  if (idx < 0 || idx < series.warmup) return null;
  let lastChange = '';
  for (let i = idx; i >= 0; i--) if (series.reasons[i]) { lastChange = series.reasons[i]!; break; }
  return { index: idx, t: candles[idx]!.t, price: candles[idx]!.c, target: series.target[idx]!, reason: series.reasons[idx] || lastChange, lastChange, params: resolved, overlays: series.overlays };
}
