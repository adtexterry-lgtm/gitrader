// SPDX-License-Identifier: CPAL-1.0
// 交易连接器端到端（全离线）：假的链节点独立验签 / 复算签名域 / 校验 quantums·subticks 整数倍 / 校验 OrderId.owner，
// 假的 Indexer 给官方响应形状（挂单裸数组、账户平铺）。断言覆盖：订单计划、取整口径、能力拒绝、短单 vs 长单、
// 手续费、结果未知（3006）与对账、单号 UUID、撤单与全撤、账户读、密钥不外泄。
import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { createHash } from 'node:crypto'
import type { OrderIntent } from '@gitrader/protocol'
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import { DydxTradeConnector, ClientIdAllocator, clientIdBaseOf, parseMarkets, planOrder, randomClientOrderId } from '../src/trading'
import type { MarketSnapshot } from '../src/trading'
import { FakeDydx } from './helpers/fake-dydx'
import { DydxSigner } from '../src/keys'
import { anyOf, msgPlaceOrder, type OrderMessage } from '../src/msgs'
import { signTransaction } from '../src/tx'
import { ORDER_FLAGS, TYPE_URL } from '../src/constants'

const KEY = '11'.repeat(32)
const BTC: MarketSnapshot = {
  ticker: 'BTC-USD',
  clobPairId: 0,
  atomicResolution: -10,
  quantumConversionExponent: -9,
  stepBaseQuantums: 1_000_000,
  subticksPerTick: 100_000,
  oraclePrice: '20000',
  tickSize: '1',
  stepSize: '0.0001',
  status: 'ACTIVE',
}

// 测试用：Decimal 是品牌类型，测试里直接给十进制字符串（等价于 asDecimal）
const intent = (o: Record<string, unknown>): OrderIntent => ({
  accountId: 'acc_1',
  instrumentId: 'dydx:BTC-USD',
  side: 'buy',
  type: 'limit',
  ...o,
} as unknown as OrderIntent)

const account = { accountId: 'acc_1', address: 'dydx1owner' } as unknown as AccountRef
const ctx = (): TradeContext => ({ account, signer: {} } as unknown as TradeContext)

