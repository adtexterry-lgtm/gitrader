// SPDX-License-Identifier: CPAL-1.0
// 教学示例 momentum-roc：必须通过校验器，并在合成 K 线上核对 ROC、目标仓位与理由。
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadStrategyFile } from '../src/strategy/loader'
import { EXAMPLE_STRATEGIES } from './harness'

const file = join(EXAMPLE_STRATEGIES, 'momentum-roc.ts')

/** 合成 K 线：开高低收都取同一价格，时间戳每小时一根。 */
function mk(closes: number[]) {
  return closes.map((c, i) => ({ t: i * 3_600_000, o: c, h: c, l: c, c, v: 1 }))
}

async function load() {
  const r = await loadStrategyFile(file)
  expect(r.errors).toEqual([])
  return r.def!
}

describe('momentum-roc 教学示例', () => {
  it('通过校验，元数据与默认参数符合约定', async () => {
    const def = await load()
    expect(def.name).toMatch(/teaching example/)
    expect(def.defaults).toEqual({ lookback: 20, threshold: 0.02, allowShort: true })
  })

  it('A 复利上涨：越过阈值做多并在之后保持', async () => {
    const def = await load()
    const closes = Array.from({ length: 40 }, (_, i) => 100 * 1.01 ** i)
    const s = def.evaluate(mk(closes), { lookback: 5, threshold: 0.02, allowShort: true })
    expect(s.warmup).toBe(5)
    const roc = s.overlays.ROC!
    expect(roc[4]).toBeNull()
    expect(roc[5]).toBeCloseTo(0.0510100501, 8)
    expect(s.target[4]).toBe(0)
    expect(s.target[5]).toBe(1)
    expect(s.target[39]).toBe(1)
    expect(s.reasons[5]).toContain('做多')
    expect(s.reasons[6]).toBe('')
  })

  it('B 复利下跌：跌破负阈值做空；不允许做空时保持空仓', async () => {
    const def = await load()
    const closes = Array.from({ length: 40 }, (_, i) => 100 * 0.99 ** i)
    const s = def.evaluate(mk(closes), { lookback: 5, threshold: 0.02, allowShort: true })
    expect(s.overlays.ROC![5]).toBeCloseTo(0.99 ** 5 - 1, 8)
    expect(s.target[5]).toBe(-1)
    expect(s.target[39]).toBe(-1)
    const flat = def.evaluate(mk(closes), { lookback: 5, threshold: 0.02, allowShort: false })
    expect(flat.target.every((t) => t === 0)).toBe(true)
  })

  it('C 横盘：ROC 为 0，从不触发', async () => {
    const def = await load()
    const s = def.evaluate(mk(new Array(40).fill(100)), { lookback: 5, threshold: 0.02, allowShort: true })
    expect(s.target.every((t) => t === 0)).toBe(true)
    expect(s.reasons.every((r) => r === '')).toBe(true)
    expect(s.overlays.ROC![5]).toBe(0)
  })

  it('D 进出：横盘后 ROC 逐根回落，跌破阈值即平仓', async () => {
    const def = await load()
    const up = Array.from({ length: 10 }, (_, i) => 100 * 1.01 ** i)
    const closes = [...up, ...new Array(30).fill(up[9]!)]
    const s = def.evaluate(mk(closes), { lookback: 5, threshold: 0.02, allowShort: true })
    expect(s.target[9]).toBe(1)
    expect(s.target[12]).toBe(1)
    expect(s.target[13]).toBe(0)
    expect(s.reasons[13]).toContain('平仓')
    expect(s.target.slice(14).every((t) => t === 0)).toBe(true)
    expect(s.reasons.slice(14).every((r) => r === '')).toBe(true)
  })

  it('E 空序列与不足预热期：全 0，不抛错', async () => {
    const def = await load()
    const empty = def.evaluate([], def.defaults)
    expect(empty.target).toEqual([])
    expect(empty.warmup).toBe(20)
    const short = def.evaluate(mk([100, 101, 102]), def.defaults)
    expect(short.target).toEqual([0, 0, 0])
  })

  it('F 基准价为 0 时 ROC 不可用：持仓回到 0 并给出理由，不静默平仓', async () => {
    const def = await load()
    const closes = [...Array.from({ length: 10 }, (_, i) => 100 * 1.01 ** i), 0, ...Array<number>(9).fill(120)]
    const s = def.evaluate(mk(closes), { lookback: 5, threshold: 0.02, allowShort: false })
    expect(s.target[9]).toBe(1)
    expect(s.target[10]).toBe(0)
    expect(s.target[14]).toBe(1)
    expect(s.overlays.ROC![15]).toBeNull()
    expect(s.target[15]).toBe(0)
    expect(s.reasons[15]).toContain('不可用')
    expect(s.target[16]).toBe(0)
    expect(s.reasons[16]).toBe('')
  })
})
