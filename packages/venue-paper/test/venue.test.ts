// SPDX-License-Identifier: CPAL-1.0
// 模拟场所：吃单穿档、限价排队（碰价成交）、费用、资金费、强平、多账户、父子单、触发单、状态导出导入。
// 数字都是手算的（写在注释里），不是从实现里抄出来的。
import { describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { PaperVenue } from '../src/venue'
import type { PaperEvent } from '../src/types'
import { BTC, ETH, TestMarket, caps, ctx, inst, intent } from './helpers/test-market'
import type { BudgetKind, RateBudget } from '../../connector-hyperliquid/src/budget'
import { HyperliquidConnector } from '../../connector-hyperliquid/src/connector'
import { FakeHl, FakeWS, FakeWebSocket, loadFixture } from '../../connector-hyperliquid/test/helpers/fake-hl'

const A = 'acct_A'
const B = 'acct_B'

function setup(balance = '100000', onWarn?: (message: string) => void, markStaleMs?: number) {
  const m = new TestMarket()
  const v = new PaperVenue({ market: m, clock: () => m.now, ...(onWarn ? { onWarn } : {}), ...(markStaleMs === undefined ? {} : { markStaleMs }) })
  v.createAccount({ accountId: A, initialBalance: balance })
  const events: PaperEvent[] = []
  v.onEvent((e) => events.push(e))
  return { m, v, events }
}
const snap = (v: PaperVenue, id = A) => v.accountState({ accountId: id } as never)
const buyMarket = (over: Record<string, unknown> = {}) => intent(A, { type: 'market', price: undefined, maxSlippageBps: 50, leverage: 10, ...over })

describe('risk-gate account view and mark', () => {
  it('marks the whole account stale for a missing or stale position quote and freezes confirmation until recovery', async () => {
    const { m, v } = setup()
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    const confirmed = await snap(v)
    expect(confirmed.stale).toBe(false)
    const lastMark = confirmed.positions[0]!.markPrice
    const confirmedAt = confirmed.confirmedAt

    m.now += 1_000
    const quoteSpy = vi.spyOn(m, 'quote').mockReturnValue(undefined)
    const missing = await snap(v)
    expect(missing).toMatchObject({ stale: true, confirmedAt })
    expect(missing.positions).toHaveLength(1)
    expect(missing.positions[0]!.markPrice).toBe(lastMark)
    expect((v as any).markOf(BTC)).toBeUndefined()
    quoteSpy.mockRestore()

    m.now += 1_000
    m.stale.add(BTC)
    const staleQuote = await snap(v)
    expect(staleQuote).toMatchObject({ stale: true, confirmedAt })
    expect(staleQuote.positions[0]!.markPrice).toBe(lastMark)
    expect((v as any).markOf(BTC)).toBeUndefined()
    m.stale.delete(BTC)

    m.now += 5_001
    const expired = await snap(v)
    expect(expired).toMatchObject({ stale: true, confirmedAt })
    expect(expired.positions[0]!.markPrice).toBe(lastMark)
    expect((v as any).markOf(BTC)).toBeUndefined()

    m.setPrice(BTC, 81_000)
    const recovered = await snap(v)
    expect(recovered).toMatchObject({ stale: false, confirmedAt: m.now })
    expect(recovered.positions[0]!.markPrice).toBe('81000')
    m.mark[BTC] = Number.POSITIVE_INFINITY
    expect((v as any).markOf(BTC)).toBeUndefined()
    m.setPrice(BTC, 81_000)
    await v.close()
  })

  it('uses the custom mark age boundary and marks the account stale when only one of two positions expires', async () => {
    const { m, v } = setup('100000', undefined, 8_000)
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    await v.submit(ctx(A), [buyMarket({ instrumentId: ETH, size: '1' })])
    const confirmed = await snap(v)
    expect(confirmed.positions).toHaveLength(2)

    m.now += 8_000
    m.setPrice(BTC, 81_000)
    const boundary = await snap(v)
    expect(boundary.stale).toBe(false) // ETH age 等于阈值仍有效，BTC 已收到新报价
    const boundaryConfirmedAt = boundary.confirmedAt
    m.now += 1
    const stale = await snap(v)
    expect(stale.stale).toBe(true)
    expect(stale.confirmedAt).toBe(boundaryConfirmedAt)
    expect(stale.positions).toHaveLength(2)

    m.setPrice(BTC, 81_000)
    const stillStale = await snap(v)
    expect(stillStale.stale).toBe(true) // ETH 仍过期，整户不能确认
    expect(stillStale.confirmedAt).toBe(boundaryConfirmedAt)
    m.setPrice(ETH, 3_600)
    const recovered = await snap(v)
    expect(recovered.stale).toBe(false)
    expect(recovered.confirmedAt).toBe(m.now)
    await v.close()
  })

  it('marks the snapshot stale when a live order loses its instrument after submit', async () => {
    const { m, v } = setup()
    const placed = await v.submit(ctx(A), [intent(A, { price: '79000', size: '1', leverage: 10 })])
    expect(placed.acks[0]?.problem).toBeUndefined()
    m.instruments = m.instruments.filter((instrument) => instrument.instrumentId !== BTC)
    const snapshot = await snap(v)
    expect(snapshot.stale).toBe(true)
    expect(snapshot.confirmedAt).toBeUndefined()
  })

  it('keeps Hyperliquid mark and Paper quote distinct through push staleness and REST recovery', async () => {
    FakeWebSocket.reset()
    const baseNow = 1_800_000_000_000
    vi.useFakeTimers({ now: baseNow })
    const hl = new FakeHl()
    const time = { now: baseNow }
    const budgetKinds: BudgetKind[] = []
    const budget: RateBudget = {
      async acquire(_weight, options) { budgetKinds.push(options?.kind ?? (options?.priority === 'low' ? 'query' : 'trade')) },
      charge(_weight, kind = 'trade') { budgetKinds.push(kind) },
      penalize() {},
      reportOk() {},
      usage() { return { used: 0, target: 1200, limit: 1200, ratio: 0, windowMs: 60_000, backoffUntil: 0, byKind: { trade: 0, query: 0, background: 0 } } },
    }
    const metaWithPrices = (markPx: string, midPx: string, dex = '') => {
      const data = structuredClone(loadFixture<any[]>(dex ? `metaAndAssetCtxs-${dex}.json` : 'metaAndAssetCtxs.json'))
      const index = data[0].universe.findIndex((asset: { name?: string }) => asset.name === 'BTC')
      if (!dex && index >= 0) data[1][index] = { ...data[1][index], markPx, midPx }
      return data
    }
    hl.info.set('metaAndAssetCtxs', (request) => metaWithPrices('81000', '82000', request.dex ?? ''))
    const connector = new HyperliquidConnector({
      environment: 'mainnet', fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true,
      discoveryIntervalMs: 0, clock: () => time.now, budget, httpTimeoutMs: 60_000,
    })
    const paper = new PaperVenue({ market: connector, clock: () => time.now, onWarn: () => {} })
    let releasePending: (value: unknown) => void = () => {}
    let stopRecovery: (() => void) | undefined
    let stopContext: (() => void) | undefined
    const advance = async (ms: number) => {
      time.now += ms
      await vi.advanceTimersByTimeAsync(ms)
    }
    try {
      await connector.start()
      expect(budgetKinds).toContain('background')
      const ws = FakeWebSocket.last
      ws.open()
      ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '81000', midPx: '82000' } } })
      expect(connector.status().wsState).toBe('connected')
      connector.mark(BTC)
      stopContext = connector.subscribe({ channel: 'context', instrumentId: BTC }, () => {})
      paper.mark(BTC)

      ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '81100', midPx: '82100' } } })
      expect(connector.mark(BTC)?.price).toBe('81100')
      expect(paper.mark(BTC)?.price).toBe('82100')
      await advance(4_000)
      ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '81200', midPx: '82200' } } })
      expect(connector.mark(BTC)?.price).toBe('81200')
      expect(paper.mark(BTC)?.price).toBe('82200')
      await advance(1_000)
      await advance(4_000)
      ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '81300', midPx: '82300' } } })
      expect(connector.mark(BTC)?.price).toBe('81300')
      expect(paper.mark(BTC)?.price).toBe('82300')
      await advance(1_000)
      expect(connector.mark(BTC)?.price).toBe('81300')
      expect(paper.mark(BTC)?.price).toBe('82300')

      let pendingStarted = false
      const pendingMeta = new Promise<unknown>((resolve) => { releasePending = resolve })
      hl.info.set('metaAndAssetCtxs', (request) => {
        if (request.dex) return metaWithPrices('83000', '84000', request.dex)
        pendingStarted = true
        return pendingMeta
      })
      let recoveryObserved = false
      let resolveRecovery!: () => void
      const recoveryLatch = new Promise<void>((resolve) => { resolveRecovery = resolve })
      stopRecovery = connector.subscribe({ channel: 'quote', instrumentId: BTC }, () => {
        if (connector.mark(BTC)?.price === '83000' && paper.mark(BTC)?.price === '84000') {
          recoveryObserved = true
          resolveRecovery()
        }
      })
      await advance(5_000)
      expect(pendingStarted).toBe(true)
      expect(connector.mark(BTC)).toBeUndefined()
      expect(paper.mark(BTC)).toBeUndefined()

      releasePending(metaWithPrices('83000', '84000'))
      await recoveryLatch
      expect(recoveryObserved).toBe(true)
      expect(connector.mark(BTC)?.price).toBe('83000')
      expect(paper.mark(BTC)?.price).toBe('84000')

      const beforeClose = ws.unsubs().filter((sub) => sub.type === 'bbo' && sub.coin === 'BTC').length
      await paper.close()
      stopRecovery?.()
      expect(ws.unsubs().filter((sub) => sub.type === 'bbo' && sub.coin === 'BTC')).toHaveLength(beforeClose + 1)
      const quoteSubs = ws.subs().filter((sub) => sub.type === 'bbo' && sub.coin === 'BTC').length
      paper.mark(BTC)
      expect(ws.subs().filter((sub) => sub.type === 'bbo' && sub.coin === 'BTC')).toHaveLength(quoteSubs)
      stopContext?.()
    } finally {
      releasePending(metaWithPrices('83000', '84000'))
      await paper.close()
      await connector.close()
      vi.useRealTimers()
      FakeWebSocket.reset()
    }
  })

  it('returns complete authoritative empty account fields', async () => {
    const { m, v } = setup()
    expect(await snap(v)).toMatchObject({
      asOf: m.now, confirmedAt: m.now, stale: false, availableDeductsOpenOrders: false,
      openOrders: [], stopLossOrderIds: [], rules: {},
    })
  })

  it('aggregates live remaining exposure, filters protective stop loss, and updates after cancel', async () => {
    const { m, v } = setup()
    m.describe = () => ({ ...caps, rules: { maxOpenOrders: { cap: 10 } } })
    await v.submit(ctx(A), [intent(A, { price: '80001', size: '3', leverage: 10, tpsl: { takeProfit: { triggerPrice: '81000' }, stopLoss: { triggerPrice: '79000' }, grouping: 'order' } })])
    await v.submit(ctx(A), [intent(A, { side: 'sell', price: '85000', size: '1', leverage: 10 })])
    await v.submit(ctx(A), [intent(A, { side: 'sell', type: 'stop_limit', price: '82000', triggerPrice: '83000', size: '1', leverage: 10 })])
    const first = await snap(v)
    expect(first.openOrders).toEqual([
      { instrumentId: BTC, side: 'buy', notional: '160002', count: 1 },
      { instrumentId: BTC, side: 'sell', notional: '167000', count: 2 },
    ])
    const sl = v.orders(A, { live: true }).find((o) => o.role === 'sl')!
    expect(first.stopLossOrderIds).toEqual([sl.venueOrderId])
    expect(first.rules).toEqual({ maxOpenOrders: { cap: 10, current: 5 } })

    await v.cancel(ctx(A), [{ instrumentId: BTC, venueOrderId: v.orders(A, { live: true }).find((o) => o.type === 'limit' && o.side === 'sell')!.venueOrderId }])
    const after = await snap(v)
    expect(after.openOrders).toEqual([
      { instrumentId: BTC, side: 'buy', notional: '160002', count: 1 },
      { instrumentId: BTC, side: 'sell', notional: '82000', count: 1 },
    ])
    expect(after.rules).toEqual({ maxOpenOrders: { cap: 10, current: 4 } })
  })

  it('adds dynamic current only to declared rules and keeps full decimal notional precision', async () => {
    const { m, v } = setup()
    m.instruments[0]!.contractSize = asDecimal('0.123456789012345678')
    m.describe = () => ({ ...caps, rules: { maxOpenOrders: { cap: 12 }, marketPriceBandBps: 800, minOrderNotional: asDecimal('10') } })
    const placed = await v.submit(ctx(A), [intent(A, { price: '79000', size: '1.00001', leverage: 10 })])
    expect(placed.acks[0]?.problem).toBeUndefined()
    const snapshot = await snap(v)
    expect(snapshot.openOrders).toHaveLength(1)
    expect(snapshot.openOrders![0]!.notional).toBe('9753.183862838628315085')
    expect(snapshot.rules).toEqual({ maxOpenOrders: { cap: 12, current: 1 }, marketPriceBandBps: 800, minOrderNotional: asDecimal('10') })
    expect(v.describe().rules).toEqual({ maxOpenOrders: { cap: 12 }, marketPriceBandBps: 800, minOrderNotional: asDecimal('10') })
  })

  it('returns venue_mark only for a fresh positive paper quote', () => {
    const { m, v } = setup()
    expect((v as any).mark(BTC)).toEqual({ price: '80000.5', ts: m.now, source: 'venue_mark' })
    expect(m.quoteSubscribed).toEqual([BTC])
    expect((v as any).mark(BTC)).toEqual({ price: '80000.5', ts: m.now, source: 'venue_mark' })
    expect(m.quoteSubscribed).toHaveLength(1)
    m.stale.add(BTC)
    expect((v as any).mark(BTC)).toBeUndefined()
    expect((v as any).mark('hyperliquid:missing')).toBeUndefined()
    m.instruments.find((instrument) => instrument.instrumentId === ETH)!.status = 'delisted'
    expect((v as any).mark(ETH)).toBeUndefined()
    m.stale.delete(BTC)
    m.now += 5_001
    expect((v as any).mark(BTC)).toBeUndefined()
    m.setPrice(BTC, 80_001)
    expect((v as any).mark(BTC)).toEqual({ price: '80001', ts: m.now, source: 'venue_mark' })
    m.mark[BTC] = Number.POSITIVE_INFINITY
    expect((v as any).mark(BTC)).toBeUndefined()
    return v.close().then(() => {
      expect(m.quoteUnsubscribed).toEqual([BTC])
      ;(v as any).mark(BTC)
      expect(m.quoteSubscribed).toHaveLength(1)
    })
  })

  it('warns with a fixed message when the quote subscription fails and still reads a fresh local quote', () => {
    const warnings: string[] = []
    const { m, v } = setup('100000', (message) => warnings.push(message))
    m.failSubscribeChannels.add('quote')
    expect(v.mark(BTC)?.price).toBe('80000.5')
    expect(warnings).toEqual(['纸面场所行情订阅失败；仅使用本地报价'])
  })

  it('retries a failed mark subscription at ten minutes and keeps a recovered subscription until close', async () => {
    const warnings: string[] = []
    const { m, v } = setup('100000', (message) => warnings.push(message))
    const subscribe = vi.spyOn(m, 'subscribe')
    m.failSubscribeChannels.add('quote')
    expect(v.mark(BTC)?.price).toBe('80000.5')
    expect(v.mark(BTC)?.price).toBe('80000.5')
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(warnings).toEqual(['纸面场所行情订阅失败；仅使用本地报价'])

    m.now += 599_999
    m.quoteTs[BTC] = m.now
    expect(v.mark(BTC)?.price).toBe('80000.5')
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveLength(1)

    m.now += 1
    m.failSubscribeChannels.delete('quote')
    expect(v.mark(BTC)?.price).toBe('80000.5')
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(m.quoteSubscribed).toEqual([BTC])
    expect(warnings).toHaveLength(1)
    expect(v.mark(BTC)?.price).toBe('80000.5')
    expect(v.mark(BTC)?.price).toBe('80000.5')
    expect(m.quoteSubscribed).toHaveLength(1)

    await v.close()
    expect(m.quoteUnsubscribed).toEqual([BTC])
    subscribe.mockRestore()
  })

  it('skips only unpriceable orders, warns, and keeps all live orders in the cap count', async () => {
    const warnings: string[] = []
    const { m, v } = setup('100000', (message) => warnings.push(message))
    const upper = inst('A', 4, 25)
    const lower = inst('a', 4, 25)
    const missing = inst('MISSING', 4, 25)
    m.instruments.push(upper, lower, missing)
    m.setPrice(upper.instrumentId, 100)
    m.setPrice(lower.instrumentId, 100)
    m.setPrice(missing.instrumentId, 100)
    m.describe = () => ({ ...caps, rules: { maxOpenOrders: { cap: 20 } } })
    const originalConfirm = await snap(v)
    await v.submit(ctx(A), [
      intent(A, { instrumentId: lower.instrumentId, side: 'sell', price: '100', size: '1', leverage: 10 }),
      intent(A, { instrumentId: upper.instrumentId, side: 'sell', price: '100', size: '1', leverage: 10 }),
      intent(A, { instrumentId: lower.instrumentId, side: 'buy', price: '100', size: '1', leverage: 10 }),
      intent(A, { instrumentId: upper.instrumentId, side: 'buy', price: '100', size: '1', leverage: 10 }),
      intent(A, { instrumentId: missing.instrumentId, side: 'buy', price: '100', size: '1', leverage: 10 }),
      intent(A, { instrumentId: missing.instrumentId, side: 'sell', price: '100', size: '1', leverage: 10 }),
    ])
    expect(v.orders(A, { live: true })).toHaveLength(6)
    const warningStart = m.now
    m.instruments = m.instruments.filter((instrument) => instrument.instrumentId !== missing.instrumentId)
    delete m.books[missing.instrumentId]
    delete m.mark[missing.instrumentId]
    const snapshot = await snap(v)
    expect(snapshot.stale).toBe(true)
    expect(snapshot.confirmedAt).toBe(originalConfirm.confirmedAt)
    expect(snapshot.openOrders?.map((x) => [x.instrumentId, x.side])).toEqual([
      ['hyperliquid:A', 'buy'], ['hyperliquid:A', 'sell'], ['hyperliquid:a', 'buy'], ['hyperliquid:a', 'sell'],
    ])
    expect(snapshot.balances).toHaveLength(1)
    expect(snapshot.rules?.maxOpenOrders).toEqual({ cap: 20, current: 6 })
    expect(warnings).toHaveLength(2)
    expect(warnings.every((message) => message === '纸面账户挂单无法估值；已跳过该单')).toBe(true)
    await snap(v)
    m.now = warningStart - 1
    await snap(v)
    expect(warnings).toHaveLength(2)
    m.now = warningStart + 600_000
    await snap(v)
    expect(warnings).toHaveLength(4)
    m.instruments.push(missing)
    m.setPrice(missing.instrumentId, 100)
    const restored = await snap(v)
    expect(restored.stale).toBe(false)
    expect(restored.confirmedAt).toBe(m.now)
    expect(warnings).toHaveLength(4)
    m.now -= 1
    expect((await snap(v)).confirmedAt).toBe(restored.confirmedAt)
  })
})