// Indexer 订单 UUID：测试里用 node:crypto 独立算（不 import src 的 indexerOrderId），公式同 v4-chain indexer。
const INDEXER_NS = '0f9da948-a6fb-4c45-9edc-4685c3f3317d'
function uuid5(name: string, ns: string): string {
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')])).digest()
  const b = Buffer.from(digest.subarray(0, 16))
  b[6] = (b[6]! & 0x0f) | 0x50
  b[8] = (b[8]! & 0x3f) | 0x80
  const s = b.toString('hex')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
function indexerId(address: string, sub: number, clientId: number, clobPairId: number, orderFlags: number): string {
  const subId = uuid5(`${address}-${sub}`, INDEXER_NS)
  return uuid5(`${subId}-${clientId}-${clobPairId}-${orderFlags}`, INDEXER_NS)
}

function plan(i: OrderIntent, overrides: Record<string, unknown> = {}) {
  return planOrder(i, {
    market: BTC,
    owner: 'dydx1owner',
    subaccountNumber: 0,
    clientId: 42,
    goodTilBlock: 1020,
    goodTilBlockTime: 1_900_000_000,
    ...overrides,
  })
}

function makeFake(extra: Partial<ConstructorParameters<typeof FakeDydx>[0]> = {}): FakeDydx {
  return new FakeDydx({
    chainId: 'dydx-testnet-4',
    accountNumber: 9,
    height: 1000,
    sequence: 3,
    markets: {
      'BTC-USD': {
        clobPairId: 0,
        atomicResolution: -10,
        quantumConversionExponent: -9,
        stepBaseQuantums: 1_000_000,
        subticksPerTick: 100_000,
        oraclePrice: '20000',
        tickSize: '1',
        stepSize: '0.0001',
      },
    },
    subaccount: {
      address: 'dydx1owner',
      subaccountNumber: 0,
      equity: '1234.5',
      freeCollateral: '1000',
      assetPositions: { USDC: { symbol: 'USDC', size: '1234.5', side: 'LONG' } },
      openPerpetualPositions: { 'BTC-USD': { market: 'BTC-USD', status: 'OPEN', side: 'LONG', size: '0.5', entryPrice: '19000', unrealizedPnl: '500', realizedPnl: '0', netFunding: '-1.25', createdAt: '2026-10-01T00:00:00.000Z' } },
    },
    ...extra,
  })
}

function makeConnector(fake: FakeDydx, extra: Record<string, unknown> = {}): DydxTradeConnector {
  return new DydxTradeConnector({
    privateKey: KEY,
    environment: 'testnet',
    indexerBaseUrl: 'https://indexer.test.local',
    nodeBaseUrl: 'https://node.test.local',
    fetchImpl: fake.fetchImpl,
    ...extra,
  })
}

describe('订单计划（纯函数）', () => {
  it('市价买：走价带限价 + IOC + 短单（flags=0，块高 1020）', () => {
    const p = plan(intent({ type: 'market', size: '0.5', maxSlippageBps: 50 }))
    expect(p.shortTerm).toBe(true)
    expect(p.order.tif).toBe('ioc')
    expect(p.order.goodTilBlock).toBe(1020)
    expect(p.order.goodTilBlockTime).toBeUndefined()
    // 20000 × 1.005 = 20100 → subticks 20100 × 1e5
    expect(p.order.subticks).toBe(2_010_000_000n)
    expect(p.order.quantums).toBe(5_000_000_000n)
  })

  it('市价卖：价带向下（20000 × 0.995）', () => {
    const p = plan(intent({ type: 'market', side: 'sell', size: '1', maxSlippageBps: 50 }))
    expect(p.order.subticks).toBe(1_990_000_000n)
  })

  it('市价缺 maxSlippageBps → INVALID_PARAMS（不猜滑点）', () => {
    try {
      plan(intent({ type: 'market', size: '1' }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { problem?: { name: string } }).problem?.name).toBe('INVALID_PARAMS')
    }
  })

  it('限价 gtc → 长单（flags=64，带 good_til_block_time）', () => {
    const p = plan(intent({ price: '20000', size: '0.01' }))
    expect(p.shortTerm).toBe(false)
    expect(p.stateful).toBe(true)
    expect(p.order.orderId.orderFlags).toBe(ORDER_FLAGS.longTerm)
    expect(p.order.goodTilBlockTime).toBe(1_900_000_000)
    expect(p.order.tif).toBe('gtc')
  })

  it('限价 ioc → 短单', () => {
    const p = plan(intent({ price: '20000', size: '0.01', tif: 'ioc' }))
    expect(p.shortTerm).toBe(true)
    expect(p.order.goodTilBlock).toBe(1020)
  })

  it('post-only / alo → 长单 + TIF POST_ONLY(2)', () => {
    expect(plan(intent({ price: '19000', size: '0.01', postOnly: true })).order.tif).toBe('postOnly')
    expect(plan(intent({ price: '19000', size: '0.01', tif: 'alo' })).order.tif).toBe('postOnly')
    expect(plan(intent({ price: '19000', size: '0.01', tif: 'alo' })).order.orderId.orderFlags).toBe(ORDER_FLAGS.longTerm)
  })

  it('gtd 必须给 expiresAt，且写成 good_til_block_time', () => {
    expect(() => plan(intent({ price: '19000', size: '0.01', tif: 'gtd' }))).toThrow()
    const p = plan(intent({ price: '19000', size: '0.01', tif: 'gtd', expiresAt: 1_950_000_000_000 }))
    expect(p.order.goodTilBlockTime).toBe(1_950_000_000)
  })

  it('止损市价：条件单 flags=32 + condition_type=stopLoss(1) + 触发 subticks + IOC', () => {
    const p = plan(intent({ type: 'stop_market', side: 'sell', size: '0.5', triggerPrice: '18000', maxSlippageBps: 100, reduceOnly: true }))
    expect(p.order.orderId.orderFlags).toBe(ORDER_FLAGS.conditional)
    expect(p.order.conditionType).toBe('stopLoss')
    expect(p.order.conditionalTriggerSubticks).toBe(1_800_000_000n)
    expect(p.order.tif).toBe('ioc')
    expect(p.order.reduceOnly).toBe(true)
  })

  it('止盈限价：condition_type=takeProfit(2) + gtc', () => {
    const p = plan(intent({ type: 'take_limit', side: 'sell', size: '0.5', triggerPrice: '22000', price: '22100' }))
    expect(p.order.conditionType).toBe('takeProfit')
    expect(p.order.tif).toBe('gtc')
    expect(p.order.subticks).toBe(2_210_000_000n)
  })

  it('条件单缺 triggerPrice → INVALID_PARAMS', () => {
    expect(() => plan(intent({ type: 'stop_limit', size: '0.5', price: '18000' }))).toThrow(/triggerPrice/)
  })

  it('触发价类型只支持 mark（dYdX 条件单按预言机价触发）', () => {
    expect(() => plan(intent({ type: 'stop_market', size: '0.5', triggerPrice: '18000', maxSlippageBps: 10, triggerType: 'last' }))).toThrow(/oracle price only/)
  })

  it('trailing_stop / twap / fok / 带 tpsl 一律拒绝（能力位 none）', () => {
    expect(() => plan(intent({ type: 'trailing_stop', size: '1' }))).toThrow(/does not support/)
    expect(() => plan(intent({ type: 'twap', size: '1' }))).toThrow(/does not support/)
    expect(() => plan(intent({ price: '1', size: '1', tif: 'fok' }))).toThrow(/FILL_OR_KILL/)
    expect(() => plan(intent({ price: '1', size: '1', tpsl: { grouping: 'order', takeProfit: { triggerPrice: '2' as never } } }))).toThrow(/attached take-profit/)
  })

  it('限价缺 price → INVALID_PARAMS；缺 size / notional → INVALID_PARAMS', () => {
    expect(() => plan(intent({ size: '1' }))).toThrow(/needs a price/)
    expect(() => plan(intent({ price: '100' }))).toThrow(/size or notional/)
  })

  it('按名义额折数量（1000 USDC / 20000 = 0.05 BTC）', () => {
    const p = plan(intent({ type: 'market', notional: '1000', maxSlippageBps: 50 }))
    expect(p.order.quantums).toBe(500_000_000n)
  })

  it('数量按 step：缺省拒绝 0.01234，passive 向下截到 0.0123', () => {
    expect(() => plan(intent({ type: 'market', size: '0.01234', maxSlippageBps: 10 }))).toThrow(/stepBaseQuantums/)
    const p = plan(intent({ type: 'market', size: '0.01234', maxSlippageBps: 10, rounding: 'passive' }))
    expect(BigInt(p.order.quantums!)).toBe(123_000_000n)
    expect(BigInt(p.order.quantums!) % 1_000_000n).toBe(0n)
  })

  it('取整（缺省 reject）：0.00015 拒，passive 发一个 step', () => {
    try {
      plan(intent({ price: '20000', size: '0.00015' }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { problem?: { name: string } }).problem?.name).toBe('INVALID_PARAMS')
      expect((e as Error).message).toMatch(/stepBaseQuantums 1000000/)
    }
    expect(BigInt(plan(intent({ price: '20000', size: '0.00015', rounding: 'passive' })).order.quantums!)).toBe(1_000_000n)
  })

  it('取整：0.00001 两种模式都拒（不夹到一个 step）', () => {
    expect(() => plan(intent({ price: '20000', size: '0.00001' }))).toThrow(/smaller than one step/)
    expect(() => plan(intent({ price: '20000', size: '0.00001', rounding: 'passive' }))).toThrow(/smaller than one step/)
  })

  it('限价取整：买单 20000.4 缺省拒，passive → 20000；卖单 20000.4 passive → 20001', () => {
    try {
      plan(intent({ price: '20000.4', size: '0.01' }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { problem?: { name: string } }).problem?.name).toBe('INVALID_PARAMS')
    }
    expect(plan(intent({ price: '20000.4', size: '0.01', rounding: 'passive' })).order.subticks).toBe(2_000_000_000n)
    expect(plan(intent({ side: 'sell', price: '20000.4', size: '0.01', rounding: 'passive' })).order.subticks).toBe(2_000_100_000n)
  })

  it('市价价带取整：ref 20000 / 50 bps → 2010000000；ref 20000.37 / 0 bps 买向下到 2000000000', () => {
    expect(plan(intent({ type: 'market', size: '0.01', maxSlippageBps: 50 })).order.subticks).toBe(2_010_000_000n)
    const tight = plan(intent({ type: 'market', size: '0.01', maxSlippageBps: 0 }), { market: { ...BTC, oraclePrice: '20000.37' } })
    expect(tight.order.subticks).toBe(2_000_000_000n)
  })

  it('postOnly 与 tif=ioc 同给 → INVALID_PARAMS', () => {
    try {
      plan(intent({ price: '20000', size: '0.01', postOnly: true, tif: 'ioc' }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { problem?: { name: string } }).problem?.name).toBe('INVALID_PARAMS')
    }
  })

  it('负 bps / 负数量 → INVALID_PARAMS', () => {
    expect(() => plan(intent({ type: 'market', size: '1', maxSlippageBps: -1 }))).toThrow()
    expect(() => plan(intent({ type: 'market', size: '-1', maxSlippageBps: 10 }))).toThrow()
  })
})

describe('clientId 分配', () => {
  it('同一 clientOrderId 复用同一 clientId，不同 order 不同 id', () => {
    const a = new ClientIdAllocator()
    const id1 = a.allocate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, 0)
    const id2 = a.allocate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 0, 0)
    expect(a.allocate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, 0)).toBe(id1)
    expect(id1).not.toBe(id2)
    expect(a.size).toBe(2)
  })

  it('前 8 位相同的两个单会碰撞，第二个顺延', () => {
    const a = new ClientIdAllocator()
    const id1 = a.allocate('deadbeef000000000000000000000001', 0, 0)
    const id2 = a.allocate('deadbeef000000000000000000000002', 0, 0)
    expect(id2).toBe(id1 + 1)
  })

  it('release 后可以复用，lookup 找不到时返回 undefined', () => {
    const a = new ClientIdAllocator()
    const hex = 'cafebabe000000000000000000000000'
    a.allocate(hex, 0, 0)
    expect(a.lookup(hex)).toBeDefined()
    a.release(hex)
    expect(a.lookup(hex)).toBeUndefined()
  })

  it('randomClientOrderId 是 32 位十六进制且两次不同', () => {
    const a = randomClientOrderId()
    const b = randomClientOrderId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })

  it('clientIdBaseOf 只取前 8 位十六进制，与分配器同规则', () => {
    expect(clientIdBaseOf('deadbeef000000000000000000000001')).toBe(0xdeadbeef)
    expect(clientIdBaseOf('0x0000002a111111111111111111111111')).toBe(42)
    expect(clientIdBaseOf('1')).toBe(1)
  })
})

