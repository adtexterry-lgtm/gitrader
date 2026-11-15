// SPDX-License-Identifier: CPAL-1.0
// 先挂后吃状态机：起步、部分成交、超时撤余量、tail guard、吃单腿收尾、加权均价与多币种费用。
import { describe, expect, it } from 'vitest'
import {
  averagePrice,
  onFill,
  onTimeout,
  remainingSize,
  startMakerThenMarket,
  type ExecState,
  type MakerThenMarketSpec,
} from '../src'

const NOW = 1760000000000

// 基准规格：买 1 个，参考价 100，挂单价 100 × (1 − 5/10000) = 99.95，价带上沿 100 × 1.003 = 100.3
const spec: MakerThenMarketSpec = {
  side: 'buy',
  size: '1',
  refPrice: '100',
  makerOffsetBps: 5,
  makerWaitMs: 1500,
  maxSlippageBps: 30,
  tickSize: '0.01',
  lotStep: '0.001',
  minSize: '0.01',
}

function started(): ExecState {
  return startMakerThenMarket(spec, NOW).state
}

describe('startMakerThenMarket', () => {
  it('起步发出 post-only 限价 99.95 + 等待 1500ms', () => {
    const { state, next } = startMakerThenMarket(spec, NOW)
    expect(state.phase).toBe('maker')
    expect(state.filled).toBe('0')
    expect(state.notional).toBe('0')
    expect(state.fees).toEqual({})
    expect(state.steps).toEqual([
      { kind: 'place_limit', price: '99.95', size: '1', postOnly: true },
      { kind: 'wait', ms: 1500 },
    ])
    expect(next).toEqual({ kind: 'place_limit', price: '99.95', size: '1', postOnly: true })
  })

  it('数量按 lotStep 向零截断：1.2345 / 0.001 → 1.234', () => {
    const { state } = startMakerThenMarket({ ...spec, size: '1.2345' }, NOW)
    expect(state.steps[0]).toEqual({ kind: 'place_limit', price: '99.95', size: '1.234', postOnly: true })
  })

  it('截断后不足 minSize → 直接 tail_guard，不发限价', () => {
    const { state, next } = startMakerThenMarket({ ...spec, size: '0.005' }, NOW)
    expect(state.phase).toBe('done')
    expect(state.steps).toEqual([{ kind: 'done', reason: 'tail_guard' }])
    expect(next).toEqual({ kind: 'done', reason: 'tail_guard' })
  })

  it('截断到 0（0.0004 / 0.001）→ tail_guard', () => {
    const { state } = startMakerThenMarket({ ...spec, size: '0.0004' }, NOW)
    expect(state.phase).toBe('done')
    expect(state.steps).toEqual([{ kind: 'done', reason: 'tail_guard' }])
  })

  it('满量判定用截断后的量：size 1.2345 / lotStep 0.001，成交 1.234 就 done/filled', () => {
    const spec123 = { ...spec, size: '1.2345' }
    const s = startMakerThenMarket(spec123, NOW).state
    // 目标量 = floor(1.2345 / 0.001) × 0.001 = 1.234；挂单量与满量阈值同源
    expect(s.steps[0]).toEqual({ kind: 'place_limit', price: '99.95', size: '1.234', postOnly: true })
    const r = onFill(spec123, s, { size: '1.234', price: '99.95' }, NOW)
    expect(r.state.phase).toBe('done')
    expect(r.state.filled).toBe('1.234')
    expect(r.next).toEqual({ kind: 'done', reason: 'filled' })
  })

  it('负偏移 / 负滑点 / 非正数量都抛 RangeError', () => {
    expect(() => startMakerThenMarket({ ...spec, makerOffsetBps: -1 }, NOW)).toThrow(RangeError)
    expect(() => startMakerThenMarket({ ...spec, maxSlippageBps: -1 }, NOW)).toThrow(RangeError)
    expect(() => startMakerThenMarket({ ...spec, size: '0' }, NOW)).toThrow(RangeError)
    expect(() => startMakerThenMarket(spec, Number.NaN)).toThrow(RangeError)
  })
})

