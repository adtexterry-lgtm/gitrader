// SPDX-License-Identifier: CPAL-1.0
// 行情：多 dex 动态发现（离线 dex 自动剔除）、陈旧标记、WS 订阅引用计数、REST 兜底、历史 K 线翻页与录制器、权重预算占用、端点切换。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Candle, CandleInterval } from '@gitrader/protocol'
import { createWeightBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import type { HyperliquidConnectorOptions } from '../src/connector'
import type { VenueEvent } from '@gitrader/protocol/connector'
import { FX_NOW, FakeHl, FakeWS, FakeWebSocket, loadFixture } from './helpers/fake-hl'

function make(over: Partial<HyperliquidConnectorOptions> = {}) {
  const hl = new FakeHl()
  const t = { now: FX_NOW }
  const c = new HyperliquidConnector({
    environment: 'mainnet', fetchImpl: hl.fetch, useWs: false, discoveryIntervalMs: 0, clock: () => t.now, ...over,
  })
  return { hl, t, c }
}
afterEach(() => { vi.useRealTimers(); FakeWebSocket.reset() })

describe('multi-dex discovery', () => {
  it('lists live markets from every live dex and hides delisted ones and dead dexes', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    const ids = c.listInstruments().map((i) => i.instrumentId)
    expect(ids).toContain('hyperliquid:BTC')
    expect(ids).toContain('hyperliquid:xyz:TSLA')
    expect(ids).not.toContain('hyperliquid:xyz:OLDCO1') // 已下架
    expect(ids.some((x) => x.startsWith('hyperliquid:flx:'))).toBe(false) // 整个 dex 已关停
    expect(c.listInstruments({ includeDelisted: true }).map((i) => i.instrumentId)).toContain('hyperliquid:xyz:OLDCO1')
    const status = Object.fromEntries(c.market.dexStatus().map((d) => [d.dex, d.status]))
    expect(status).toMatchObject({ '': 'live', xyz: 'live', io: 'live', para: 'live', mkts: 'live', flx: 'delisted' })
    // 1 次 perpDexs + 6 次 metaAndAssetCtxs（含默认 dex），每次权重 20
    expect(hl.infoCalls().length).toBe(7)
    expect(c.budget.usage().used).toBe(140)
    expect(c.budget.usage().byKind).toEqual({ trade: 0, query: 0, background: 140 }) // 发现是后台任务，不占用户查询和交易的配额
  })

  it('instrument shape follows the contract: precision from the venue, HIP-3 flagged as synthetic', async () => {
    const { c } = make()
    await c.market.refreshInstruments()
    const btc = c.getInstrument('hyperliquid:BTC')!
    expect(btc).toMatchObject({
      venue: 'hyperliquid', symbol: 'BTC', kind: 'perp', quote: 'USDC', settlement: 'linear', venueSizeUnit: 'base', assetClass: 'crypto',
      marketGroup: null, status: 'trading', price: { sigFigs: 5, maxDecimals: 1 }, size: { step: '0.00001', decimals: 5, min: '0.00001' },
      minNotional: '10', fundingIntervalMs: 3_600_000, tif: ['gtc', 'ioc', 'alo'], triggerPriceTypes: ['mark'], fees: { source: 'assumed' },
    })
    const tsla = c.getInstrument('hyperliquid:xyz:TSLA')!
    expect(tsla).toMatchObject({ marketGroup: 'xyz', assetClass: 'stocks', underlying: { synthetic: true } })
    expect(c.getInstrument('hyperliquid:xyz:GOLD')!.assetClass).toBe('metals')
  })

  it('a dex whose meta request fails is dropped; it comes back on a later re-check and an event says so', async () => {
    const { hl, t, c } = make({ offlineRecheckMs: 600_000 })
    hl.failDex.add('io')
    const events: VenueEvent[] = []
    c.subscribe({ channel: 'instruments' }, (e) => events.push(e))
    await c.market.refreshInstruments()
    expect(c.market.dexStatus().find((d) => d.dex === 'io')!.status).toBe('offline')
    expect(c.listInstruments().some((i) => i.marketGroup === 'io')).toBe(false)

    // 还没到复查时间：不会重新请求
    const before = hl.infoCalls('metaAndAssetCtxs').filter((x) => x.body.dex === 'io').length
    t.now += 60_000
    await c.market.refreshInstruments()
    expect(hl.infoCalls('metaAndAssetCtxs').filter((x) => x.body.dex === 'io').length).toBe(before)

    hl.failDex.delete('io')
    t.now += 600_000
    await c.market.refreshInstruments()
    expect(c.listInstruments().some((i) => i.marketGroup === 'io')).toBe(true)
    const added = events.flatMap((e) => (e.channel === 'instruments' ? e.added : []))
    expect(added.some((x) => x.startsWith('hyperliquid:io:'))).toBe(true)
  })

  it('a dex that disappears from perpDexs is removed together with its quotes', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    expect(c.quote('hyperliquid:para:' + c.listInstruments().find((i) => i.marketGroup === 'para')!.base)).toBeDefined()
    const events: VenueEvent[] = []
    c.subscribe({ channel: 'instruments' }, (e) => events.push(e))
    const dexs = loadFixture<any[]>('perpDexs.json').filter((d) => d?.name !== 'para')
    hl.info.set('perpDexs', () => dexs)
    await c.market.refreshInstruments()
    expect(c.listInstruments().some((i) => i.marketGroup === 'para')).toBe(false)
    const removed = events.flatMap((e) => (e.channel === 'instruments' ? e.removed : []))
    expect(removed.length).toBeGreaterThan(0)
    expect(removed.every((x) => x.startsWith('hyperliquid:para:'))).toBe(true)
  })

  it('if perpDexs itself fails, the default dex is still usable and the reason is kept', async () => {
    const { hl, c } = make()
    hl.info.set('perpDexs', () => new Response('boom', { status: 500 }))
    await c.market.refreshInstruments()
    expect(c.listInstruments().some((i) => i.instrumentId === 'hyperliquid:BTC')).toBe(true)
    expect(c.market.discoveryError).toContain('HTTP 500')
  })
})