describe('market orders walk the L2 book', () => {
  it('crosses levels, weighted average price, taker fee, margin and PnL bookkeeping', async () => {
    const { v } = setup()
    // 买 2：卖盘 80001×1 + 80002×1 → 均价 80001.5；名义 160003；taker 0.045% → 72.00135
    const r = await v.submit(ctx(A), [buyMarket({ size: '2' })])
    expect(r.acks[0]).toMatchObject({ status: 'filled', filledSize: '2', avgFillPrice: '80001.5', builder: { attached: false } })
    const s = await snap(v)
    expect(s.positions[0]).toMatchObject({ side: 'long', size: '2', entryPrice: '80001.5', markPrice: '80000.5', unrealizedPnl: '-2', leverage: 10, estimated: true })
    // 权益 = 100000 − 72.00135 − 2；已占用 2×80000.5/10；维持 = 160001/80
    expect(s.margin).toMatchObject({ equity: '99925.99865', initialMargin: '16000.1', maintenanceMargin: '2000.0125', model: 'standard', valuationCcy: 'USDC' })
    const fills = await v.fills({ accountId: A } as never, 0)
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({ price: '80001.5', size: '2', fee: '72.00135', liquidity: 'taker', realizedPnl: '0', side: 'buy' })
  })

  it('book shortfall: the rest is filled at last level +0.1% (inside the slippage cap)', async () => {
    const { v } = setup()
    // 卖盘共 8：80001×1 + 80002×2 + 80010×5 = 640055；剩 2 张按 80010×1.001 = 80090.01 → 160180.02；合计 800235.02 / 10
    const r = await v.submit(ctx(A), [buyMarket({ size: '10', leverage: 20 })])
    expect(r.acks[0]).toMatchObject({ status: 'filled', filledSize: '10', avgFillPrice: '80023.502' })
  })

  it('a tight slippage cap stops the sweep: only what fits under the cap fills, the rest is dropped', async () => {
    const { v } = setup()
    // 上限 = 80000.5×1.0005 = 80040.5 → 贴到合法刻度向下 = 80040；末档补足价 80090.01 越界 → 只成交盘口里的 8 张，均价 640055/8
    const r = await v.submit(ctx(A), [buyMarket({ size: '10', maxSlippageBps: 5, leverage: 20 })])
    expect(r.acks[0]).toMatchObject({ status: 'filled', filledSize: '8', avgFillPrice: '80006.875' })
    const o = v.orders(A)[0]!
    expect(o).toMatchObject({ status: 'cancelled', filledSize: '8', size: '10' })
    expect(o.reason).toContain('kernel-sim:')
  })

  it('a book with no liquidity on the needed side fills at mid +5 bps', async () => {
    const { m, v } = setup()
    m.books[BTC] = { bids: [], asks: [] }
    const r = await v.submit(ctx(A), [buyMarket({ size: '1' })])
    expect(r.acks[0]).toMatchObject({ status: 'filled', avgFillPrice: '80040.50025' }) // 80000.5 × 1.0005
  })

  it('requires maxSlippageBps and a fresh price', async () => {
    const { m, v } = setup()
    const r1 = await v.submit(ctx(A), [intent(A, { type: 'market', price: undefined, leverage: 10 })])
    expect(r1.acks[0]!.problem!.code).toBe(-32602)
    m.stale.add(BTC)
    const r2 = await v.submit(ctx(A), [buyMarket()])
    expect(r2.acks[0]!.problem!.code).toBe(2007)
  })
})

