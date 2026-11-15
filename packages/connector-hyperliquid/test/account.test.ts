// SPDX-License-Identifier: CPAL-1.0
// 账户读取：账户模式感知、持仓符号约定、成交 / 挂单映射、启动对账、builder 授权探测、用户流；
// 以及「WS 用户流增量维护本地快照、查询不再打 REST」（含 asOf / stale、断线兜底、跟踪上限）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDecimal } from '@gitrader/protocol'
import { createWeightBudget } from '../src/budget'
import type { RateBudget } from '../src/budget'
import { HyperliquidConnector } from '../src/connector'
import type { HyperliquidConnectorOptions } from '../src/connector'
import { hyperliquidCapabilities } from '../src/capabilities'
import type { AccountRef, VenueEvent } from '@gitrader/protocol/connector'
import { FX_NOW, FakeHl, FakeWS, FakeWebSocket } from './helpers/fake-hl'

const MAIN = '0x2222222222222222222222222222222222222222' as const
const ref = (over: Partial<AccountRef> = {}): AccountRef => ({ accountId: 'acct_01TEST', address: MAIN, ...over })

afterEach(() => { FakeWebSocket.reset(); vi.useRealTimers() })

async function setup(opts: { ws?: boolean; clock?: { now: number }; extra?: Partial<HyperliquidConnectorOptions>; budget?: RateBudget } = {}) {
  const hl = new FakeHl()
  const t = opts.clock ?? { now: FX_NOW }
  const c = new HyperliquidConnector({
    environment: 'mainnet', fetchImpl: hl.fetch, useWs: !!opts.ws, ...(opts.ws ? { WebSocketImpl: FakeWS } : {}),
    discoveryIntervalMs: 0, clock: () => t.now, ...opts.extra,
    // 假时钟下预算不能真睡；本组用例不测限速，放宽 target 避免等待（限速另有 budget / market 用例）
    budget: opts.budget ?? createWeightBudget({ clock: () => t.now, targetRatio: 1, sleep: async () => { throw new Error('budget wait in a test that should not wait') } }),
  })
  await c.market.refreshInstruments()
  // REST 默认应答（引导 / 对比用）；各用例按需覆盖
  hl.info.set('userAbstraction', () => 'default')
  hl.info.set('clearinghouseState', () => chState([]))
  hl.info.set('spotClearinghouseState', () => ({ balances: [] }))
  hl.info.set('frontendOpenOrders', () => [])
  hl.info.set('userRateLimit', () => ({ cumVlm: '0', nRequestsUsed: 0, nRequestsCap: 0, nRequestsSurplus: 0 }))
  hl.calls.length = 0
  return { hl, c, t }
}

async function waitForAccount(c: HyperliquidConnector, accountRef: AccountRef = ref()) {
  let snapshot: Awaited<ReturnType<HyperliquidConnector['accountState']>> | undefined
  await vi.waitFor(async () => {
    snapshot = await c.accountState(accountRef)
    expect(snapshot.stale).toBe(false)
  })
  return snapshot!
}

async function waitForAccountView(c: HyperliquidConnector, accountRef: AccountRef = ref()) {
  let view: Awaited<ReturnType<HyperliquidConnector['accountView']>> | undefined
  await vi.waitFor(async () => {
    view = await c.accountView(accountRef)
    expect(view.stale).toBe(false)
  })
  return view!
}

const chState = (positions: unknown[], over: Record<string, unknown> = {}) => ({
  marginSummary: { accountValue: '1000.5', totalNtlPos: '800', totalMarginUsed: '80' },
  crossMaintenanceMarginUsed: '20', withdrawable: '900.25', assetPositions: positions, time: FX_NOW, ...over,
})
const pos = (coin: string, szi: string, extra: Record<string, unknown> = {}) => ({
  type: 'oneWay',
  position: {
    coin, szi, leverage: { type: 'cross', value: 10 }, entryPx: '80000.0', positionValue: '800.0', unrealizedPnl: '12.5',
    liquidationPx: '72000.0', marginUsed: '80.0', cumFunding: { allTime: '3.0', sinceOpen: '1.5', sinceChange: '1.5' }, ...extra,
  },
})
const zeroState = () => chState([], { marginSummary: { accountValue: '0', totalNtlPos: '0', totalMarginUsed: '0' }, withdrawable: '0', crossMaintenanceMarginUsed: '0' })