describe('staleness', () => {
  it('quote and status are marked stale once nothing has arrived for staleMs (no silent old prices)', async () => {
    const { t, c } = make({ staleMs: 10_000 })
    await c.market.refreshInstruments()
    const fresh = c.quote('hyperliquid:BTC')!
    expect(fresh).toMatchObject({ stale: false, ageMs: 0 })
    t.now += 9_000
    expect(c.quote('hyperliquid:BTC')!.stale).toBe(false)
    t.now += 2_000
    const old = c.quote('hyperliquid:BTC')!
    expect(old.stale).toBe(true)
    expect(old.ageMs).toBe(11_000)
    expect(old.bid).toBe(old.ask) // 只有中间价时不假装有买卖价差
    expect(c.status().stale).toBe(true)
  })

  it('a bbo push gives a real bid/ask and resets the age; it goes stale again after staleMs', async () => {
    const { t, c } = make({ WebSocketImpl: FakeWS, useWs: true, staleMs: 5_000 })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    ws.push({ channel: 'bbo', data: { coin: 'BTC', time: t.now, bbo: [{ px: '80000.0', sz: '1', n: 1 }, { px: '80001.0', sz: '2', n: 1 }] } })
    const q = c.quote('hyperliquid:BTC')!
    expect(q).toMatchObject({ bid: 80000, ask: 80001, stale: false })
    expect(c.status()).toMatchObject({ wsState: 'connected', source: 'ws', stale: false })
    t.now += 6_000
    expect(c.quote('hyperliquid:BTC')!.stale).toBe(true)
    expect(c.status().stale).toBe(true)
    await c.close()
  })
})