describe('submit（假链节点独立验签）', () => {
  it('限价 IOC 短单：一笔记账交易、签名验过、空手续费、SYNC 广播', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc', clientOrderId: '11112222333344445555666677778888' as never })])
    expect(fake.failures).toEqual([])
    expect(fake.txs).toHaveLength(1)
    const tx = fake.lastTx!
    expect(tx.messages.map((m) => m.typeUrl)).toEqual(['/dydxprotocol.clob.MsgPlaceOrder'])
    expect(tx.orders[0]!.goodTilBlock).toBe(1020n)
    expect(tx.feeAmounts).toEqual([])
    expect(tx.sequence).toBe(3)
    expect(JSON.parse(fake.requests.find((r) => r.method === 'POST')!.body!).mode).toBe('BROADCAST_MODE_SYNC')
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[0]!.clientOrderId).toBe('11112222333344445555666677778888')
    // 回执单号 = 独立的 uuid v5 期望值（不是 src 的 indexerOrderId 反算）
    expect(res.acks[0]!.venueOrderId).toBe(
      indexerId(c.address!, 0, tx.orders[0]!.clientId, tx.orders[0]!.clobPairId, tx.orders[0]!.orderFlags),
    )
    expect(res.requestWeight).toBe(0)
  })

  it('回执哈希 = sha256(原始响应)', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    const raw = JSON.stringify({ tx_response: { code: 0, codespace: '', raw_log: '', txhash: fake.lastTx!.txHash, height: '1001' } })
    expect(res.receiptHash).toBe(createHash('sha256').update(raw).digest('hex'))
  })

  it('长单没配 fee → 拒绝（INVALID_PARAMS），不发广播', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '19000', size: '0.01' })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(fake.txs).toHaveLength(0)
  })

  it('长单配了 fee：带 denom/amount/gas，一律 SYNC 广播，sequence 自增', async () => {
    const fake = makeFake()
    const c = makeConnector(fake, { fee: { amount: [{ denom: 'uusdc', amount: '2000000' }], gasLimit: 200000 } })
    const res = await c.submit(ctx(), [intent({ price: '19000', size: '0.01' })])
    expect(fake.failures).toEqual([])
    expect(res.acks[0]!.status).toBe('open')
    expect(fake.lastTx!.feeAmounts).toEqual([{ denom: 'uusdc', amount: '2000000' }])
    expect(fake.lastTx!.feeGas).toBe(200000)
    expect(fake.lastTx!.sequence).toBe(3)
    expect(JSON.parse(fake.requests.filter((r) => r.method === 'POST').at(-1)!.body!).mode).toBe('BROADCAST_MODE_SYNC')
    expect(fake.opts.sequence).toBe(4)
    // 第二次签名用 sequence 4
    await c.submit(ctx(), [intent({ price: '19001', size: '0.01' })])
    expect(fake.lastTx!.sequence).toBe(4)
  })

  it('长单被拒（code≠0）不消耗 sequence，下一笔还用同一个', async () => {
    const fake = makeFake()
    const c = makeConnector(fake, { fee: { amount: [], gasLimit: 0 } })
    fake.opts.nextCode = 1105
    fake.opts.nextRawLog = 'clob: rejected'
    const bad = await c.submit(ctx(), [intent({ price: '19000', size: '0.01' })])
    expect(bad.acks[0]!.status).toBe('rejected')
    await c.submit(ctx(), [intent({ price: '19001', size: '0.01' })])
    expect(fake.lastTx!.sequence).toBe(3)
    expect(fake.failures).toEqual([])
  })

  it('长单广播断连（3006）→ 缓存 sequence 作废，下一笔重新从链上取', async () => {
    const fake = makeFake()
    const c = makeConnector(fake, { fee: { amount: [], gasLimit: 0 } })
    fake.opts.failNetwork = true
    const res = await c.submit(ctx(), [intent({ price: '19000', size: '0.01' })])
    expect(res.acks[0]!.problem?.code).toBe(3006)
    fake.opts.failNetwork = false
    fake.opts.sequence = 5
    await c.submit(ctx(), [intent({ price: '19001', size: '0.01' })])
    expect(fake.lastTx!.sequence).toBe(5)
    expect(fake.failures).toEqual([])
  })

  it('链上明确拒绝（code≠0）→ ack rejected，Problem 带原始 raw_log', async () => {
    const fake = makeFake()
    fake.opts.nextCode = 1105
    fake.opts.nextRawLog = 'clob: order would not be valid: insufficient margin'
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).toBe(3004)
    expect(res.acks[0]!.problem?.venue?.message).toContain('insufficient margin')
  })

  it('广播时断连 → ack unknown（3006，不可重发）', async () => {
    const fake = makeFake({ failNetwork: true })
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('unknown')
    expect(res.acks[0]!.problem?.code).toBe(3006)
    expect(res.acks[0]!.problem?.retryable).toBe(false)
  })

  it('一次 submit 多张意图 → 拒绝（batch.maxOrders = 1）', async () => {
    const c = makeConnector(makeFake())
    await expect(c.submit(ctx(), [intent({ price: '1', size: '1' }), intent({ price: '1', size: '1' })])).rejects.toThrow(/one order per transaction/)
  })

  it('没有私钥的连接器不能下单（ACCOUNT_NOT_BOUND），也不发请求', async () => {
    const fake = makeFake()
    const c = new DydxTradeConnector({ environment: 'testnet', indexerBaseUrl: 'https://i.local', nodeBaseUrl: 'https://n.local', fetchImpl: fake.fetchImpl })
    await expect(c.submit(ctx(), [intent({ type: 'market', size: '1', maxSlippageBps: 1 })])).rejects.toThrow(/without a private key/)
    expect(fake.requests).toHaveLength(0)
  })

  it('onSigned 每次签名回调一次，digest 是 sha256(SignDoc)', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const events: Array<{ purpose: string; digest: string; signer: string }> = []
    await c.submit({ ...ctx(), onSigned: (e) => events.push({ purpose: e.purpose, digest: e.digest, signer: e.signer }) }, [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(events).toHaveLength(1)
    expect(events[0]!.purpose).toBe('dydx.place_order.short_term')
    expect(events[0]!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(events[0]!.signer).toBe(c.address)
  })

  it('未知市场 → INSTRUMENT_UNKNOWN', async () => {
    const c = makeConnector(makeFake())
    await expect(c.submit(ctx(), [intent({ instrumentId: 'dydx:DOGE-USD' as never, price: '1', size: '1' })])).rejects.toThrow(/not found/)
  })
})