describe('account model', () => {
  it('maps userAbstraction to the contract account models (and caches the answer)', async () => {
    for (const [raw, model] of [['unifiedAccount', 'unified'], ['portfolioMargin', 'portfolio'], ['default', 'standard'], ['disabled', 'standard'], ['dexAbstraction', 'standard']] as const) {
      const { hl, c } = await setup()
      hl.info.set('userAbstraction', () => raw)
      expect(await c.accounts.detectModel(MAIN)).toBe(model)
      await c.accounts.detectModel(MAIN)
      expect(hl.infoCalls('userAbstraction')).toHaveLength(1) // 模式缓存：不是每次查询都花 20 权重
    }
  })

  it('standard: reads every live dex separately, sums equity, keeps the contract sign conventions', async () => {
    const { hl, c } = await setup()
    hl.info.set('clearinghouseState', (b) => b.dex === 'xyz'
      ? chState([pos('xyz:TSLA', '-2.5', { entryPx: '380.0', positionValue: '950.0', unrealizedPnl: '-3.0', liquidationPx: null })], { marginSummary: { accountValue: '200', totalNtlPos: '950', totalMarginUsed: '95' }, withdrawable: '100', crossMaintenanceMarginUsed: '10' })
      : b.dex ? zeroState() : chState([pos('BTC', '0.01')]))
    hl.info.set('spotClearinghouseState', () => ({ balances: [{ coin: 'USDC', total: '50', hold: '0' }, { coin: 'HYPE', total: '3', hold: '1' }] }))
    const s = await waitForAccount(c)
    expect(s.accountModel).toBe('standard')
    // 每个在线 dex 一次 clearinghouseState：默认 + xyz/io/para/mkts（flx 已关停不查）
    expect(hl.infoCalls('clearinghouseState').map((x) => x.body.dex ?? '').sort()).toEqual(['', 'io', 'mkts', 'para', 'xyz'])
    expect(hl.infoCalls('clearinghouseState').every((x) => x.body.user === MAIN)).toBe(true) // 用主账户地址查，不是 API 钱包地址

    expect(s.margin).toMatchObject({ accountId: 'acct_01TEST', model: 'standard', valuationCcy: 'USDC', equity: '1200.5', initialMargin: '175', maintenanceMargin: '30', available: '1000.25' })
    expect(Number(s.margin.marginRatio)).toBeCloseTo(30 / 1200.5, 6)
    expect(s.margin.leverage).toBeCloseTo(1750 / 1200.5, 3)

    const btc = s.positions.find((p) => p.instrumentId === 'hyperliquid:BTC')!
    expect(btc).toMatchObject({ side: 'long', size: '0.01', entryPrice: '80000', notional: '800', unrealizedPnl: '12.5', leverage: 10, marginMode: 'cross', liquidationPrice: '72000', initialMargin: '80' })
    expect(btc.fundingSinceOpen).toBe('-1.5') // HL 的 sinceOpen 正数 = 付出；契约现金流符号取反
    const tsla = s.positions.find((p) => p.instrumentId === 'hyperliquid:xyz:TSLA')!
    expect(tsla).toMatchObject({ side: 'short', size: '2.5', liquidationPrice: null })

    const usdc = s.balances.find((b) => b.asset === 'USDC')!
    expect(usdc).toMatchObject({ total: '1200.5', hold: '175', available: '1000.25' })
    expect(s.balances.find((b) => b.asset === 'HYPE')).toMatchObject({ total: '3', hold: '1', available: '2' })
    for (const p of s.positions) for (const k of ['size', 'entryPrice', 'markPrice', 'notional', 'unrealizedPnl', 'fundingSinceOpen'] as const) expect(isDecimal(p[k])).toBe(true)
  })

  it('unified: balances and holds come from the spot state; equity = spot USDC + unrealized PnL', async () => {
    const { hl, c } = await setup()
    hl.info.set('userAbstraction', () => 'unifiedAccount')
    hl.info.set('clearinghouseState', (b) => (b.dex ? chState([]) : chState([pos('BTC', '0.01')], { marginSummary: { accountValue: '0', totalNtlPos: '800', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0' })))
    hl.info.set('spotClearinghouseState', () => ({ balances: [{ coin: 'USDC', total: '2000', hold: '80' }] }))
    const s = await waitForAccount(c)
    expect(s.accountModel).toBe('unified')
    expect(s.margin).toMatchObject({ model: 'unified', equity: '2012.5', available: '1920' })
    expect(s.balances.filter((b) => b.asset === 'USDC')).toHaveLength(1)
    expect(s.balances[0]).toMatchObject({ asset: 'USDC', total: '2000', hold: '80', available: '1920' })
  })

  it('an explicit accountModel in the ref skips the detection request', async () => {
    const { hl, c } = await setup()
    await c.accountState(ref({ accountModel: 'standard' }))
    expect(hl.infoCalls('userAbstraction')).toHaveLength(0)
  })
})

describe('orders, fills, status', () => {
  it('maps open orders including trigger types and client order ids', async () => {
    const { hl, c } = await setup()
    hl.info.set('frontendOpenOrders', (b) => (b.dex ? [] : [
      { coin: 'BTC', side: 'B', limitPx: '79000.0', sz: '0.01', origSz: '0.02', oid: 5, timestamp: FX_NOW - 1000, orderType: 'Limit', cloid: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { coin: 'BTC', side: 'A', limitPx: '90000', sz: '0.02', oid: 6, timestamp: FX_NOW, orderType: 'Take Profit Market', isTrigger: true, triggerPx: '90000.0', reduceOnly: true },
    ]))
    await waitForAccount(c)
    const o = await c.openOrders(ref())
    expect(o[0]).toMatchObject({ instrumentId: 'hyperliquid:BTC', venueOrderId: '5', clientOrderId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', side: 'buy', type: 'limit', price: '79000', size: '0.01', origSize: '0.02', reduceOnly: false })
    expect(o[1]).toMatchObject({ side: 'sell', type: 'take_market', isTrigger: true, triggerPrice: '90000', reduceOnly: true })
  })

  it('maps fills: fee sign, taker/maker, builder fee, closedPnl, liquidation, client order id', async () => {
    const { hl, c } = await setup()
    hl.info.set('userFillsByTime', () => [
      { coin: 'BTC', px: '80000.0', sz: '0.01', side: 'B', time: FX_NOW - 5, closedPnl: '0.0', oid: 1, tid: 101, crossed: true, fee: '0.36', feeToken: 'USDC', builderFee: '0.08', cloid: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      { coin: 'xyz:TSLA', px: '380.5', sz: '2', side: 'A', time: FX_NOW - 3, closedPnl: '-4.2', oid: 2, tid: 102, crossed: false, fee: '-0.01', feeToken: 'USDC', liquidation: { liquidatedUser: MAIN } },
    ])
    const f = await c.fills(ref(), FX_NOW - 1000) // 早于开始跟踪的时刻 = 历史回补，走 REST
    expect(f[0]).toMatchObject({ venueFillId: '101', venueOrderId: '1', clientOrderId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', side: 'buy', price: '80000', size: '0.01', fee: '0.36', builderFee: '0.08', liquidity: 'taker', realizedPnl: '0' })
    expect(f[1]).toMatchObject({ instrumentId: 'hyperliquid:xyz:TSLA', side: 'sell', fee: '-0.01', liquidity: 'maker', realizedPnl: '-4.2', liquidation: true, clientOrderId: null })
  })

  it('startup snapshot always goes to REST, pages through fills (dedupe by tid) and reports the whole picture', async () => {
    const { hl, c } = await setup()
    const mk = (i: number) => ({ coin: 'BTC', px: '80000', sz: '0.001', side: 'B', time: 1000 + i, closedPnl: '0', oid: i, tid: i, crossed: true, fee: '0.03', feeToken: 'USDC' })
    hl.info.set('userFillsByTime', (b) => {
      if (b.startTime === 900) return Array.from({ length: 500 }, (_, i) => mk(i))
      if (b.startTime === 1000 + 499 + 1) return [mk(499), mk(500), mk(501)] // 499 是重复的
      return []
    })
    const first = await c.startupSnapshot(ref(), 900)
    expect(first.account.stale).toBe(true)
    expect(first.truncated).toBe(true)
    await vi.waitFor(async () => {
      const current = await c.startupSnapshot(ref(), 900)
      expect(current.fills).toHaveLength(502)
      expect(current.truncated).toBe(false)
      expect(current.account.stale).toBe(false)
    })
    const snap = await c.startupSnapshot(ref(), 900)
    expect(snap.fills).toHaveLength(502)
    expect(new Set(snap.fills.map((f) => f.venueFillId)).size).toBe(502)
    expect(snap.truncated).toBe(false)
    expect(snap.account.accountModel).toBe('standard')
    expect(snap.account).toMatchObject({ availableDeductsOpenOrders: true, confirmedAt: FX_NOW, stale: false, source: 'rest', rules: { marketPriceBandBps: 800, minOrderNotional: '10' } })
    expect(snap.openOrders).toEqual([])
    expect(hl.infoCalls('userFillsByTime').map((x) => x.body.startTime)).toEqual([900, 1500])
  })

  it('does not reuse newer startup history as coverage for an earlier request', async () => {
    const { hl, c } = await setup()
    let releaseHistory!: () => void
    let notifyHistoryStarted!: () => void
    const pendingHistory = new Promise<void>((resolve) => { releaseHistory = resolve })
    const historyStarted = new Promise<void>((resolve) => { notifyHistoryStarted = resolve })
    hl.info.set('userFillsByTime', async (body) => {
      if (body.startTime === 1000) {
        notifyHistoryStarted()
        await pendingHistory
      }
      return []
    })
    try {
      const newer = await c.startupSnapshot(ref(), 1000)
      expect(newer).toMatchObject({ truncated: true, account: { stale: true } })
      await historyStarted
      const earlierPending = await c.startupSnapshot(ref(), 900)
      expect(earlierPending).toMatchObject({ truncated: true, fills: [], account: { stale: true } })
      releaseHistory()
      await vi.waitFor(async () => {
        const completed = await c.startupSnapshot(ref(), 1000)
        expect(completed).toMatchObject({ truncated: false, account: { stale: false } })
      })
      const earlierAgain = await c.startupSnapshot(ref(), 900)
      expect(earlierAgain).toMatchObject({ truncated: true, account: { stale: true } })
      await vi.waitFor(() => expect(hl.infoCalls('userFillsByTime').some((call) => call.body.startTime === 900)).toBe(true))
    } finally {
      releaseHistory()
      await c.close()
    }
  })

  it('orderStatus by client order id, found and not found; upstream status string is kept as is', async () => {
    const { hl, c } = await setup()
    hl.info.set('orderStatus', (b) => (b.oid === '0x0123456789abcdef0123456789abcdef'
      ? { status: 'order', order: { status: 'canceled', statusTimestamp: FX_NOW, order: { oid: 77, origSz: '0.5', sz: '0.2' } } }
      : { status: 'unknownOid' }))
    const found = await c.orderStatus(ref(), { clientOrderId: '0123456789abcdef0123456789abcdef' })
    expect(found).toMatchObject({ found: true, status: 'canceled', venueOrderId: '77', filledSize: '0.3' })
    expect((await c.orderStatus(ref(), { clientOrderId: 'ffffffffffffffffffffffffffffffff' })).found).toBe(false)
    expect((await c.orderStatus(ref(), { venueOrderId: '9' })).found).toBe(false)
    expect(hl.infoCalls('orderStatus').at(-1)!.body.oid).toBe(9)
  })

  it('builder approval is read from maxBuilderFee (tenths of a bp): >= 10 means approved', async () => {
    const { hl, c } = await setup()
    const builder = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as const
    for (const [raw, status] of [[10, 'approved'], [100, 'approved'], [5, 'not_approved'], [0, 'not_approved'], [null, 'not_approved']] as const) {
      hl.info.set('maxBuilderFee', () => raw)
      expect((await c.builderStatus(MAIN, builder)).status).toBe(status)
    }
    expect(hl.infoCalls('maxBuilderFee').at(-1)!.body).toEqual({ type: 'maxBuilderFee', user: MAIN, builder: builder.toLowerCase() })
  })
})

// ---------------------------------------------------------------------------------------------
// WS 用户流：首批快照 + 增量；查询不再打 REST
// ---------------------------------------------------------------------------------------------
const rawOrder = (coin: string, oid: number, extra: Record<string, unknown> = {}) => ({ coin, side: 'B', limitPx: '79000.0', sz: '0.01', origSz: '0.01', oid, timestamp: FX_NOW, ...extra })
const rawFill = (tid: number, extra: Record<string, unknown> = {}) => ({ coin: 'BTC', px: '80000.0', sz: '0.01', side: 'B', time: FX_NOW + tid, closedPnl: '0.0', oid: tid, tid, crossed: true, fee: '0.36', feeToken: 'USDC', ...extra })

/** 场所对每条订阅回的首批快照。 */
function installSnapshots(state: { positions: unknown[]; orders: Record<string, unknown[]>; fills: unknown[] }) {
  const dexKey = (sub: any) => sub.dex ?? ''
  FakeWebSocket.autoReply = (sub) => {
    switch (sub.type) {
      case 'allDexsClearinghouseState':
        return [{ channel: 'allDexsClearinghouseState', data: { user: sub.user, clearinghouseStates: [['', chState(state.positions)], ['xyz', zeroState()], ['io', zeroState()], ['para', zeroState()], ['mkts', zeroState()]] } }]
      case 'spotState':
        return [{ channel: 'spotState', data: { user: sub.user, spotState: { balances: [{ coin: 'USDC', total: '50', hold: '0' }] } } }]
      case 'openOrders':
        return [{ channel: 'openOrders', data: { dex: dexKey(sub), user: sub.user, orders: state.orders[dexKey(sub)] ?? [] } }]
      case 'userFills':
        return [{ channel: 'userFills', data: { isSnapshot: true, user: sub.user, fills: state.fills } }]
      default: return undefined
    }
  }
}

describe('account stream (WS user streams instead of REST polling)', () => {
  it('returns an empty stale first view while the account bootstrap budget is pending', async () => {
    let releaseAcquire!: () => void
    let holdAccountBudget = false
    const requestKinds: Array<string | undefined> = []
    let signalAccountRequest!: () => void
    const accountRequestStarted = new Promise<void>((resolve) => { signalAccountRequest = resolve })
    const pendingAcquire = new Promise<void>((resolve) => { releaseAcquire = resolve })
    const baseBudget = createWeightBudget({ targetRatio: 1, sleep: async () => { throw new Error('unexpected budget sleep') } })
    const budget: RateBudget = {
      acquire: async (weight, options) => {
        if (holdAccountBudget) {
          requestKinds.push(options?.kind)
          signalAccountRequest()
          await pendingAcquire
        }
        await baseBudget.acquire(weight, options)
      },
      charge: (weight, kind) => baseBudget.charge(weight, kind),
      penalize: (retryAfterMs) => baseBudget.penalize(retryAfterMs),
      reportOk: () => baseBudget.reportOk(),
      usage: () => baseBudget.usage(),
    }
    const { c } = await setup({ budget })
    holdAccountBudget = true
    const firstView = c.accountView(ref())
    try {
      const started = await Promise.race([
        accountRequestStarted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ])
      expect(started).toBe(true)
      expect(requestKinds.length).toBeGreaterThan(0)
      expect(requestKinds.every((kind) => kind === 'background')).toBe(true)
      const resolved = await Promise.race([
        firstView.then((view) => ({ view })),
        new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
      ])
      expect(resolved).not.toHaveProperty('timeout')
      if (!('view' in resolved)) throw new Error('first account view did not settle')
      expect(resolved.view).toMatchObject({ stale: true, snapshot: { stale: true, positions: [] }, openOrders: [] })
    } finally {
      releaseAcquire()
      await c.close()
    }
  })

  it('does not confirm an empty view from an account subscription ack while REST is pending', async () => {
    const { hl, c } = await setup({ ws: true })
    let releaseAccount!: () => void
    let notifyStarted!: () => void
    const pendingAccount = new Promise<void>((resolve) => { releaseAccount = resolve })
    const accountStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    hl.info.set('clearinghouseState', async () => {
      notifyStarted()
      await pendingAccount
      return chState([])
    })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    try {
      const first = await c.accountView(ref())
      expect(first).toMatchObject({ stale: true, snapshot: { stale: true, positions: [] } })
      await accountStarted
      ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'spotState', user: MAIN } } })
      const afterAck = await c.accountView(ref())
      expect(afterAck.stale).toBe(true)
      expect(afterAck.snapshot.confirmedAt).toBeUndefined()
    } finally {
      releaseAccount()
      await c.close()
    }
  })

  it('returns the previous account cache while a background REST refresh is pending', async () => {
    const t = { now: FX_NOW }
    let holdBackground = false
    let releaseAcquire!: () => void
    let notifyStarted!: () => void
    const pendingAcquire = new Promise<void>((resolve) => { releaseAcquire = resolve })
    const backgroundStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    const baseBudget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const budget: RateBudget = {
      acquire: async (weight, options) => {
        if (holdBackground && options?.kind === 'background') {
          notifyStarted()
          await pendingAcquire
        }
        await baseBudget.acquire(weight, options)
      },
      charge: (weight, kind) => baseBudget.charge(weight, kind),
      penalize: (retryAfterMs) => baseBudget.penalize(retryAfterMs),
      reportOk: () => baseBudget.reportOk(),
      usage: () => baseBudget.usage(),
    }
    const { hl, c } = await setup({ ws: true, clock: t, budget, extra: { accounts: { restFallbackMs: 1_000 } } })
    installSnapshots({ positions: [pos('BTC', '0.01')], orders: {}, fills: [] })
    let restMode = 0
    hl.info.set('userFillsByTime', () => [])
    hl.info.set('clearinghouseState', (b) => b.dex ? zeroState() : chState([pos('BTC', restMode ? '0.02' : '0.01')]))
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    try {
      await waitForAccountView(c)
      await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.rules?.maxOpenOrders?.cap).toBe(1000))
      await vi.waitFor(() => expect(hl.infoCalls('clearinghouseState')).toHaveLength(5))
      await vi.waitFor(async () => expect((await c.startupSnapshot(ref(), FX_NOW)).account.stale).toBe(false))
      restMode = 1
      t.now += 3_001
      ws.drop()
      holdBackground = true
      const refreshRead = c.accountView(ref())
      await backgroundStarted
      const cached = await Promise.race([
        refreshRead,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('cached account read waited for background REST')), 100)),
      ])
      expect(cached).toMatchObject({ stale: true, snapshot: { positions: [{ size: '0.01' }] } })
      releaseAcquire()
      await vi.waitFor(async () => expect((await c.accountState(ref())).positions[0]?.size).toBe('0.02'))
    } finally {
      releaseAcquire()
      await c.close()
    }
  })

  it('returns the cached open-order cap while an expired limit refresh is pending', async () => {
    const t = { now: FX_NOW }
    let releaseAcquire!: () => void
    const pendingAcquire = new Promise<void>((resolve) => { releaseAcquire = resolve })
    let blockNextAcquire = false
    let refreshKind: string | undefined
    let pendingAcquires = 0
    let released = false
    const baseBudget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const budget: RateBudget = {
      acquire: async (weight, options) => {
        if (blockNextAcquire && options?.kind === 'background') {
          blockNextAcquire = false
          refreshKind = options?.kind
          pendingAcquires++
          await pendingAcquire
        }
        await baseBudget.acquire(weight, options)
      },
      charge: (weight, kind) => baseBudget.charge(weight, kind),
      penalize: (retryAfterMs) => baseBudget.penalize(retryAfterMs),
      reportOk: () => baseBudget.reportOk(),
      usage: () => baseBudget.usage(),
    }
    const { c, hl } = await setup({
      ws: true,
      clock: t,
      budget,
    })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    await c.market.start()
    FakeWebSocket.last.open()
    const first = await c.accountView(ref())
    expect(first.snapshot.rules?.maxOpenOrders).toBeUndefined()
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.rules?.maxOpenOrders?.cap).toBe(1000))
    const cached = await c.accountView(ref())
    expect(cached.snapshot.rules?.maxOpenOrders?.cap).toBe(1000)
    const accountRestCalls = () => hl.infoCalls().filter((call) => ['clearinghouseState', 'spotClearinghouseState', 'frontendOpenOrders'].includes(call.body.type))
    const accountRestBefore = accountRestCalls()

    t.now += 60_001
    FakeWebSocket.last.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } })
    FakeWebSocket.last.push({ channel: 'allDexsClearinghouseState', data: { user: MAIN, clearinghouseStates: [['', chState([])], ['xyz', zeroState()], ['io', zeroState()], ['para', zeroState()], ['mkts', zeroState()]] } })
    blockNextAcquire = true
    try {
      const pendingView = c.accountView(ref())
      await vi.waitFor(() => expect(pendingAcquires).toBe(1))
      const settledBeforeRefresh = await Promise.race([
        pendingView.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
      ])
      expect(settledBeforeRefresh).toBe(true)
      const second = await pendingView
      expect(refreshKind).toBe('background')
      expect(released).toBe(false)
      expect(second.snapshot.rules?.maxOpenOrders?.cap).toBe(1000)
      expect(second.snapshot.confirmedAt).toBe(t.now)
      expect(second.stale).toBe(false)
      expect(accountRestCalls()).toEqual(accountRestBefore)
      expect(hl.infoCalls('userRateLimit')).toHaveLength(1)
    } finally {
      released = true
      releaseAcquire()
      await c.close()
    }
  })

  it('single-flights cap refreshes and aborts an unsettled refresh on close', async () => {
    const t = { now: FX_NOW }
    let blockBackground = false
    let backgroundAcquires = 0
    let wasAborted = false
    const baseBudget = createWeightBudget({ clock: () => t.now, targetRatio: 1, sleep: async () => { throw new Error('unexpected budget sleep') } })
    const budget: RateBudget = {
      acquire: async (weight, options) => {
        if (blockBackground && options?.kind === 'background') {
          backgroundAcquires++
          await new Promise<void>((_resolve, reject) => {
            if (options.signal?.aborted) { wasAborted = true; reject(options.signal.reason); return }
            options.signal?.addEventListener('abort', () => { wasAborted = true; reject(options.signal?.reason) }, { once: true })
          })
        }
        await baseBudget.acquire(weight, options)
      },
      charge: (weight, kind) => baseBudget.charge(weight, kind),
      penalize: (retryAfterMs) => baseBudget.penalize(retryAfterMs),
      reportOk: () => baseBudget.reportOk(),
      usage: () => baseBudget.usage(),
    }
    const { hl, c } = await setup({ ws: true, clock: t, budget })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    await c.market.start()
    FakeWebSocket.last.open()
    await c.accountView(ref())
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.rules?.maxOpenOrders?.cap).toBe(1000))
    const first = await c.accountView(ref())
    expect(first.snapshot.rules?.maxOpenOrders?.cap).toBe(1000)

    t.now += 60_001
    FakeWebSocket.last.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } })
    FakeWebSocket.last.push({ channel: 'allDexsClearinghouseState', data: { user: MAIN, clearinghouseStates: [['', chState([])], ['xyz', zeroState()], ['io', zeroState()], ['para', zeroState()], ['mkts', zeroState()]] } })
    blockBackground = true
    const views = Promise.all([c.accountView(ref()), c.accountView(ref())])
    const finishedBeforeClose = await Promise.race([
      views.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
    ])
    await c.close()
    await views

    expect(finishedBeforeClose).toBe(true)
    expect(backgroundAcquires).toBe(1)
    expect(wasAborted).toBe(true)
    expect(hl.infoCalls('userRateLimit')).toHaveLength(1)
  })

  it('untrack aborts a pending startup cap refresh even without a tracked stream', async () => {
    const t = { now: FX_NOW }
    let blockBackground = false
    let wasAborted = false
    const baseBudget = createWeightBudget({ clock: () => t.now, targetRatio: 1, sleep: async () => { throw new Error('unexpected budget sleep') } })
    const budget: RateBudget = {
      acquire: async (weight, options) => {
        if (blockBackground && options?.kind === 'background') {
          await new Promise<void>((_resolve, reject) => {
            if (options.signal?.aborted) { wasAborted = true; reject(options.signal.reason); return }
            options.signal?.addEventListener('abort', () => { wasAborted = true; reject(options.signal?.reason) }, { once: true })
          })
        }
        await baseBudget.acquire(weight, options)
      },
      charge: (weight, kind) => baseBudget.charge(weight, kind),
      penalize: (retryAfterMs) => baseBudget.penalize(retryAfterMs),
      reportOk: () => baseBudget.reportOk(),
      usage: () => baseBudget.usage(),
    }
    const { hl, c } = await setup({ clock: t, budget, extra: { accounts: { stream: false } } })
    hl.info.set('userFillsByTime', () => [])
    await c.startupSnapshot(ref(), FX_NOW)
    await vi.waitFor(async () => expect((await c.startupSnapshot(ref(), FX_NOW)).account.rules?.maxOpenOrders?.cap).toBe(1000))
    t.now += 60_001
    blockBackground = true
    await c.startupSnapshot(ref(), FX_NOW)
    c.untrackAccount(ref().address)

    expect(wasAborted).toBe(true)
    expect(hl.infoCalls('userRateLimit')).toHaveLength(1)
    await c.close()
  })

  it('keeps an old cap and warns once when a background limit refresh is rejected', async () => {
    const t = { now: FX_NOW }
    const warnings: string[] = []
    const { hl, c } = await setup({ ws: true, clock: t, extra: { accounts: { restFallbackMs: 120_000 }, onWarn: (message) => warnings.push(message) } })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    await c.market.start()
    FakeWebSocket.last.open()
    await c.accountView(ref())
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.rules?.maxOpenOrders?.cap).toBe(1000))
    const accountRestCalls = () => hl.infoCalls().filter((call) => ['clearinghouseState', 'spotClearinghouseState', 'frontendOpenOrders'].includes(call.body.type))
    const accountRestBefore = accountRestCalls()
    hl.info.set('userRateLimit', () => new Response('sensitive response detail', { status: 429 }))
    t.now += 60_001
    FakeWebSocket.last.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } })
    const refreshed = await c.accountView(ref())
    await vi.waitFor(() => expect(warnings).toHaveLength(1))
    const stillCached = await c.accountView(ref())

    expect(c.budget.usage().backoffUntil).toBeGreaterThan(t.now)
    expect(refreshed.snapshot.rules?.maxOpenOrders?.cap).toBe(1000)
    expect(refreshed.snapshot.confirmedAt).toBe(t.now)
    expect(refreshed.stale).toBe(false)
    expect(stillCached.snapshot.rules?.maxOpenOrders?.cap).toBe(1000)
    expect(stillCached.snapshot.confirmedAt).toBe(t.now)
    expect(stillCached.stale).toBe(false)
    expect(accountRestCalls()).toEqual(accountRestBefore)
    expect(hl.infoCalls('userRateLimit')).toHaveLength(2)
    expect(warnings).toEqual(['挂单限额刷新失败；保留已缓存限额'])
    expect(warnings[0]).not.toContain('sensitive response detail')
    await c.close()
  })

  it('does not treat public mids, another user ack, or an unsubscribe ack as account confirmation', async () => {
    const t = { now: FX_NOW }
    const { c } = await setup({ ws: true, clock: t, extra: { accounts: { readyTimeoutMs: 0, restFallbackMs: 10_000 } } })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const first = await waitForAccountView(c)
    const restConfirmedAt = first.snapshot.confirmedAt
    t.now += 1_000
    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'spotState', user: `${MAIN.slice(0, -1)}3` } } })
    ws.push({ channel: 'subscriptionResponse', data: { method: 'unsubscribe', subscription: { type: 'spotState', user: MAIN } } })
    ws.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } })
    const quiet = await c.accountView(ref())
    expect(quiet.snapshot.confirmedAt).toBe(restConfirmedAt)
    expect(quiet.asOf).toBe(first.asOf)
    await c.close()
  })

  it('a clearinghouse ack cannot confirm an empty view, then confirms a complete quiet view without moving asOf', async () => {
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ ws: true, clock: t, extra: { accounts: { readyTimeoutMs: 0, restFallbackMs: 10_000 } } })
    let releaseRest!: () => void
    let notifyRestStarted!: () => void
    const pendingRest = new Promise<void>((resolve) => { releaseRest = resolve })
    const restStarted = new Promise<void>((resolve) => { notifyRestStarted = resolve })
    hl.info.set('clearinghouseState', async () => { notifyRestStarted(); await pendingRest; return chState([]) })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    try {
      const first = await c.accountView(ref({ accountModel: 'standard' }))
      expect(first.stale).toBe(true)
      await restStarted
      ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: MAIN.toUpperCase() } } })
      const afterEmptyAck = await c.accountView(ref({ accountModel: 'standard' }))
      expect(afterEmptyAck.stale).toBe(true)
      expect(afterEmptyAck.snapshot.confirmedAt).toBeUndefined()

      ws.push({ channel: 'allDexsClearinghouseState', data: { user: MAIN, clearinghouseStates: [['', chState([])], ['xyz', zeroState()], ['io', zeroState()], ['para', zeroState()], ['mkts', zeroState()]] } })
      ws.push({ channel: 'spotState', data: { user: MAIN, spotState: { balances: [] } } })
      for (const dex of ['', 'xyz', 'io', 'para', 'mkts']) ws.push({ channel: 'openOrders', data: { user: MAIN, dex, orders: [] } })
      const complete = await c.accountView(ref({ accountModel: 'standard' }))
      expect(complete.stale).toBe(false)
      const asOf = complete.asOf
      t.now += 1_000
      ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: MAIN.toUpperCase() } } })
      const quiet = await c.accountView(ref({ accountModel: 'standard' }))
      expect(quiet.snapshot.confirmedAt).toBe(t.now)
      expect(quiet.asOf).toBe(asOf)
    } finally {
      releaseRest()
      await c.close()
    }
  })

  it('merges a pending REST bootstrap around newer WS clearing and order shards', async () => {
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ ws: true, clock: t })
    let releaseDefault!: () => void
    let notifyDefaultStarted!: () => void
    const pendingDefault = new Promise<void>((resolve) => { releaseDefault = resolve })
    const defaultStarted = new Promise<void>((resolve) => { notifyDefaultStarted = resolve })
    hl.info.set('clearinghouseState', async (body) => {
      if ((body.dex ?? '') === '') {
        notifyDefaultStarted()
        await pendingDefault
        return chState([pos('BTC', '0.01')])
      }
      return zeroState()
    })
    hl.info.set('spotClearinghouseState', () => ({ balances: [{ coin: 'REST_ONLY', total: '50', hold: '0' }] }))
    hl.info.set('frontendOpenOrders', () => [])
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    try {
      const initial = await c.startupSnapshot(ref({ accountModel: 'standard' }), FX_NOW)
      expect(initial.account.stale).toBe(true)
      await defaultStarted
      t.now += 1_000
      ws.push({ channel: 'allDexsClearinghouseState', data: { user: MAIN, clearinghouseStates: [['', chState([pos('BTC', '0.02')])]] } })
      ws.push({ channel: 'openOrders', data: { user: MAIN, dex: '', orders: [rawOrder('BTC', 71, { orderType: 'Stop Market', isTrigger: true, triggerPx: '70000', reduceOnly: true })] } })
      releaseDefault()
      await vi.waitFor(async () => expect((await c.accountView(ref({ accountModel: 'standard' }))).stale).toBe(false))
      const view = await c.accountView(ref({ accountModel: 'standard' }))
      expect(view).toMatchObject({ stale: false, source: 'ws' })
      expect(view.snapshot.positions[0]).toMatchObject({ size: '0.02' })
      expect(view.openOrders).toMatchObject([{ venueOrderId: '71', type: 'stop_market', triggerPrice: '70000', reduceOnly: true }])
      expect(view.snapshot.stopLossOrderIds).toEqual(['71'])
      expect(view.snapshot.balances.find((balance) => balance.asset === 'REST_ONLY')).toMatchObject({ total: '50' })
      expect(view.snapshot.confirmedAt).toBe(t.now)
    } finally {
      releaseDefault()
      await c.close()
    }
  })

  it('a new connection needs its own clearinghouse confirmation after reconnect', async () => {
    vi.useFakeTimers()
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ ws: true, clock: t, extra: { accounts: { readyTimeoutMs: 0, restFallbackMs: 10_000 } } })
    await c.market.start()
    const firstWs = FakeWebSocket.last
    firstWs.open()
    const firstView = await c.accountView(ref())
    expect(firstView.stale).toBe(true)
    const first = await waitForAccountView(c)
    t.now += 10_000
    firstWs.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: MAIN } } })
    const acknowledged = await c.accountView(ref())
    expect(acknowledged.asOf).toBe(first.asOf)
    let releaseRest!: () => void
    const pendingRest = new Promise<void>((resolve) => { releaseRest = resolve })
    hl.info.set('clearinghouseState', async () => { await pendingRest; return chState([]) })
    firstWs.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    const secondWs = FakeWebSocket.last
    secondWs.open()
    t.now += 15_000 // 新连接在旧清算证据仍未过 20 秒时重连；REST 已过期
    secondWs.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } })
    secondWs.push({ channel: 'openOrders', data: { user: MAIN, dex: '', orders: [] } })
    const afterReconnect = await c.accountView(ref())
    expect(acknowledged.snapshot.confirmedAt).toBe(FX_NOW + 10_000)
    expect(afterReconnect.stale).toBe(true)
    expect(afterReconnect.snapshot.confirmedAt).toBe(acknowledged.snapshot.confirmedAt)
    expect(afterReconnect.asOf).toBe(t.now)
    secondWs.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: MAIN } } })
    const afterClearingAck = await c.accountView(ref())
    expect(afterClearingAck.stale).toBe(false)
    expect(afterClearingAck.snapshot.confirmedAt).toBe(t.now)
    releaseRest()
    await c.close()
  })

  it('order traffic cannot keep clearinghouse evidence fresh while REST is pending', async () => {
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ ws: true, clock: t, extra: { staleMs: 200_000, accounts: { restFallbackMs: 10_000 } } })
    hl.info.set('clearinghouseState', (body) => body.dex ? zeroState() : chState([pos('BTC', '0.01')]))
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const first = await waitForAccountView(c)
    expect(first.snapshot.positions[0]?.size).toBe('0.01')
    ws.push({ channel: 'allDexsClearinghouseState', data: { user: MAIN, clearinghouseStates: [['', chState([pos('BTC', '0.01')])]] } })
    const confirmedAt = first.snapshot.confirmedAt
    let releaseRest!: () => void
    let notifyRestStarted!: () => void
    const pendingRest = new Promise<void>((resolve) => { releaseRest = resolve })
    const restStarted = new Promise<void>((resolve) => { notifyRestStarted = resolve })
    hl.info.set('clearinghouseState', async (body) => {
      notifyRestStarted()
      await pendingRest
      return body.dex ? zeroState() : chState([pos('BTC', '0.05')])
    })

    for (let i = 0; i < 150; i++) {
      t.now += 1_000
      ws.push({ channel: 'openOrders', data: { user: MAIN, dex: '', orders: [] } })
    }
    const refreshing = await c.accountView(ref())
    await restStarted
    expect(refreshing.stale).toBe(true)
    expect(refreshing.snapshot.confirmedAt).toBe(confirmedAt)
    releaseRest()
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.positions[0]?.size).toBe('0.05'))
    const refreshed = await c.accountView(ref())
    expect(refreshed.stale).toBe(false)
    expect(refreshed.snapshot.confirmedAt).toBe(t.now)
    await c.close()
  })

  it('keeps confirmedAt monotonic when a healthy view follows a small clock rollback', async () => {
    const t = { now: FX_NOW }
    const { c } = await setup({ ws: true, clock: t, extra: { accounts: { restFallbackMs: 10_000 } } })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const restView = await waitForAccountView(c)
    const restConfirmedAt = restView.snapshot.confirmedAt!
    t.now += 1_000
    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: MAIN } } })
    t.now += 1_000
    const advanced = await c.accountView(ref())
    expect(advanced.snapshot.confirmedAt).toBe(t.now)
    t.now -= 500
    const rolledBack = await c.accountView(ref())
    expect(restConfirmedAt).toBeLessThan(advanced.snapshot.confirmedAt!)
    expect(rolledBack.snapshot.confirmedAt).toBe(advanced.snapshot.confirmedAt)
    await c.close()
  })

  it('keeps confirmedAt monotonic when a clearinghouse ack follows a small clock rollback', async () => {
    const t = { now: FX_NOW }
    const { c } = await setup({ ws: true, clock: t, extra: { accounts: { restFallbackMs: 10_000 } } })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const restView = await waitForAccountView(c)
    const restConfirmedAt = restView.snapshot.confirmedAt!
    t.now += 2_000
    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: MAIN } } })
    const advanced = await c.accountView(ref())
    expect(advanced.snapshot.confirmedAt).toBe(t.now)
    t.now -= 1_000
    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'allDexsClearinghouseState', user: MAIN } } })
    const rolledBack = await c.accountView(ref())
    expect(restConfirmedAt).toBeLessThan(advanced.snapshot.confirmedAt!)
    expect(rolledBack.snapshot.confirmedAt).toBe(advanced.snapshot.confirmedAt)
    await c.close()
  })

  it('does not confirm the account from spot, order, or fills acknowledgements and pushes', async () => {
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ ws: true, clock: t, extra: { accounts: { restFallbackMs: 10_000 } } })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const first = await waitForAccountView(c)
    const confirmedAt = first.snapshot.confirmedAt
    let releaseRest!: () => void
    const pendingRest = new Promise<void>((resolve) => { releaseRest = resolve })
    hl.info.set('clearinghouseState', async () => { await pendingRest; return chState([]) })
    t.now += 20_001
    await c.accountView(ref()) // expire clearing evidence and begin a pending REST fallback

    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'spotState', user: MAIN } } })
    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'openOrders', user: MAIN } } })
    ws.push({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'userFills', user: MAIN } } })
    ws.push({ channel: 'spotState', data: { user: MAIN, spotState: { balances: [] } } })
    ws.push({ channel: 'openOrders', data: { user: MAIN, dex: '', orders: [] } })
    ws.push({ channel: 'userFills', data: { user: MAIN, isSnapshot: false, fills: [] } })
    const afterShardTraffic = await c.accountView(ref())
    expect(afterShardTraffic.stale).toBe(true)
    expect(afterShardTraffic.snapshot.confirmedAt).toBe(confirmedAt)
    releaseRest()
    await c.close()
  })

  it('a disconnected account view is fresh after a successful REST fallback', async () => {
    const t = { now: FX_NOW }
    const budget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const { hl, c } = await setup({ ws: true, clock: t, budget, extra: { accounts: { restFallbackMs: 1_000 } } })
    installSnapshots({ positions: [pos('BTC', '0.01')], orders: {}, fills: [] })
    hl.info.set('userFillsByTime', () => [])
    hl.info.set('clearinghouseState', (b) => (b.dex ? zeroState() : chState([pos('BTC', '0.02')])))
    await c.market.start()
    FakeWebSocket.last.open()
    const first = await waitForAccountView(c)
    expect(first.snapshot.positions[0]?.size).toBe('0.01')
    await vi.waitFor(async () => expect((await c.startupSnapshot(ref(), FX_NOW)).account.stale).toBe(false))
    const clearingCallsBeforeDisconnect = hl.infoCalls('clearinghouseState').length
    t.now += 1_001
    FakeWebSocket.last.drop()
    const recovering = await c.accountView(ref())
    expect(recovering.stale).toBe(false)
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.asOf).toBe(t.now))
    const recovered = await c.accountView(ref())
    expect(hl.infoCalls('clearinghouseState').length).toBe(clearingCallsBeforeDisconnect + 5)
    expect(recovered.stale).toBe(false)
    expect(recovered.snapshot.confirmedAt).toBe(t.now)
    expect(recovered.snapshot.positions[0]?.size).toBe('0.02')
    await c.close()
  })

  it('keeps the last snapshot stale when REST fallback fails after both sources expire', async () => {
    const t = { now: FX_NOW }
    const warnings: string[] = []
    const { hl, c } = await setup({ ws: true, clock: t, extra: { accounts: { restFallbackMs: 1_000 }, onWarn: (message: string) => warnings.push(message) } as Partial<HyperliquidConnectorOptions> })
    installSnapshots({ positions: [pos('BTC', '0.01')], orders: {}, fills: [] })
    await c.market.start()
    FakeWebSocket.last.open()
    const first = await waitForAccountView(c)
    hl.info.set('clearinghouseState', () => new Response('upstream detail', { status: 500 }))
    t.now += 2_001
    FakeWebSocket.last.drop()
    const stale = await c.accountView(ref())
    expect(stale.stale).toBe(true)
    expect(stale.snapshot.positions).toEqual(first.snapshot.positions)
    await vi.waitFor(() => expect(warnings).toHaveLength(1))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('upstream detail')
    await c.close()
  })

  it('keeps an empty stale cache when the initial background REST snapshot fails', async () => {
    const warnings: string[] = []
    const { hl, c } = await setup({ ws: true, extra: { accounts: { readyTimeoutMs: 0 }, onWarn: (message) => warnings.push(message) } })
    await c.market.start()
    FakeWebSocket.last.open()
    hl.info.set('clearinghouseState', () => new Response('upstream detail', { status: 500 }))

    const initial = await c.accountView(ref())
    expect(initial).toMatchObject({ stale: true, snapshot: { stale: true, positions: [] }, openOrders: [] })
    await vi.waitFor(() => expect(warnings).toEqual(['账户 REST 后台刷新失败；保留最后快照']))
    await c.close()
  })

  it('rate limits each fixed background account warning to ten minutes', async () => {
    const t = { now: FX_NOW }
    const warnings: string[] = []
    const { hl, c } = await setup({ ws: true, clock: t, extra: { accounts: { readyTimeoutMs: 0, restFallbackMs: 1_000 }, onWarn: (message) => warnings.push(message) } })
    await c.market.start()
    FakeWebSocket.last.open()
    hl.info.set('clearinghouseState', () => new Response('upstream detail', { status: 500 }))
    await c.accountView(ref())
    await vi.waitFor(() => expect(warnings).toEqual(['账户 REST 后台刷新失败；保留最后快照']))

    t.now += 1_001
    await c.accountView(ref())
    await vi.waitFor(() => expect(hl.infoCalls('clearinghouseState').length).toBeGreaterThan(5))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('upstream detail')

    t.now += 598_999
    await c.accountView(ref())
    await vi.waitFor(() => expect(warnings).toHaveLength(2))
    expect(warnings).toEqual(['账户 REST 后台刷新失败；保留最后快照', '账户 REST 后台刷新失败；保留最后快照'])
    await c.close()
  })

  it('untrack aborts pending account REST and prevents its late result from seeding a new tracked instance', async () => {
    const warnings: string[] = []
    const { hl, c } = await setup({ extra: { onWarn: (message) => warnings.push(message) } })
    let releaseOld!: () => void
    let notifyOldStarted!: () => void
    let clearingCalls = 0
    const pendingOld = new Promise<void>((resolve) => { releaseOld = resolve })
    const oldStarted = new Promise<void>((resolve) => { notifyOldStarted = resolve })
    hl.info.set('clearinghouseState', async () => {
      clearingCalls++
      if (clearingCalls <= 5) {
        notifyOldStarted()
        await pendingOld
        return chState([pos('BTC', '9')])
      }
      return new Response('upstream detail', { status: 500 })
    })
    try {
      const first = await c.accountView(ref())
      expect(first).toMatchObject({ stale: true, snapshot: { positions: [] } })
      await oldStarted
      c.untrackAccount(ref().address)
      const newTracked = await c.accountView(ref())
      expect(newTracked).toMatchObject({ stale: true, snapshot: { positions: [] } })
      releaseOld()
      await vi.waitFor(() => expect(warnings).toEqual(['账户 REST 后台刷新失败；保留最后快照']))
      expect((await c.accountView(ref())).snapshot.positions).toEqual([])
      expect((await c.accountView(ref())).snapshot.confirmedAt).toBeUndefined()
    } finally {
      releaseOld()
      await c.close()
    }
  })

  it('uses the real REST success time when that time is zero', async () => {
    const t = { now: 0 }
    const { c } = await setup({ clock: t })
    const snapshot = await waitForAccount(c)
    expect(snapshot.confirmedAt).toBe(0)
    expect(snapshot.stale).toBe(false)
    await c.close()
  })

  it('keeps the first read stale, then caches account data without adding REST or query weight on repeated reads', async () => {
    const { hl, c } = await setup({ ws: true })
    installSnapshots({ positions: [pos('BTC', '0.01')], orders: { '': [rawOrder('BTC', 5)] }, fills: [rawFill(1)] })
    await c.market.start()
    FakeWebSocket.last.open()
    hl.calls.length = 0
    const initial = await c.accountView(ref())
    expect(initial).toMatchObject({ stale: true, snapshot: { stale: true, positions: [] }, openOrders: [] })
    const first = await waitForAccountView(c)
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.rules?.maxOpenOrders?.cap).toBe(1000))
    await vi.waitFor(() => expect(hl.infoCalls('clearinghouseState')).toHaveLength(5))
    await vi.waitFor(() => expect(hl.infoCalls('frontendOpenOrders')).toHaveLength(5))
    // 首次缓存可由账户流或后台 REST 完成；后续读取均不再等待 REST / query 预算。
    expect(hl.infoCalls().map((x) => x.body.type).sort()).toEqual([
      ...Array(5).fill('clearinghouseState'), ...Array(5).fill('frontendOpenOrders'), 'spotClearinghouseState', 'userAbstraction', 'userRateLimit',
    ].sort())
    expect(first.stale).toBe(false)
    expect(first.snapshot.positions[0]).toMatchObject({ instrumentId: 'hyperliquid:BTC', side: 'long', size: '0.01' })
    expect(first.snapshot.margin).toMatchObject({ equity: '1000.5', model: 'standard' })
    expect(first.openOrders[0]).toMatchObject({ venueOrderId: '5', type: 'unknown' }) // WS 推送不带订单类型：不猜
    expect(first.fills).toHaveLength(1)

    const restCallsBefore = hl.calls.map((call) => ({ ...call, body: { ...call.body } }))
    const queryWeightBefore = c.budget.usage().byKind.query
    for (let i = 0; i < 200; i++) { await c.accountState(ref()); await c.openOrders(ref()); await c.fills(ref(), FX_NOW) }
    expect(hl.calls).toEqual(restCallsBefore)
    expect(c.budget.usage().byKind.query).toBe(queryWeightBefore)
    await c.close()
  })

  it('confirms a healthy quiet view without moving asOf and recovers freshness through REST after disconnect', async () => {
    const t = { now: FX_NOW }
    const budget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const { hl, c } = await setup({ ws: true, clock: t, budget })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    hl.info.set('userFillsByTime', () => [])
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const first = await waitForAccountView(c)
    await vi.waitFor(async () => expect((await c.startupSnapshot(ref(), FX_NOW)).account.stale).toBe(false))
    expect(first.snapshot.confirmedAt).toBe(FX_NOW)
    t.now += 10_001
    ws.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } })
    const quiet = await c.accountView(ref())
    expect(quiet.asOf).toBe(first.asOf)
    expect(quiet.snapshot.confirmedAt).toBe(t.now)
    ws.drop()
    const disconnected = await c.accountView(ref())
    expect(disconnected.stale).toBe(false)
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.asOf).toBe(t.now))
    const recovered = await waitForAccountView(c)
    expect(recovered.stale).toBe(false)
    expect(recovered.snapshot.asOf).toBe(t.now)
    expect(recovered.snapshot.confirmedAt).toBe(t.now)
    await c.close()
  })

  it('keeps missing WS order metadata from overwriting known reduce-only stop loss data', async () => {
    const { c } = await setup({ ws: true })
    installSnapshots({ positions: [], orders: { '': [rawOrder('BTC', 5, { orderType: 'Stop Market', isTrigger: true, triggerPx: '70000', reduceOnly: true })] }, fills: [] })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    await waitForAccountView(c)
    ws.push({ channel: 'openOrders', data: { dex: '', user: MAIN, orders: [rawOrder('BTC', 5, { sz: '0.005' })] } })
    const view = await c.accountView(ref())
    expect(view.openOrders[0]).toMatchObject({ reduceOnly: true, type: 'stop_market', isTrigger: true, triggerPrice: '70000' })
    expect(view.snapshot.openOrders).toEqual([])
    expect(view.snapshot.stopLossOrderIds).toEqual(['5'])
    await c.close()
  })

  it('builds sorted exposure groups, stop-loss IDs, and a volume-derived live-order cap', async () => {
    const { hl, c } = await setup()
    hl.info.set('userRateLimit', () => ({ cumVlm: '12500000', nRequestsUsed: 0, nRequestsCap: 0, nRequestsSurplus: 0 }))
    hl.info.set('frontendOpenOrders', (b) => b.dex ? [] : [
      rawOrder('BTC', 1, { side: 'B', limitPx: '79000', sz: '0.01', origSz: '0.02', orderType: 'Limit' }),
      rawOrder('BTC', 2, { side: 'B', limitPx: '', sz: '0.01', orderType: 'Stop Market', isTrigger: true, triggerPx: '80000' }),
      rawOrder('BTC', 3, { side: 'A', limitPx: '', sz: '0.02', orderType: 'Stop Limit', isTrigger: true, triggerPx: '78000', reduceOnly: true }),
      rawOrder('BTC', 4, { side: 'A', limitPx: '81000', sz: '0.02', orderType: 'Limit' }),
      rawOrder('BTC', 5, { side: 'A', limitPx: '', sz: '0.01', orderType: 'Take Profit Market', isTrigger: true, triggerPx: '85000', reduceOnly: true }),
      rawOrder('xyz:TSLA', 6, { side: 'A', limitPx: '380.5', sz: '2', orderType: 'Limit' }),
      rawOrder('BTC', 7, { side: 'B', limitPx: '77000', sz: '0.1', orderType: 'Limit', reduceOnly: true }),
    ])
    const initial = await c.accountState(ref())
    expect(initial.rules?.maxOpenOrders).toBeUndefined()
    await vi.waitFor(async () => expect((await c.accountState(ref())).rules?.maxOpenOrders?.cap).toBe(1002))
    const s = await waitForAccount(c)
    expect(s).toMatchObject({
      availableDeductsOpenOrders: true,
      openOrders: [
        { instrumentId: 'hyperliquid:BTC', side: 'buy', notional: '1590', count: 2 },
        { instrumentId: 'hyperliquid:BTC', side: 'sell', notional: '1620', count: 1 },
        { instrumentId: 'hyperliquid:xyz:TSLA', side: 'sell', notional: '761', count: 1 },
      ],
      stopLossOrderIds: ['3'],
      rules: { marketPriceBandBps: 800, minOrderNotional: '10', maxOpenOrders: { cap: 1002, current: 7 } },
    })
    expect(hl.infoCalls('userRateLimit')).toHaveLength(1)
  })

  it('uses UTF-16 order for mixed-case exposure groups and triggered unknown stop orders', async () => {
    const { hl, c } = await setup()
    hl.info.set('frontendOpenOrders', (b) => b.dex ? [] : [
      rawOrder('a', 1, { side: 'A', limitPx: '10', sz: '1', orderType: 'Limit' }),
      rawOrder('A', 2, { side: 'A', limitPx: '10', sz: '1', orderType: 'Limit' }),
      rawOrder('a', 2, { side: 'B', limitPx: '10', sz: '1', orderType: 'Limit' }),
      rawOrder('A', 1, { side: 'B', limitPx: '10', sz: '1', orderType: 'Limit' }),
      rawOrder('A', 10, { side: 'B', limitPx: '', sz: '1', orderType: 'Unrecognized Trigger', isTrigger: true, triggerPx: '10', reduceOnly: true }),
      rawOrder('A', 11, { side: 'A', limitPx: '', sz: '1', orderType: 'Take Profit Market', isTrigger: true, triggerPx: '10', reduceOnly: true }),
    ])
    const view = await waitForAccountView(c)
    expect(view.snapshot.openOrders?.map((x) => [x.instrumentId, x.side])).toEqual([
      ['hyperliquid:A', 'buy'], ['hyperliquid:A', 'sell'], ['hyperliquid:a', 'buy'], ['hyperliquid:a', 'sell'],
    ])
    expect(view.snapshot.stopLossOrderIds).toEqual(['10'])
    expect(view.openOrders.find((order) => order.venueOrderId === '10')).toMatchObject({ type: 'unknown', reduceOnly: true, isTrigger: true })
    expect(view.openOrders.some((order) => order.venueOrderId === '11')).toBe(true)
  })

  it('uses exact volume math, caps at 5000, and expires user-limit cache at 60 seconds', async () => {
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ clock: t })
    let calls = 0
    hl.info.set('userRateLimit', () => { calls++; return { cumVlm: '999999999999999999999999999999999999', nRequestsUsed: 0, nRequestsCap: 0, nRequestsSurplus: 0 } })
    const initial = await c.accountState(ref())
    expect(initial.rules?.maxOpenOrders).toBeUndefined()
    await vi.waitFor(async () => expect((await c.accountState(ref())).rules?.maxOpenOrders?.cap).toBe(5000))
    expect(calls).toBe(1)
    t.now += 59_999
    expect((await c.accountState(ref())).rules?.maxOpenOrders?.cap).toBe(5000)
    expect(calls).toBe(1)
    t.now += 1
    expect((await c.accountState(ref())).rules?.maxOpenOrders?.cap).toBe(5000)
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(calls).toBe(2)
  })

  it('omits a dynamic cap when user-rate-limit lookup fails or cumVlm is invalid', async () => {
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ clock: t })
    const cases: Array<() => unknown> = [
      () => { throw new Error('lookup failed') },
      () => ({ cumVlm: '-1' }),
      () => ({ cumVlm: '1e9' }),
    ]
    for (let i = 0; i < cases.length; i++) {
      hl.info.set('userRateLimit', cases[i]!)
      if (i) t.now += 60_000
      const address = `0x${String(i + 1).padStart(40, '0')}` as AccountRef['address']
      const snapshot = await c.accountState(ref({ address }))
      expect(snapshot.rules).toMatchObject({ marketPriceBandBps: 800, minOrderNotional: '10' })
      expect(snapshot.rules?.maxOpenOrders).toBeUndefined()
    }
  })

  it('subscribes the cheapest set: one all-dex clearinghouse stream, spot, fills, and open orders per live dex', async () => {
    const { c } = await setup({ ws: true })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    await c.accountState(ref({ address: '0xABCDEF0000000000000000000000000000000001' }))
    const subs = ws.subs().filter((s) => s.user).map((s) => JSON.stringify(s))
    const u = '0xabcdef0000000000000000000000000000000001'
    expect(subs).toContain(JSON.stringify({ type: 'allDexsClearinghouseState', user: u }))
    expect(subs).toContain(JSON.stringify({ type: 'spotState', user: u }))
    expect(subs).toContain(JSON.stringify({ type: 'userFills', user: u }))
    expect(subs).toContain(JSON.stringify({ type: 'openOrders', user: u }))
    for (const d of ['xyz', 'io', 'para', 'mkts']) expect(subs).toContain(JSON.stringify({ type: 'openOrders', user: u, dex: d }))
    expect(subs.filter((s) => s.includes('"clearinghouseState"'))).toHaveLength(0) // 不按 dex 逐个订清算状态
    await c.close()
  })

  it('pushes update the local snapshot incrementally and move asOf forward', async () => {
    const t = { now: FX_NOW }
    const { hl, c } = await setup({ ws: true, clock: t })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const a = await c.accountView(ref())
    expect(a).toMatchObject({ stale: true, snapshot: { stale: true, positions: [] }, openOrders: [] })
    await waitForAccountView(c)
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.rules?.maxOpenOrders?.cap).toBe(1000))
    hl.calls.length = 0
    const beforeQueryWeight = c.budget.usage().byKind.query
    expect(a.snapshot.positions).toHaveLength(0)
    expect(a.openOrders).toHaveLength(0)

    t.now += 5000
    ws.push({ channel: 'openOrders', data: { dex: '', user: MAIN, orders: [rawOrder('BTC', 9, { orderType: 'Limit' })] } })
    ws.push({ channel: 'allDexsClearinghouseState', data: { user: MAIN, clearinghouseStates: [['', chState([pos('BTC', '-0.02', { unrealizedPnl: '-1.0' })])]] } })
    ws.push({ channel: 'userFills', data: { isSnapshot: false, user: MAIN, fills: [rawFill(7), rawFill(7), rawFill(8, { crossed: false })] } }) // tid 7 重复推送
    const b = await c.accountView(ref())
    expect(b.openOrders.map((o) => [o.venueOrderId, o.type])).toEqual([['9', 'limit']])
    expect(b.snapshot.positions[0]).toMatchObject({ side: 'short', size: '0.02', unrealizedPnl: '-1' })
    expect(b.fills.map((f) => f.venueFillId)).toEqual(['7', '8'])
    expect(b.asOf).toBe(FX_NOW + 5000)
    expect(b.snapshot.asOf).toBe(b.asOf)
    expect(b.snapshot.confirmedAt).toBe(FX_NOW + 5000)
    expect(hl.infoCalls()).toEqual([])
    expect(c.budget.usage().byKind.query).toBe(beforeQueryWeight)

    // 另一个账户的推送不会串进来
    ws.push({ channel: 'openOrders', data: { dex: '', user: '0x9999999999999999999999999999999999999999', orders: [rawOrder('BTC', 99)] } })
    expect((await c.accountView(ref())).openOrders.map((o) => o.venueOrderId)).toEqual(['9'])
    // 本次开始跟踪之后的成交读本地；更早的才回补
    expect((await c.fills(ref(), FX_NOW + 8)).map((f) => f.venueFillId)).toEqual(['8'])
    await c.close()
  })

  it('an order whose type the stream did not carry keeps the type learned earlier', async () => {
    const { c } = await setup({ ws: true })
    installSnapshots({ positions: [], orders: { '': [rawOrder('BTC', 5, { orderType: 'Stop Market', isTrigger: true, triggerPx: '70000' })] }, fills: [] })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    await waitForAccountView(c)
    expect((await c.openOrders(ref()))[0]).toMatchObject({ type: 'stop_market', triggerPrice: '70000' })
    ws.push({ channel: 'openOrders', data: { dex: '', user: MAIN, orders: [rawOrder('BTC', 5, { sz: '0.005' })] } }) // 部分成交后的更新，没带类型
    expect((await c.openOrders(ref()))[0]).toMatchObject({ type: 'stop_market', size: '0.005' })
    await c.close()
  })

  it('refreshes through REST when WS health expires and stays fresh once messages resume', async () => {
    const t = { now: FX_NOW }
    const budget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const { hl, c } = await setup({ ws: true, clock: t, budget, extra: { staleMs: 10_000 } })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    hl.info.set('userFillsByTime', () => [])
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    ws.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } })
    const first = await c.accountView(ref())
    expect(first.stale).toBe(true)
    await waitForAccountView(c)
    await vi.waitFor(async () => expect((await c.startupSnapshot(ref(), FX_NOW)).account.stale).toBe(false))
    t.now += 30_000 // 连接上什么都没来：账户数据没法证明是新的
    await vi.waitFor(async () => expect((await c.accountView(ref())).snapshot.asOf).toBe(t.now))
    const old = await c.accountView(ref())
    expect(old.stale).toBe(false)
    expect(old.asOf).toBe(t.now) // 成功的 REST 兜底更新快照时间
    ws.push({ channel: 'allMids', data: { mids: { BTC: '80001' } } })
    expect((await c.accountView(ref())).stale).toBe(false)
    await c.close()
  })

  it('no snapshot within the timeout: bootstraps once through REST, marks the source, and limits REST refreshes', async () => {
    const t = { now: FX_NOW }
    const budget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const { hl, c } = await setup({ ws: true, clock: t, budget, extra: { accounts: { readyTimeoutMs: 20, restFallbackMs: 10_000 } } })
    await c.market.start()
    FakeWebSocket.last.open() // 但场所不回首批快照
    FakeWebSocket.last.push({ channel: 'allMids', data: { mids: { BTC: '80000' } } }) // 行情 WS 健康，用户流仍需 REST 引导
    hl.info.set('clearinghouseState', (b) => (b.dex ? zeroState() : chState([pos('BTC', '0.01')])))
    const initial = await c.accountView(ref())
    expect(initial).toMatchObject({ stale: true, snapshot: { stale: true, positions: [] } })
    const a = await waitForAccountView(c)
    expect(a).toMatchObject({ source: 'rest', stale: false })
    expect(a.snapshot.positions).toHaveLength(1)
    const n = hl.infoCalls('clearinghouseState').length
    t.now += 10_001 // 用户订阅未确认：达到 REST 兜底间隔
    FakeWebSocket.last.push({ channel: 'allMids', data: { mids: { BTC: '80001' } } }) // 只维持行情 WS 健康，不推账户用户流
    await vi.waitFor(async () => expect((await c.accountView(ref())).asOf).toBe(t.now))
    const quietHealthy = await waitForAccountView(c)
    expect(quietHealthy.source).toBe('rest')
    expect(quietHealthy.stale).toBe(false)
    expect(quietHealthy.asOf).toBe(t.now)
    expect(quietHealthy.snapshot.confirmedAt).toBe(t.now)
    expect(n).toBe(5) // 引导一次：5 个在线 dex
    expect(hl.infoCalls('clearinghouseState').length).toBe(2 * n) // 未确认的账户流按 REST 间隔刷新
    // WS 不在线 → REST 兜底；首次刷新后仍按最小间隔限频
    FakeWebSocket.last.drop()
    await c.accountView(ref())
    expect(hl.infoCalls('clearinghouseState').length).toBe(2 * n)
    await c.accountView(ref())
    expect(hl.infoCalls('clearinghouseState').length).toBe(2 * n)
    t.now += 10_001
    await vi.waitFor(async () => expect((await c.accountView(ref())).asOf).toBe(t.now))
    await waitForAccountView(c)
    expect(hl.infoCalls('clearinghouseState').length).toBe(3 * n)
    expect((await c.accounts.view(ref())).source).toBe('rest')
    await c.close()
  })

  it('without a websocket at all, queries are rate-limited REST refreshes (disconnect-recovery path)', async () => {
    const t = { now: FX_NOW }
    const budget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const { hl, c } = await setup({ clock: t, budget })
    await c.accountState(ref())
    await waitForAccount(c)
    const n = hl.infoCalls('clearinghouseState').length
    for (let i = 0; i < 50; i++) await c.accountState(ref())
    expect(hl.infoCalls('clearinghouseState').length).toBe(n) // 10 s 内不重复打
    t.now += 10_001
    await c.accountState(ref())
    await vi.waitFor(() => expect(hl.infoCalls('clearinghouseState').length).toBe(2 * n))
    await waitForAccount(c)
    expect(hl.infoCalls('clearinghouseState').length).toBe(2 * n)
    t.now += 30_000
    expect((await c.accounts.view(ref())).stale).toBe(true)
    await vi.waitFor(async () => expect((await c.accounts.view(ref())).asOf).toBe(t.now))
    expect((await c.accounts.view(ref())).stale).toBe(false)
  })

  it('stream=false disables account WS and keeps a background REST cache', async () => {
    const { hl, c } = await setup({ ws: true, extra: { accounts: { stream: false } } })
    hl.info.set('userAbstraction', () => 'default')
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const w0 = c.budget.usage().used
    const initial = await c.accountState(ref())
    expect(initial).toMatchObject({ stale: true, positions: [] })
    expect(ws.subs().filter((sub) => sub.user)).toEqual([])
    const first = await waitForAccount(c)
    expect(first).toMatchObject({ stale: false, availableDeductsOpenOrders: true })
    await c.openOrders(ref())
    await vi.waitFor(async () => expect((await c.accountState(ref())).rules?.maxOpenOrders?.cap).toBe(1000))
    const restCount = hl.infoCalls().length
    const queryWeight = c.budget.usage().byKind.query
    await c.accountState(ref())
    await c.openOrders(ref())
    expect(hl.infoCalls()).toHaveLength(restCount)
    expect(c.budget.usage().byKind.query).toBe(queryWeight)
    expect(c.budget.usage().used).toBeGreaterThan(w0)
    await c.close()
  })

  it('refuses to track more accounts than the venue allows for user subscriptions', async () => {
    const { c } = await setup({ extra: { accounts: { maxTracked: 1 } } })
    await c.accountState(ref())
    await expect(c.accountState(ref({ address: '0x3333333333333333333333333333333333333333' }))).rejects.toMatchObject({ problem: { code: 4004 } })
  })

  it('open orders follow the live dex list: a dropped dex loses its subscription and its orders', async () => {
    const t = { now: FX_NOW }
    const budget = createWeightBudget({ clock: () => t.now, limit: 100_000, targetRatio: 1, backgroundShare: 1, queryShare: 1, sleep: async (ms) => { t.now += ms } })
    const { hl, c } = await setup({ ws: true, clock: t, budget })
    installSnapshots({ positions: [], orders: { para: [rawOrder('para:X', 1)] }, fills: [] })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    await vi.waitFor(async () => expect((await c.openOrders(ref())).map((o) => o.venueOrderId)).toEqual(['1']))
    hl.info.set('perpDexs', () => [null, { name: 'xyz' }, { name: 'io' }, { name: 'mkts' }, { name: 'flx' }])
    await c.market.refreshInstruments()
    expect(c.market.dexStatus().some((dex) => dex.dex === 'para')).toBe(false)
    expect(ws.unsubs().map((s) => JSON.stringify(s))).toContain(JSON.stringify({ type: 'openOrders', user: MAIN, dex: 'para' }))
    expect(await c.openOrders(ref())).toEqual([])
    await c.close()
  })

  it('cancelAll queries live orders while the first account REST bootstrap is pending', async () => {
    const { hl, c } = await setup()
    let releaseAccount!: () => void
    let notifyStarted!: () => void
    const pendingAccount = new Promise<void>((resolve) => { releaseAccount = resolve })
    const accountStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    hl.info.set('clearinghouseState', async () => {
      notifyStarted()
      await pendingAccount
      return chState([])
    })
    hl.info.set('frontendOpenOrders', (b) => (b.dex ? [] : [{ coin: 'BTC', side: 'B', limitPx: '79000', sz: '0.01', oid: 11, timestamp: FX_NOW, orderType: 'Limit' }]))
    hl.exchange = () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } })
    const signer = { address: '0x1111111111111111111111111111111111111111', signTypedData: async () => `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` } as never
    try {
      const initial = await c.accountView(ref())
      expect(initial).toMatchObject({ stale: true, snapshot: { positions: [] }, openOrders: [] })
      await accountStarted
      const out = await c.cancelAll({ account: ref(), signer }, undefined)
      expect(out).toHaveLength(1)
      expect(c.budget.usage().byKind.trade).toBeGreaterThanOrEqual(5 * 20 + 1)
    } finally {
      releaseAccount()
      await c.close()
    }
  })
})

