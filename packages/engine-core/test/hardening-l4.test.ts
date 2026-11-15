// SPDX-License-Identifier: CPAL-1.0
// 批 10 / R2-L4：引擎层数值与协议边界的回归（FINDINGS-L4 的 L4-02 / L4-03 / L4-04 / L4-06 / L4-08）。
// 每条都带反证：合法输入必须照旧，非法输入必须显式报错（G18），不许静默产出 NaN / Infinity。
import { afterEach, describe, expect, it } from 'vitest'
import { mk, up } from './helpers'
import { rig, BTC, type Rig } from './harness'
import { T0 } from '../../protocol/conformance/host-sim'
import { simulateSeries } from '../src/strategy/backtest'
import { Simulator } from '../src/strategy/simulator'
import { emaSeries, priorExtreme, rollingMeanStd } from '../src/strategy/indicators'
import { normalizeLot } from '../src/util/decimal'
import { stableStringify } from '../src/util/hash'
import { MAX_BATCH_MEMBERS, RpcPeer } from '../src/gep/peer'
import { checkEventSequence, type GepEvent } from '../src/proto'

const candles = mk(up(8))

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

const series = (target: number[], warmup = 0) => ({
  target,
  reasons: target.map(() => ''),
  overlays: {},
  warmup,
})

describe('L4-02：非有限 target 显式报错，绝不让 Infinity / NaN 进账本', () => {
  it('target = Infinity → RangeError（以前 size/fee 写成 Infinity、权益写成 NaN）', () => {
    const t = [0, Infinity, 0, 0, 0, 0, 0, 0]
    expect(() => simulateSeries(series(t), candles)).toThrow(/not a finite number/)
  })

  it('target = NaN → RangeError（以前 Math.abs(NaN - applied) > EPS 恒假，静默 0 成交）', () => {
    const t = [0, NaN, 0, 0, 0, 0, 0, 0]
    expect(() => simulateSeries(series(t), candles)).toThrow(/not a finite number/)
  })

  it('target = 1e308 → RangeError（有限但越出 [-1, 1]，以前溢出成 Infinity）', () => {
    const t = [0, 1e308, 0, 0, 0, 0, 0, 0]
    expect(() => simulateSeries(series(t), candles)).toThrow(/outside \[-1, 1\]/)
  })

  it('target 长度与 K 线数不一致 → RangeError（缺一个目标以前被当成"不调仓"）', () => {
    expect(() => simulateSeries(series([0, 0, 0]), candles)).toThrow(/entries but there are 8 candles/)
  })

  it('Simulator.onBar 直接收到非有限 want 也报错（绕开 simulateSeries 的路径）', () => {
    const sim = new Simulator({ initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0 })
    expect(() => sim.onBar(0, candles[0]!, Infinity, 'x')).toThrow(/not a finite number/)
    expect(() => sim.onBar(0, candles[0]!, NaN, 'x')).toThrow(/not a finite number/)
  })

  it('normalizeLot 对非有限数量抛 RangeError（算不出就报错，不再静默给 0）', () => {
    expect(() => normalizeLot(Infinity, 0.1)).toThrow(RangeError)
    expect(() => normalizeLot(-Infinity, 0.1)).toThrow(RangeError)
    expect(() => normalizeLot(NaN, 0.1)).toThrow(/not a finite number/)
    // 反证：有限数量的既有口径不变
    expect(normalizeLot(0.30000000000000004, 0.1)).toBe(0.3)
    expect(normalizeLot(0.29, 0.1)).toBe(0.2)
  })

  it('权益一旦不是有限值就报错，而不是推一根 NaN 进 equity', () => {
    const sim = new Simulator({ initialCash: 1e308, leverage: 1e300, feeRate: 0, slippageBps: 0 })
    expect(() => sim.onBar(0, candles[0]!, 1, 'x')).toThrow(/equity at bar 0 is not a finite number/)
  })

  it('反证：合法序列的统计量全部有限，且与不设闸时一致', () => {
    const t = [0, 1, 1, 0, -1, 0, 0, 0]
    const out = simulateSeries(series(t), candles)
    for (const [k, v] of Object.entries(out.stats)) {
      if (typeof v === 'number') expect(Number.isFinite(v), `${k} = ${v}`).toBe(true)
    }
    expect(out.trades.length).toBeGreaterThan(0)
    expect(out.stats.fills).toBe(out.trades.length)
    for (const tr of out.trades) {
      expect(Number.isFinite(tr.size)).toBe(true)
      expect(Number.isFinite(tr.fee)).toBe(true)
      expect(Number.isFinite(tr.pnl)).toBe(true)
    }
  })
})