describe('撤单 / 全撤 / 不支持的方法', () => {
  const OPEN_ROW = {
    id: '11111111-2222-5333-8444-555555555555', clientId: '77', clobPairId: '0', side: 'BUY',
    size: '0.01', totalFilled: '0', price: '19000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD',
    createdAt: '2026-10-01T00:00:00Z',
  }

  it('按 Indexer 订单 id 撤短单：GET /v4/orders/{id} 取行，good_til_block = 块高 + 20，SYNC', async () => {
    const fake = makeFake({ orders: [OPEN_ROW] })
    const c = makeConnector(fake)
    const acks = await c.cancel(ctx(), [{ instrumentId: 'dydx:BTC-USD' as never, venueOrderId: OPEN_ROW.id }])
    expect(acks[0]!.ok).toBe(true)
    expect(fake.failures).toEqual([])
    const tx = fake.lastTx!
    expect(tx.messages[0]!.typeUrl).toBe('/dydxprotocol.clob.MsgCancelOrder')
    expect(tx.cancels[0]).toMatchObject({ clientId: 77, clobPairId: 0, orderFlags: 0, goodTilBlock: 1020n })
    expect(JSON.parse(fake.requests.filter((r) => r.method === 'POST').at(-1)!.body!).mode).toBe('BROADCAST_MODE_SYNC')
    expect(fake.opts.sequence).toBe(3)
  })

  it('按 Indexer 订单 id 撤长单：带 good_til_block_time（fixed32），sequence +1', async () => {
    const fake = makeFake({ orders: [{ ...OPEN_ROW, orderFlags: '64' }] })
    const c = makeConnector(fake, { fee: { amount: [], gasLimit: 0 } })
    const acks = await c.cancel(ctx(), [{ instrumentId: 'dydx:BTC-USD' as never, venueOrderId: OPEN_ROW.id }])
    expect(acks[0]!.ok).toBe(true)
    expect(fake.failures).toEqual([])
    expect(fake.lastTx!.cancels[0]!.blockTime).toBeGreaterThan(1_700_000_000n)
    expect(JSON.parse(fake.requests.filter((r) => r.method === 'POST').at(-1)!.body!).mode).toBe('BROADCAST_MODE_SYNC')
    expect(fake.opts.sequence).toBe(4)
  })

  it('本进程下过单后：按 clientOrderId 或回执 venueOrderId 都能撤', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc', clientOrderId: '12345678000000000000000000000000' as never })])
    const byClient = await c.cancel(ctx(), [{ instrumentId: 'dydx:BTC-USD' as never, clientOrderId: '12345678000000000000000000000000' as never }])
    expect(byClient[0]!.ok).toBe(true)
    const byVenue = await c.cancel(ctx(), [{ instrumentId: 'dydx:BTC-USD' as never, venueOrderId: res.acks[0]!.venueOrderId! }])
    expect(byVenue[0]!.ok).toBe(true)
    expect(fake.failures).toEqual([])
    expect(fake.txs.filter((t) => t.cancels.length > 0).map((t) => t.cancels[0]!.clientId)).toEqual([0x12345678, 0x12345678])
  })

  it('未知 clientOrderId（进程重启后）→ 明确要求用 venueOrderId', async () => {
    const c = makeConnector(makeFake())
    const acks = await c.cancel(ctx(), [{ instrumentId: 'dydx:BTC-USD' as never, clientOrderId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never }])
    expect(acks[0]!.ok).toBe(false)
    expect(acks[0]!.problem?.name).toBe('INVALID_PARAMS')
    expect(acks[0]!.problem?.message).toMatch(/venueOrderId/)
  })

  it('cancelAll 只撤该标的的挂单（2 张 → 2 笔交易）', async () => {
    const fake = makeFake({
      orders: [
        { id: 'o1', clientId: '11', clobPairId: '0', side: 'BUY', size: '0.01', totalFilled: '0', price: '19000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'o2', clientId: '12', clobPairId: '0', side: 'SELL', size: '0.02', totalFilled: '0.01', price: '21000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'o3', clientId: '13', clobPairId: '1', side: 'SELL', size: '1', totalFilled: '0', price: '100', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'ETH-USD', createdAt: '2026-10-01T00:00:00Z' },
      ],
    })
    const c = makeConnector(fake)
    const acks = await c.cancelAll(ctx(), 'dydx:BTC-USD' as never)
    expect(acks).toHaveLength(2)
    expect(acks.every((a) => a.ok)).toBe(true)
    expect(fake.txs).toHaveLength(2)
    expect(fake.txs.map((t) => t.cancels[0]!.clientId).sort()).toEqual([11, 12])
  })

  it('cancelAll 能撤到条件单（UNTRIGGERED 在第二次 GET 里）', async () => {
    const fake = makeFake({
      orders: [
        { id: 'a', clientId: '21', clobPairId: '0', side: 'BUY', size: '0.01', totalFilled: '0', price: '19000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD' },
        { id: 'b', clientId: '22', clobPairId: '0', side: 'SELL', size: '0.01', totalFilled: '0', price: '22000', status: 'UNTRIGGERED', type: 'TAKE_PROFIT_LIMIT', orderFlags: '32', market: 'BTC-USD', triggerPrice: '22000' },
      ],
    })
    const c = makeConnector(fake, { fee: { amount: [], gasLimit: 0 } })
    const acks = await c.cancelAll(ctx())
    expect(acks).toHaveLength(2)
    expect(fake.txs.filter((t) => t.cancels.length > 0).map((t) => t.cancels[0]!.orderFlags).sort()).toEqual([0, 32])
  })

  it('没有挂单时 cancelAll 返回空数组、不发交易', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    expect(await c.cancelAll(ctx())).toEqual([])
    expect(fake.txs).toHaveLength(0)
  })

  it('amend / setLeverage / scheduleCancel 一律 1004', async () => {
    const c = makeConnector(makeFake())
    await expect(c.amend()).rejects.toMatchObject({ problem: { name: 'ORDER_TYPE_UNSUPPORTED' } })
    await expect(c.setLeverage()).rejects.toMatchObject({ problem: { name: 'ORDER_TYPE_UNSUPPORTED' } })
    await expect(c.scheduleCancel()).rejects.toMatchObject({ problem: { name: 'ORDER_TYPE_UNSUPPORTED' } })
  })
})

