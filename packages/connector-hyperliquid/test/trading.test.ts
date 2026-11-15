// SPDX-License-Identifier: CPAL-1.0
// 交易路径：离线假场所 + 随机测试密钥（只在内存）。断言发给场所的字节形状、签名可恢复、回执映射、错误原话、nonce。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { HyperliquidConnector } from '../src/connector'
import { ProblemError } from '../src/errors'
import type { VenueExpiryDiagnostic } from '../src/trading'
import type { AccountRef, SignedEvent, TradeContext } from '@gitrader/protocol/connector'
import { FX_NOW, FakeHl } from './helpers/fake-hl'
import { makeTestSigner } from './helpers/test-signer'

const BUILDER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as const
const MAIN = '0x2222222222222222222222222222222222222222' as const

async function setup(opts: { builderAddress?: typeof BUILDER | undefined; supportDeveloper?: boolean; clock?: () => number; httpDateOffsetMs?: number; onDiagnostic?: (event: VenueExpiryDiagnostic) => void } = {}, signer = makeTestSigner()) {
  const hl = new FakeHl()
  const t = { now: FX_NOW }
  const clock = opts.clock ?? (() => t.now)
  const fetchImpl: typeof fetch = async (input, init) => {
    const res = await hl.fetch(input, init)
    if (opts.httpDateOffsetMs === undefined) return res
    const headers = new Headers(res.headers)
    headers.set('date', new Date(clock() + opts.httpDateOffsetMs).toUTCString())
    return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers })
  }
  hl.exchange = (body) => {
    const a = body.action
    if (a.type === 'order') return { status: 'ok', response: { type: 'order', data: { statuses: a.orders.map((_: unknown, i: number) => ({ resting: { oid: 100 + i } })) } } }
    if (a.type === 'cancel' || a.type === 'cancelByCloid') return { status: 'ok', response: { type: 'cancel', data: { statuses: a.cancels.map(() => 'success') } } }
    return { status: 'ok', response: { type: 'default' } }
  }
  const c = new HyperliquidConnector({
    environment: 'testnet', useWs: false, discoveryIntervalMs: 0,
    clock,
    fetchImpl,
    ...(opts.builderAddress ? { builderAddress: opts.builderAddress } : {}),
    ...(opts.supportDeveloper !== undefined ? { supportDeveloper: opts.supportDeveloper } : {}),
    ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
  })
  await c.market.refreshInstruments()
  const signed: SignedEvent[] = []
  const account = (over: Partial<AccountRef> = {}): AccountRef => ({ accountId: 'acct_01TEST', address: MAIN, accountModel: 'standard', ...over })
  const ctx = (over: Partial<AccountRef> = {}, s = signer, gateExpiresAt?: number): TradeContext => ({
    account: account(over), signer: s, onSigned: (e) => signed.push(e),
    ...(gateExpiresAt !== undefined ? { gate: { precheckId: 'pre_01TEST' as never, ticketId: 'ticket_01TEST', expiresAt: gateExpiresAt } } : {}),
  })
  return { hl, c, t, signer, signed, ctx, account }
}
const intent = (over: Record<string, unknown> = {}): OrderIntent => ({
  accountId: 'acct_01TEST', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '80000', ...over,
}) as unknown as OrderIntent

afterEach(() => { vi.useRealTimers() })

