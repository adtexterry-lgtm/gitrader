// SPDX-License-Identifier: CPAL-1.0
// 回放模式：按时间戳重放 fixtures/hl/replay/btc-1m.json（真实 BTC 1m 收盘价 + 真实盘口形状）。同一夹具同一串指令，结果逐位一致。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PaperVenue } from '../src/venue'
import { ReplayMarket, runReplay } from '../src/replay'
import type { ReplayFixture } from '../src/replay'
import { BTC, caps, ctx, inst, intent } from './helpers/test-market'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, '..', '..', '..', 'fixtures', 'hl', 'replay', 'btc-1m.json'), 'utf8')) as ReplayFixture
const A = 'acct_A'

async function run(fundingRate?: number) {
  const frames = fundingRate === undefined ? fixture.frames : fixture.frames.map((f) => ({ ...f, funding: { [BTC]: fundingRate } }))
  const market = new ReplayMarket([inst('BTC', 5, 40)], frames, caps)
  const venue = new PaperVenue({ market, clock: () => market.now() })
  venue.createAccount({ accountId: A, initialBalance: '100000' })
  await runReplay(venue, market, {
    onFrame: async (i) => {
      if (i === 0) await venue.submit(ctx(A), [intent(A, { type: 'market', price: undefined, size: '0.1', maxSlippageBps: 50, leverage: 10, clientOrderId: 'a'.repeat(32) })])
      if (i === 30) await venue.submit(ctx(A), [intent(A, { side: 'sell', type: 'market', price: undefined, size: '0.1', reduceOnly: true, maxSlippageBps: 50, clientOrderId: 'b'.repeat(32) })])
    },
  })
  return { venue, market }
}

describe('replay', () => {
  it('replays deterministically: two runs with the same inputs end in byte-identical state', async () => {
    const a = await run()
    const b = await run()
    expect(a.venue.exportState()).toBe(b.venue.exportState())
    expect(a.market.position).toBe(fixture.frames.length - 1)
  })

  it('fills come from the recorded book at the recorded timestamps', async () => {
    const { venue } = await run()
    const fills = await venue.fills({ accountId: A } as never, 0)
    expect(fills).toHaveLength(2)
    const buyPx = fixture.frames[0]!.books[BTC]!.asks[0]![0]
    const sellPx = fixture.frames[30]!.books[BTC]!.bids[0]![0]
    expect(fills[0]).toMatchObject({ side: 'buy', price: String(buyPx), ts: fixture.frames[0]!.ts })
    expect(fills[1]).toMatchObject({ side: 'sell', price: String(sellPx), ts: fixture.frames[30]!.ts })
    expect(Number(fills[1]!.realizedPnl)).toBeCloseTo((sellPx - buyPx) * 0.1, 8)
  })

  it('funding accrues along the replay clock (30 one-minute frames at 0.01%/h on 0.1 BTC)', async () => {
    const { venue } = await run(0.0001)
    const fills = await venue.fills({ accountId: A } as never, 0)
    const snapshot = await venue.accountState({ accountId: A } as never)
    // 持仓约 30 分钟：付出 ≈ 0.1 x ~80000 x 0.0001 x 0.5h ≈ 0.4 USDC；断言方向与数量级
    const fees = Number(fills[0]!.fee) + Number(fills[1]!.fee)
    const equity = Number(snapshot.margin.equity)
    const realized = Number(fills[1]!.realizedPnl)
    const funding = 100000 - fees + realized - equity
    expect(funding).toBeGreaterThan(0.2)
    expect(funding).toBeLessThan(0.8)
  })
})