describe('limit orders', () => {
  it('a resting order fills at its limit price as maker when the market touches it (no queue)', async () => {
    const { m, v } = setup()
    const r = await v.submit(ctx(A), [intent(A, { price: '79500', leverage: 10 })])
    expect(r.acks[0]).toMatchObject({ status: 'open', filledSize: '0' })
    expect(await v.openOrders({ accountId: A } as never)).toHaveLength(1)
    await v.tick()
    expect((await snap(v)).positions).toHaveLength(0) // 还没碰到
    m.books[BTC] = { bids: [[79499, 1]], asks: [[79500, 1]] }
    m.now += 1000
    await v.tick()
    const f = (await v.fills({ accountId: A } as never, 0))[0]!
    expect(f).toMatchObject({ price: '79500', size: '1', liquidity: 'maker', fee: '11.925' }) // 79500 × 0.015%
    expect(await v.openOrders({ accountId: A } as never)).toHaveLength(0)
  })

  it('a marketable limit order takes the book up to its price, then rests the remainder (GTC)', async () => {
    const { v } = setup()
    const full = await v.submit(ctx(A), [intent(A, { price: '80002', size: '2', leverage: 10 })])
    expect(full.acks[0]).toMatchObject({ status: 'filled', filledSize: '2', avgFillPrice: '80001.5' })

    const { v: v2 } = setup()
    const part = await v2.submit(ctx(A), [intent(A, { price: '80001', size: '3', leverage: 10 })])
    expect(part.acks[0]).toMatchObject({ status: 'open', filledSize: '1', avgFillPrice: '80001' })
    const open = await v2.openOrders({ accountId: A } as never)
    expect(open[0]).toMatchObject({ size: '2', origSize: '3', price: '80001' })
    expect(v2.orders(A)[0]!.status).toBe('partially_filled')
  })

  it('IOC that matches nothing is rejected, not silently dropped; ALO that would cross is rejected', async () => {
    const { v } = setup()
    const ioc = await v.submit(ctx(A), [intent(A, { price: '79000', tif: 'ioc', leverage: 10 })])
    expect(ioc.acks[0]).toMatchObject({ status: 'rejected', problem: { code: 3001, venue: { id: 'kernel-sim' } } })
    expect(ioc.acks[0]!.problem!.venue!.message).toContain('could not immediately match')
    const alo = await v.submit(ctx(A), [intent(A, { price: '80001', postOnly: true, leverage: 10 })])
    expect(alo.acks[0]!.status).toBe('rejected')
    expect(alo.acks[0]!.problem!.venue!.message).toContain('bbo was 80000@80001')
    const okAlo = await v.submit(ctx(A), [intent(A, { price: '79000', postOnly: true, leverage: 10 })])
    expect(okAlo.acks[0]!.problem, JSON.stringify(okAlo.acks[0])).toBeUndefined()
    expect(okAlo.acks[0]!.status).toBe('open')
    expect(v.orders(A, { live: true })).toHaveLength(1)
  })

  it('price rule: off-grid price is refused (1002); passive rounding goes the safe way', async () => {
    const { v } = setup()
    const bad = await v.submit(ctx(A), [intent(A, { price: '79000.55', leverage: 10 })])
    expect(bad.acks[0]!.problem!.code).toBe(1002)
    const buy = await v.submit(ctx(A), [intent(A, { price: '79000.55', rounding: 'passive', leverage: 10 })])
    const sell = await v.submit(ctx(A), [intent(A, { side: 'sell', price: '82000.55', rounding: 'passive', leverage: 10 })])
    const open = await v.openOrders({ accountId: A } as never)
    expect(open.map((o) => o.price)).toEqual(['79000', '82001'])
    expect(buy.acks[0]!.status).toBe('open')
    expect(sell.acks[0]!.status).toBe('open')
  })

  it('min notional, lot size, unsupported types, margin', async () => {
    const { v } = setup()
    expect((await v.submit(ctx(A), [intent(A, { size: '0.0001', price: '79000', leverage: 10 })])).acks[0]!.problem!.code).toBe(1003)
    expect((await v.submit(ctx(A), [intent(A, { size: '0.0001', price: '79000', reduceOnly: true })])).acks[0]!.problem!.message).toContain('reduce only')
    expect((await v.submit(ctx(A), [intent(A, { size: '0.000001', price: '79000' })])).acks[0]!.problem!.code).toBe(1002)
    expect((await v.submit(ctx(A), [intent(A, { type: 'twap' })])).acks[0]!.problem!.code).toBe(1004)
    expect((await v.submit(ctx(A), [intent(A, { tif: 'fok' })])).acks[0]!.problem!.code).toBe(1004)
    // 杠杆 1（默认）买 2 张 ≈ 16 万 > 10 万本金
    const m = await v.submit(ctx(A), [buyMarket({ size: '2', leverage: undefined })])
    expect(m.acks[0]).toMatchObject({ status: 'rejected', problem: { code: 3004, category: 'VENUE' } })
    expect(m.acks[0]!.problem!.venue!.message).toContain('insufficient margin')
    expect((await snap(v)).positions).toHaveLength(0)
  })
})