describe('venue mark price', () => {
  const markId = 'hyperliquid:BTC'
  it('pins the first known mark read to an activeAssetCtx stream without awaiting discovery', async () => {
    const { hl, t, c } = make({ WebSocketImpl: FakeWS, useWs: true })
    await c.market.refreshInstruments()
    expect(c.mark(markId)).toBeDefined()
    const ws = FakeWebSocket.last
    ws.open()
    expect(ws.subs().map((s) => JSON.stringify(s))).toContain(JSON.stringify({ type: 'activeAssetCtx', coin: 'BTC' }))
    const before = hl.infoCalls('metaAndAssetCtxs').length
    const unsub = c.subscribe({ channel: 'quote', instrumentId: markId }, () => {})
    unsub()
    expect(ws.unsubs().map((s) => JSON.stringify(s))).not.toContain(JSON.stringify({ type: 'activeAssetCtx', coin: 'BTC' }))
    t.now += 10_001
    expect(c.mark(markId)).toBeUndefined()
    await c.close()
    expect(before).toBe(6)
  })

  it('uses only raw positive markPx on REST and WS context updates', async () => {
    const { hl, t, c } = make({ WebSocketImpl: FakeWS, useWs: true })
    hl.info.set('metaAndAssetCtxs', (body) => {
      const file = body.dex ? `metaAndAssetCtxs-${body.dex}.json` : 'metaAndAssetCtxs.json'
      const data = structuredClone(loadFixture<any[]>(file))
      if (!body.dex) data[1][0] = { ...data[1][0], markPx: '81000.25', midPx: '80000.5' }
      return data
    })
    await c.market.start()
    expect((c as any).mark(markId)).toEqual({ price: '81000.25', ts: t.now, source: 'venue_mark' })

    const ws = FakeWebSocket.last
    ws.open()
    c.subscribe({ channel: 'context', instrumentId: markId }, () => {})
    t.now += 25
    ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '81234.125', midPx: '81000' } } })
    expect((c as any).mark(markId)).toEqual({ price: '81234.125', ts: t.now, source: 'venue_mark' })

    t.now += 25
    ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '0', midPx: '79999' } } })
    expect((c as any).mark(markId)).toBeUndefined()
    await c.close()
  })

  it('expires cached mark at the configured threshold even when allMids stays fresh', async () => {
    const { t, c } = make({ WebSocketImpl: FakeWS, useWs: true, markStaleMs: 5_000 })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(c.mark(markId)).toBeDefined()
    t.now += 5_000
    expect(c.mark(markId)).toBeDefined()
    ws.push({ channel: 'allMids', data: { mids: { BTC: '83000' } } })
    t.now += 1
    expect(c.mark(markId)).toBeUndefined()
    await c.close()
  })

  it('defaults mark staleness to five seconds', async () => {
    const { t, c } = make()
    await c.market.refreshInstruments()
    t.now += 5_001
    expect(c.mark(markId)).toBeUndefined()
    await c.close()
  })

  it('refreshes tracked marks once per dex and never refreshes unknown or delisted ids', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(c.mark('hyperliquid:BTC')).toBeDefined()
    expect(c.mark('hyperliquid:ETH')).toBeDefined()
    expect(c.mark('hyperliquid:xyz:TSLA')).toBeDefined()
    const before = hl.infoCalls('metaAndAssetCtxs').length
    expect(c.mark('hyperliquid:unknown')).toBeUndefined()
    expect(c.mark('hyperliquid:xyz:OLDCO1')).toBeUndefined()
    const subsBeforeUnknown = ws.subs().map((sub) => JSON.stringify(sub))
    const stopUnknown = c.subscribe({ channel: 'quote', instrumentId: 'hyperliquid:unknown' }, () => {})
    stopUnknown()
    expect(ws.subs().map((sub) => JSON.stringify(sub))).toEqual(subsBeforeUnknown)
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.waitFor(() => expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(before + 2))
    const refreshes = hl.infoCalls('metaAndAssetCtxs').slice(before).map((call) => call.body.dex ?? '')
    expect(refreshes.sort()).toEqual(['', 'xyz'])
    await c.close()
  })

  it.each([
    ['default mark staleness', undefined, 2_500],
    ['custom mark staleness', 8_000, 4_000],
  ] as const)('uses half the %s threshold as the automatic refresh period', async (_label, markStaleMs, periodMs) => {
    vi.useFakeTimers({ now: FX_NOW })
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true, ...(markStaleMs === undefined ? {} : { markStaleMs }), clock: () => Date.now() })
    await c.market.start()
    FakeWebSocket.last.open()
    expect(c.mark(markId)).toBeDefined()
    const before = hl.infoCalls('metaAndAssetCtxs').length
    await vi.advanceTimersByTimeAsync(periodMs - 1)
    expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(before + 1))
    await c.close()
  })

  it('keeps mark reads available and falls back to REST when the implicit context subscription hits the cap', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const warnings: string[] = []
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true, maxSubscriptions: 5, onWarn: (message) => warnings.push(message) })
    await c.market.start()
    FakeWebSocket.last.open()
    expect(c.mark(markId)).toBeDefined()
    expect(warnings).toContain('持续标记价格订阅达到上限；保留 REST 刷新')
    const before = hl.infoCalls('metaAndAssetCtxs').length
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(hl.infoCalls('metaAndAssetCtxs').length).toBeGreaterThan(before))
    await c.close()
  })

  it('keeps marks fresh through active pushes and uses fallback only after that stream goes quiet', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true, clock: () => Date.now() })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(c.mark(markId)).toBeDefined()
    let pending = false
    let release!: () => void
    let notifyStarted!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const before = hl.infoCalls('metaAndAssetCtxs').length
    hl.info.set('metaAndAssetCtxs', async (body) => {
      if ((body.dex ?? '') !== '') return loadFixture(`metaAndAssetCtxs-${body.dex}.json`)
      if (pending) {
        notifyStarted()
        await held
        const raw = structuredClone(loadFixture<any[]>('metaAndAssetCtxs.json'))
        raw[1][0] = { ...raw[1][0], markPx: '82000' }
        return raw
      }
      return loadFixture('metaAndAssetCtxs.json')
    })
    try {
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(2_000)
        ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: String(81_000 + i), midPx: String(80_900 + i) } } })
        expect(c.mark(markId)).toBeDefined()
      }
      expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(before)
      pending = true
      await vi.advanceTimersByTimeAsync(2_500)
      await started
      await vi.advanceTimersByTimeAsync(2_500)
      expect(c.mark(markId)).toBeDefined() // age 恰为默认 5 s，阈值边界仍有效
      await vi.advanceTimersByTimeAsync(2_501)
      expect(c.mark(markId)).toBeUndefined()
      release()
      await vi.waitFor(() => expect(c.mark(markId)?.price).toBe('82000'))
    } finally {
      release()
      await c.close()
    }
  })

  it('recovers a stale mark within one refresh period plus REST latency after a failed attempt', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true, clock: () => Date.now() })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(c.mark(markId)).toBeDefined()
    await vi.advanceTimersByTimeAsync(1_000)
    ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '81001', midPx: '80999' } } })
    let calls = 0
    hl.info.set('metaAndAssetCtxs', async (body) => {
      if ((body.dex ?? '') !== '') return loadFixture(`metaAndAssetCtxs-${body.dex}.json`)
      calls++
      if (calls === 1) return new Response('failure', { status: 500 })
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      const raw = structuredClone(loadFixture<any[]>('metaAndAssetCtxs.json'))
      raw[1][0] = { ...raw[1][0], markPx: '82000' }
      return raw
    })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(c.mark(markId)).toBeDefined()
    await vi.advanceTimersByTimeAsync(1_001)
    expect(c.mark(markId)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(999)
    expect(c.mark(markId)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(800)
    expect(c.mark(markId)?.price).toBe('82000')
    await c.close()
  })

  it('limits repeated background refresh warnings by object and message category to ten minutes', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const warnings: string[] = []
    const budget = createWeightBudget({ limit: 100_000, targetRatio: 1, backgroundShare: 1, clock: () => Date.now() })
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true, clock: () => Date.now(), budget, onWarn: (message) => warnings.push(message) })
    await c.market.start()
    FakeWebSocket.last.open()
    expect(c.mark(markId)).toBeDefined()
    const before = warnings.length
    hl.info.set('metaAndAssetCtxs', (body) => body.dex ? loadFixture(`metaAndAssetCtxs-${body.dex}.json`) : new Response('upstream detail', { status: 500 }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(warnings.slice(before)).toEqual(['持续标记价格后台刷新失败；保留缓存并继续重试'])
    await vi.advanceTimersByTimeAsync(592_499)
    expect(warnings.slice(before)).toHaveLength(1) // 距首次 warn 599999 ms
    await vi.advanceTimersByTimeAsync(1)
    expect(warnings.slice(before)).toHaveLength(2) // 首次 warn 后满 600000 ms
    expect(warnings.at(-1)).toBe('持续标记价格后台刷新失败；保留缓存并继续重试')
    await c.close()
  })

  it('keeps one pending per-dex mark refresh across ticks and aborts it on close', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const hl = new FakeHl()
    const t = { now: FX_NOW }
    let requestSignal: AbortSignal | undefined
    const fetchImpl: typeof fetch = (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.type === 'metaAndAssetCtxs' && body.dex === undefined) requestSignal = init?.signal ?? undefined
      return hl.fetch(input, init)
    }
    const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl, WebSocketImpl: FakeWS, useWs: true, discoveryIntervalMs: 0, httpTimeoutMs: 60_000, clock: () => t.now })
    await c.market.start()
    FakeWebSocket.last.open()
    const mark = c.mark(markId)
    expect(mark).toBeDefined()
    let release!: () => void
    let notifyStarted!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    let attempts = 0
    hl.info.set('metaAndAssetCtxs', async () => {
      attempts++
      notifyStarted()
      await pending
      return loadFixture('metaAndAssetCtxs.json')
    })
    try {
      t.now += 5_000
      await vi.advanceTimersByTimeAsync(5_000)
      await started
      t.now += 15_000
      await vi.advanceTimersByTimeAsync(15_000)
      expect(attempts).toBe(1)
      expect(c.mark(markId)).toBeUndefined()
      await c.close()
      expect(requestSignal?.aborted).toBe(true)
      release()
      t.now += 10_000
      await vi.advanceTimersByTimeAsync(10_000)
      expect(c.mark(markId)).toBeUndefined()
      expect(attempts).toBe(1)
    } finally {
      release()
      await c.close()
    }
  })

  it('uses valid activeAssetCtx midPx for quote inputs while keeping markPx distinct', async () => {
    const { c } = make({ WebSocketImpl: FakeWS, useWs: true })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(c.mark(markId)).toBeDefined()
    ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '81010', midPx: '81000' } } })
    expect(c.mark(markId)?.price).toBe('81010')
    expect(c.quote(markId)?.last).toBe(81000)
    await c.close()
  })
})

