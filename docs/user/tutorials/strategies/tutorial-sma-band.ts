// SPDX-License-Identifier: CPAL-1.0
// 教程 02 的 TS 策略：均线偏离回归（教学用）。
//
// 规则：收盘价高出 N 根简单均线 band% 以上 → 目标 -1（满仓空）；低于 band% 以下 → 目标 +1（满仓多）；
// 回到带内 → 目标 0（空仓）。每根只用当前及更早的 K 线（无前视），无状态、无随机。
// 这类规则在震荡行情里经常吃到回归，在单边趋势里会持续逆势——没有任何业绩含义，只用来演示范式。
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }

type ParamDef = {
  key: string
  label: string
  type: 'number' | 'integer' | 'boolean'
  default: number | boolean | string
  min?: number
  max?: number
  step?: number
  help?: string
}

type SignalSeries = { target: number[]; reasons: string[]; overlays: Record<string, Array<number | null>>; warmup: number }

type StrategyDef = {
  id: string
  name: string
  nameZh?: string
  version: string
  desc: string
  tags: string[]
  params: ParamDef[]
  evaluate(candles: Candle[], params: Record<string, number | boolean | string>): SignalSeries
}

/** 尾部窗口的简单均值（只看 candles[i-period+1 .. i]）。 */
function smaAt(closes: number[], i: number, period: number): number | null {
  if (i + 1 < period) return null
  let sum = 0
  for (let j = i + 1 - period; j <= i; j++) sum += closes[j]!
  return sum / period
}

const strategy: StrategyDef = {
  id: 'tutorial-sma-band',
  name: 'SMA band reversion (tutorial)',
  nameZh: '均线偏离回归（教程）',
  version: '0.1.0',
  desc: '收盘高出 N 根均线 band% 做空、低出 band% 做多，回到带内空仓。震荡行情里吃回归，单边趋势里会反复逆势。',
  tags: ['教程', '均值回归'],
  params: [
    { key: 'period', label: '均线周期（根）', type: 'integer', default: 24, min: 5, max: 200, step: 1 },
    { key: 'band', label: '偏离带（%）', type: 'number', default: 1, min: 0.1, max: 10, step: 0.1 },
    { key: 'allowShort', label: '允许做空', type: 'boolean', default: true },
  ],

  evaluate(candles, params) {
    const n = candles.length
    const period = Math.max(2, Math.floor(Number(params.period)))
    const band = Number(params.band)
    const allowShort = Boolean(params.allowShort)
    const closes = candles.map((c) => c.c)
    const target: number[] = new Array(n).fill(0)
    const reasons: string[] = new Array(n).fill('')
    const line: Array<number | null> = new Array(n).fill(null)
    let prev = 0
    for (let i = 0; i < n; i++) {
      const ma = smaAt(closes, i, period)
      line[i] = ma
      if (ma === null) continue
      const upper = ma * (1 + band / 100)
      const lower = ma * (1 - band / 100)
      const px = closes[i]!
      let next = 0
      if (px > upper) next = allowShort ? -1 : 0
      else if (px < lower) next = 1
      target[i] = next
      if (next !== prev) {
        const side = next === 1 ? '做多' : next === -1 ? '做空' : '空仓'
        const where = px > upper ? `收盘 ${px} 高于上带 ${upper.toFixed(2)}` : px < lower ? `收盘 ${px} 低于下带 ${lower.toFixed(2)}` : `收盘 ${px} 回到带内`
        reasons[i] = `${where}（均线 ${ma.toFixed(2)}，±${band}%）→ ${side}`
        prev = next
      }
    }
    return { target, reasons, overlays: { SMA: line }, warmup: period - 1 }
  },
}

export default strategy