describe('reduce-only and closing', () => {
  it('closing realizes PnL net of both fees; a reduce-only order is clipped to the position', async () => {
    const { v } = setup()
    await v.submit(ctx(A), [buyMarket({ size: '2' })]) // 均价 80001.5，开仓费 72.00135
    // 卖 5 只减仓 → 裁剪到 2；买盘 80000×1 + 79999×1 → 均价 79999.5；已实现 (79999.5−80001.5)×2 = −4；平仓费 159999×0.00045 = 71.99955
    const r = await v.submit(ctx(A), [intent(A, { side: 'sell', type: 'market', price: undefined, size: '5', reduceOnly: true, maxSlippageBps: 50 })])
    expect(r.acks[0]).toMatchObject({ status: 'filled', filledSize: '2', avgFillPrice: '79999.5' })
    const s = await snap(v)
    expect(s.positions).toHaveLength(0)
    expect(s.margin.equity).toBe('99851.9991') // 100000 − 72.00135 − 4 − 71.99955
    const fills = await v.fills({ accountId: A } as never, 0)
    expect(fills[1]).toMatchObject({ realizedPnl: '-4', fee: '71.99955', side: 'sell' })
  })

  it('reduce-only with no opposite position is rejected', async () => {
    const { v } = setup()
    const r = await v.submit(ctx(A), [intent(A, { side: 'sell', type: 'market', price: undefined, reduceOnly: true, maxSlippageBps: 50 })])
    expect(r.acks[0]!.problem!.venue!.message).toContain('reduce only order would increase position')
  })

  it('flipping through zero opens the remainder on the other side', async () => {
    const { v } = setup()
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    await v.submit(ctx(A), [intent(A, { side: 'sell', type: 'market', price: undefined, size: '1.5', maxSlippageBps: 50, leverage: 10 })])
    const p = (await snap(v)).positions[0]!
    expect(p).toMatchObject({ side: 'short', size: '0.5' })
  })
})