describe('账户读（Indexer 形状）', () => {
  it('accountState：权益、可用、持仓（空头符号取绝对值）', async () => {
    const fake = makeFake()
    fake.opts.subaccount = {
      address: 'dydx1owner',
      subaccountNumber: 0,
      equity: '1234.5',
      freeCollateral: '1000',
      assetPositions: { USDC: { symbol: 'USDC', size: '1234.5' } },
      openPerpetualPositions: {
        'BTC-USD': { market: 'BTC-USD', size: '-0.25', entryPrice: '19000', unrealizedPnl: '12.5', netFunding: '-0.5', createdAt: '2026-10-01T00:00:00Z' },
      },
    }
    const c = makeConnector(fake)
    const snap = await c.accountState(account)
    expect(snap.margin.equity).toBe('1234.5')
    expect(snap.margin.available).toBe('1000')
    expect(snap.balances[0]!.total).toBe('1234.5')
    expect(snap.positions).toHaveLength(1)
    expect(snap.positions[0]!.side).toBe('short')
    expect(snap.positions[0]!.size).toBe('0.25')
    expect(snap.positions[0]!.instrumentId).toBe('dydx:BTC-USD')
    expect(snap.source).toBe('rest')
  })

  it('扁平 BaseAccount（account.account_number / sequence）能读到序列号并下单', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('open')
    expect(fake.lastTx!.sequence).toBe(3)
    const accountGet = fake.requests.find((r) => r.url.includes('/cosmos/auth/v1beta1/accounts/'))
    expect(accountGet).toBeDefined()
  })

  it('vesting 形状（base_vesting_account.base_account）也能读到序列号', async () => {
    const fake = makeFake({ accountShape: 'vesting' })
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('open')
    expect(fake.lastTx!.sequence).toBe(3)
    expect(fake.failures).toEqual([])
  })

  it('两笔市价单相隔 10 s → 重取一次市场参数；限价单不强制重取', async () => {
    let now = 1_000_000
    const fake = makeFake()
    const c = makeConnector(fake, { now: () => now })
    await c.submit(ctx(), [intent({ type: 'market', size: '0.01', maxSlippageBps: 10 })])
    now += 10_000
    await c.submit(ctx(), [intent({ type: 'market', size: '0.01', maxSlippageBps: 10 })])
    const markets = () => fake.requests.filter((r) => r.method === 'GET' && r.url.includes('/v4/perpetualMarkets'))
    expect(markets()).toHaveLength(2)
    now += 10_000
    await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(markets()).toHaveLength(2)
  })

  it('账户不存在 → ACCOUNT_NOT_BOUND', async () => {    const fake = makeFake()
    fake.opts.subaccount = undefined
    const c = makeConnector(fake)
    await expect(c.accountState(account)).rejects.toMatchObject({ problem: { name: 'ACCOUNT_NOT_BOUND' } })
  })

  it('openOrders：两次 GET（OPEN + UNTRIGGERED）拿裸数组，剩余量 = size - totalFilled', async () => {
    const fake = makeFake({
      orders: [
        { id: 'o1', clientId: '11', clobPairId: '0', side: 'BUY', size: '0.5', totalFilled: '0.2', price: '19000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'o2', clientId: '12', clobPairId: '0', side: 'SELL', size: '0.1', totalFilled: '0', price: '21000', status: 'FILLED', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD' },
        { id: 'o3', clientId: '13', clobPairId: '0', side: 'SELL', size: '0.1', totalFilled: '0', price: '22000', status: 'UNTRIGGERED', type: 'TAKE_PROFIT_LIMIT', orderFlags: '32', market: 'BTC-USD', triggerPrice: '22000' },
      ],
    })
    const c = makeConnector(fake)
    const orders = await c.openOrders(account)
    expect(orders).toHaveLength(2)
    expect(orders[0]!.size).toBe('0.3')
    expect(orders[0]!.origSize).toBe('0.5')
    expect(orders[1]!.isTrigger).toBe(true)
    expect(orders[1]!.type).toBe('take_limit')
    const orderGets = fake.requests.filter((r) => r.method === 'GET' && r.url.includes('/v4/orders?'))
    expect(orderGets.map((r) => new URL(r.url).searchParams.get('status')).sort()).toEqual(['OPEN', 'UNTRIGGERED'])
  })

  it('裸数组：OPEN 一行 + UNTRIGGERED 一行 → openOrders 两行、cancelAll 两条撤单', async () => {
    const fake = makeFake({
      orders: [
        { id: 'p1', clientId: '31', clobPairId: '0', side: 'BUY', size: '0.01', totalFilled: '0', price: '19000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD' },
        { id: 'p2', clientId: '32', clobPairId: '0', side: 'SELL', size: '0.01', totalFilled: '0', price: '22000', status: 'UNTRIGGERED', type: 'TAKE_PROFIT_LIMIT', orderFlags: '32', market: 'BTC-USD', triggerPrice: '22000' },
      ],
    })
    const c = makeConnector(fake, { fee: { amount: [], gasLimit: 0 } })
    expect(await c.openOrders(account)).toHaveLength(2)
    expect(await c.cancelAll(ctx())).toHaveLength(2)
    expect(fake.txs).toHaveLength(2)
  })

  it('openOrders 的 clientOrderId 只在映射命中时给（默认 null，不下十进制 clientId）', async () => {
    const fake = makeFake({
      orders: [{ id: 'q1', clientId: '41', clobPairId: '0', side: 'BUY', size: '0.01', totalFilled: '0', price: '19000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD' }],
    })
    const c = makeConnector(fake)
    expect((await c.openOrders(account))[0]!.clientOrderId).toBeNull()
  })

  it('fills：按 Indexer 的 fill.id 去重，sinceMs 过滤', async () => {
    const fake = makeFake({
      fills: [
        { id: 'f1', orderId: 'o1', clientId: '11', market: 'BTC-USD', side: 'BUY', liquidity: 'TAKER', price: '19000', size: '0.1', fee: '0.19', createdAt: '2026-10-01T00:00:00.000Z', createdAtHeight: '100' },
        { id: 'f1', orderId: 'o1', clientId: '11', market: 'BTC-USD', side: 'BUY', liquidity: 'TAKER', price: '19000', size: '0.1', fee: '0.19', createdAt: '2026-10-01T00:00:00.000Z', createdAtHeight: '100' },
        { id: 'f2', orderId: 'o2', clientId: '12', market: 'BTC-USD', side: 'SELL', liquidity: 'MAKER', price: '20000', size: '0.2', fee: '-0.1', createdAt: '2026-09-01T00:00:00.000Z', createdAtHeight: '90' },
      ],
    })
    const c = makeConnector(fake)
    const fills = await c.fills(account, Date.parse('2026-09-15T00:00:00Z'))
    expect(fills).toHaveLength(1)
    expect(fills[0]!.venueFillId).toBe('f1')
    expect(fills[0]!.liquidity).toBe('taker')
    expect(fills[0]!.fee).toBe('0.19')
    const all = await c.fills(account, 0)
    expect(all).toHaveLength(2)
    expect(all.find((f) => f.venueFillId === 'f2')!.liquidity).toBe('maker')
  })

  it('fills 缺 id 时回退键 = orderId:height:size:price', async () => {
    const fake = makeFake({
      fills: [{ orderId: 'o9', clientId: '19', market: 'BTC-USD', side: 'BUY', liquidity: 'TAKER', price: '20000', size: '0.5', fee: '0.5', createdAt: '2026-10-01T00:00:00Z', createdAtHeight: '123' }],
    })
    const c = makeConnector(fake)
    const fills = await c.fills(account, 0)
    expect(fills[0]!.venueFillId).toBe('o9:123:0.5:20000')
  })

  it('orderStatus：给 venueOrderId → GET /v4/orders/{id}，不存在回 found:false', async () => {
    const fake = makeFake({
      orders: [{ id: 'o1', clientId: '4242', clobPairId: '0', side: 'BUY', size: '0.5', totalFilled: '0.1', price: '19000', status: 'OPEN', type: 'LIMIT', market: 'BTC-USD' }],
    })
    const c = makeConnector(fake)
    const hit = await c.orderStatus(account, { venueOrderId: 'o1' })
    expect(hit.found).toBe(true)
    expect(hit.status).toBe('OPEN')
    expect(hit.filledSize).toBe('0.1')
    expect((await c.orderStatus(account, { venueOrderId: 'missing' })).found).toBe(false)
  })

  it('3006 后 orderStatus({clientOrderId}) 靠映射里的 UUID 查得到', async () => {
    const fake = makeFake({ orders: [] })
    const c = makeConnector(fake)
    const hexId = '0a0b0c0d000000000000000000000000'
    await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc', clientOrderId: hexId as never })])
    const clientId = fake.lastTx!.orders[0]!.clientId
    const id = indexerId(c.address!, 0, clientId, 0, 0)
    fake.opts.orders = [{ id, clientId: String(clientId), clobPairId: '0', side: 'BUY', size: '0.01', totalFilled: '0.01', status: 'FILLED', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD' }]
    fake.opts.failNetwork = true
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc', clientOrderId: 'ffffffff000000000000000000000000' as never })])
    expect(res.acks[0]!.problem?.code).toBe(3006)
    fake.opts.failNetwork = false
    const hit = await c.orderStatus(account, { clientOrderId: hexId as never })
    expect(hit.found).toBe(true)
    expect(hit.status).toBe('FILLED')
  })

  it('新连接器（映射为空）按 clientOrderId 回推到 clientId 也能 found', async () => {
    const hexId = '0a0b0c0d000000000000000000000000'
    const fake = makeFake({
      orders: [{ id: 'r1', clientId: String(0x0a0b0c0d), clobPairId: '0', side: 'BUY', size: '0.01', totalFilled: '0', price: '19000', status: 'OPEN', type: 'LIMIT', orderFlags: '0', market: 'BTC-USD' }],
    })
    const hit = await makeConnector(fake).orderStatus(account, { clientOrderId: hexId as never })
    expect(hit.found).toBe(true)
    expect((await makeConnector(fake).orderStatus(account, { clientOrderId: '99999999000000000000000000000000' as never })).found).toBe(false)
  })

  it('成交行的 clientOrderId 按 orderId（UUID）映射回下单时的 hex', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const hexId = '22223333444455556666777788889999'
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc', clientOrderId: hexId as never })])
    fake.opts.fills = [{ id: 'f1', orderId: res.acks[0]!.venueOrderId, market: 'BTC-USD', side: 'BUY', liquidity: 'TAKER', price: '20000', size: '0.01', fee: '0.01', createdAt: '2026-10-01T00:00:00.000Z' }]
    const fills = await c.fills(account, 0)
    expect(fills[0]!.clientOrderId).toBe(hexId)
    expect(fills[0]!.venueOrderId).toBe(res.acks[0]!.venueOrderId)
  })

  it('startupSnapshot：持仓取持仓专用端点的结果，fills 不截断时 truncated=false', async () => {
    const fake = makeFake({
      positions: [{ market: 'ETH-USD', size: '2', entryPrice: '3000', unrealizedPnl: '10', realizedPnl: '5', netFunding: '-0.2', createdAt: '2026-10-01T00:00:00Z' }],
      fills: [{ id: 'f1', orderId: 'o1', market: 'BTC-USD', side: 'BUY', price: '1', size: '1', fee: '0', createdAt: '2026-10-01T00:00:00Z' }],
    })
    const c = makeConnector(fake)
    const snap = await c.startupSnapshot(account, 0)
    expect(snap.account.positions).toHaveLength(1)
    expect(snap.account.positions[0]!.instrumentId).toBe('dydx:ETH-USD')
    expect(snap.fills).toHaveLength(1)
    expect(snap.truncated).toBe(false)
  })

  it('行情方法没有注入行情源时老实回 1004 / 空列表', async () => {
    const c = makeConnector(makeFake())
    expect(c.listInstruments()).toEqual([])
    expect(c.quote('dydx:BTC-USD')).toBeUndefined()
    await expect(c.book('dydx:BTC-USD')).rejects.toMatchObject({ problem: { code: 5002 } })
    expect(c.subscribe({ channel: 'mids' }, () => {})).toBeTypeOf('function')
  })

  it('parseMarkets 跳过字段缺失的市场', () => {
    const m = parseMarkets({ markets: { 'BTC-USD': { clobPairId: '0', atomicResolution: -10, quantumConversionExponent: -9, stepBaseQuantums: '1000000', subticksPerTick: '100000', oraclePrice: '20000', tickSize: '1', stepSize: '0.0001' }, BROKEN: { clobPairId: 'x' } } })
    expect(Array.from(m.keys())).toEqual(['BTC-USD'])
    expect(m.get('BTC-USD')!.stepBaseQuantums).toBe(1_000_000)
  })
})

