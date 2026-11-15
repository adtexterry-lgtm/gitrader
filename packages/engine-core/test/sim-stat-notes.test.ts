// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { Candle } from '../src/types'
import { Simulator } from '../src/strategy/simulator'

const H = 3_600_000
const DAY = 86_400_000
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1e9 })
const mk = () => new Simulator({ initialCash: 1000, leverage: 1, feeRate: 0, slippageBps: 0 })
/** 开多 → 涨 → 平仓：一笔盈利往返，没有亏损单。 */
function winningRun(step = H): { sim: Simulator; cs: Candle[] } {
  const cs = [bar(0, 100, 100, 100, 100), bar(step, 100, 110, 100, 110), bar(2 * step, 110, 110, 110, 110), bar(3 * step, 110, 110, 110, 110)]
  const sim = mk()
  sim.onBar(0, cs[0]!, 1, 'x'); sim.onBar(1, cs[1]!, 1, 'x'); sim.onBar(2, cs[2]!, 0, 'x'); sim.onBar(3, cs[3]!, 0, 'x')
  return { sim, cs }
}

describe('GQ-18 退化字段说明（数值不动）', () => {
  it('零亏损：profitFactor 仍为 null，且有说明；sortino 仍为 0，且有说明', () => {
    const { sim, cs } = winningRun()
    const s = sim.stats(cs, H)
    expect(s.profitFactor).toBeNull()
    expect(s.sortino).toBe(0)
    const n = sim.statNotes.join('|')
    expect(n).toMatch(/profitFactor is null: no losing round trip/)
    expect(n).toMatch(/sortino is reported as 0 because the window has no downside deviation/)
  })
  it('反例：有亏损往返时 profitFactor 是数、不写 null 说明', () => {
    const cs = [bar(0, 100, 100, 100, 100), bar(H, 100, 100, 90, 90), bar(2 * H, 90, 90, 90, 90), bar(3 * H, 90, 90, 90, 90)]
    const sim = mk()
    sim.onBar(0, cs[0]!, 1, 'x'); sim.onBar(1, cs[1]!, 1, 'x'); sim.onBar(2, cs[2]!, 0, 'x'); sim.onBar(3, cs[3]!, 0, 'x')
    const s = sim.stats(cs, H)
    expect(s.profitFactor).toBe(0)                     // 只有亏损，毛盈 0 / 毛亏 > 0
    expect(sim.statNotes.join('|')).not.toMatch(/profitFactor is null/)
  })
  it('没有任何往返：profitFactor null，说明是「no closed round trips」', () => {
    const cs = [bar(0, 100, 100, 100, 100), bar(H, 100, 100, 100, 100), bar(2 * H, 100, 100, 100, 100), bar(3 * H, 100, 100, 100, 100)]
    const sim = mk()
    cs.forEach((c, i) => sim.onBar(i, c, 0, 'x'))
    sim.stats(cs, H)
    expect(sim.statNotes.join('|')).toMatch(/profitFactor is null: no closed round trips/)
  })
  it('短窗口（4 小时）年化写「外推、无意义」；40 天窗口不写', () => {
    const short = winningRun()
    short.sim.stats(short.cs, H)
    expect(short.sim.statNotes.join('|')).toMatch(/annualizedRatio is extrapolated from a .* window \(< 30 days\)/)

    const cs = Array.from({ length: 40 }, (_, i) => bar(i * DAY, 100, 100, 100, 100))
    const sim = mk()
    cs.forEach((c, i) => sim.onBar(i, c, 1, 'x'))
    sim.stats(cs, DAY)
    expect(sim.statNotes.join('|')).not.toMatch(/extrapolated/)
  })
  it('每次 stats() 重新生成说明，不累积', () => {
    const { sim, cs } = winningRun()
    sim.stats(cs, H)
    const first = sim.statNotes.length
    sim.stats(cs, H)
    expect(sim.statNotes.length).toBe(first)
  })
})