describe('funding', () => {
  it('long pays a positive hourly rate, short receives; one record per hour with cash-flow sign', async () => {
    const { m, v, events } = setup()
    m.funding[BTC] = 0.0001
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    const before = Number((await snap(v)).margin.equity)
    m.now += 3_600_000
    await v.tick()
    // 名义 1 × 80000.5，费率 0.01%/h，经过 1 小时 → 付 8.00005
    const p = (await snap(v)).positions[0]!
    expect(p.fundingSinceOpen).toBe('-8.00005')
    expect(Number((await snap(v)).margin.equity)).toBeCloseTo(before - 8.00005, 6)
    const f = events.find((e) => e.kind === 'funding') as Extract<PaperEvent, { kind: 'funding' }>
    expect(f).toMatchObject({ instrumentId: BTC, intervalMs: 3_600_000, positionSize: '1', amount: '-8.00005' })

    const { m: m2, v: v2, events: e2 } = setup()
    m2.funding[BTC] = 0.0001
    await v2.submit(ctx(A), [intent(A, { side: 'sell', type: 'market', price: undefined, size: '1', maxSlippageBps: 50, leverage: 10 })])
    m2.now += 3_600_000
    await v2.tick()
    expect((await snap(v2)).positions[0]!.fundingSinceOpen).toBe('8.00005')
    expect((e2.find((e) => e.kind === 'funding') as Extract<PaperEvent, { kind: 'funding' }>).positionSize).toBe('-1')
  })
})