describe('websocket subscriptions', () => {
  it('subscribes allMids for the default dex and every live dex (not dead ones), with the dex parameter', async () => {
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true })
    hl.failDex.add('io')
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const subs = ws.subs().map((s) => JSON.stringify(s))
    expect(subs).toContain(JSON.stringify({ type: 'allMids' }))
    for (const d of ['xyz', 'para', 'mkts']) expect(subs).toContain(JSON.stringify({ type: 'allMids', dex: d }))
    expect(subs).not.toContain(JSON.stringify({ type: 'allMids', dex: 'io' }))
    expect(subs).not.toContain(JSON.stringify({ type: 'allMids', dex: 'flx' }))
    expect(ws.url).toBe('wss://api.hyperliquid.xyz/ws')
    await c.close()
  })

  it('reference-counts per-instrument subscriptions (HIP-3 names stay prefixed) and unsubscribes at zero', async () => {
    const { c } = make({ WebSocketImpl: FakeWS, useWs: true })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const a = c.subscribe({ channel: 'quote', instrumentId: 'hyperliquid:xyz:TSLA' }, () => {})
    const b = c.subscribe({ channel: 'quote', instrumentId: 'hyperliquid:xyz:TSLA' }, () => {})
    c.subscribe({ channel: 'book', instrumentId: 'hyperliquid:BTC' }, () => {})
    c.subscribe({ channel: 'candle', instrumentId: 'hyperliquid:BTC', interval: '15m' }, () => {})
    c.subscribe({ channel: 'context', instrumentId: 'hyperliquid:BTC' }, () => {})
    const subs = ws.subs().map((s) => JSON.stringify(s))
    expect(subs.filter((s) => s === JSON.stringify({ type: 'bbo', coin: 'xyz:TSLA' }))).toHaveLength(1)
    expect(subs).toContain(JSON.stringify({ type: 'l2Book', coin: 'BTC' }))
    expect(subs).toContain(JSON.stringify({ type: 'candle', coin: 'BTC', interval: '15m' }))
    expect(subs).toContain(JSON.stringify({ type: 'activeAssetCtx', coin: 'BTC' }))
    a()
    expect(ws.unsubs()).toHaveLength(0)
    b()
    const unsubs = ws.unsubs().map((s) => JSON.stringify(s))
    expect(unsubs).toHaveLength(2)
    expect(new Set(unsubs)).toEqual(new Set([
      JSON.stringify({ type: 'bbo', coin: 'xyz:TSLA' }),
      JSON.stringify({ type: 'activeAssetCtx', coin: 'xyz:TSLA' }),
    ]))
    await c.close()
  })

  it('routes pushes to typed events: quote, mids (throttled), book, candle, context', async () => {
    const { t, c } = make({ WebSocketImpl: FakeWS, useWs: true })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const got: VenueEvent[] = []
    c.subscribe({ channel: 'quote', instrumentId: 'hyperliquid:BTC' }, (e) => got.push(e))
    c.subscribe({ channel: 'mids' }, (e) => got.push(e))
    c.subscribe({ channel: 'book', instrumentId: 'hyperliquid:BTC' }, (e) => got.push(e))
    c.subscribe({ channel: 'candle', instrumentId: 'hyperliquid:BTC', interval: '1m' }, (e) => got.push(e))
    c.subscribe({ channel: 'context', instrumentId: 'hyperliquid:BTC' }, (e) => got.push(e))

    ws.push({ channel: 'allMids', data: { mids: { BTC: '81000.5', '@1': '2.0', 'xyz:TSLA': '380.1' } } })
    ws.push({ channel: 'l2Book', data: loadFixture('l2Book-BTC.json') })
    ws.push({ channel: 'candle', data: { t: t.now, T: t.now + 59999, s: 'BTC', i: '1m', o: '1', c: '3', h: '4', l: '0.5', v: '9', n: 2 } })
    ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { funding: '0.0000125', openInterest: '100', markPx: '81010', midPx: '81000.5', oraclePx: '81005', dayNtlVlm: '1', prevDayPx: '80000' } } })

    const mids = got.find((e) => e.channel === 'mids') as Extract<VenueEvent, { channel: 'mids' }>
    expect(mids.mids['hyperliquid:BTC']).toBe(81000.5)
    expect(mids.mids['hyperliquid:xyz:TSLA']).toBe(380.1)
    expect(Object.keys(mids.mids).some((k) => k.includes('@'))).toBe(false) // 现货键被丢弃
    const quote = got.find((e) => e.channel === 'quote') as Extract<VenueEvent, { channel: 'quote' }>
    expect(quote.quote).toMatchObject({ instrumentId: 'hyperliquid:BTC', stale: false })
    const book = got.find((e) => e.channel === 'book') as Extract<VenueEvent, { channel: 'book' }>
    expect(book.book.instrumentId).toBe('hyperliquid:BTC')
    expect(book.book.bids[0]!.price).toBeGreaterThan(book.book.bids[1]!.price)
    expect(book.book.asks[0]!.price).toBeLessThan(book.book.asks[1]!.price)
    const candle = got.find((e) => e.channel === 'candle') as Extract<VenueEvent, { channel: 'candle' }>
    expect(candle.candle).toEqual({ t: t.now, o: 1, h: 4, l: 0.5, c: 3, v: 9 })
    const ctx = got.find((e) => e.channel === 'context') as Extract<VenueEvent, { channel: 'context' }>
    expect(ctx.context).toMatchObject({ markPrice: 81010, fundingRate: 0.0000125, fundingIntervalMs: 3_600_000 })
    expect(c.market.cachedContext('hyperliquid:BTC')!.markPrice).toBe(81010)

    // 4 次/秒节流：250 ms 内的第二条 allMids 不会立刻再发一次 mids 事件
    const n = got.filter((e) => e.channel === 'mids').length
    ws.push({ channel: 'allMids', data: { mids: { BTC: '81001' } } })
    expect(got.filter((e) => e.channel === 'mids').length).toBe(n)
    await c.close()
  })

  it('refuses to exceed the subscription cap', async () => {
    const { c } = make({ WebSocketImpl: FakeWS, useWs: true, maxSubscriptions: 40 })
    await c.market.start()
    const ids = c.listInstruments().slice(0, 100).map((i) => i.instrumentId)
    expect(() => { for (const id of ids) c.subscribe({ channel: 'quote', instrumentId: id }, () => {}) }).toThrow(/subscription limit/)
    await c.close()
  })
})

