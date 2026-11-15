// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { FakeHl, FakeWS, FakeWebSocket, loadFixture } from '../../connector-hyperliquid/test/helpers/fake-hl'
import { HyperliquidConnector } from '../../connector-hyperliquid/src/connector'
import { PaperVenue } from '../../venue-paper/src/venue'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider } from '../src/device-key'
import { Kernel } from '../src/kernel'
import { FakeClock } from '../src/util/clock'
import { mkOrigin } from '../src/util/origin'
import { newClientOrderId } from '../src/util/ids'
import type { GateDecision, OrderIntent } from '../src/proto'

type MetaResponse = [{ universe: Array<{ name?: string }> }, Array<Record<string, string>>]
type GateLedgerPayload = { gate?: { decision?: GateDecision } }

describe('cold venue mark for paper orders', () => {
  let home: string | undefined
  let kernel: Kernel | undefined
  let connector: HyperliquidConnector | undefined

  afterEach(async () => {
    if (kernel) await kernel.stop().catch(() => undefined)
    if (connector) await connector.close().catch(() => undefined)
    FakeWebSocket.reset()
    vi.useRealTimers()
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
    kernel = undefined
    connector = undefined
  })

  it('pins on the first paper order, uses fresh venue marks, and rejects after they expire', async () => {
    FakeWebSocket.reset()
    const clock = new FakeClock()
    vi.useFakeTimers({ now: clock.now() })
    home = mkdtempSync(join(tmpdir(), 'gitrader-k1-price-'))
    kernel = await Kernel.create({ home, clock, scrypt: { N: 1 << 10, r: 8, p: 1 }, deviceKeyProvider: fileProvider, timers: false })
    const k = kernel
    const hl = new FakeHl()
    const px = { mark: '80100', mid: '80200', publishMark: true }
    const meta = (mark: string, mid: string): MetaResponse => {
      const data = structuredClone(loadFixture<MetaResponse>('metaAndAssetCtxs.json'))
      const index = data[0].universe.findIndex((asset) => asset.name === 'BTC')
      if (index >= 0) data[1][index] = { ...data[1][index], markPx: mark, midPx: mid }
      return data
    }
    hl.info.set('metaAndAssetCtxs', () => meta(px.mark, px.mid))
    connector = new HyperliquidConnector({
      environment: 'testnet', fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true,
      // This cold-price integration test uses C's native default budget; it does not test shared-budget injection.
      discoveryIntervalMs: 0, clock: () => clock.now(), httpTimeoutMs: 60_000,
    })
    const c = connector
    let markCalls = 0
    let lastMark: ReturnType<typeof c.mark>
    const readMark = c.mark.bind(c)
    c.mark = (id) => { markCalls += 1; lastMark = readMark(id); return lastMark }
    const paper = new PaperVenue({ market: c, clock: () => clock.now(), onWarn: () => {} })
    k.registerConnector(c)
    k.registerConnector(paper)
    await c.start()
    const ws = FakeWebSocket.last
    ws.open()
    const push = (): void => {
      ws.push({ channel: 'allMids', data: { mids: { BTC: px.mid } } })
      ws.push({ channel: 'bbo', data: { coin: 'BTC', bbo: [{ px: String(Number(px.mid) - 1) }, { px: String(Number(px.mid) + 1) }] } })
      ws.push({ channel: 'l2Book', data: { coin: 'BTC', time: clock.now(), levels: [[], []] } })
      if (px.publishMark && ws.subs().some((sub) => sub.type === 'activeAssetCtx' && sub.coin === 'BTC')) {
        ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: px.mark, midPx: px.mid } } })
      }
    }
    const feed = setInterval(push, 250)
    const advance = async (ms: number): Promise<void> => { clock.advance(ms); await vi.advanceTimersByTimeAsync(ms) }
    const runUntilDone = async <T>(promise: Promise<T>): Promise<T> => {
      let done = false
      let value!: T
      let failure: unknown
      void promise.then((result) => { value = result; done = true }, (error: unknown) => { failure = error; done = true })
      for (let i = 0; i < 60 && !done; i += 1) await advance(250)
      if (!done) throw new Error('order did not settle within the bounded test window')
      if (failure) throw failure
      return value
    }

    try {
      push()
      await advance(6_000)
      expect(markCalls).toBe(0)
      expect(ws.subs().some((sub) => sub.type === 'activeAssetCtx' && sub.coin === 'BTC')).toBe(false)

      const boot = k.auth.mintBootToken()
      const session = k.auth.authenticateToken(k.auth.exchangeBoot(boot).sessionToken)!
      const pin = await k.auth.setupPin(session, '482916')
      k.keystore.unlock(pin)
      const ctx = { principal: session, origin: mkOrigin('user:usr_local', 'order', 'ui') }
      const paperAccount = k.accounts.find('paper')!
      const makeIntent = (size = '0.001'): OrderIntent => ({ accountId: paperAccount.accountId as never, instrumentId: 'hyperliquid:BTC' as never, side: 'buy', type: 'market', size: asDecimal(size), clientOrderId: newClientOrderId(), reason: 'cold mark test' })
      const firstIntent = makeIntent()
      const first = await runUntilDone(k.trading.place({ intent: firstIntent }, ctx))
      expect(first.order?.status).toBe('filled')
      expect(markCalls).toBeGreaterThan(0)
      expect(ws.subs().some((sub) => sub.type === 'activeAssetCtx' && sub.coin === 'BTC')).toBe(true)
      const gateFor = (id: string): GateDecision | undefined => {
        const entry = [...k.ledger.iterate()].reverse().find((item) => item.type === 'order.intent' && item.subject.clientOrderId === id)
        return (entry?.payload as GateLedgerPayload | undefined)?.gate?.decision
      }
      const firstDecision = gateFor(firstIntent.clientOrderId!)
      expect(firstDecision?.priceRef?.markPrice).toBe('80100')
      expect(clock.now() - firstDecision!.priceRef!.ts).toBeLessThanOrEqual(250)

      await advance(6_000)
      px.mark = '80300'
      px.mid = '80400'
      push()
      await advance(250)
      const secondIntent = makeIntent('0.002')
      const second = await runUntilDone(k.trading.place({ intent: secondIntent }, ctx))
      expect(second.order?.status).toBe('filled')
      const secondDecision = gateFor(secondIntent.clientOrderId!)
      expect(secondDecision?.priceRef?.markPrice).toBe('80300')
      expect(clock.now() - secondDecision!.priceRef!.ts).toBeLessThanOrEqual(250)

      px.publishMark = false
      hl.info.set('metaAndAssetCtxs', () => new Promise<never>(() => {}))
      await advance(5_001)
      const beforeStaleSubmit = paper.submit.bind(paper)
      let submitCount = 0
      paper.submit = (tradeCtx, intents) => { submitCount += 1; return beforeStaleSubmit(tradeCtx, intents) }
      const staleIntent = makeIntent('0.003')
      const stale = await runUntilDone(k.trading.place({ intent: staleIntent }, ctx))
      expect(stale.order?.status).toBe('denied')
      expect(stale.order?.problem?.ruleHits?.map((hit) => hit.code)).toContain('STALE_PRICE')
      expect(submitCount).toBe(0)
    } finally {
      clearInterval(feed)
    }
  })

  it('executes a PIN reduction from the real Hyperliquid stale mark cache while stale opens remain denied', async () => {
    FakeWebSocket.reset()
    const clock = new FakeClock()
    vi.useFakeTimers({ now: clock.now() })
    home = mkdtempSync(join(tmpdir(), 'gitrader-x2k-hl-'))
    kernel = await Kernel.create({ home, clock, scrypt: { N: 1 << 10, r: 8, p: 1 }, deviceKeyProvider: fileProvider, timers: false })
    const k = kernel
    const hl = new FakeHl()
    const px = { mark: '80100', mid: '80200', publishMark: true }
    const meta = (): MetaResponse => {
      const data = structuredClone(loadFixture<MetaResponse>('metaAndAssetCtxs.json'))
      const index = data[0].universe.findIndex((asset) => asset.name === 'BTC')
      if (index >= 0) data[1][index] = { ...data[1][index], markPx: px.mark, midPx: px.mid }
      return data
    }
    hl.info.set('metaAndAssetCtxs', meta)
    connector = new HyperliquidConnector({ environment: 'testnet', fetchImpl: hl.fetch, WebSocketImpl: FakeWS, useWs: true, discoveryIntervalMs: 0, clock: () => clock.now(), httpTimeoutMs: 60_000 })
    const c = connector
    const readMark = c.mark.bind(c)
    c.mark = (id, options) => readMark(id, options)
    const paper = new PaperVenue({ market: c, clock: () => clock.now(), onWarn: () => {} })
    k.registerConnector(c)
    k.registerConnector(paper)
    await c.start()
    const ws = FakeWebSocket.last
    ws.open()
    const push = (): void => {
      ws.push({ channel: 'allMids', data: { mids: { BTC: px.mid } } })
      ws.push({ channel: 'bbo', data: { coin: 'BTC', bbo: [{ px: String(Number(px.mid) - 1) }, { px: String(Number(px.mid) + 1) }] } })
      ws.push({ channel: 'l2Book', data: { coin: 'BTC', time: clock.now(), levels: [[], []] } })
      if (px.publishMark && ws.subs().some((sub) => sub.type === 'activeAssetCtx' && sub.coin === 'BTC')) ws.push({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: px.mark, midPx: px.mid } } })
    }
    const feed = setInterval(push, 250)
    const advance = async (ms: number): Promise<void> => { clock.advance(ms); await vi.advanceTimersByTimeAsync(ms) }
    const runUntilDone = async <T>(promise: Promise<T>): Promise<T> => {
      let done = false
      let value!: T
      let failure: unknown
      void promise.then((result) => { value = result; done = true }, (error: unknown) => { failure = error; done = true })
      for (let index = 0; index < 60 && !done; index += 1) await advance(250)
      if (!done) throw new Error('order did not settle within the bounded test window')
      if (failure) throw failure
      return value
    }
    try {
      push()
      await advance(6_000)
      c.mark('hyperliquid:BTC' as never)
      await advance(250)
      push()
      await advance(250)
      expect(c.mark('hyperliquid:BTC' as never)).toMatchObject({ source: 'venue_mark' })
      const boot = k.auth.mintBootToken()
      const session = k.auth.authenticateToken(k.auth.exchangeBoot(boot).sessionToken)!
      const pin = await k.auth.setupPin(session, '482916')
      k.keystore.unlock(pin)
      const ctx = { principal: session, origin: mkOrigin('user:usr_local', 'order', 'ui') }
      const paperAccount = k.accounts.find('paper')!
      const makeIntent = (side: 'buy' | 'sell', reduceOnly: boolean, size: string): OrderIntent => ({ accountId: paperAccount.accountId as never, instrumentId: 'hyperliquid:BTC' as never, side, type: 'market', size: asDecimal(size), reduceOnly, clientOrderId: newClientOrderId(), reason: 'stale mark integration' })
      const opened = await runUntilDone(k.trading.place({ intent: makeIntent('buy', false, '0.001') }, ctx))
      expect(opened.order?.status).toBe('filled')
      px.publishMark = false
      hl.info.set('metaAndAssetCtxs', () => new Promise<never>(() => {}))
      await advance(5_001)
      expect(c.mark('hyperliquid:BTC' as never)).toBeUndefined()
      const reductionIntent = makeIntent('sell', true, '0.001')
      const staleReduction = await runUntilDone(k.trading.place({ intent: reductionIntent }, { ...ctx, proof: pin }))
      expect(staleReduction.order?.status).toBe('filled')
      const reductionEntry = [...k.ledger.iterate()].reverse().find((item) => item.type === 'order.intent' && item.subject.clientOrderId === reductionIntent.clientOrderId)!
      const reductionDecision = (reductionEntry.payload as GateLedgerPayload).gate?.decision
      expect(reductionDecision).toMatchObject({ decision: 'ALLOW', priceRef: { markPrice: '80100' } })
      expect(reductionDecision?.ruleHits).toContainEqual(expect.objectContaining({ code: 'STALE_PRICE', action: 'warn' }))
      expect(reductionDecision?.applied).toContainEqual(expect.objectContaining({ kind: 'warning', field: 'markPrice', from: '80100', to: '80100' }))
      const positions = await paper.accountState({ accountId: paperAccount.accountId } as never)
      expect(positions.positions).toEqual([])
      const staleOpen = await runUntilDone(k.trading.place({ intent: makeIntent('buy', false, '0.001') }, ctx))
      expect(staleOpen.order?.status).toBe('denied')
      expect(staleOpen.order?.problem?.ruleHits?.map((hit) => hit.code)).toContain('STALE_PRICE')
    } finally {
      clearInterval(feed)
    }
  })
})