describe('liquidation', () => {
  it('estimates a liquidation price from the full-margin formula, then liquidates at mark when equity < maintenance', async () => {
    const { m, v, events } = setup('1000')
    await v.submit(ctx(A), [buyMarket({ size: '0.1', leverage: 20 })]) // 成交 80001，费 8000.1×0.00045 = 3.600045
    const open = (await snap(v)).positions[0]!
    // 权益 E0 = 996.399955 + 0.1×(80000.5−80001) = 996.349955；p = (s·m − E0) / (s·(1 − 1/80))
    const expected = (0.1 * 80000.5 - 996.349955) / (0.1 * (1 - 1 / 80))
    expect(open.estimated).toBe(true)
    expect(Number(open.liquidationPrice)).toBeCloseTo(expected, 2)

    m.setPrice(BTC, 70000)
    m.now += 1000
    await v.tick()
    // 平仓价 = 标记价 70000；已实现 (70000−80001)×0.1 = −1000.1；费 7000×0.00045 = 3.15 → 余额 996.399955 − 1000.1 − 3.15
    const s = await snap(v)
    expect(s.positions).toHaveLength(0)
    expect(s.balances[0]!.total).toBe('-6.850045') // 坏账不分摊，直接体现在余额里（见 ASSUMPTIONS.md）
    const fills = await v.fills({ accountId: A } as never, 0)
    expect(fills[1]).toMatchObject({ liquidation: true, price: '70000', liquidity: 'taker', realizedPnl: '-1000.1' })
    expect(events.some((e) => e.kind === 'liquidation')).toBe(true)
  })

  it('a healthy account is left alone', async () => {
    const { m, v } = setup('100000')
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    m.setPrice(BTC, 78000)
    await v.tick()
    expect((await snap(v)).positions).toHaveLength(1)
  })
})

describe('multiple accounts', () => {
  it('cash, positions, orders and fills never leak between accounts', async () => {
    const { v } = setup()
    v.createAccount({ accountId: B, initialBalance: '5000' })
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    await v.submit(ctx(B), [intent(B, { price: '79000', size: '0.1', leverage: 5 })])
    expect((await snap(v, A)).positions).toHaveLength(1)
    expect((await snap(v, B)).positions).toHaveLength(0)
    expect((await v.fills({ accountId: B } as never, 0))).toHaveLength(0)
    expect(await v.openOrders({ accountId: A } as never)).toHaveLength(0)
    expect(await v.openOrders({ accountId: B } as never)).toHaveLength(1)
    const bad = await v.cancelAll(ctx(A))
    expect(bad).toHaveLength(0) // 不会撤到别人的单
    expect(await v.openOrders({ accountId: B } as never)).toHaveLength(1)
    await expect(snap(v, 'acct_Z')).rejects.toMatchObject({ problem: { code: 1005 } })
    expect(() => v.createAccount({ accountId: A, initialBalance: '1' })).toThrow(/already exists/)
  })

  it('equity of one account is untouched by the other account losing money', async () => {
    const { m, v } = setup()
    v.createAccount({ accountId: B, initialBalance: '100000' })
    await v.submit(ctx(B), [intent(B, { side: 'sell', type: 'market', price: undefined, size: '1', maxSlippageBps: 50, leverage: 10 })])
    m.setPrice(BTC, 85000)
    await v.tick()
    expect(Number((await snap(v, A)).margin.equity)).toBe(100000)
    expect(Number((await snap(v, B)).margin.equity)).toBeLessThan(100000 - 4000)
  })
})