describe('onFill', () => {
  it('部分成交 0.4 @ 99.95：数量 0.4，名义额 0.4 × 99.95 = 39.98，仍在挂单腿', () => {
    const r = onFill(spec, started(), { size: '0.4', price: '99.95' }, NOW)
    expect(r.state.phase).toBe('maker')
    expect(r.state.filled).toBe('0.4')
    expect(r.state.notional).toBe('39.98')
    expect(r.next).toBeUndefined()
  })

  it('补完剩余 0.6 @ 100.05：名义额 39.98 + 60.03 = 100.01，结束原因 filled', () => {
    const first = onFill(spec, started(), { size: '0.4', price: '99.95' }, NOW).state
    const r = onFill(spec, first, { size: '0.6', price: '100.05' }, NOW)
    expect(r.state.phase).toBe('done')
    expect(r.state.filled).toBe('1')
    expect(r.state.notional).toBe('100.01')
    expect(r.next).toEqual({ kind: 'done', reason: 'filled' })
    expect(r.state.steps.at(-1)).toEqual({ kind: 'done', reason: 'filled' })
  })

  it('成交超过意图量也收尾（不截断账面，照实记）', () => {
    const r = onFill(spec, started(), { size: '1.5', price: '100' }, NOW)
    expect(r.state.phase).toBe('done')
    expect(r.state.filled).toBe('1.5')
    expect(r.next).toEqual({ kind: 'done', reason: 'filled' })
  })

  it('多币种费用：USDT 与 BNB 各自累计，币种大写归并', () => {
    let s = started()
    s = onFill(spec, s, { size: '0.4', price: '100', fee: '0.03998', feeCurrency: 'usdt' }, NOW).state
    s = onFill(spec, s, { size: '0.3', price: '100', fee: '0.0001', feeCurrency: 'bnb' }, NOW).state
    s = onFill(spec, s, { size: '0.2', price: '100', fee: '0.02', feeCurrency: 'USDT' }, NOW).state
    expect(s.fees).toEqual({ USDT: '0.05998', BNB: '0.0001' })
    expect(s.phase).toBe('maker')
  })

  it('费用缺币种记 UNKNOWN；费用为 0 不建键', () => {
    let s = started()
    s = onFill(spec, s, { size: '0.4', price: '100', fee: '0.001' }, NOW).state
    s = onFill(spec, s, { size: '0.1', price: '100', fee: '0' }, NOW).state
    expect(s.fees).toEqual({ UNKNOWN: '0.001' })
  })

  it('IOC 两笔成交都记账：0.3 挂单 + 0.4 @ 100.3 + 0.3 @ 100.35 → filled 1 / notional 100.21 / 两币种费用', () => {
    let s = onFill(spec, started(), { size: '0.3', price: '99.95' }, NOW).state
    s = onTimeout(spec, s, NOW).state // cancel
    s = onTimeout(spec, s, NOW).state // place_ioc 0.7
    const first = onFill(spec, s, { size: '0.4', price: '100.3', fee: '0.04', feeCurrency: 'USDT' }, NOW)
    // 0.3 + 0.4 = 0.7 < 1 → 仍在 taker，不结束
    expect(first.state.phase).toBe('taker')
    expect(first.state.filled).toBe('0.7')
    expect(first.next).toBeUndefined()
    const second = onFill(spec, first.state, { size: '0.3', price: '100.35', fee: '0.03', feeCurrency: 'BNB' }, NOW)
    // 0.7 + 0.3 = 1 = target → done/market_fallback
    expect(second.state.phase).toBe('done')
    expect(second.state.filled).toBe('1')
    // 0.3 × 99.95 = 29.985；0.4 × 100.3 = 40.12；0.3 × 100.35 = 30.105；合计 100.21
    expect(second.state.notional).toBe('100.21')
    expect(second.state.fees).toEqual({ USDT: '0.04', BNB: '0.03' })
    expect(second.next).toEqual({ kind: 'done', reason: 'market_fallback' })
  })

  it('done 之后再来一笔成交仍记账：只累加，phase 仍是 done，不加步骤、不返回 next', () => {
    const done = onFill(spec, started(), { size: '1', price: '99.95' }, NOW).state
    const again = onFill(spec, done, { size: '0.1', price: '100.4', fee: '0.01', feeCurrency: 'USDT' }, NOW)
    // 1 × 99.95 = 99.95；0.1 × 100.4 = 10.04；合计 109.99
    expect(again.state).not.toBe(done)
    expect(again.state.phase).toBe('done')
    expect(again.state.filled).toBe('1.1')
    expect(again.state.notional).toBe('109.99')
    expect(again.state.fees).toEqual({ USDT: '0.01' })
    expect(again.state.steps).toEqual(done.steps)
    expect(again.next).toBeUndefined()
  })

  it('加权均价 100.25 = (0.4 × 99.95 + 0.3 × 100.65) / 0.7 = 70.175 / 0.7', () => {
    let s = started()
    s = onFill(spec, s, { size: '0.4', price: '99.95' }, NOW).state
    s = onFill(spec, s, { size: '0.3', price: '100.65' }, NOW).state
    expect(s.notional).toBe('70.175')
    expect(averagePrice(s)).toBe('100.25')
  })

  it('没有成交时均价是 0；剩余量按 lotStep 截断', () => {
    const s = started()
    expect(averagePrice(s)).toBe('0')
    const half = onFill(spec, s, { size: '0.2507', price: '100' }, NOW).state
    // 剩余 1 − 0.2507 = 0.7493 → 向零截断到 0.001 → 0.749
    expect(remainingSize(spec, half)).toBe('0.749')
  })

  it('数量为 0 或价格非正的成交是非法输入', () => {
    expect(() => onFill(spec, started(), { size: '0', price: '100' }, NOW)).toThrow(RangeError)
    expect(() => onFill(spec, started(), { size: '0.1', price: '0' }, NOW)).toThrow(RangeError)
    expect(() => onFill(spec, started(), { size: '0.1', price: '100' }, Number.NaN)).toThrow(RangeError)
  })
})

