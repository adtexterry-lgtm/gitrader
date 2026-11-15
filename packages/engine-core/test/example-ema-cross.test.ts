// SPDX-License-Identifier: CPAL-1.0
// 教学示例 ema-cross：加载通过校验、默认参数正确、双均线交叉的目标序列与理由/画线按定义输出。
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadStrategyFile } from '../src/strategy/loader'
import { EXAMPLE_STRATEGIES } from './harness'

const FILE = join(EXAMPLE_STRATEGIES, 'ema-cross.ts')

/** 合成 K 线：开高低收都等于给定价，每小时一根，量恒为 1。 */
function mk(closes: number[]): Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> {
  return closes.map((c, i) => ({ t: i * 3_600_000, o: c, h: c, l: c, c, v: 1 }))
}

const flat = (n: number, x: number): number[] => new Array<number>(n).fill(x)

async function loadDef() {
  const r = await loadStrategyFile(FILE)
  expect(r.errors).toEqual([])
  expect(r.def).toBeDefined()
  return r.def!
}

describe('ema-cross（教学示例）', () => {
  it('加载通过校验，名称与默认参数符合定义', async () => {
    const def = await loadDef()
    expect(def.name).toMatch(/teaching example/)
    expect(def.defaults).toEqual({ fast: 12, slow: 26, allowShort: true })
  })

  it('用例 A：90 根三段价格，交叉处反手，理由与画线对齐', async () => {
    const def = await loadDef()
    const closes = [...flat(30, 100), ...flat(30, 200), ...flat(30, 50)]
    const s = def.evaluate(mk(closes), { ...def.defaults, fast: 2, slow: 5, allowShort: true })

    expect(s.warmup).toBe(5)
    expect(s.target[4]).toBe(0)
    expect(s.target[29]).toBe(0)
    expect(s.target[30]).toBe(1)
    expect(s.target[59]).toBe(1)
    expect(s.target[60]).toBe(-1)
    expect(s.target[89]).toBe(-1)

    expect(s.reasons[30]).toContain('上穿')
    expect(s.reasons[31]).toBe('')
    expect(s.reasons[60]).toContain('下穿')

    expect(s.overlays.EMA2![0]).toBeNull()
    expect(s.overlays.EMA2![1]).toBeCloseTo(100)
    expect(s.overlays.EMA5![3]).toBeNull()
    expect(s.overlays.EMA5![4]).toBeCloseTo(100)
  })

  it('用例 B：不允许做空时，下穿只平多', async () => {
    const def = await loadDef()
    const closes = [...flat(30, 100), ...flat(30, 200), ...flat(30, 50)]
    const s = def.evaluate(mk(closes), { ...def.defaults, fast: 2, slow: 5, allowShort: false })
    expect(s.target[60]).toBe(0)
    expect(s.reasons[60]).toContain('平多')
  })

  it('用例 C：空输入与不足预热期都不抛错，目标全 0', async () => {
    const def = await loadDef()

    const empty = def.evaluate([], def.defaults)
    expect(empty.target).toEqual([])
    expect(empty.warmup).toBe(26)

    const short = def.evaluate(mk(flat(5, 100)), def.defaults)
    expect(short.target).toEqual(flat(5, 0))
    expect(short.reasons).toEqual(new Array<string>(5).fill(''))
  })

  it('用例 D：慢线不大于快线时自动抬到快线 + 1', async () => {
    const def = await loadDef()
    const s = def.evaluate(mk(flat(40, 100)), { ...def.defaults, fast: 10, slow: 5, allowShort: true })
    expect(s.warmup).toBe(11)
  })
})