describe('L4-02：年化算不出不是 0（stats.annualizedRatio 报 0 时必须有 warning）', () => {
  const ANNUALIZED_WARNING = 'annualizedRatio is reported as 0: annualising a window shorter than a day does not give a finite number (stats.spanDays is the window actually simulated)'
  const spec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    subject: { strategy: { id: 'ema-trend', version: '0.1.0', params: { fast: 5, slow: 20 } } },
    instruments: [BTC], interval: '1m', from: T0, to: T0 + 2000 * 60_000,
    data: { source: 'host' }, account: { initialBalance: '10000', ccy: 'USDC', leverage: 1 },
    assumptions: { fees: { maker: '0.00015', taker: '0.00045' }, slippageBps: 2, fillModel: 'next-bar-open', funding: false, liquidation: false },
    seed: 42, ...over,
  })
  const runJob = async (s: Record<string, unknown>): Promise<any> => {
    const { jobId } = await r!.session.call<{ jobId: string }>('backtest.run', { spec: s })
    for (let i = 0; i < 400; i++) {
      const st = await r!.session.call<{ state: string }>('backtest.status', { jobId })
      if (st.state === 'done') return r!.session.call('backtest.result', { jobId })
      if (st.state === 'failed' || st.state === 'cancelled') throw new Error(`job ${st.state}`)
      await new Promise((res) => setTimeout(res, 20))
    }
    throw new Error('job timeout')
  }

  it('3 根 1 ms K 线的模拟：Simulator 记下 annualizedUnavailable，annualizedRatio 报 0', () => {
    const bars = mk([100, 101, 102], 1)
    const sim = new Simulator({ initialCash: 10_000, leverage: 1, feeRate: 0, slippageBps: 0 })
    for (let i = 0; i < bars.length; i++) sim.onBar(i, bars[i]!, i === 0 ? null : 1, '')
    expect(sim.annualizedUnavailable).toBe(false) // stats() 之前还没算，不能先报
    const stats = sim.stats(bars, 1)
    expect(stats.annualizedRatio).toBe(0)
    expect(sim.annualizedUnavailable).toBe(true)
  })

  it('短于一天的窗口（30 根 1m）：作业结果 warnings 含该句、stats.annualizedRatio === 0', async () => {
    r = await rig()
    const result = await runJob(spec({ from: T0, to: T0 + 30 * 60_000, account: { initialBalance: '10000', ccy: 'USDC', leverage: 50 } }))
    expect(result.stats.annualizedRatio).toBe(0)
    expect(result.warnings).toContain(ANNUALIZED_WARNING)
  })

  it('反证：正常多日窗口不含该句', async () => {
    r = await rig()
    const result = await runJob(spec())
    expect(result.warnings).not.toContain(ANNUALIZED_WARNING)
  })
})

describe('L4-03：batch 有成员上限（响应体积随成员数线性放大）', () => {
  const peer = (sent: string[], maxFrameBytes = 1 << 20) => new RpcPeer({
    send: (text) => { sent.push(text) },
    maxFrameBytes,
    handle: () => ({ ok: true }),
    onNotify: () => {},
  })

  it('空数组 batch 回一帧 INVALID_REQUEST（与 Python 引擎同形）', async () => {
    const sent: string[] = []
    const p = peer(sent)
    await p.receive('[]')
    expect(sent).toHaveLength(1)
    const frame = JSON.parse(sent[0]!)
    expect(frame.id).toBeNull()
    expect(frame.error.data.name).toBe('INVALID_REQUEST')
    expect(frame.error.message).toBe('empty batch')
  })

  it('超过上限的批量整帧 INVALID_REQUEST，一条都不执行', async () => {
    const sent: string[] = []
    let handled = 0
    const p = new RpcPeer({ send: (t) => { sent.push(t) }, maxFrameBytes: 4 << 20, handle: () => { handled += 1; return { ok: true } }, onNotify: () => {} })
    const batch = Array.from({ length: MAX_BATCH_MEMBERS + 1 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'engine.health' }))
    await p.receive(JSON.stringify(batch))
    expect(handled).toBe(0)
    expect(sent).toHaveLength(1)
    const frame = JSON.parse(sent[0]!)
    expect(frame.id).toBeNull()
    expect(frame.error.data.name).toBe('INVALID_REQUEST')
    expect(frame.error.message).toContain(String(MAX_BATCH_MEMBERS))
  })

  it('反证：正好等于上限的批量逐条执行并回一个数组', async () => {
    const sent: string[] = []
    const p = peer(sent)
    const batch = Array.from({ length: MAX_BATCH_MEMBERS }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'engine.health' }))
    await p.receive(JSON.stringify(batch))
    expect(sent).toHaveLength(1)
    const answers = JSON.parse(sent[0]!)
    expect(Array.isArray(answers)).toBe(true)
    expect(answers).toHaveLength(MAX_BATCH_MEMBERS)
    expect(answers[0].id).toBe(1)
  })
})