describe('take-profit / stop-loss parent-child orders', () => {
  const tpsl = { takeProfit: { triggerPrice: '81000' }, stopLoss: { triggerPrice: '79000' }, grouping: 'order' }

  it('children arm when the parent fully fills; the one that fires closes the position and the other disappears', async () => {
    const { m, v } = setup()
    const r = await v.submit(ctx(A), [buyMarket({ size: '1', tpsl })])
    expect(r.acks.map((a) => [a.role, a.status])).toEqual([['parent', 'filled'], ['tp', 'untriggered'], ['sl', 'untriggered']])
    const open = await v.openOrders({ accountId: A } as never)
    expect(open.filter((o) => o.isTrigger)).toHaveLength(2)
    m.setPrice(BTC, 81500)
    await v.tick()
    expect((await snap(v)).positions).toHaveLength(0)
    expect(v.orders(A, { live: true })).toHaveLength(0)
    // 开仓 80001（买一张吃卖一），平仓 81499.5（setPrice 后买一）→ 已实现 +1498.5
    const fills = await v.fills({ accountId: A } as never, 0)
    expect(fills[1]).toMatchObject({ side: 'sell', price: '81499.5', realizedPnl: '1498.5' })
  })

  it('children wait for the parent: a resting parent keeps them dormant; cancelling the parent cancels them', async () => {
    const { m, v } = setup()
    await v.submit(ctx(A), [intent(A, { price: '79000', size: '1', leverage: 10, tpsl })])
    expect(v.orders(A, { live: true })).toHaveLength(3)
    m.setPrice(BTC, 90000) // 子单若已生效，止盈会触发；还在等父单就不能动（价格上行，买单父单也不会成交）
    await v.tick()
    expect(v.orders(A).filter((o) => o.role !== 'parent').every((o) => o.status === 'untriggered')).toBe(true)
    const parent = v.orders(A).find((o) => o.role === 'parent')!
    await v.cancel(ctx(A), [{ instrumentId: BTC, venueOrderId: parent.venueOrderId }])
    expect(v.orders(A, { live: true })).toHaveLength(0)
    expect(v.orders(A).filter((o) => o.role !== 'parent').every((o) => o.status === 'cancelled')).toBe(true)
  })

  it('an IOC parent that only partly fills cancels its children (parentPartialCancel: cancel_children)', async () => {
    const { v } = setup()
    const r = await v.submit(ctx(A), [intent(A, { price: '80001', size: '3', tif: 'ioc', leverage: 10, tpsl })])
    expect(r.acks.map((a) => a.role)).toEqual(['parent']) // 子单已撤，不再回执
    expect(r.acks[0]).toMatchObject({ status: 'filled', filledSize: '1' })
    expect(v.orders(A, { live: true })).toHaveLength(0)
  })
})

describe('trigger orders', () => {
  it('stop-market fires on the mark price and closes the position; stop-limit becomes a limit order', async () => {
    const { m, v } = setup()
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    const stop = await v.submit(ctx(A), [intent(A, { side: 'sell', type: 'stop_market', price: undefined, triggerPrice: '79000', size: '1', reduceOnly: true })])
    expect(stop.acks[0]!.status).toBe('untriggered')
    await v.tick()
    expect((await snap(v)).positions).toHaveLength(1) // 价格没到
    m.setPrice(BTC, 78900)
    await v.tick()
    expect((await snap(v)).positions).toHaveLength(0)

    const { m: m2, v: v2 } = setup()
    await v2.submit(ctx(A), [buyMarket({ size: '1' })])
    await v2.submit(ctx(A), [intent(A, { side: 'sell', type: 'take_limit', price: '82000', triggerPrice: '81000', size: '1', reduceOnly: true })])
    m2.setPrice(BTC, 81500) // 触发，但买一 81499.5 < 82000，不穿价 → 挂单
    await v2.tick()
    expect((await v2.openOrders({ accountId: A } as never))[0]).toMatchObject({ type: 'take_limit', price: '82000', isTrigger: false })
    m2.setPrice(BTC, 82500)
    await v2.tick()
    const f = (await v2.fills({ accountId: A } as never, 0)).at(-1)!
    expect(f).toMatchObject({ side: 'sell', price: '82000', liquidity: 'maker' })
  })
})

describe('cancel / amend', () => {
  it('cancel by venue id or client id; a missing order is an error ack', async () => {
    const { v } = setup()
    const r = await v.submit(ctx(A), [intent(A, { price: '79000', leverage: 10, clientOrderId: '0123456789abcdef0123456789abcdef' })])
    const out = await v.cancel(ctx(A), [{ instrumentId: BTC, clientOrderId: '0123456789abcdef0123456789abcdef' }, { instrumentId: BTC, venueOrderId: 'sim-999999' }])
    expect(out.map((x) => x.ok)).toEqual([true, false])
    expect(out[1]!.problem!.venue!.message).toContain('already canceled')
    expect(r.acks[0]!.venueOrderId).toMatch(/^sim-\d{6}$/)
    expect(v.orders(A)[0]!.status).toBe('cancelled')
  })

  it('amend a resting order into the market: it takes liquidity immediately', async () => {
    const { v } = setup()
    const r = await v.submit(ctx(A), [intent(A, { price: '79000', leverage: 10 })])
    const out = await v.amend(ctx(A), { instrumentId: BTC, venueOrderId: r.acks[0]!.venueOrderId!, order: intent(A, { price: '80001', leverage: 10 }) })
    expect(out.acks[0]!.problem).toBeUndefined()
    const f = (await v.fills({ accountId: A } as never, 0))[0]!
    expect(f).toMatchObject({ price: '80001', liquidity: 'taker' })
  })
})

