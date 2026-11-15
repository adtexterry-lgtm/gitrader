// SPDX-License-Identifier: CPAL-1.0
// 合成数据：确定性 K 线与合成回测结果。
//
// synthCandles / mulberry32 镜像自本仓库 packages/engine-core/src/util/synth.ts（同仓库、同许可证）：
// 基准要能在不构建 TS 的情况下被 node --test 直接跑，所以把生成器留在纯 ESM 里；数值口径与
// bench/engine/run.mjs 用的引擎内生成器一致（同一算法、同一 seed），便于并排比较吞吐。
// 收益数字没有任何意义，只用来量速度——这不是行情，也不是预测。

/** mulberry32：32 位种子的确定性伪随机数，输出 [0,1)。 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 合成 K 线：几何随机游走 + 慢周期趋势 + 波动聚集（与引擎内 synthCandles 同算法）。
 * @param {{n:number, seed?:number, t0?:number, intervalMs?:number, start?:number}} o
 */
export function synthCandles(o) {
  const n = Math.max(0, Math.floor(o.n))
  const rnd = mulberry32(o.seed ?? 1)
  const step = o.intervalMs ?? 60_000
  const t0 = o.t0 ?? Date.UTC(2026, 0, 1)
  const out = new Array(n)
  let price = o.start ?? 80_000
  let vol = 0.0008
  for (let i = 0; i < n; i++) {
    const open = price
    vol = Math.max(0.0002, Math.min(0.004, vol * 0.98 + 0.02 * 0.0008 + (rnd() - 0.5) * 0.0002))
    const drift = 0.00003 * Math.sin(i / 3000) + 0.00002 * Math.sin(i / 400)
    const ret = drift + (rnd() + rnd() + rnd() - 1.5) * 2 * vol
    price = Math.max(1, open * (1 + ret))
    const hi = Math.max(open, price) * (1 + rnd() * vol)
    const lo = Math.min(open, price) * (1 - rnd() * vol)
    out[i] = {
      t: t0 + i * step,
      o: Number(open.toFixed(2)),
      h: Number(hi.toFixed(2)),
      l: Number(lo.toFixed(2)),
      c: Number(price.toFixed(2)),
      v: Number((10 + rnd() * 90).toFixed(3)),
    }
  }
  return out
}

/** 收盘价序列（指标库基准的输入）。 */
export function closesOf(candles) {
  return candles.map((c) => c.c)
}

/**
 * 合成回测结果：只为了量「报告渲染」的耗时，字段形态照 @gitrader/report 的 ReportInput.result。
 * 权益曲线与成交都是确定性生成的，收益数字无意义。
 */
export function syntheticResult(o = {}) {
  const points = Math.max(2, Math.floor(o.points ?? 5000))
  const tradeCount = Math.max(2, Math.floor(o.trades ?? 200))
  const intervalMs = o.intervalMs ?? 60_000
  const t0 = o.t0 ?? Date.UTC(2026, 0, 1)
  const rnd = mulberry32(o.seed ?? 7)
  const initial = o.initial ?? 10_000

  const equity = new Array(points)
  let v = initial
  for (let i = 0; i < points; i++) {
    v *= 1 + (rnd() - 0.5) * 0.002
    equity[i] = { t: t0 + i * intervalMs, v: Number(v.toFixed(2)) }
  }

  const trades = new Array(tradeCount)
  let px = 80_000
  for (let i = 0; i < tradeCount; i++) {
    px *= 1 + (rnd() - 0.5) * 0.001
    const side = i % 2 === 0 ? 'buy' : 'sell'
    const size = Number((0.01 + rnd() * 0.05).toFixed(5))
    const fee = Number((px * size * 0.00045).toFixed(4))
    trades[i] = {
      t: t0 + Math.floor((i * points) / tradeCount) * intervalMs,
      side,
      price: Number(px.toFixed(2)),
      size,
      pnl: side === 'sell' ? Number(((rnd() - 0.45) * 40).toFixed(2)) : -fee,
      fee,
      reason: side === 'sell' ? 'signal' : 'entry',
    }
  }

  const finalEquity = equity[equity.length - 1].v
  const totalReturnRatio = finalEquity / initial - 1
  let peak = -Infinity
  let maxDrawdownRatio = 0
  for (const p of equity) {
    peak = Math.max(peak, p.v)
    maxDrawdownRatio = Math.min(maxDrawdownRatio, p.v / peak - 1)
  }
  const spanDays = (points * intervalMs) / 86_400_000
  const years = spanDays / 365
  const closed = trades.filter((t) => t.side === 'sell')
  const wins = closed.filter((t) => t.pnl > 0).length

  return {
    engine: { id: 'bench-synthetic', version: '0' },
    assumptions: { fees: 'venue', slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
    stats: {
      totalReturnRatio: Number(totalReturnRatio.toFixed(6)),
      annualizedRatio: years > 0 ? Number(((1 + totalReturnRatio) ** (1 / years) - 1).toFixed(6)) : 0,
      maxDrawdownRatio: Number(maxDrawdownRatio.toFixed(6)),
      sharpe: 0.4,
      sortino: 0.6,
      winRatio: closed.length > 0 ? Number((wins / closed.length).toFixed(4)) : 0,
      profitFactor: 1.1,
      trades: closed.length,
      fills: trades.length,
      finalEquity: Number(finalEquity.toFixed(2)),
      feesPaid: Number(trades.reduce((a, t) => a + t.fee, 0).toFixed(2)),
      fundingPaid: 0,
      liquidations: 0,
      spanDays: Number(spanDays.toFixed(2)),
    },
    equity,
    trades,
    warnings: ['bench: synthetic data — 收益数字无意义，只用于渲染计时'],
  }
}
