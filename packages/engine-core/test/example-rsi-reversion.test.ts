// SPDX-License-Identifier: CPAL-1.0
// 教学示例 rsi-reversion 的加载校验与信号规则：全部用合成 K 线，不碰网络、不读文件、不看时钟。
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadStrategyFile } from '../src/strategy/loader'
import { EXAMPLE_STRATEGIES } from './harness'

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }

const FILE = join(EXAMPLE_STRATEGIES, 'rsi-reversion.ts')

/** 合成 K 线：开高低收都等于收盘价，成交量为 1，每小时一根。 */
const mk = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i * 3_600_000, o: c, h: c, l: c, c, v: 1 }))

let cached: Promise<Awaited<ReturnType<typeof loadStrategyFile>>> | null = null
const load = (): Promise<Awaited<ReturnType<typeof loadStrategyFile>>> => (cached ??= loadStrategyFile(FILE))

const up = (n: number, from = 100): number[] => Array.from({ length: n }, (_, i) => from + i)

describe('rsi-reversion 教学示例', () => {
  it('加载校验通过，名字标明是教学示例，默认周期 14', async () => {
    const { def, errors } = await load()
    expect(errors).toEqual([])
    expect(def?.name).toMatch(/teaching example/)
    expect(def?.defaults.period).toBe(14)
  })

  it('A 单边上涨：预热 14 根，RSI 走到 100，然后一直做空', async () => {
    const def = (await load()).def!
    const out = def.evaluate(mk(up(40)), def.defaults)
    const rsi = out.overlays.RSI!
    expect(out.warmup).toBe(14)
    expect(rsi[13]).toBeNull()
    expect(rsi[14]).toBe(100)
    expect(out.target[13]).toBe(0)
    expect(out.target[14]).toBe(-1)
    expect(out.target[39]).toBe(-1)
    expect(out.reasons[14]).toContain('做空')
    expect(out.reasons[15]).toBe('')
  })

  it('B 单边下跌：RSI 走到 0，然后一直做多', async () => {
    const def = (await load()).def!
    const closes = Array.from({ length: 40 }, (_, i) => 200 - i)
    const out = def.evaluate(mk(closes), def.defaults)
    expect(out.overlays.RSI![14]).toBe(0)
    expect(out.target[14]).toBe(1)
    expect(out.target[39]).toBe(1)
    expect(out.reasons[14]).toContain('做多')
  })

  it('C 上涨后回落：先做空，随后在离场线平空，此后不再做空', async () => {
    const def = (await load()).def!
    const closes = [...up(20), ...Array.from({ length: 20 }, (_, k) => 119 - (k + 1))]
    const out = def.evaluate(mk(closes), { ...def.defaults, allowShort: true })
    expect(out.target[14]).toBe(-1)
    let exit = -1
    for (let i = 21; i <= 39; i++) {
      if (out.target[i] === 0 && (out.reasons[i] ?? '').includes('平空')) { exit = i; break }
    }
    expect(exit).toBeGreaterThanOrEqual(21)
    expect(exit).toBeLessThanOrEqual(39)
    for (let i = exit + 1; i <= 39; i++) {
      const t = out.target[i]
      expect(t === 0 || t === 1).toBe(true)
    }
  })

  it('D 关掉 allowShort：同样的单边上涨里目标全 0', async () => {
    const def = (await load()).def!
    const out = def.evaluate(mk(up(40)), { ...def.defaults, allowShort: false })
    expect(out.target.every((t) => t === 0)).toBe(true)
  })

  it('E 空序列与不足预热期：返回全 0，warmup 仍是周期', async () => {
    const def = (await load()).def!
    const empty = def.evaluate([], def.defaults)
    expect(empty.target).toEqual([])
    expect(empty.warmup).toBe(14)
    const short = def.evaluate(mk(up(10)), def.defaults)
    expect(short.target).toHaveLength(10)
    expect(short.target.every((t) => t === 0)).toBe(true)
  })
})