describe('能力声明与密钥外泄', () => {
  it('describe() 的关键位：market emulated、amend none、cancelAll emulated、batch 1', () => {
    const caps = makeConnector(makeFake()).describe()
    expect(caps.venue).toBe('dydx')
    expect(caps.orderTypes.market).toBe('emulated')
    expect(caps.orderTypes.limit).toBe('native')
    expect(caps.orderTypes.stop_market).toBe('native')
    expect(caps.orderTypes.trailing_stop).toBe('none')
    expect(caps.amend).toBe('none')
    expect(caps.cancelAll).toBe('emulated')
    expect(caps.batch).toEqual({ maxOrders: 1, atomic: false })
    expect(caps.tif).toEqual(['gtc', 'ioc', 'alo'])
    expect(caps.triggerPriceTypes).toEqual(['mark'])
    expect(caps.marginModes).toEqual(['cross'])
    expect(caps['x-unverified']).toMatch(/not verified/)
  })

  it('HTTP 层不再暴露 secrets() 方法（私钥脱敏在连接器自己身上）', () => {
    const c = makeConnector(makeFake())
    expect((c.http as unknown as { secrets?: unknown }).secrets).toBeUndefined()
    expect(JSON.stringify(c.http)).not.toContain(KEY)
    expect(inspect(c.http, { depth: 4, showHidden: true })).not.toContain(KEY)
  })

  it('JSON.stringify(connector) / util.inspect 不含私钥', () => {
    const c = makeConnector(makeFake())
    expect(JSON.stringify(c)).not.toContain(KEY)
    expect(inspect(c, { depth: 4 })).not.toContain(KEY)
    expect(inspect(c, { depth: 4, showHidden: true })).not.toContain(KEY)
  })

  it('上游错误原文回显私钥时被脱敏', async () => {
    const fake = makeFake()
    fake.opts.nextCode = 1100
    fake.opts.nextRawLog = `bad key ${KEY}`
    const c = makeConnector(fake)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(JSON.stringify(res.acks[0]!.problem)).not.toContain(KEY)
    expect(res.acks[0]!.problem?.venue?.message).toContain('<redacted>')
  })

  it('连接器把行情源的方法透传出去（注入假行情源）', async () => {
    const fake = makeFake()
    const calls: string[] = []
    const market = {
      listInstruments: () => { calls.push('list'); return [{ instrumentId: 'dydx:BTC-USD' }] },
      getInstrument: () => undefined,
      quote: () => undefined,
      book: async () => { calls.push('book'); return { instrumentId: 'dydx:BTC-USD', bids: [], asks: [], ts: 0 } },
      candles: async () => [],
      context: async () => ({ instrumentId: 'dydx:BTC-USD' }),
      subscribe: () => () => {},
      status: () => ({ stale: false, source: 'rest', lastMessageTs: 1 }),
    }
    const c = makeConnector(fake, { market })
    expect(c.listInstruments()).toHaveLength(1)
    await c.book('dydx:BTC-USD')
    expect(calls).toEqual(['list', 'book'])
    expect(c.status().source).toBe('rest')
  })
})

