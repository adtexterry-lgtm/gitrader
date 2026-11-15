// SPDX-License-Identifier: CPAL-1.0
// WI-F13（ADR-24）：纸面场所的强平成交必须写进账本（内核补一条来源可追溯的订单 + annotation），按账本重建后现金 / 持仓与场所一致。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VenueFill } from '@gitrader/protocol/connector'
import type { OrderIntent } from '../src/proto'
import { Kernel } from '../src/kernel'
import { defaultConfig } from '../src/config'
import type { GitraderConfig } from '../src/config'
import { fileProvider } from '../src/device-key'
import { mkOrigin } from '../src/util/origin'
import type { ActorCtx } from '../src/trading'
import { rebuildPaperStateFromLedger } from '../src/paper-rebuild'
import * as d from '../src/util/dec'
import { PaperVenue } from '../../venue-paper/src/venue'
import { BTC, TestMarket } from '../../venue-paper/test/helpers/test-market'
import { FakeConnector, LIVE_ADDR } from './helpers/fake-connector'

const FAST_SCRYPT = { N: 1 << 10, r: 8, p: 1 }
const LIVE_ID = 'acct_LIVE0000000000000000000001'

interface F13Harness {
  k: Kernel
  home: string
  market: TestMarket
  paper: PaperVenue
  human: ActorCtx
  paperId: string
  liveId: string
  cleanup(): Promise<void>
}

/** 纸面账户 1000 USDC（故意小，便于把标记价推到强平），另加一个实盘账户用于对照；风控限额放宽到允许 20× 持仓。 */
async function boot(): Promise<F13Harness> {
  const home = mkdtempSync(join(tmpdir(), 'gitrader-f13-'))
  const market = new TestMarket()
  const clock = { now: () => market.now }
  const cfg = defaultConfig()
  cfg.accounts = [
    { alias: 'paper', venue: 'hyperliquid', environment: 'testnet', mode: 'paper', paper: { initialBalance: '1000', ccy: 'USDC' } },
    { alias: 'live', venue: 'hyperliquid', environment: 'testnet', mode: 'live', signerRef: 'w1', accountId: LIVE_ID, owner: { address: LIVE_ADDR } },
  ]
  cfg.risk.limits = {
    ...(cfg.risk.limits ?? {}),
    maxLeverage: 40, maxOrderNotional: '100000', maxPositionNotionalRatio: '20', maxTotalNotionalRatio: '40', maxDailyLossRatio: '1', maxOpenPositions: 5,
  } as GitraderConfig['risk']['limits']
  writeFileSync(join(home, 'gitrader.json'), JSON.stringify(cfg, null, 2))
  const k = await Kernel.create({ home, clock, deviceKeyProvider: fileProvider, scrypt: FAST_SCRYPT, timers: false, sleep: async () => undefined })
  const source = new FakeConnector({ id: 'hyperliquid', clock })
  source.quote = market.quote.bind(market)
  source.context = market.context.bind(market)
  const paper = new PaperVenue({ market, clock: () => market.now })
  k.registerConnector(source)
  k.registerConnector(paper)
  const principal = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!
  const paperId = k.accounts.find('paper')!.accountId
  const liveId = k.accounts.find('live')!.accountId
  return {
    k, home, market, paper, paperId, liveId,
    human: { principal, origin: mkOrigin('user:usr_local', 'order', 'ui') },
    cleanup: async () => { await k.stop().catch(() => undefined); rmSync(home, { recursive: true, force: true }) },
  }
}

const entries = (h: F13Harness) => [...h.k.ledger.iterate()]
const payloadOf = (e: { payload?: unknown }): Record<string, unknown> => (e.payload ?? {}) as Record<string, unknown>

/** 开 0.1 BTC 的 20× 多仓，再把标记价从 80000.5 砸到 70000 触发场所强平。 */
async function openThenLiquidate(h: F13Harness): Promise<void> {
  const intent: OrderIntent = {
    accountId: h.paperId as never, instrumentId: BTC as never, side: 'buy', type: 'market',
    size: '0.1' as never, leverage: 20, reason: 'f13 liquidation fixture',
  }
  const placed = await h.k.trading.place({ intent }, h.human)
  expect(placed.order?.status).toBe('filled')
  h.market.now += 1_000
  h.market.setPrice(BTC, 70_000)
  await h.paper.tick()
}