describe('state', () => {
  it('export / import round-trips accounts, orders and counters', async () => {
    const { m, v } = setup()
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    await v.submit(ctx(A), [intent(A, { price: '79000', leverage: 10 })])
    const json = v.exportState()
    const v2 = new PaperVenue({ market: m, clock: () => m.now })
    v2.importState(json)
    expect(await snap(v2)).toEqual(await snap(v))
    expect(v2.orders(A)).toEqual(v.orders(A))

    const oldState = JSON.parse(json) as { accounts: Array<Record<string, unknown>> }
    delete oldState.accounts[0]!.confirmedAt
    const v3 = new PaperVenue({ market: m, clock: () => m.now })
    v3.importState(JSON.stringify(oldState))
    expect((await snap(v3)).confirmedAt).toBe(m.now)

    const next = await v2.submit(ctx(A), [intent(A, { price: '78000', leverage: 10 })])
    expect(next.acks[0]!.venueOrderId).toBe('sim-000003') // 计数接着走，不重号
  })

  it('describe() mirrors the venue minus dead-man switch and signers, and publishes the declaration', async () => {
    const { v } = setup()
    const d = v.describe()
    expect(d.deadman).toBeUndefined()
    expect(d.signers).toBeUndefined()
    expect(d['x-kernelSim']).toMatchObject({ connector: 'kernel-sim', mirrors: ['hyperliquid'] })
    await expect(v.scheduleCancel()).rejects.toMatchObject({ problem: { code: 5002 } })
    expect(() => v.subscribe({ channel: 'userFills', address: '0x1111111111111111111111111111111111111111' }, () => {})).toThrow()
  })

  it('leverage: set per instrument, bounded by the instrument maximum', async () => {
    const { v } = setup()
    await v.setLeverage(ctx(A), ETH, 5, 'cross')
    const r = await v.submit(ctx(A), [intent(A, { instrumentId: ETH, price: '3400', size: '1' })])
    expect(r.acks[0]!.status).toBe('open')
    expect(v.orders(A)[0]!.leverage).toBe(5)
    await expect(v.setLeverage(ctx(A), ETH, 26, 'cross')).rejects.toMatchObject({ problem: { code: 3001 } })
  })
})

describe('v0.1.3 legId passthrough', () => {
  it('order views and fill events carry the leg; TP/SL children inherit it; matching ignores it', async () => {
    const { v, events } = setup()
    await v.submit(ctx(A), [buyMarket({ size: '1', legId: 'leg-7', tpsl: { takeProfit: { triggerPrice: '81000' }, grouping: 'order' } })])
    expect(v.orders(A).map((o) => [o.role, o.legId])).toEqual([['parent', 'leg-7'], ['tp', 'leg-7']])
    const fill = events.find((e) => e.kind === 'fill') as Extract<PaperEvent, { kind: 'fill' }>
    expect(fill.legId).toBe('leg-7')
    await v.submit(ctx(A), [buyMarket({ size: '1' })])
    expect(v.orders(A).at(-1)!.legId).toBeUndefined()
    expect((await snap(v)).positions[0]!.size).toBe('2') // 同标的合并，聚合持仓不受 legId 影响
  })
})

describe('L2 snapshot consumption (no REST order book per order)', () => {
  function snap() {
    const { m, v, events } = setup()
    m.useSnapshots()
    return { m, v, events }
  }

  it('300 paper orders in a row read the local snapshot: zero REST book calls, one subscription per instrument', async () => {
    const { m, v } = snap()
    for (let i = 0; i < 300; i++) {
      const r = await v.submit(ctx(A), [intent(A, { side: i % 2 ? 'sell' : 'buy', type: 'market', price: undefined, size: '0.01', maxSlippageBps: 50, leverage: 10 })])
      expect(r.acks[0]!.status).toBe('filled')
    }
    await v.tick()
    expect(m.restBookCalls).toBe(0)
    expect(m.refreshCalls).toBe(0)
    expect(m.subscribed.filter((x) => x === BTC)).toHaveLength(1)
  })

  it('a stale snapshot triggers one bounded REST refresh; if that works the order matches', async () => {
    const { m, v } = snap()
    m.now += 20_000 // 快照 20 s 没更新
    const r = await v.submit(ctx(A), [buyMarket({ size: '1' })])
    expect(r.acks[0]!.status).toBe('filled')
    expect(m.refreshCalls).toBe(1)
    await v.submit(ctx(A), [buyMarket({ size: '0.1' })]) // 刚刷新过，不再兜底
    expect(m.refreshCalls).toBe(1)
  })

  it('stale and the fallback cannot help: the order is refused with a readable error, not blocked, nothing is filled', async () => {
    const { m, v } = snap()
    m.now += 20_000
    m.refreshWorks = false
    const r = await v.submit(ctx(A), [buyMarket({ size: '1' })])
    expect(r.acks[0]).toMatchObject({ status: 'rejected', problem: { code: 2007, retryable: true } })
    expect(r.acks[0]!.problem!.message).toContain('no fresh L2 snapshot for hyperliquid:BTC (last update 20000 ms ago)')
    expect((await snap2(v)).positions).toHaveLength(0)
    expect(v.orders(A)).toHaveLength(0)
    expect(m.restBookCalls).toBe(0)
  })

  it('no snapshot at all (stream not up yet): same refusal, and the message says so', async () => {
    const { m, v } = snap()
    delete m.snapshotAsOf[BTC]
    m.refreshWorks = false
    const r = await v.submit(ctx(A), [buyMarket({ size: '1' })])
    expect(r.acks[0]!.problem!.message).toContain('none received yet')
    expect(r.acks[0]!.problem!.message).toContain('order not matched')
  })

  it('resting orders and triggers are not matched against a stale book, and match again once it is fresh', async () => {
    const { m, v } = snap()
    await v.submit(ctx(A), [intent(A, { price: '79500', leverage: 10 })])
    m.books[BTC] = { bids: [[79499, 1]], asks: [[79500, 1]] }
    m.now += 20_000
    m.refreshWorks = false
    await v.tick() // 盘口已陈旧：不撮合，也不抛错
    expect((await snap2(v)).positions).toHaveLength(0)
    m.refreshWorks = true
    m.snapshotAsOf[BTC] = m.now
    await v.tick()
    expect((await snap2(v)).positions).toHaveLength(1)
  })

  it('a market source without snapshots (replay) falls back to awaiting book() as before; a failing book() is a readable refusal', async () => {
    const { m, v } = setup()
    m.noBook.add(BTC)
    const r = await v.submit(ctx(A), [buyMarket({ size: '1' })])
    expect(r.acks[0]!.problem!.message).toMatch(/no L2 book for hyperliquid:BTC .* order not matched/)
  })
})

const snap2 = (v: PaperVenue) => v.accountState({ accountId: A } as never)
