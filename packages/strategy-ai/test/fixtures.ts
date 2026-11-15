// SPDX-License-Identifier: CPAL-1.0
// 测试夹具（不是测试文件本身）：一份能过 engine-core 静态 + 动态校验的策略源码、三种坏形态、一条确定性锯齿 K 线、
// 一个按脚本作答的假 client。全部离线，构造出来的数字每次都一样。
import type { Candle } from '@gitrader/engine-core'
import type { Llm } from '../src'

/** 合法策略：快慢简单均线，价上穿过慢线做多、下穿平掉。写法照 engine-core 的示例策略（纯算术、无 import）。 */
export const GOOD_STRATEGY = `export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

function sma(values: number[], period: number, i: number): number | null {
  if (i + 1 < period) return null
  let sum = 0
  for (let k = i - period + 1; k <= i; k++) sum += values[k]
  return sum / period
}

const strategy = {
  id: 'gen-average-cross',
  name: 'Generated average cross',
  version: '0.1.0',
  desc: 'Long while the fast simple average sits above the slow one, flat otherwise. Choppy ranges make it switch back and forth and pay fees.',
  tags: ['trend'],
  params: [
    { key: 'fast', label: 'Fast period', type: 'integer', default: 5, min: 2, max: 30, step: 1 },
    { key: 'slow', label: 'Slow period', type: 'integer', default: 20, min: 3, max: 60, step: 1 },
  ],
  evaluate(candles, params) {
    const n = candles.length
    const fast = Math.max(2, Math.round(Number(params.fast)))
    const slow = Math.max(3, Math.round(Number(params.slow)))
    const closes = candles.map((c) => c.c)
    const target = []
    const reasons = []
    const fastLine = []
    const slowLine = []
    let prev = 0
    for (let i = 0; i < n; i++) {
      const f = sma(closes, fast, i)
      const s = sma(closes, slow, i)
      fastLine.push(f)
      slowLine.push(s)
      let t = prev
      let why = ''
      if (f !== null && s !== null) {
        t = f > s ? 1 : 0
        if (t !== prev) why = t === 1 ? 'fast average above slow' : 'fast average below slow'
      }
      target.push(t)
      reasons.push(why)
      prev = t
    }
    return { target, reasons, overlays: { FAST: fastLine, SLOW: slowLine }, warmup: Math.max(fast, slow) }
  },
}

export default strategy
`

/** 运行时 import：静态校验必须拒（no-import）。 */
export const WITH_IMPORT = `import { readFileSync } from 'node:fs'

const probe = readFileSync

${GOOD_STRATEGY}`

/** desc 里写承诺：静态校验必须拒（no-promise）。 */
export const WITH_PROMISE = GOOD_STRATEGY.replace(
  'Choppy ranges make it switch back and forth and pay fees.',
  'Guaranteed profit in every market.',
)

/** 没写 export default：静态校验必须拒（export-default）。 */
export const NO_EXPORT = GOOD_STRATEGY.replace('export default strategy\n', '')

/** 静态校验能过，但 evaluate 返回的序列长度不对：冒烟（加载器）必须拒（output-length）。 */
export const WRONG_LENGTH = GOOD_STRATEGY.replace(
  'return { target, reasons, overlays: { FAST: fastLine, SLOW: slowLine }, warmup: Math.max(fast, slow) }',
  'return { target: target.slice(0, Math.max(0, n - 1)), reasons, overlays: { FAST: fastLine, SLOW: slowLine }, warmup: Math.max(fast, slow) }',
)

/** 确定性锯齿：100 ± amplitude 的正弦，每小时一根，量恒为 1000。均线在这里一定会交叉。 */
export function zigzagCandles(n = 240, amplitude = 10, period = 20): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const c = 100 + amplitude * Math.sin((i / period) * Math.PI * 2)
    out.push({ t: i * 3_600_000, o: c, h: c + 0.5, l: c - 0.5, c, v: 1000 })
  }
  return out
}

/** 按脚本作答的假 client：记下每次提示词，超出脚本长度就抛错（也用来测 llm-error）。 */
export function scriptedLlm(replies: Array<string | Error>): { llm: Llm; prompts: string[] } {
  const prompts: string[] = []
  let i = 0
  const llm: Llm = {
    complete: async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      const reply = replies[i++]
      if (reply === undefined) throw new Error('scripted llm ran out of replies')
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { llm, prompts }
}