describe('REST fallback', () => {
  it('without a websocket it polls allMids and reports source=rest', async () => {
    const { hl, c } = make({ pollMs: 10 })
    await c.market.start()
    await vi.waitFor(() => expect(hl.infoCalls('allMids').length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(c.status().source).toBe('rest'))
    expect(c.status().stale).toBe(false)
    await c.close()
  })

  it('after 3 failed websocket connections it falls back to REST polling', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const hl = new FakeHl()
    const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true, discoveryIntervalMs: 0, pollMs: 1000, clock: () => Date.now() })
    await c.market.start()
    FakeWebSocket.last.drop()
    await vi.advanceTimersByTimeAsync(1000)
    FakeWebSocket.last.drop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(hl.infoCalls('allMids')).toHaveLength(0)
    FakeWebSocket.last.drop() // 第 3 次失败
    await vi.advanceTimersByTimeAsync(10)
    expect(hl.infoCalls('allMids').length).toBeGreaterThan(0)
    expect(c.status().source).toBe('rest')
    await c.close()
  })
})

describe('local L2 snapshot (asOf / stale) and bounded REST fallback', () => {
  it('WS l2Book pushes maintain the snapshot; stale after bookStaleMs; refreshBook is rate-limited and returns the fresh snapshot', async () => {
    const { hl, t, c } = make({ WebSocketImpl: FakeWS, useWs: true, bookStaleMs: 5000, bookRefreshMinMs: 2000 })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(c.bookSnapshot('hyperliquid:BTC')).toBeUndefined()
    c.subscribe({ channel: 'book', instrumentId: 'hyperliquid:BTC' }, () => {})
    ws.push({ channel: 'l2Book', data: loadFixture('l2Book-BTC.json') })
    const a = c.bookSnapshot('hyperliquid:BTC')!
    expect(a).toMatchObject({ asOf: FX_NOW, stale: false })
    expect(a.book.bids.length).toBeGreaterThan(5)
    t.now += 6000
    expect(c.bookSnapshot('hyperliquid:BTC')).toMatchObject({ asOf: FX_NOW, stale: true })
    // 兜底：一次 REST，拿到新鲜快照
    const n0 = hl.infoCalls('l2Book').length
    const fresh = await c.refreshBook('hyperliquid:BTC')
    expect(hl.infoCalls('l2Book')).toHaveLength(n0 + 1)
    expect(fresh).toMatchObject({ asOf: t.now, stale: false })
    // 限频：2 s 内不再打；快照又陈旧时原样返回陈旧快照
    t.now += 6000
    await c.refreshBook('hyperliquid:BTC')
    expect(hl.infoCalls('l2Book')).toHaveLength(n0 + 2)
    await c.refreshBook('hyperliquid:BTC')
    expect(hl.infoCalls('l2Book')).toHaveLength(n0 + 2)
    await c.close()
  })

  it('the fallback never queues behind a saturated budget: it gives up after maxWaitMs and returns what it has', async () => {
    const budget = createWeightBudget({ clock: () => FX_NOW })
    const { hl, c } = make({ budget })
    await c.market.refreshInstruments()
    budget.charge(10_000, 'query') // 预算被打满：任何查询都得等一整个窗口
    const t0 = Date.now()
    const s = await c.refreshBook('hyperliquid:BTC', { maxWaitMs: 30 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(s).toBeUndefined()
    expect(hl.infoCalls('l2Book')).toHaveLength(0)
  })
})

describe('book / candles / context', () => {
  it('book falls back to REST l2Book (weight 2), sorted and cut to depth; served from the WS cache when subscribed and fresh', async () => {
    const { hl, c } = make({ WebSocketImpl: FakeWS, useWs: true })
    await c.market.start()
    FakeWebSocket.last.open()
    const rest = await c.book('hyperliquid:BTC', 5)
    expect(rest.bids).toHaveLength(5)
    expect(rest.asks).toHaveLength(5)
    expect(rest.bids[0]!.price).toBeGreaterThan(rest.asks[0]!.price - 100)
    expect(hl.infoCalls('l2Book')).toHaveLength(1)
    c.subscribe({ channel: 'book', instrumentId: 'hyperliquid:BTC' }, () => {})
    FakeWebSocket.last.push({ channel: 'l2Book', data: loadFixture('l2Book-BTC.json') })
    const cached = await c.book('hyperliquid:BTC', 3)
    expect(cached.bids).toHaveLength(3)
    expect(hl.infoCalls('l2Book')).toHaveLength(1) // 没有再走 REST
    await c.close()
  })

  it('candles: latest n via candleSnapshot, ascending, numeric', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    const out = await c.candles('hyperliquid:BTC', '1m', { n: 20 })
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(20)
    for (let i = 1; i < out.length; i++) expect(out[i]!.t).toBeGreaterThan(out[i - 1]!.t)
    expect(typeof out[0]!.o).toBe('number')
    const req = hl.infoCalls('candleSnapshot')[0]!.body.req
    expect(req).toMatchObject({ coin: 'BTC', interval: '1m', endTime: FX_NOW })
    expect(req.startTime).toBe(FX_NOW - 22 * 60_000)
  })

  it('candles: 单次取 K 线带 10 s 超时信号，信号触发即以错误结束（不无限挂起）', async () => {
    const stall = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(stall.signal)
    try {
      const hl = new FakeHl()
      const hang = ((url: string, init?: RequestInit) => (typeof init?.body === 'string' && init.body.includes('candleSnapshot')
        ? new Promise<Response>(() => undefined) // 永不返回的上游
        : hl.fetch(url as never, init as never))) as typeof fetch
      const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl: hang, useWs: false, discoveryIntervalMs: 0, clock: () => FX_NOW })
      await c.market.refreshInstruments()
      const settled = c.candles('hyperliquid:BTC', '1m', { n: 20 }).then(() => 'resolved', () => 'rejected')
      stall.abort(new Error('timeout'))
      expect(await settled).toBe('rejected')
      expect(timeoutSpy).toHaveBeenCalledWith(10_000)
    } finally { timeoutSpy.mockRestore() }
  })

  it('history over a range pages through, hands every page to the recorder, and stays inside the weight budget', async () => {
    const recorded: Array<{ id: string; interval: CandleInterval; n: number }> = []
    const { hl, c } = make({ recorder: { record: (id, interval, candles: Candle[]) => { recorded.push({ id, interval, n: candles.length }) } } })
    await c.market.refreshInstruments()
    const step = 60_000
    const from = FX_NOW - 1300 * step
    hl.info.set('candleSnapshot', (b) => {
      const r = b.req
      const out = []
      for (let t = Math.ceil(r.startTime / step) * step; t <= r.endTime && out.length < 500; t += step) out.push({ t, T: t + step - 1, s: 'BTC', i: '1m', o: '1', c: '1', h: '1', l: '1', v: '1', n: 1 })
      return out
    })
    const before = c.budget.usage().used
    const out = await c.candles('hyperliquid:BTC', '1m', { from, to: FX_NOW })
    expect(out.length).toBe(1300)
    expect(new Set(out.map((x) => x.t)).size).toBe(1300)
    expect(recorded.map((r) => r.n)).toEqual([500, 500, 300])
    expect(recorded.every((r) => r.id === 'hyperliquid:BTC' && r.interval === '1m')).toBe(true)
    // 每页 20 + floor(500/60)=8 ；300 条那页 20 + 5
    expect(c.budget.usage().used - before).toBe(28 + 28 + 25)
  })

  it('context comes from discovery, refreshes after its TTL with one request', async () => {
    const { hl, t, c } = make()
    await c.market.refreshInstruments()
    const n0 = hl.infoCalls('metaAndAssetCtxs').length
    const first = await c.context('hyperliquid:BTC')
    expect(first.fundingIntervalMs).toBe(3_600_000)
    expect(typeof first.fundingRate).toBe('number')
    expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(n0)
    t.now += 25_000
    await c.context('hyperliquid:BTC')
    expect(hl.infoCalls('metaAndAssetCtxs')).toHaveLength(n0 + 1)
    await expect(c.context('hyperliquid:NOPE')).rejects.toThrow(/unknown/)
  })
})