describe('user streams', () => {
  it('subscribes userFills / orderUpdates with the lowercase address and maps pushes', async () => {
    const { c } = await setup({ ws: true })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    const events: VenueEvent[] = []
    const MIXED = '0xAbCdEf0000000000000000000000000000000001' as const
    c.subscribe({ channel: 'userFills', address: MIXED }, (e) => events.push(e))
    c.subscribe({ channel: 'orderUpdates', address: MIXED }, (e) => events.push(e))
    expect(ws.subs().map((s) => JSON.stringify(s))).toContain(JSON.stringify({ type: 'userFills', user: MIXED.toLowerCase() }))
    ws.push({ channel: 'userFills', data: { isSnapshot: true, user: MIXED.toLowerCase(), fills: [{ coin: 'BTC', px: '1', sz: '1', side: 'B', time: 1, closedPnl: '0', oid: 3, tid: 9, crossed: true, fee: '0', feeToken: 'USDC' }] } })
    ws.push({ channel: 'orderUpdates', data: [{ order: { coin: 'BTC', side: 'B', limitPx: '1', sz: '1', oid: 3, timestamp: 5, origSz: '1', cloid: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }, status: 'filled', statusTimestamp: 6 }] })
    const fills = events.find((e) => e.channel === 'userFills') as Extract<VenueEvent, { channel: 'userFills' }>
    expect(fills).toMatchObject({ address: MIXED.toLowerCase(), isSnapshot: true })
    expect(fills.fills[0]).toMatchObject({ venueFillId: '9', liquidity: 'taker' })
    const upd = events.find((e) => e.channel === 'orderUpdates') as Extract<VenueEvent, { channel: 'orderUpdates' }>
    expect(upd.updates[0]).toEqual({ venueOrderId: '3', clientOrderId: 'cccccccccccccccccccccccccccccccc', instrumentId: 'hyperliquid:BTC', status: 'filled', ts: 6, side: 'buy', size: '1', origSize: '1', price: '1', createdAt: 5 })
    await c.close()
  })

  it('a public userFills subscription and the account cache share one websocket subscription', async () => {
    const { c } = await setup({ ws: true })
    installSnapshots({ positions: [], orders: {}, fills: [] })
    await c.market.start()
    const ws = FakeWebSocket.last
    ws.open()
    c.subscribe({ channel: 'userFills', address: MAIN }, () => {})
    await c.accountState(ref())
    expect(ws.subs().filter((s) => s.type === 'userFills')).toHaveLength(1)
    await c.close()
  })
})