describe('假节点的独立校验（不是循环自证）', () => {
  it('BROADCAST_MODE_BLOCK → HTTP 500（cosmos-sdk v0.50 只支持 sync/async）', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    await expect(c.http.nodePost('/cosmos/tx/v1beta1/txs', { tx_bytes: 'AAAA', mode: 'BROADCAST_MODE_BLOCK' }))
      .rejects.toMatchObject({ status: 500 })
    expect(fake.failures.some((f) => f.includes('BROADCAST_MODE_BLOCK'))).toBe(true)
  })

  it('OrderId.owner 不是签名公钥派生的地址 → code 4，sequence 不变', async () => {
    const fake = makeFake()
    const c = makeConnector(fake)
    const order: OrderMessage = {
      orderId: {
        owner: 'dydx14zzueazeh0hj67cghhf9jypslcf9sh2n5k6art',
        subaccountNumber: 0, clientId: 5, clobPairId: 0, orderFlags: 0,
      },
      side: 'buy',
      quantums: 1_000_000,
      subticks: 2_000_000_000,
      goodTilBlock: 1020,
      tif: 'ioc',
      reduceOnly: false,
      clientMetadata: 0,
    }
    const signed = signTransaction(new DydxSigner(KEY), [anyOf(TYPE_URL.msgPlaceOrder, msgPlaceOrder(order))], {
      chainId: 'dydx-testnet-4', accountNumber: 9, sequence: 3, fee: { amount: [], gasLimit: 0 },
    })
    const res = await c.http.nodePost<{ tx_response?: { code?: number; raw_log?: string } }>(
      '/cosmos/tx/v1beta1/txs', { tx_bytes: signed.txBytesBase64, mode: 'BROADCAST_MODE_SYNC' },
    )
    expect(res.data.tx_response?.code).toBe(4)
    expect(res.data.tx_response?.raw_log).toContain('pubKey does not match signer address')
    expect(fake.failures.some((f) => f.includes('owner'))).toBe(true)
    expect(fake.opts.sequence).toBe(3)
  })
})
