// SPDX-License-Identifier: CPAL-1.0
// 教学示例 martingale：加载通过校验、默认参数正确、加倍层与止盈止损的目标序列 / 理由 / 画线按定义输出。
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadStrategyFile } from '../src/strategy/loader'
import { EXAMPLE_STRATEGIES } from './harness'

const FILE = join(EXAMPLE_STRATEGIES, 'martingale.ts')

/** 合成 K 线：开高低收都等于给定价，每小时一根，量恒为 1。 */
function mk(closes: number[]): Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> {
  return closes.map((c, i) => ({ t: i * 3_600_000, o: c, h: c, l: c, c, v: 1 }))
}

async function loadDef() {
  const r = await loadStrategyFile(FILE)
  expect(r.errors).toEqual([])
  expect(r.def).toBeDefined()
  return r.def!
}

describe('martingale（教学示例）', () => {
  it('加载通过校验，名称与默认参数符合定义', async () => {
    const def = await loadDef()
    expect(def.name).toMatch(/teaching example/)
    expect(def.defaults).toEqual({ baseSize: 0.1, multiplier: 2, maxDoublings: 3, takeProfitPct: 0.01, stopLossPct: 0.02 })
  })

  it('用例 A：止盈归零、止损加层并封顶，理由与画线对齐', async () => {
    const def = await loadDef()
    const closes = [100, 100, 101.5, 100, 97, 100, 97, 100, 97, 100, 97, 100]
    const s = def.evaluate(mk(closes), def.defaults)

    const expected = [0, 0.1, 0, 0.1, 0, 0.2, 0, 0.4, 0, 0.8, 0, 0.8]
    expected.forEach((x, i) => expect(s.target[i]).toBeCloseTo(x))

    expect(s.reasons[1]).toContain('进场')
    expect(s.reasons[2]).toContain('止盈')
    expect(s.reasons[3]).not.toBe('')
    expect(s.reasons[4]).toContain('止损')
    expect(s.reasons[5]).toContain('第 1 层')

    expect(s.overlays.入场价![1]).toBe(100)
    expect(s.overlays.入场价![2]).toBeNull()
    expect(s.overlays.止盈价![1]).toBeCloseTo(101)
    expect(s.overlays.止损价![1]).toBeCloseTo(98)
  })

  it('用例 B：仓位按 2 的层数次方放大，超过 1 封顶', async () => {
    const def = await loadDef()
    const s = def.evaluate(mk([100, 100, 97, 100, 97, 100]), { baseSize: 0.3, maxDoublings: 3, takeProfitPct: 0.01, stopLossPct: 0.02 })
    expect(s.target[1]).toBeCloseTo(0.3)
    expect(s.target[3]).toBeCloseTo(0.6)
    expect(s.target[5]).toBeCloseTo(1)
  })

  it('用例 C：maxDoublings 为 0 时永不加倍', async () => {
    const def = await loadDef()
    const s = def.evaluate(mk([100, 100, 101.5, 100, 97, 100]), { ...def.defaults, maxDoublings: 0 })
    expect(s.target[5]).toBeCloseTo(0.1)
  })

  it('用例 D：空输入与不足预热期都不抛错，目标全 0', async () => {
    const def = await loadDef()

    const empty = def.evaluate([], def.defaults)
    expect(empty.target).toEqual([])
    expect(empty.warmup).toBe(1)

    const one = def.evaluate(mk([100]), def.defaults)
    expect(one.target).toEqual([0])
  })
})
