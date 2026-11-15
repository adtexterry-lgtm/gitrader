// SPDX-License-Identifier: CPAL-1.0
// 可成交限价夹取：只把越界的限价收紧到参考价的可成交带内，绝不朝成交方向放宽。

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/limit_price_safety.py:5-38; adapted.
/**
 * 把限价夹到参考价的可成交带内：买单上限 = ref·(1 + bandBps/1e4)，卖单下限 = ref·(1 − bandBps/1e4)。
 * 只收紧、不朝成交方向放宽；ref 非正或非有限时原价不动。
 */
export function clampLimitPrice(
  side: 'buy' | 'sell',
  limitPx: number,
  referencePx: number,
  bandBps: number,
): { price: number; clamped: boolean } {
  if (!Number.isFinite(referencePx) || referencePx <= 0) return { price: limitPx, clamped: false }
  if (!Number.isFinite(limitPx)) return { price: limitPx, clamped: false }
  const band = bandBps / 1e4
  if (side === 'buy') {
    const cap = referencePx * (1 + band)
    return limitPx > cap ? { price: cap, clamped: true } : { price: limitPx, clamped: false }
  }
  const floor = referencePx * (1 - band)
  return limitPx < floor ? { price: floor, clamped: true } : { price: limitPx, clamped: false }
}
