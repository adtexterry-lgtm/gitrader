// SPDX-License-Identifier: CPAL-1.0
// GQ-25：到达时刻落在同一毫秒的多条记录上，按该毫秒最后一版盘口撮合（文档「同一毫秒取较晚那版」）。
import { describe, expect, it } from 'vitest'
import { SimBook } from '../src'
import type { MarketRecord } from '../src'

const D = (ts: number, side: 'bid' | 'ask', action: 'add' | 'delete' | 'update', price: string, size?: string): MarketRecord =>
  ({ type: 'book_delta', ts, instrument: 'BTCUSDT', side, action, price, ...(size ? { size } : {}) }) as MarketRecord

function fresh(): SimBook {
  const sim = new SimBook({ instrument: 'BTCUSDT', latency: { baseMs: 0, insertMs: 20, updateMs: 0, cancelMs: 0 } })
  sim.apply({ type: 'book_snapshot', ts: 5000, instrument: 'BTCUSDT', bids: [['100', '5']], asks: [['101', '5']] })
  sim.submit({ id: 'o', side: 'buy', type: 'market', qty: '1' }, 5000)      // 到达 5020
  return sim
}
const same = [D(5020, 'ask', 'add', '106', '2'), D(5020, 'ask', 'delete', '101'), D(5020, 'bid', 'add', '99', '1')]

describe('GQ-25 同一毫秒取最后一版', () => {
  it('applyBatch：同一毫秒三条记录落完才撮合 → 成交在 106', () => {
    const sim = fresh()
    sim.applyBatch(same)
    expect(sim.report('o')?.fills).toEqual([{ price: '106', qty: '1', liquidity: 'taker' }])
  })
  it('逐条 apply 且声明「后面还有同毫秒记录」→ 同样 106', () => {
    const sim = fresh()
    sim.apply(same[0]!, { sameMsFollows: true })
    sim.apply(same[1]!, { sameMsFollows: true })
    sim.apply(same[2]!)
    expect(sim.report('o')?.fills[0]?.price).toBe('106')
  })
  it('反例：逐条 apply 不声明 → 保持旧语义（第一条之后即撮合，成交在 101）', () => {
    const sim = fresh()
    for (const r of same) sim.apply(r)
    expect(sim.report('o')?.fills[0]?.price).toBe('101')
  })
  it('回归：只有一条记录落在到达时刻时，applyBatch 与 apply 结果一致', () => {
    const a = fresh(); a.applyBatch([D(5020, 'ask', 'add', '106', '2')])
    const b = fresh(); b.apply(D(5020, 'ask', 'add', '106', '2'))
    expect(a.report('o')).toEqual(b.report('o'))
    expect(a.report('o')?.status).toBe('filled')
  })
  it('回归：到达时刻早于记录 ts 时仍用记录之前的盘口（不偷看未来），批量与逐条一致', () => {
    const sim = new SimBook({ instrument: 'BTCUSDT', latency: { baseMs: 0, insertMs: 20, updateMs: 0, cancelMs: 0 } })
    sim.apply({ type: 'book_snapshot', ts: 5000, instrument: 'BTCUSDT', bids: [['100', '5']], asks: [['101', '5'], ['104', '5']] })
    sim.submit({ id: 'early', side: 'buy', type: 'market', qty: '1' }, 5000)  // 到达 5020
    sim.applyBatch([D(5030, 'ask', 'delete', '101'), D(5030, 'bid', 'add', '99', '1')])
    expect(sim.report('early')?.fills[0]?.price).toBe('101')
  })
})
