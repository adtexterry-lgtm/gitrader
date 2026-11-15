// SPDX-License-Identifier: CPAL-1.0
// 延迟模型：三个操作各自的固定延迟、基础延迟相加、种子抖动可复现、到达时刻不早于发出时刻。
import { describe, expect, it } from 'vitest'
import { LatencyModel, MAX_LATENCY_MS, toLatencyModel } from '../src'

describe('固定延迟', () => {
  it('缺省零延迟：命令在发出时刻到达', () => {
    const model = LatencyModel.zero()
    expect(model.latency('insert')).toBe(0)
    expect(model.latency('update')).toBe(0)
    expect(model.latency('cancel')).toBe(0)
    expect(model.arrivalTs('insert', 1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  it('基础延迟加到每个操作上（参照口径：base + 该操作额外延迟）', () => {
    const model = new LatencyModel({ baseMs: 100, insertMs: 200, updateMs: 50, cancelMs: 0 })
    expect(model.latency('insert')).toBe(300)
    expect(model.latency('update')).toBe(150)
    expect(model.latency('cancel')).toBe(100)
    expect(model.baseMs).toBe(100)
  })

  it('三个操作互不影响', () => {
    const model = new LatencyModel({ insertMs: 10, updateMs: 20, cancelMs: 30 })
    expect([model.latency('insert'), model.latency('update'), model.latency('cancel')]).toEqual([10, 20, 30])
  })

  it('到达时刻 = 发出时刻 + 该操作延迟', () => {
    const model = new LatencyModel({ baseMs: 5, insertMs: 7, updateMs: 11, cancelMs: 13 })
    expect(model.arrivalTs('insert', 1000)).toBe(1012)
    expect(model.arrivalTs('update', 1000)).toBe(1016)
    expect(model.arrivalTs('cancel', 1000)).toBe(1018)
  })

  it('发出时刻不是整数毫秒时报错', () => {
    const model = new LatencyModel()
    expect(() => model.arrivalTs('insert', 1.5)).toThrow(/发出时刻必须是整数毫秒/)
  })

  it('未知操作报错', () => {
    expect(() => new LatencyModel().latency('submit' as never)).toThrow(/未知延迟操作/)
  })
})

describe('确定性抖动', () => {
  it('非负抖动落在 [0, jitterMs] 里', () => {
    const model = new LatencyModel({ insertMs: 10, jitterMs: 4, seed: 7 })
    const draws = Array.from({ length: 200 }, () => model.latency('insert'))
    for (const value of draws) {
      expect(value).toBeGreaterThanOrEqual(10)
      expect(value).toBeLessThanOrEqual(14)
      expect(Number.isInteger(value)).toBe(true)
    }
    // 抖动确实在动（不是常量）
    expect(new Set(draws).size).toBeGreaterThan(1)
  })

  it('对称抖动落在 [-jitterMs, +jitterMs] 里，两侧都出现', () => {
    const model = new LatencyModel({ insertMs: 100, jitterMs: 5, jitterMode: 'symmetric', seed: 11 })
    const draws = Array.from({ length: 300 }, () => model.latency('insert'))
    expect(Math.min(...draws)).toBeLessThan(100)
    expect(Math.max(...draws)).toBeGreaterThan(100)
    for (const value of draws) {
      expect(value).toBeGreaterThanOrEqual(95)
      expect(value).toBeLessThanOrEqual(105)
    }
  })

  it('同种子 + 同调用顺序 = 同一串延迟（可复现）', () => {
    const run = (): number[] => {
      const model = new LatencyModel({ baseMs: 3, insertMs: 5, updateMs: 1, cancelMs: 2, jitterMs: 8, seed: 20261021 })
      const out: number[] = []
      for (let i = 0; i < 40; i += 1) {
        out.push(model.latency('insert'), model.latency('update'), model.latency('cancel'))
      }
      return out
    }
    expect(run()).toEqual(run())
  })

  it('不同种子给出不同序列', () => {
    const seq = (seed: number): number[] => {
      const model = new LatencyModel({ insertMs: 10, jitterMs: 16, seed })
      return Array.from({ length: 32 }, () => model.latency('insert'))
    }
    expect(seq(1)).not.toEqual(seq(2))
  })

  it('reset 后重放同一串延迟', () => {
    const model = new LatencyModel({ insertMs: 10, jitterMs: 6, seed: 99 })
    const first = Array.from({ length: 10 }, () => model.latency('insert'))
    model.reset()
    expect(model.draws).toBe(0)
    expect(Array.from({ length: 10 }, () => model.latency('insert'))).toEqual(first)
  })

  it('无抖动时不消耗随机数', () => {
    const model = new LatencyModel({ insertMs: 10 })
    model.latency('insert')
    model.latency('cancel')
    expect(model.draws).toBe(0)
  })

  it('对称抖动不会把到达时刻推到发出之前', () => {
    const model = new LatencyModel({ jitterMs: 9, jitterMode: 'symmetric', seed: 5 })
    for (let i = 0; i < 100; i += 1) {
      const at = model.arrivalTs('insert', 500)
      expect(at).toBeGreaterThanOrEqual(500)
    }
  })
})

describe('配置校验', () => {
  it('负延迟报错', () => {
    expect(() => new LatencyModel({ insertMs: -1 })).toThrow(/不能为负/)
  })

  it('非整数延迟报错', () => {
    expect(() => new LatencyModel({ cancelMs: 1.5 })).toThrow(/必须是整数毫秒/)
  })

  it('未知抖动方向报错', () => {
    expect(() => new LatencyModel({ jitterMode: 'both' as never })).toThrow(/未知抖动方向/)
  })

  it('种子不是整数报错', () => {
    expect(() => new LatencyModel({ seed: 1.2 })).toThrow(/seed 必须是 32 位整数/)
  })

  it('toLatencyModel 接受配置对象与模型实例，未给则是零延迟', () => {
    expect(toLatencyModel(undefined).latency('insert')).toBe(0)
    expect(toLatencyModel({ insertMs: 4 }).latency('insert')).toBe(4)
    const instance = new LatencyModel({ insertMs: 9 })
    expect(toLatencyModel(instance)).toBe(instance)
  })

  // L4-10：1e308 ms 是整数且非负，以前会被接受，订单到达时刻等于永不到达且不报错。
  it('超过上限的延迟报错（1e308 ms 不再被接受）', () => {
    expect(() => toLatencyModel({ insertMs: 1e308 })).toThrow(/不能超过 60000 ms/)
    expect(() => new LatencyModel({ baseMs: MAX_LATENCY_MS + 1 })).toThrow(/不能超过 60000 ms/)
    expect(() => new LatencyModel({ jitterMs: Number.MAX_SAFE_INTEGER })).toThrow(/不能超过 60000 ms/)
  })

  it('反证：上限本身与常见值照旧接受', () => {
    expect(toLatencyModel({ insertMs: MAX_LATENCY_MS }).latency('insert')).toBe(MAX_LATENCY_MS)
    expect(toLatencyModel({ baseMs: 100, insertMs: 200 }).latency('insert')).toBe(300)
    expect(new LatencyModel({ jitterMs: 5, seed: 1 }).latency('insert')).toBeLessThanOrEqual(5)
  })
})