describe('L4-04：checkEventSequence 对畸形事件返回问题列表，不抛 TypeError', () => {
  const good = (seq: number, id: string): GepEvent => ({ seq, eventId: id, stream: 'order', type: 'order.created', ts: 1, data: {} })

  it('null / 缺字段 / 错类型的事件都只记 problem', () => {
    const bad = [
      null,
      { seq: 2, stream: 'order', type: null, ts: 1, data: {} },
      { seq: 'x', eventId: 5, stream: 7, type: 9, ts: 1, data: {} },
      undefined,
      [],
    ]
    const problems = checkEventSequence(bad as unknown[])
    expect(problems.length).toBeGreaterThanOrEqual(5)
    expect(problems.join('\n')).toMatch(/event\[0\] is not an object/)
    expect(problems.join('\n')).toMatch(/event\[1\]: .*type is not a string/)
    expect(problems.join('\n')).toMatch(/event\[2\]: seq is not a finite number/)
  })

  it('非数组输入也返回问题而不是抛', () => {
    expect(checkEventSequence(null as unknown as unknown[])).toEqual(['events is not an array'])
  })

  it('反证：形状合格的事件序列照旧通过，重复 seq / eventId / 错 stream 仍被判定', () => {
    expect(checkEventSequence([good(1, 'a'), good(2, 'b')])).toEqual([])
    expect(checkEventSequence([good(1, 'a'), good(1, 'b')]).length).toBe(1)
    expect(checkEventSequence([good(1, 'a'), good(2, 'a')]).join()).toContain('duplicate eventId')
    expect(checkEventSequence([{ ...good(1, 'a'), type: 'fill.created' }]).join()).toContain('does not belong')
    expect(checkEventSequence([good(5, 'a')], 5).length).toBe(1)
  })
})

describe('L4-06：rollingMeanStd / priorExtreme 与 emaSeries 同口径（非法窗口 → 全 null）', () => {
  const values = [10, 11, 12, 11.5, 13]

  it('period = 0 不再除零出 NaN', () => {
    const { mean, std } = rollingMeanStd(values, 0)
    expect(mean).toEqual([null, null, null, null, null])
    expect(std).toEqual([null, null, null, null, null])
    expect(priorExtreme(values, 0, 'max')).toEqual([null, null, null, null, null])
  })

  it('period 非整数 / 负数 / NaN / Infinity / 越界大数一律全 null', () => {
    for (const p of [-1, -5, 2.5, NaN, Infinity, 1e308]) {
      const { mean, std } = rollingMeanStd(values, p)
      expect(mean.every((x) => x === null), `period=${p}`).toBe(true)
      expect(std.every((x) => x === null), `period=${p}`).toBe(true)
      expect(priorExtreme(values, p, 'min').every((x) => x === null), `period=${p}`).toBe(true)
    }
    expect(emaSeries(values, 0).every((x) => x === null)).toBe(true)
  })

  it('反证：period = 1 / 3 的既有数值不变', () => {
    expect(rollingMeanStd(values, 1).mean).toEqual(values)
    const { mean, std } = rollingMeanStd(values, 3)
    expect(mean[2]).toBeCloseTo(11, 12)
    expect(std[2]).toBeCloseTo(Math.sqrt(2 / 3), 12)
    expect(mean[1]).toBeNull()
    expect(priorExtreme(values, 2, 'max')).toEqual([null, null, 11, 12, 12])
  })
})

describe('L4-08：stableStringify 区分 NaN / ±Infinity / null / -0（摘要不再碰撞）', () => {
  it('四种非有限/空值得到四个不同文本与四个不同摘要', () => {
    const texts = [NaN, Infinity, -Infinity, null].map((x) => stableStringify({ x }))
    expect(new Set(texts).size).toBe(4)
    expect(texts[0]).toBe('{"x":{"$num":"NaN"}}')
    expect(texts[1]).toBe('{"x":{"$num":"+Inf"}}')
    expect(texts[2]).toBe('{"x":{"$num":"-Inf"}}')
    expect(texts[3]).toBe('{"x":null}')
  })

  it('0 与 -0 可区分，且 -0 仍是合法 JSON 数字文本', () => {
    expect(stableStringify({ x: 0 })).toBe('{"x":0}')
    expect(stableStringify({ x: -0 })).toBe('{"x":-0}')
    expect(() => JSON.parse(stableStringify({ x: -0 }))).not.toThrow()
  })

  it('反证：普通对象/数组仍然键排序、确定性、与 JSON 语义一致', () => {
    expect(stableStringify({ b: 1, a: [2, 3], c: undefined })).toBe('{"a":[2,3],"b":1}')
    expect(stableStringify({ a: 1, b: 'x' })).toBe(stableStringify({ b: 'x', a: 1 }))
    expect(JSON.parse(stableStringify({ a: [1, 2.5], b: 'x', c: true, d: null }))).toEqual({ a: [1, 2.5], b: 'x', c: true, d: null })
  })
})