describe('submit', () => {
  it('sends a signed order action; signature recovers to the API wallet; ack maps resting -> open', async () => {
    const { hl, c, ctx, signer } = await setup()
    const res = await c.submit(ctx(), [intent({ clientOrderId: '9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60' })])
    const [call] = hl.exchangeCalls()
    expect(call!.body.action).toEqual({
      type: 'order',
      orders: [{ a: 0, b: true, p: '80000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60' }],
      grouping: 'na',
    })
    expect(call!.body.nonce).toBe(FX_NOW)
    expect(call!.body.vaultAddress).toBeUndefined()
    expect(call!.body.expiresAfter).toBeUndefined()
    const { r, s, v } = call!.body.signature
    expect(signer.recover(signer.seen[0]!, `${r}${s.slice(2)}${v.toString(16)}`)).toBe(signer.address)
    expect(res.acks).toHaveLength(1)
    expect(res.acks[0]).toMatchObject({ intentIndex: 0, status: 'open', venueOrderId: '100', clientOrderId: '9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60', builder: { attached: false } })
    expect(res.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(c.budget.usage().byKind.trade).toBe(1) // 下单记在交易档
  })

  it('supportDeveloper is OFF by default: no builder field even for an approved account with a builder address configured', async () => {
    const s = await setup({ builderAddress: BUILDER }) // 不传 supportDeveloper = 默认关闭
    expect(s.c.supportDeveloper).toBe(false)
    const r = await s.c.submit(s.ctx({ builder: { status: 'approved' } }), [intent()])
    expect(s.hl.exchangeCalls()[0]!.body.action.builder).toBeUndefined()
    expect(r.acks[0]).toMatchObject({ status: 'open', builder: { attached: false } })
    expect(() => s.c.buildApproveBuilderFee(1)).toThrow(/supportDeveloper is off/) // 关闭时不生成授权载荷
    expect(s.c.describe()['x-supportDeveloper']).toBe(false)
    const explicitOff = await setup({ builderAddress: BUILDER, supportDeveloper: false })
    await explicitOff.c.submit(explicitOff.ctx({ builder: { status: 'approved' } }), [intent()])
    expect(explicitOff.hl.exchangeCalls()[0]!.body.action.builder).toBeUndefined()
  })

  it('supportDeveloper ON: attaches the 1 bp builder only when the account approved it AND a builder address is configured', async () => {
    const on = await setup({ builderAddress: BUILDER, supportDeveloper: true })
    expect(on.c.describe()['x-supportDeveloper']).toBe(true)
    const r1 = await on.c.submit(on.ctx({ builder: { status: 'approved' } }), [intent()])
    expect(on.hl.exchangeCalls()[0]!.body.action.builder).toEqual({ b: BUILDER.toLowerCase(), f: 10 })
    expect(r1.acks[0]!.builder).toEqual({ attached: true, feeTenthBps: 10 })
    expect(on.c.buildApproveBuilderFee(5).action).toMatchObject({ type: 'approveBuilderFee', maxFeeRate: '0.01%', builder: BUILDER.toLowerCase() })

    for (const status of ['not_approved', 'unknown'] as const) {
      const s = await setup({ builderAddress: BUILDER, supportDeveloper: true })
      const r = await s.c.submit(s.ctx({ builder: { status } }), [intent()])
      expect(s.hl.exchangeCalls()[0]!.body.action.builder).toBeUndefined() // 未授权照常下单，不带 builder
      expect(r.acks[0]!.status).toBe('open')
      expect(r.acks[0]!.builder.attached).toBe(false)
    }
    const noAddr = await setup({ supportDeveloper: true })
    await noAddr.c.submit(noAddr.ctx({ builder: { status: 'approved' } }), [intent()])
    expect(noAddr.hl.exchangeCalls()[0]!.body.action.builder).toBeUndefined()
    expect(() => noAddr.c.buildApproveBuilderFee(1)).toThrow(/no builder address/)
  })

  it('splits a batch into an ALO-only action and the rest; acks come back in intent order', async () => {
    const { hl, c, ctx } = await setup()
    const res = await c.submit(ctx(), [intent({ price: '79000' }), intent({ postOnly: true, price: '78000' }), intent({ price: '77000' })])
    const calls = hl.exchangeCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.action.orders).toHaveLength(1) // ALO 单独一批
    expect(calls[0]!.body.action.orders[0].t).toEqual({ limit: { tif: 'Alo' } })
    expect(calls[1]!.body.action.orders).toHaveLength(2)
    expect(res.acks.map((a) => a.intentIndex)).toEqual([0, 1, 2])
    expect(new Set(calls.map((x) => x.body.nonce)).size).toBe(2) // 两次动作 nonce 不同
  })

  it('tpsl intent is one grouped action with parent + children; waitingForTrigger -> untriggered', async () => {
    const { hl, c, ctx } = await setup()
    hl.exchange = () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 7 } }, 'waitingForTrigger', 'waitingForTrigger'] } } })
    const res = await c.submit(ctx(), [intent({ tpsl: { takeProfit: { triggerPrice: '82000' }, stopLoss: { triggerPrice: '78000' }, grouping: 'order' } })])
    const a = hl.exchangeCalls()[0]!.body.action
    expect(a.grouping).toBe('normalTpsl')
    expect(a.orders).toHaveLength(3)
    expect(res.acks.map((x) => [x.role, x.status])).toEqual([['parent', 'open'], ['tp', 'untriggered'], ['sl', 'untriggered']])
  })

  it('invalid intents are rejected locally with the contract error code and never sent', async () => {
    const { hl, c, ctx } = await setup()
    const res = await c.submit(ctx(), [intent({ price: '80000.55' }), intent({ price: '80000' })])
    expect(res.acks[0]).toMatchObject({ intentIndex: 0, status: 'rejected', problem: { code: 1002, category: 'REJECTED' } })
    expect(res.acks[1]!.status).toBe('open')
    expect(hl.exchangeCalls()).toHaveLength(1)
    expect(hl.exchangeCalls()[0]!.body.action.orders).toHaveLength(1)
  })

  it('market order: IOC at mid +/- slippage, uses the seeded mid; stale price is refused', async () => {
    const { hl, c, ctx, t } = await setup()
    const mid = c.quote('hyperliquid:BTC')!.last!
    await c.submit(ctx(), [intent({ type: 'market', price: undefined, maxSlippageBps: 100 })])
    const o = hl.exchangeCalls()[0]!.body.action.orders[0]
    expect(o.t).toEqual({ limit: { tif: 'Ioc' } })
    expect(Number(o.p)).toBeGreaterThan(mid)
    expect(Number(o.p)).toBeLessThanOrEqual(mid * 1.01)
    t.now += 60_000 // 行情陈旧
    const res = await c.submit(ctx(), [intent({ type: 'market', price: undefined, maxSlippageBps: 100 })])
    expect(res.acks[0]!.problem!.code).toBe(2007)
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('expiresAt becomes expiresAfter, vault account adds vaultAddress', async () => {
    const { hl, c, ctx } = await setup()
    const vault = '0x3333333333333333333333333333333333333333' as const
    await c.submit(ctx({ vaultAddress: vault }), [intent({ expiresAt: FX_NOW + 5000 })])
    const b = hl.exchangeCalls()[0]!.body
    expect(b.expiresAfter).toBe(FX_NOW + 5000)
    expect(b.vaultAddress).toBe(vault)
  })

  it('gate expiry reaches submit, leverage, and attached TP/SL requests', async () => {
    const { hl, c, ctx } = await setup()
    await c.submit(ctx({}, undefined, FX_NOW + 9000), [intent({ leverage: 5, tpsl: { takeProfit: { triggerPrice: '82000' }, stopLoss: { triggerPrice: '78000' }, grouping: 'order' } })])
    expect(hl.exchangeCalls().map((x) => [x.body.action.type, x.body.expiresAfter])).toEqual([
      ['updateLeverage', FX_NOW + 9000], ['order', FX_NOW + 9000],
    ])
    expect(hl.exchangeCalls()[1]!.body.action.orders).toHaveLength(3)
  })

  it('gate expiry changes the signature when the action and nonce are unchanged', async () => {
    const signer = makeTestSigner()
    const first = await setup({}, signer)
    const second = await setup({}, signer)
    const fixedIntent = intent({ clientOrderId: '0123456789abcdef0123456789abcdef' })
    await first.c.submit(first.ctx({}, undefined, FX_NOW + 7000), [fixedIntent])
    await second.c.submit(second.ctx({}, undefined, FX_NOW + 8000), [fixedIntent])
    const [firstBody, secondBody] = [first.hl.exchangeCalls()[0]!.body, second.hl.exchangeCalls()[0]!.body]
    expect(firstBody.nonce).toBe(secondBody.nonce)
    expect(firstBody.action).toEqual(secondBody.action)
    expect(firstBody.expiresAfter).toBe(FX_NOW + 7000)
    expect(secondBody.expiresAfter).toBe(FX_NOW + 8000)
    expect(firstBody.signature).not.toEqual(secondBody.signature)
  })

  it('submit uses the earliest grouped intent expiry capped by the gate expiry', async () => {
    const { hl, c, ctx } = await setup()
    await c.submit(ctx({}, undefined, FX_NOW + 12000), [
      intent({ expiresAt: FX_NOW + 15000 }), intent({ expiresAt: FX_NOW + 10000 }),
    ])
    expect(hl.exchangeCalls()[0]!.body.expiresAfter).toBe(FX_NOW + 10000)

    const earlierGate = await setup()
    await earlierGate.c.submit(earlierGate.ctx({}, undefined, FX_NOW + 8000), [intent({ expiresAt: FX_NOW + 15000 })])
    expect(earlierGate.hl.exchangeCalls()[0]!.body.expiresAfter).toBe(FX_NOW + 8000)
  })

  it('converts the single options deadline by the measured server offset for every expiring write family', async () => {
    for (const [headerOffsetMs, measuredOffsetMs] of [[12_000, 11_952], [-12_000, -12_048]] as const) {
      const { hl, c, ctx } = await setup({ httpDateOffsetMs: headerOffsetMs })
      const gateExpiry = FX_NOW + 60_000
      const gateCtx = ctx({}, undefined, gateExpiry)
      const gateBefore = structuredClone(gateCtx.gate)
      await c.submit(gateCtx, [intent({
        leverage: 5, expiresAt: gateExpiry - 5_000,
        tpsl: { takeProfit: { triggerPrice: '82000' }, stopLoss: { triggerPrice: '78000' }, grouping: 'order' },
      })])
      await c.amend(gateCtx, { instrumentId: 'hyperliquid:BTC', venueOrderId: '321', order: intent({ expiresAt: gateExpiry - 10_000 }) })
      await c.cancel(gateCtx, [
        { instrumentId: 'hyperliquid:BTC', venueOrderId: '555' },
        { instrumentId: 'hyperliquid:ETH', clientOrderId: '0123456789abcdef0123456789abcdef' },
      ])
      hl.info.set('frontendOpenOrders', () => [{ coin: 'BTC', side: 'B', limitPx: '79000', sz: '0.01', oid: 11, timestamp: FX_NOW, orderType: 'Limit', origSz: '0.01' }])
      await c.cancelAll(gateCtx)
      await c.setLeverage(gateCtx, 'hyperliquid:BTC', 3, 'cross')
      await c.scheduleCancel(gateCtx, FX_NOW + 6_000)
      await c.scheduleCancel(gateCtx, null)

      const expected = [
        gateExpiry - 5_000 + measuredOffsetMs, gateExpiry - 5_000 + measuredOffsetMs,
        gateExpiry - 10_000 + measuredOffsetMs,
        gateExpiry + measuredOffsetMs, gateExpiry + measuredOffsetMs, gateExpiry + measuredOffsetMs,
        gateExpiry + measuredOffsetMs,
        gateExpiry + measuredOffsetMs, gateExpiry + measuredOffsetMs,
      ]
      expect(hl.exchangeCalls().map((x) => x.body.expiresAfter)).toEqual(expected)
      expect(hl.exchangeCalls()[0]!.body.action.type).toBe('updateLeverage')
      expect(hl.exchangeCalls()[1]!.body.action.grouping).toBe('normalTpsl')
      expect(hl.exchangeCalls().map((x) => x.body.action.type)).toContain('cancelByCloid')
      expect(gateCtx.gate).toEqual(gateBefore)
    }
  })

  it('reports only the prepared local deadline, measured offset, and venue deadline', async () => {
    const diagnostics: VenueExpiryDiagnostic[] = []
    const { c, ctx } = await setup({ httpDateOffsetMs: 12_000, onDiagnostic: (event) => diagnostics.push(event) })
    const deadline = FX_NOW + 5_000
    await c.submit(ctx({}, undefined, deadline + 2_000), [intent({ expiresAt: deadline })])
    await c.submit(ctx(), [intent()])
    expect(diagnostics).toEqual([{
      event: 'venue_expiry_prepared', localExpiresAt: deadline,
      serverClockOffsetMs: 11_952, venueExpiresAt: deadline + 11_952,
    }])
    expect(Object.keys(diagnostics[0]!).sort()).toEqual(['event', 'localExpiresAt', 'serverClockOffsetMs', 'venueExpiresAt'])
  })

  it('keeps no-deadline writes unbounded and signs the adjusted expiry without changing gate input', async () => {
    const signer = makeTestSigner()
    const withOffset = await setup({ httpDateOffsetMs: 12_000 }, signer)
    const withoutEvidence = await setup({}, signer)
    const deadline = FX_NOW + 20_000
    const fixed = intent({ clientOrderId: '0123456789abcdef0123456789abcdef', expiresAt: deadline - 1_000 })
    const withCtx = withOffset.ctx({}, signer, deadline)
    const withoutCtx = withoutEvidence.ctx({}, signer, deadline)
    const originalGate = structuredClone(withCtx.gate)
    await withOffset.c.submit(withCtx, [fixed])
    await withoutEvidence.c.submit(withoutCtx, [fixed])
    await withOffset.c.submit(withOffset.ctx(), [intent()])

    const [adjusted, unchanged] = [withOffset.hl.exchangeCalls()[0]!.body, withoutEvidence.hl.exchangeCalls()[0]!.body]
    expect(adjusted.nonce).toBe(unchanged.nonce)
    expect(adjusted.action).toEqual(unchanged.action)
    expect(adjusted.expiresAfter).toBe(deadline - 1_000 + 11_952)
    expect(unchanged.expiresAfter).toBe(deadline - 1_000)
    expect(adjusted.signature).not.toEqual(unchanged.signature)
    for (const body of [adjusted, unchanged]) {
      const { r, s, v } = body.signature
      expect(signer.recover(signer.seen[body === adjusted ? 0 : 1]!, `${r}${s.slice(2)}${v.toString(16)}`)).toBe(signer.address)
    }
    expect(withOffset.hl.exchangeCalls()[1]!.body.expiresAfter).toBeUndefined()
    expect(withCtx.gate).toEqual(originalGate)
  })

  it('sets leverage first, once per change', async () => {
    const { hl, c, ctx } = await setup()
    await c.submit(ctx(), [intent({ leverage: 5 })])
    await c.submit(ctx(), [intent({ leverage: 5 })])
    const types = hl.exchangeCalls().map((x) => x.body.action.type)
    expect(types).toEqual(['updateLeverage', 'order', 'order'])
    expect(hl.exchangeCalls()[0]!.body.action).toEqual({ type: 'updateLeverage', asset: 0, isCross: true, leverage: 5 })
    await c.submit(ctx(), [intent({ leverage: 3, marginMode: 'isolated' })])
    expect(hl.exchangeCalls().at(-2)!.body.action).toEqual({ type: 'updateLeverage', asset: 0, isCross: false, leverage: 3 })
  })
})