describe('capability declaration', () => {
  it('declares only what is implemented and carries the documented numbers', () => {
    const cap = hyperliquidCapabilities()
    expect(cap).toMatchObject({
      venue: 'hyperliquid',
      rules: { marketPriceBandBps: 800, minOrderNotional: '10' },
      environments: ['mainnet', 'testnet'],
      instrumentKinds: ['perp'],
      orderTypes: { market: 'emulated', limit: 'native', stop_market: 'native', take_limit: 'native', trailing_stop: 'none', twap: 'none' },
      marketEmulation: { method: 'ioc_limit' },
      tif: ['gtc', 'ioc', 'alo'],
      triggerPriceTypes: ['mark'],
      tpsl: { attachToOrder: true, positionLevel: true, parentPartialCancel: 'cancel_children' },
      batch: { atomic: false },
      amend: 'native',
      cancelAll: 'emulated',
      deadman: { method: 'schedule_cancel', minDelaySec: 5, maxTriggersPerDay: 10 },
      positionMode: ['oneWay'],
      accountModels: ['standard', 'unified', 'portfolio'],
      signers: { type: 'api-wallet', perAccount: { unnamed: 1, named: 3 }, perSubaccountNamed: 2, maxValidityDays: 180, withdrawCapable: false, noncePerSigner: true },
      clientOrderId: { format: 'hex128' },
      builderFee: { supported: true, perpMaxTenthBps: 100, spotMaxTenthBps: 1000, maxApprovalsPerUser: 10, collectorAccountModel: 'standard', collectorMinValue: '100' },
      history: { maxCandles: 5000, pageLimit: 500 },
      withdrawPermissionCheck: 'not_applicable',
    })
    expect(cap.rateLimits![0]).toMatchObject({ scope: 'ip', model: 'weight', limit: 1200, windowMs: 60_000 })
    expect(cap.wsLimits).toEqual({ maxConnections: 10, newPerMinute: 30, maxSubscriptions: 1000, maxDistinctUsersInUserSubs: 10 })
    // 标的级能力与场所级一致，且没有场所私有字段（只允许 x- 扩展键）
    const privateKeys = Object.keys(cap).filter((k) => k.startsWith('x-'))
    expect(privateKeys.sort()).toEqual(['x-builderFeeTenthBps', 'x-supportDeveloper'])
  })
})
