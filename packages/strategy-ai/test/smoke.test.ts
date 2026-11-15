// SPDX-License-Identifier: CPAL-1.0
// 冒烟：真跑 engine-core 的加载器 + 回测。断言的是「历史数据上发生了什么」，不是任何推断。
import { describe, expect, it } from 'vitest'
import { smoke } from '../src'
import { GOOD_STRATEGY, WITH_IMPORT, WRONG_LENGTH, zigzagCandles } from './fixtures'

const CANDLES = zigzagCandles(240)

describe('smoke', () => {
  it('合法策略在锯齿行情上有成交：bars 等于输入根数、成交与权益都是有限数', async () => {
    const s = await smoke(GOOD_STRATEGY, CANDLES)
    expect(s.ok).toBe(true)
    expect(s.issues).toEqual([])
    expect(s.bars).toBe(240)
    expect(s.trades).toBeGreaterThan(0)
    expect(Number.isFinite(s.finalEquity)).toBe(true)
    expect(s.finalEquity).toBeGreaterThan(0)
    expect(s.maxDrawdownRatio).toBeGreaterThanOrEqual(0)
    expect(s.liquidations).toBe(0)
  })

  it('参数可覆盖：换一组更短的均线后仍在跑，且期末权益与默认参数不同', async () => {
    const base = await smoke(GOOD_STRATEGY, CANDLES)
    const fast = await smoke(GOOD_STRATEGY, CANDLES, { params: { fast: 2, slow: 3 } })
    expect(fast.ok).toBe(true)
    expect(fast.trades).toBeGreaterThan(0)
    expect(fast.finalEquity).not.toBe(base.finalEquity)
  })

  it('静态校验不过的代码不会进入回测：加载器按自己的规则名拒（no-io），成交为 0', async () => {
    const s = await smoke(WITH_IMPORT, CANDLES)
    expect(s.ok).toBe(false)
    expect(s.issues.map((i) => i.rule)).toContain('no-io')
    expect(s.issues[0]?.message.toLowerCase()).toContain('import')
    expect(s.trades).toBe(0)
    expect(s.finalEquity).toBe(0)
  })

  it('加载器的动态检查同样生效：长度不对的序列 → output-length，且不抛错', async () => {
    const s = await smoke(WRONG_LENGTH, CANDLES)
    expect(s.ok).toBe(false)
    const rules = s.issues.map((i) => i.rule)
    expect(rules).toContain('output-length')
    // 加载器把 hint 拼进消息，修复轮才有「怎么改」
    expect(s.issues[0]?.message.length).toBeGreaterThan(0)
  })

  it('没有 K 线时不跑回测，返回 no-candles', async () => {
    const s = await smoke(GOOD_STRATEGY, [])
    expect(s.ok).toBe(false)
    expect(s.bars).toBe(0)
    expect(s.issues[0]?.rule).toBe('no-candles')
  })
})