/** 纸面状态文件里的 Fx（1e18 定点）转成十进制字符串。 */
function fxToDec(v: { $b: string }): string {
  const n = BigInt(v.$b)
  const neg = n < 0n
  const abs = neg ? -n : n
  const scale = 10n ** 18n
  return `${neg ? '-' : ''}${abs / scale}.${(abs % scale).toString().padStart(18, '0')}`
}

describe('F13 paper liquidation ledger', () => {
  let h: F13Harness | undefined
  beforeEach(async () => { h = await boot() })
  afterEach(async () => { await h?.cleanup(); h = undefined })

  it('liquidation fill is written to the ledger', async () => {
    await openThenLiquidate(h!)
    const all = entries(h!)
    const fills = all.filter((e) => e.type === 'fill' && e.subject.accountId === h!.paperId)
    expect(fills).toHaveLength(2)
    const liq = fills.find((e) => payloadOf(e).liquidation === true)
    expect(liq).toBeDefined()
    const orderId = String(liq!.subject.orderId)
    const order = h!.k.orders.get(orderId)
    expect(order).toBeDefined()
    expect(order!.clientOrderId.startsWith('liq-')).toBe(true)
    expect(order!.clientOrderId).toBe(`liq-${String(order!.venueOrderId)}`)
    expect(order!.status).toBe('filled')
    expect(order!.reduceOnly).toBe(true)
    const annotation = all.find((e) => e.type === 'annotation' && payloadOf(e).kind === 'paper.liquidation')
    expect(annotation).toBeDefined()
    expect(annotation!.subject.orderId).toBe(orderId)
    expect(annotation!.origin).toMatchObject({ actor: 'system:paper-liquidation', actorType: 'system', tool: 'venue:liquidation', via: 'internal' })
    expect(payloadOf(annotation!)).toMatchObject({
      kind: 'paper.liquidation', orderId, venueOrderId: order!.venueOrderId, instrumentId: BTC, side: 'sell', size: '0.1', price: '70000',
    })
  })

  it('rebuild from ledger matches the venue after a liquidation', async () => {
    await openThenLiquidate(h!)
    const snapshot = await h!.paper.accountState(h!.k.bus.accountRef(h!.k.accounts.get(h!.paperId)))
    expect(snapshot.positions).toHaveLength(0)
    const venueCash = snapshot.balances[0]!.total
    const rebuilt = rebuildPaperStateFromLedger(h!.k, (facts) => new PaperVenue({ market: h!.market, clock: () => h!.market.now }).rebuildFromLedgerFacts(facts as never))
    const state = JSON.parse(readFileSync(rebuilt.file, 'utf8')) as { accounts: Array<{ id: string; cash: { $b: string }; positions: { $m: unknown[] } }> }
    const account = state.accounts.find((a) => a.id === h!.paperId)!
    expect(account).toBeDefined()
    expect(account.positions.$m).toHaveLength(0)
    expect(d.eq(d.D(fxToDec(account.cash)), d.D(venueCash))).toBe(true)
    const expectation = rebuilt.expectations.find((x) => x.accountId === h!.paperId)!
    expect(d.eq(d.D(expectation.cash), d.D(venueCash))).toBe(true)
    expect(Object.keys(expectation.netSize)).toHaveLength(0)
  })

  it('live accounts keep the old behaviour', () => {
    const vf = {
      venueOrderId: 'liq-live-000001', clientOrderId: null, venueFillId: 'live-liq-1', instrumentId: BTC,
      side: 'sell', price: '70000', size: '0.1', fee: '0', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '-1000', liquidation: true, ts: h!.market.now,
    } as VenueFill
    h!.k.trading.onVenueFill(h!.liveId, vf)
    expect(h!.k.orders.list({ accountId: h!.liveId })).toHaveLength(0)
    expect(entries(h!).filter((e) => e.type === 'fill' && e.subject.accountId === h!.liveId)).toHaveLength(0)
    const pending = (h!.k.trading as unknown as { pendingFills: Map<string, unknown[]> }).pendingFills
    expect(pending.get(`${h!.liveId}|liq-live-000001`)).toHaveLength(1)
  })

  it('ledger verify stays OK', async () => {
    await openThenLiquidate(h!)
    expect(h!.k.ledger.verify().ok).toBe(true)
  })
})