describe('venue errors are carried back verbatim', () => {
  it('per-order error inside an otherwise accepted batch: other orders keep their status', async () => {
    const { hl, c, ctx } = await setup()
    const text = 'Insufficient margin to place order. asset=0'
    hl.exchange = () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }, { error: text }] } } })
    const res = await c.submit(ctx(), [intent({ price: '79000' }), intent({ price: '78000' })])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[1]).toMatchObject({ status: 'rejected', problem: { code: 3004, category: 'VENUE', venue: { id: 'hyperliquid', message: text } } })
  })

  it('top-level error text is kept byte for byte and classified as an auth problem', async () => {
    const { hl, c, ctx } = await setup()
    const text = 'User or API Wallet 0xabc0000000000000000000000000000000000000 does not exist.'
    hl.exchange = () => ({ status: 'err', response: text })
    const res = await c.submit(ctx(), [intent()])
    expect(res.acks[0]).toMatchObject({ status: 'rejected', problem: { code: 3005, venue: { message: text } } })
  })

  it('unclassified venue text becomes 3001 and is never rewritten', async () => {
    const { hl, c, ctx } = await setup()
    const text = 'Order has invalid size.'
    hl.exchange = () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: text }] } } })
    const res = await c.submit(ctx(), [intent()])
    expect(res.acks[0]!.problem).toMatchObject({ code: 3001, venue: { message: text } })
  })

  it('no response after sending = outcome unknown (3006, not retryable, must query by clientOrderId)', async () => {
    const { hl, c, ctx } = await setup()
    hl.exchangeNetworkFail = true
    const res = await c.submit(ctx(), [intent({ clientOrderId: '0123456789abcdef0123456789abcdef' })])
    expect(res.acks[0]).toMatchObject({ status: 'unknown', clientOrderId: '0123456789abcdef0123456789abcdef', problem: { code: 3006, retryable: false } })
    expect(hl.exchangeCalls()).toHaveLength(1) // 没有自动重发
  })

  it('HTTP 429 -> 3002 retryable and the shared budget backs off', async () => {
    const { hl, c, ctx } = await setup()
    hl.exchange = () => new Response('Too Many Requests', { status: 429 })
    const res = await c.submit(ctx(), [intent()])
    expect(res.acks[0]!.problem).toMatchObject({ code: 3002, retryable: true, venue: { message: 'Too Many Requests' } })
    expect(c.budget.usage().backoffUntil).toBeGreaterThan(0)
  })
})