describe('weight budget in the real call path', () => {
  it('700 book requests in a row never put more than 60% of 1200 into any rolling minute', async () => {
    const hl = new FakeHl()
    let now = FX_NOW
    const budget = createWeightBudget({ clock: () => now, sleep: async (ms) => { now += ms } })
    const stamps: number[] = []
    const fetchImpl: typeof fetch = async (input, init) => { stamps.push(now); return hl.fetch(input, init) }
    const c = new HyperliquidConnector({ environment: 'mainnet', fetchImpl, useWs: false, discoveryIntervalMs: 0, clock: () => now, budget })
    for (let i = 0; i < 700; i++) await c.book('hyperliquid:BTC', 5)
    let max = 0
    for (let i = 0; i < stamps.length; i++) {
      const w = stamps.filter((s) => s > stamps[i]! - 60_000 && s <= stamps[i]!).length * 2
      max = Math.max(max, w)
    }
    expect(max).toBeLessThanOrEqual(720)
    expect(max / 1200).toBeLessThanOrEqual(0.6)
    expect(now - FX_NOW).toBeGreaterThan(60_000) // 预算真的让请求慢了下来
  })
})

describe('environment switch', () => {
  it('mainnet and testnet use their own REST and WebSocket endpoints', async () => {
    for (const [env, host] of [['mainnet', 'api.hyperliquid.xyz'], ['testnet', 'api.hyperliquid-testnet.xyz']] as const) {
      FakeWebSocket.reset()
      const hl = new FakeHl()
      const c = new HyperliquidConnector({ environment: env, fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true, discoveryIntervalMs: 0 })
      await c.market.start()
      expect(hl.calls.every((x) => x.url === `https://${host}/info`)).toBe(true)
      expect(FakeWebSocket.last.url).toBe(`wss://${host}/ws`)
      expect(c.environment).toBe(env)
      expect(c.status().environment).toBe(env)
      await c.close()
    }
  })
})

