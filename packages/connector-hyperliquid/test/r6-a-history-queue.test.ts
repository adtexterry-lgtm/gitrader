// SPDX-License-Identifier: CPAL-1.0
// R1-PERF-01：等预算排队的时间不计入单页 K 线请求的 10 s 超时——排队超过 10 s，K 线请求仍然成功；
// 排队本身仍有上限（不会无限挂起）。预算用可手动放行的替身，AbortSignal.timeout 换成可手动触发的信号，不依赖真实时间。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '@gitrader/protocol'
import type { RateBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import { FX_NOW, FakeHl } from './helpers/fake-hl'

interface Timer { ms: number; ctl: AbortController }

/** 可手动放行的预算：hold 为真时 acquire 排队，认 signal（与真预算一致：signal 触发即以其 reason 拒绝）。 */
function heldBudget() {
  const state = { hold: false, waiting: [] as Array<() => void> }
  const budget: RateBudget = {
    acquire(_w, o = {}) {
      if (!state.hold) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(o.signal!.reason instanceof Error ? o.signal!.reason : new Error('aborted'))
        if (o.signal?.aborted) return onAbort()
        o.signal?.addEventListener('abort', onAbort, { once: true })
        state.waiting.push(() => { o.signal?.removeEventListener('abort', onAbort); resolve() })
      })
    },
    charge() {},
    penalize() {},
    reportOk() {},
    usage: () => ({ used: 0, target: 720, limit: 1200, ratio: 0, windowMs: 60_000, backoffUntil: 0, byKind: { trade: 0, query: 0, background: 0 } }),
  }
  const release = () => { for (const f of state.waiting.splice(0)) f() }
  return { state, budget, release }
}

function setup() {
  const timers: Timer[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const ctl = new AbortController()
    timers.push({ ms, ctl })
    return ctl.signal
  })
  const hb = heldBudget()
  const hl = new FakeHl()
  const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => FX_NOW, budget: hb.budget })
  return { timers, hb, hl, c }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
const fire = (timers: Timer[], pick: (t: Timer) => boolean): void => { for (const t of timers) if (pick(t) && !t.ctl.signal.aborted) t.ctl.abort(new DOMException('timeout', 'TimeoutError')) }

afterEach(() => { vi.restoreAllMocks() })

describe('R1-PERF-01 K 线请求：排队不计超时', () => {
  it('最近 n 根：排队「超过 10 s」后拿到预算，请求照常成功；10 s 的请求计时在放行之后才开始', async () => {
    const { timers, hb, c } = setup()
    await c.market.refreshInstruments()
    timers.length = 0
    hb.state.hold = true
    const p = c.candles('hyperliquid:BTC', '1m', { n: 20 })
    await flush()
    expect(hb.state.waiting).toHaveLength(1) // 正在排队
    expect(timers.some((t) => t.ms === 10_000)).toBe(false) // 请求超时还没开始计
    fire(timers, (t) => t.ms <= 10_000) // 「过了 10 s」
    await flush()
    hb.state.hold = false
    hb.release()
    const out = (await p) as Candle[]
    expect(out.length).toBeGreaterThan(0)
    expect(timers.some((t) => t.ms === 10_000)).toBe(true) // 放行之后才建的请求计时
  })

  it('区间翻页：每一页都是这样——排队超过 10 s 不影响整次区间请求', async () => {
    const { timers, hb, hl, c } = setup()
    await c.market.refreshInstruments()
    const step = 60_000
    hl.info.set('candleSnapshot', (b) => {
      const r = b.req
      const out = []
      for (let t = Math.ceil(r.startTime / step) * step; t <= r.endTime && out.length < 500; t += step) out.push({ t, T: t + step - 1, s: 'BTC', i: '1m', o: '1', c: '1', h: '1', l: '1', v: '1', n: 1 })
      return out
    })
    timers.length = 0
    hb.state.hold = true
    let out: Candle[] | undefined
    void c.candles('hyperliquid:BTC', '1m', { from: FX_NOW - 700 * step, to: FX_NOW }).then((r) => { out = r })
    let pages = 0
    for (let guard = 0; guard < 50 && out === undefined; guard++) {
      await tick()
      if (hb.state.waiting.length === 0) continue
      pages++
      fire(timers, (t) => t.ms <= 10_000) // 每页都先「排队超过 10 s」
      await flush()
      hb.release()
    }
    expect(pages).toBe(2) // 500 + 200 左右两页，每页各排了一次队
    expect(out).toHaveLength(Math.floor(FX_NOW / step) - Math.ceil((FX_NOW - 700 * step) / step) + 1)
  })

  it('排队本身仍有上限：到了排队上限就以错误结束，不无限挂起', async () => {
    const { timers, hb, c } = setup()
    await c.market.refreshInstruments()
    timers.length = 0
    hb.state.hold = true
    const settled = c.candles('hyperliquid:BTC', '1m', { n: 20 }).then(() => 'resolved', () => 'rejected')
    await flush()
    const queueLimit = timers.find((t) => t.ms > 10_000)
    expect(queueLimit).toBeDefined()
    expect(queueLimit!.ms).toBeGreaterThanOrEqual(60_000)
    fire(timers, (t) => t.ms > 10_000)
    expect(await settled).toBe('rejected')
  })
})