describe('nonces and signing records', () => {
  it('nonce is strictly increasing per signer even inside one millisecond; signers are independent', async () => {
    const { hl, c, ctx } = await setup()
    const other = makeTestSigner()
    for (let i = 0; i < 3; i++) await c.submit(ctx(), [intent({ price: String(70000 + i) })])
    await c.submit(ctx({}, other), [intent()])
    const nonces = hl.exchangeCalls().map((x) => x.body.nonce)
    expect(nonces.slice(0, 3)).toEqual([FX_NOW, FX_NOW + 1, FX_NOW + 2])
    expect(nonces[3]).toBe(FX_NOW) // 另一把签名者从头开始，互不占用
    expect(c.nonce.highest(other.address)).toBe(FX_NOW)
  })

  it('reports one digest per signature and never the payload, key or signature', async () => {
    const { c, ctx, signed, signer } = await setup()
    await c.submit(ctx(), [intent()])
    expect(signed).toHaveLength(1)
    expect(Object.keys(signed[0]!).sort()).toEqual(['digest', 'purpose', 'signer', 'ts'])
    expect(signed[0]!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(signed[0]!.signer).toBe(signer.address)
  })
})

describe('cancel / amend / cancelAll', () => {
  it('cancel by order id and by client order id; per-target errors are mapped', async () => {
    const { hl, c, ctx } = await setup()
    const out = await c.cancel(ctx(), [
      { instrumentId: 'hyperliquid:BTC', venueOrderId: '555' },
      { instrumentId: 'hyperliquid:ETH', clientOrderId: '0123456789abcdef0123456789abcdef' },
    ])
    const acts = hl.exchangeCalls().map((x) => x.body.action)
    expect(acts[0]).toEqual({ type: 'cancel', cancels: [{ a: 0, o: 555 }] })
    expect(acts[1]).toEqual({ type: 'cancelByCloid', cancels: [{ asset: 1, cloid: '0x0123456789abcdef0123456789abcdef' }] })
    expect(out.map((x) => x.ok)).toEqual([true, true])

    hl.exchange = () => ({ status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled. asset=0' }] } } })
    const bad = await c.cancel(ctx(), [{ instrumentId: 'hyperliquid:BTC', venueOrderId: '1' }])
    expect(bad[0]).toMatchObject({ ok: false, problem: { code: 3001, venue: { message: 'Order was never placed, already canceled, or filled. asset=0' } } })
    const unknown = await c.cancel(ctx(), [{ instrumentId: 'hyperliquid:NOPE', venueOrderId: '1' }])
    expect(unknown[0]!.problem!.code).toBe(1001)
  })

  it('cancel by OID and client order ID carries the gate expiry', async () => {
    const { hl, c, ctx } = await setup()
    await c.cancel(ctx({}, undefined, FX_NOW + 7000), [
      { instrumentId: 'hyperliquid:BTC', venueOrderId: '555' },
      { instrumentId: 'hyperliquid:ETH', clientOrderId: '0123456789abcdef0123456789abcdef' },
    ])
    expect(hl.exchangeCalls().map((x) => x.body.expiresAfter)).toEqual([FX_NOW + 7000, FX_NOW + 7000])
  })

  it('cancelAll is emulated: list open orders, then cancel them (optionally only one instrument)', async () => {
    const { hl, c, ctx } = await setup()
    hl.info.set('frontendOpenOrders', (b) => (b.dex ? [] : [
      { coin: 'BTC', side: 'B', limitPx: '79000', sz: '0.01', oid: 11, timestamp: FX_NOW, orderType: 'Limit', origSz: '0.01' },
      { coin: 'ETH', side: 'A', limitPx: '3600', sz: '1', oid: 12, timestamp: FX_NOW, orderType: 'Limit', origSz: '1' },
    ]))
    const out = await c.cancelAll(ctx(), 'hyperliquid:BTC')
    expect(out).toHaveLength(1)
    expect(hl.exchangeCalls()[0]!.body.action).toEqual({ type: 'cancel', cancels: [{ a: 0, o: 11 }] })
    const all = await c.cancelAll(ctx())
    expect(all).toHaveLength(2)
  })

  it('cancelAll uses a fresh trade query while the public open-order bootstrap waits on background budget', async () => {
    const { hl, c, ctx, account } = await setup()
    hl.info.set('userAbstraction', () => null)
    hl.info.set('frontendOpenOrders', (request) => request.dex ? [] : [
      { coin: 'BTC', side: 'B', limitPx: '79000', sz: '0.01', oid: 11, timestamp: FX_NOW, orderType: 'Limit', origSz: '0.01' },
    ])
    let backgroundPending = false
    let releaseBackground: () => void = () => {}
    const pendingBudget = new Promise<void>((resolve) => { releaseBackground = resolve })
    const acquire = c.budget.acquire.bind(c.budget)
    c.budget.acquire = async (weight, options) => {
      if (options?.kind === 'background') {
        backgroundPending = true
        await pendingBudget
        return
      }
      await acquire(weight, options)
    }
    try {
      const cached = await c.openOrders(account())
      await vi.waitFor(() => expect(backgroundPending).toBe(true))
      expect(backgroundPending).toBe(true)
      expect(cached).toEqual([])
      const canceled = await c.cancelAll(ctx())
      expect(canceled).toHaveLength(1)
      expect(canceled[0]!.ok).toBe(true)
      expect(hl.exchangeCalls()[0]!.body.action).toEqual({ type: 'cancel', cancels: [{ a: 0, o: 11 }] })
    } finally {
      releaseBackground()
    }
  })

  it('cancelAll carries the gate expiry into its cancel request', async () => {
    const { hl, c, ctx } = await setup()
    hl.info.set('frontendOpenOrders', () => [{ coin: 'BTC', side: 'B', limitPx: '79000', sz: '0.01', oid: 11, timestamp: FX_NOW, orderType: 'Limit', origSz: '0.01' }])
    await c.cancelAll(ctx({}, undefined, FX_NOW + 7000))
    expect(hl.exchangeCalls()[0]!.body.expiresAfter).toBe(FX_NOW + 7000)
  })

  it('amend sends a modify with the rebuilt order', async () => {
    const { hl, c, ctx } = await setup()
    hl.exchange = () => ({ status: 'ok', response: { type: 'default' } })
    const res = await c.amend(ctx(), { instrumentId: 'hyperliquid:BTC', venueOrderId: '321', order: intent({ price: '79500', clientOrderId: '0123456789abcdef0123456789abcdef' }) })
    expect(hl.exchangeCalls()[0]!.body.action).toEqual({
      type: 'modify', oid: 321,
      order: { a: 0, b: true, p: '79500', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x0123456789abcdef0123456789abcdef' },
    })
    expect(res.acks[0]!).toMatchObject({ status: 'unknown', venueOrderId: null, problem: { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', retryable: false } })
    expect(hl.exchangeCalls()).toHaveLength(1)
  })

  it('amend uses the earlier of its intent expiry and the gate expiry', async () => {
    const { hl, c, ctx } = await setup()
    await c.amend(ctx({}, undefined, FX_NOW + 8000), {
      instrumentId: 'hyperliquid:BTC', venueOrderId: '321', order: intent({ price: '79500', expiresAt: FX_NOW + 6000 }),
    })
    expect(hl.exchangeCalls()[0]!.body.expiresAfter).toBe(FX_NOW + 6000)
  })
})

describe('scheduleCancel (venue-level dead-man switch)', () => {
  it('needs >= 5 s of lead time; null clears', async () => {
    const { hl, c, ctx } = await setup()
    await expect(c.scheduleCancel(ctx(), FX_NOW + 4000)).rejects.toBeInstanceOf(ProblemError)
    await c.scheduleCancel(ctx(), FX_NOW + 6000)
    await c.scheduleCancel(ctx(), null)
    const acts = hl.exchangeCalls().map((x) => x.body.action)
    expect(acts[0]).toEqual({ type: 'scheduleCancel', time: FX_NOW + 6000 })
    expect(acts[1]).toEqual({ type: 'scheduleCancel' })
    expect(acts).toHaveLength(2)
  })

  it('scheduleCancel arm and disarm carry the gate expiry', async () => {
    const { hl, c, ctx } = await setup()
    await c.scheduleCancel(ctx({}, undefined, FX_NOW + 9000), FX_NOW + 6000)
    await c.scheduleCancel(ctx({}, undefined, FX_NOW + 9000), null)
    expect(hl.exchangeCalls().map((x) => x.body.expiresAfter)).toEqual([FX_NOW + 9000, FX_NOW + 9000])
  })

  it('setLeverage carries the gate expiry', async () => {
    const { hl, c, ctx } = await setup()
    await c.setLeverage(ctx({}, undefined, FX_NOW + 5000), 'hyperliquid:BTC', 3, 'cross')
    expect(hl.exchangeCalls()[0]!.body.expiresAfter).toBe(FX_NOW + 5000)
  })

  it('armDeadman is unsupported and signs no request', async () => {
    const { hl, c, ctx, signed } = await setup()
    expect(() => c.armDeadman!(ctx(), { delaySec: 30 })).toThrow(ProblemError)
    expect(signed).toHaveLength(0)
    expect(hl.exchangeCalls()).toHaveLength(0)
  })

  it('advancing timers after armDeadman is rejected still produces no signature', async () => {
    vi.useFakeTimers({ now: FX_NOW })
    const { hl, c, ctx } = await setup({ clock: () => Date.now() })
    const signed: SignedEvent[] = []
    const noSignCtx = { ...ctx(), onSigned: (e: SignedEvent) => signed.push(e) }
    expect(() => c.armDeadman!(noSignCtx, { delaySec: 30 })).toThrow(ProblemError)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(signed).toHaveLength(0)
    expect(hl.exchangeCalls()).toHaveLength(0)
  })
})