describe('fundingHistory', () => {
  it('pages through and keeps decimal strings', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    const step = 3_600_000
    const from = FX_NOW - 1300 * step
    hl.info.set('fundingHistory', (b) => {
      const out: Array<{ coin: string; fundingRate: string; premium: string; time: number }> = []
      for (let t = Math.ceil(b.startTime / step) * step; t <= b.endTime && out.length < 500; t += step) {
        out.push({ coin: 'BTC', fundingRate: '0.0000125', premium: '0.0001', time: t })
      }
      return out
    })
    const out = await c.fundingHistory('hyperliquid:BTC', { from, to: FX_NOW })
    expect(out.length).toBe(1300)
    for (let i = 1; i < out.length; i++) expect(out[i]!.t).toBeGreaterThan(out[i - 1]!.t)
    expect(out.every((x) => x.rate === '0.0000125' && typeof x.rate === 'string' && x.premium === '0.0001')).toBe(true)
    expect(out.every((x) => x.instrumentId === 'hyperliquid:BTC')).toBe(true)
    const calls = hl.infoCalls('fundingHistory')
    expect(calls.length).toBe(3)
    expect(calls[0]!.body).toEqual({ type: 'fundingHistory', coin: 'BTC', startTime: from, endTime: FX_NOW })
  })

  it('returns an empty array for an empty range and asks once', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    hl.info.set('fundingHistory', () => [])
    const out = await c.fundingHistory('hyperliquid:BTC', { from: FX_NOW - 3_600_000, to: FX_NOW })
    expect(out).toEqual([])
    expect(hl.infoCalls('fundingHistory').length).toBe(1)
  })

  it('dedupes overlapping pages', async () => {
    const { hl, c } = make()
    await c.market.refreshInstruments()
    const step = 3_600_000
    const from = FX_NOW - 1000 * step
    hl.info.set('fundingHistory', (b) => {
      const out: Array<{ coin: string; fundingRate: string; premium: string; time: number }> = []
      if (b.startTime > from) out.push({ coin: 'BTC', fundingRate: '0.0000125', premium: '0.0001', time: b.startTime - 1 }) // 故意重复上一页最后一行
      for (let t = Math.ceil(b.startTime / step) * step; t <= b.endTime && out.length < 501; t += step) {
        out.push({ coin: 'BTC', fundingRate: '0.0000125', premium: '0.0001', time: t })
      }
      return out
    })
    const out = await c.fundingHistory('hyperliquid:BTC', { from, to: FX_NOW })
    const times = out.map((x) => x.t)
    expect(new Set(times).size).toBe(times.length)
    expect(out.length).toBe(1000)
  })
})