describe('onTimeout', () => {
  it('第一次超时（余量 0.7 ≥ minSize）：只发撤单，阶段仍是 maker，不发 IOC', () => {
    const s = onFill(spec, started(), { size: '0.3', price: '99.95' }, NOW).state
    const r = onTimeout(spec, s, NOW)
    expect(r.next).toEqual({ kind: 'cancel' })
    expect(r.state.phase).toBe('maker')
    expect(r.state.steps.at(-1)).toEqual({ kind: 'cancel' })
    expect(r.state.steps.some((x) => x.kind === 'place_ioc')).toBe(false)
  })

  it('撤单确认后第二次超时：按当前余量发 IOC 0.7 @ 价带上沿 100.3，阶段转 taker', () => {
    const s = onFill(spec, started(), { size: '0.3', price: '99.95' }, NOW).state
    const afterCancel = onTimeout(spec, s, NOW).state
    const r = onTimeout(spec, afterCancel, NOW)
    expect(r.next).toEqual({ kind: 'place_ioc', price: '100.3', size: '0.7' })
    expect(r.state.phase).toBe('taker')
    expect(r.state.steps.slice(-2)).toEqual([
      { kind: 'cancel' },
      { kind: 'place_ioc', price: '100.3', size: '0.7' },
    ])
  })

  it('卖单方向：挂单价在参考价上方，IOC 下沿在参考价下方', () => {
    const sellSpec: MakerThenMarketSpec = { ...spec, side: 'sell' }
    const startedSell = startMakerThenMarket(sellSpec, NOW).state
    const partial = onFill(sellSpec, startedSell, { size: '0.9', price: '100.05' }, NOW).state
    const r = onTimeout(sellSpec, onTimeout(sellSpec, partial, NOW).state, NOW)
    expect(startedSell.steps[0]).toEqual({ kind: 'place_limit', price: '100.05', size: '1', postOnly: true })
    expect(r.state.steps.at(-1)).toEqual({ kind: 'place_ioc', price: '99.7', size: '0.1' })
  })

  it('撤单等待期间来一笔 0.2：第二次超时的 IOC 量 = 原余量 0.7 − 0.2 = 0.5', () => {
    const s = onFill(spec, started(), { size: '0.3', price: '99.95' }, NOW).state
    const afterCancel = onTimeout(spec, s, NOW).state
    // 撤单已发、确认未回：这时到的成交照常累加（0.3 + 0.2 = 0.5）
    const meantime = onFill(spec, afterCancel, { size: '0.2', price: '99.95' }, NOW).state
    expect(meantime.filled).toBe('0.5')
    const r = onTimeout(spec, meantime, NOW)
    // 余量 = 1 − 0.5 = 0.5，不是撤单前的 0.7
    expect(r.next).toEqual({ kind: 'place_ioc', price: '100.3', size: '0.5' })
    expect(r.state.phase).toBe('taker')
  })

  it('撤单等待期间补满：done/filled，第二次超时不再发 IOC', () => {
    const s = onFill(spec, started(), { size: '0.8', price: '99.95' }, NOW).state
    const afterCancel = onTimeout(spec, s, NOW).state
    const meantime = onFill(spec, afterCancel, { size: '0.2', price: '99.95' }, NOW)
    expect(meantime.state.phase).toBe('done')
    expect(meantime.next).toEqual({ kind: 'done', reason: 'filled' })
    const r = onTimeout(spec, meantime.state, NOW)
    expect(r.next).toEqual({ kind: 'done', reason: 'filled' })
    expect(r.state.steps.some((x) => x.kind === 'place_ioc')).toBe(false)
  })

  it('第二次超时余量 0.005 < minSize 0.01：tail guard，不发尾单', () => {
    const s = onFill(spec, started(), { size: '0.995', price: '99.95' }, NOW).state
    const afterCancel = onTimeout(spec, s, NOW).state
    const r = onTimeout(spec, afterCancel, NOW)
    expect(r.state.phase).toBe('done')
    expect(r.state.steps.slice(-2)).toEqual([
      { kind: 'cancel' },
      { kind: 'done', reason: 'tail_guard' },
    ])
    expect(r.next).toEqual({ kind: 'done', reason: 'tail_guard' })
  })

  it('余量恰好等于 minSize 仍发尾单（边界不吃掉）', () => {
    const s = onFill(spec, started(), { size: '0.99', price: '99.95' }, NOW).state
    const r = onTimeout(spec, onTimeout(spec, s, NOW).state, NOW)
    expect(r.state.phase).toBe('taker')
    expect(r.state.steps.at(-1)).toEqual({ kind: 'place_ioc', price: '100.3', size: '0.01' })
  })

  it('挂单腿已满量：第一次超时直接 done/filled，没有撤单也没有尾单', () => {
    const s = onFill(spec, started(), { size: '1', price: '99.95' }, NOW).state
    const r = onTimeout(spec, s, NOW)
    expect(r.state.phase).toBe('done')
    expect(r.next).toEqual({ kind: 'done', reason: 'filled' })
    expect(r.state.steps.some((x) => x.kind === 'cancel' || x.kind === 'place_ioc')).toBe(false)
  })

  it('taker 阶段超时 = IOC 结束：phase 转 done，追加 done/market_fallback', () => {
    const s = onFill(spec, started(), { size: '0.3', price: '100' }, NOW).state
    const taker = onTimeout(spec, onTimeout(spec, s, NOW).state, NOW).state
    expect(taker.phase).toBe('taker')
    const r = onTimeout(spec, taker, NOW)
    expect(r.state.phase).toBe('done')
    expect(r.next).toEqual({ kind: 'done', reason: 'market_fallback' })
    expect(r.state.steps.at(-1)).toEqual({ kind: 'done', reason: 'market_fallback' })
  })

  it('已结束再超时是空操作，原因按 steps 里的 done 步骤原样返回', () => {
    const done = onFill(spec, started(), { size: '1', price: '100' }, NOW).state
    const r = onTimeout(spec, done, NOW)
    expect(r.state).toBe(done)
    expect(r.next).toEqual({ kind: 'done', reason: 'filled' })
  })

  it('done 后超时原因：tail_guard 原样返回', () => {
    const done = startMakerThenMarket({ ...spec, size: '0.005' }, NOW).state
    expect(done.steps).toEqual([{ kind: 'done', reason: 'tail_guard' }])
    const r = onTimeout(spec, done, NOW)
    expect(r.state).toBe(done)
    expect(r.next).toEqual({ kind: 'done', reason: 'tail_guard' })
  })

  it('done 后超时原因：market_fallback 原样返回', () => {
    const s = onFill(spec, started(), { size: '0.3', price: '100' }, NOW).state
    const taker = onTimeout(spec, onTimeout(spec, s, NOW).state, NOW).state
    const done = onTimeout(spec, taker, NOW).state
    const r = onTimeout(spec, done, NOW)
    expect(r.next).toEqual({ kind: 'done', reason: 'market_fallback' })
  })
})

describe('全程', () => {
  it('挂 99.95 → 成交 0.3 → 超时撤单 → IOC 0.7 成交 → done/market_fallback', () => {
    const start = startMakerThenMarket(spec, NOW)
    expect(start.next).toEqual({ kind: 'place_limit', price: '99.95', size: '1', postOnly: true })

    const partial = onFill(spec, start.state, { size: '0.3', price: '99.95' }, NOW + 300)
    expect(partial.state.filled).toBe('0.3')
    expect(partial.next).toBeUndefined()

    const cancelStep = onTimeout(spec, partial.state, NOW + 1500)
    expect(cancelStep.next).toEqual({ kind: 'cancel' })
    expect(cancelStep.state.phase).toBe('maker')

    // 撤单确认后再调一次，才按确认后的余量排 IOC
    const timeout = onTimeout(spec, cancelStep.state, NOW + 1600)
    expect(timeout.next).toEqual({ kind: 'place_ioc', price: '100.3', size: '0.7' })
    expect(timeout.state.phase).toBe('taker')

    const tail = onFill(spec, timeout.state, { size: '0.7', price: '100.3', fee: '0.07', feeCurrency: 'USDT' }, NOW + 1700)
    expect(tail.state.phase).toBe('done')
    expect(tail.next).toEqual({ kind: 'done', reason: 'market_fallback' })
    expect(tail.state.filled).toBe('1')
    // 0.3 × 99.95 = 29.985；0.7 × 100.3 = 70.21；合计 100.195
    expect(tail.state.notional).toBe('100.195')
    expect(tail.state.steps.map((s) => s.kind)).toEqual([
      'place_limit',
      'wait',
      'cancel',
      'place_ioc',
      'done',
    ])
    expect(tail.state.fees).toEqual({ USDT: '0.07' })
  })
})
