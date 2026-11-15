// SPDX-License-Identifier: CPAL-1.0
// 账户读取（全离线，假服务器）：balance / positions / fills / 挂单（普通 + 算法）/ 单状态 / 启动对账。
// 数量一律折成币：OKX 的 pos / fillSz / sz 都是张，按标的 ctVal 换算。
import { describe, expect, it } from 'vitest'
import { parseAlgoOrder, parseBalance, parseFill, parseOpenOrder, parsePosition } from '../src/account'
import { ProblemError } from '../src/errors'
import { FakeOkxTrade, NOW } from './helpers/fake-okx-trade'
import { stack, tradeContext } from './helpers/setup'

describe('parseBalance', () => {
  const snapshot = parseBalance({
    totalEq: '1000.5', imr: '100', mmr: '10', mgnRatio: '0.01', uTime: String(NOW),
    details: [
      { ccy: 'USDT', eq: '1000.5', cashBal: '1000.5', availBal: '900.5', frozenBal: '100', upl: '2.5' },
      { ccy: 'USDC', eq: '0', cashBal: '0', availBal: '0' },
    ],
  }, 'acct_test', NOW)

  it('reads equity / initial / maintenance margin from the account row', () => {
    expect(snapshot.margin).toMatchObject({
      accountId: 'acct_test', model: 'unified', valuationCcy: 'USDT',
      equity: '1000.5', initialMargin: '100', maintenanceMargin: '10', available: '900.5', marginRatio: '0.01', ts: NOW,
    })
  })

  it('turns details[] into balances (total / available / hold)', () => {
    expect(snapshot.balances[0]).toMatchObject({ asset: 'USDT', total: '1000.5', available: '900.5', hold: '100' })
    expect(snapshot.balances[1]).toMatchObject({ asset: 'USDC', total: '0' })
  })

  it('falls back to mmr/equity when mgnRatio is missing', () => {
    const out = parseBalance({ totalEq: '1000', mmr: '25', details: [] }, 'acct_test', NOW)
    expect(out.margin.marginRatio).toBe('0.025')
  })

  it('marks the snapshot as rest-sourced', () => {
    expect(snapshot.source).toBe('rest')
    expect(snapshot.positions).toEqual([])
  })
})

describe('parsePosition', () => {
  it('folds contracts into base units and keeps a net long positive', () => {
    const p = parsePosition({ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '2', avgPx: '99000', markPx: '100000', lever: '10' }, 'acct_test', '0.01', NOW)
    expect(p).toMatchObject({ instrumentId: 'okx:BTC-USDT-SWAP', side: 'long', size: '0.02', entryPrice: '99000', markPrice: '100000', leverage: 10 })
    expect(p!.notional).toBe('2000')
  })

  it('reads a hedge short from posSide', () => {
    const p = parsePosition({ instId: 'ETH-USDT-SWAP', posSide: 'short', pos: '10', avgPx: '3000', markPx: '2900', lever: '5', mgnMode: 'isolated' }, 'acct_test', '0.1', NOW)
    expect(p).toMatchObject({ side: 'short', size: '1', marginMode: 'isolated' })
  })

  it('uses the sign of pos in net mode', () => {
    const p = parsePosition({ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '-3', markPx: '100000' }, 'acct_test', '0.01', NOW)
    expect(p).toMatchObject({ side: 'short', size: '0.03' })
  })

  it('skips flat and malformed rows', () => {
    expect(parsePosition({ instId: 'BTC-USDT-SWAP', pos: '0' }, 'acct_test', '0.01', NOW)).toBeNull()
    expect(parsePosition({ instId: 'XXX-USDT-SWAP', pos: '0' }, 'acct_test', undefined, NOW)).toBeNull()
    expect(parsePosition({ pos: '1' }, 'acct_test', '0.01', NOW)).toBeNull()
  })

  it('folds fractional contracts without float noise', () => {
    const p = parsePosition({ instId: 'ETH-USDT-SWAP', posSide: 'net', pos: '3', markPx: '2900' }, 'acct_test', '0.1', NOW)
    expect(p!.size).toBe('0.3')
    expect(p!.notional).toBe('870')
  })

  it('refuses to report contracts as coins when ctVal is unknown', () => {
    let caught: unknown
    try {
      parsePosition({ instId: 'XXX-USDT-SWAP', pos: '4', markPx: '10' }, 'acct_test', undefined, NOW)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProblemError)
    expect((caught as ProblemError).problem.code).toBe(1001)
  })
})

describe('parseFill', () => {
  it('namespaces native and fallback trade ids by instrument', () => {
    const nativeIds = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'].map((instId) => parseFill({ instId, tradeId: '77', ordId: '9', fillSz: '1', fillTime: '123' }, '0.01', NOW)!.venueFillId)
    const fallbackIds = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'].map((instId) => parseFill({ instId, ordId: '9', fillSz: '1', fillTime: '123' }, '0.01', NOW)!.venueFillId)
    expect(nativeIds).toEqual(['BTC-USDT-SWAP:77', 'ETH-USDT-SWAP:77'])
    expect(fallbackIds).toEqual(['BTC-USDT-SWAP:9-123', 'ETH-USDT-SWAP:9-123'])
    const explicitEmptyId = parseFill({ instId: 'BTC-USDT-SWAP', tradeId: '', ordId: '9', fillSz: '1', fillTime: '123' }, '0.01', NOW)
    expect(explicitEmptyId!.venueFillId).toBe('')
  })

  it('flips the OKX fee sign into the protocol "positive = paid" convention', () => {
    const f = parseFill({ instId: 'BTC-USDT-SWAP', tradeId: '77', ordId: '1', fillSz: '2', fillPx: '100000', fee: '-0.02', feeCcy: 'USDT', fillTime: String(NOW), execType: 'T' }, '0.01', NOW)
    expect(f).toMatchObject({ venueFillId: 'BTC-USDT-SWAP:77', venueOrderId: '1', size: '0.02', price: '100000', fee: '0.02', feeCcy: 'USDT', liquidity: 'taker', ts: NOW })
  })

  it('keeps a rebate negative and marks maker fills', () => {
    const f = parseFill({ instId: 'BTC-USDT-SWAP', tradeId: '78', fillSz: '1', fillPx: '100100', fee: '0.01', execType: 'M' }, '0.01', NOW)
    expect(f!.fee).toBe('-0.01')
    expect(f!.liquidity).toBe('maker')
  })

  it('skips zero-size and instId-less rows', () => {
    expect(parseFill({ instId: 'BTC-USDT-SWAP', fillSz: '0' }, '0.01', NOW)).toBeNull()
    expect(parseFill({ instId: 'XXX-USDT-SWAP', fillSz: '0' }, undefined, NOW)).toBeNull()
    expect(parseFill({ fillSz: '1' }, '0.01', NOW)).toBeNull()
  })

  it('keeps the upstream fillPnl as realizedPnl', () => {
    const f = parseFill({ instId: 'BTC-USDT-SWAP', fillSz: '1', fillPx: '100', fillPnl: '3.2' }, '0.01', NOW)
    expect(f!.realizedPnl).toBe('3.2')
  })

  it('refuses a fill on an unknown instrument', () => {
    expect(() => parseFill({ instId: 'XXX-USDT-SWAP', fillSz: '1' }, undefined, NOW)).toThrow(ProblemError)
  })
})

describe('parseOpenOrder / parseAlgoOrder', () => {
  it('reports the remaining size in base units', () => {
    const o = parseOpenOrder({ instId: 'BTC-USDT-SWAP', ordId: '1', clOrdId: 'gtx', side: 'buy', ordType: 'limit', sz: '5', accFillSz: '2', px: '99000', cTime: String(NOW) }, '0.01', NOW)
    expect(o).toMatchObject({ instrumentId: 'okx:BTC-USDT-SWAP', venueOrderId: '1', side: 'buy', type: 'limit', size: '0.03', origSize: '0.05', price: '99000' })
  })

  it('treats an empty accFillSz as nothing filled', () => {
    const o = parseOpenOrder({ instId: 'BTC-USDT-SWAP', ordId: '1', side: 'buy', ordType: 'limit', sz: '5', accFillSz: '', px: '99000', cTime: String(NOW) }, '0.01', NOW)
    expect(o).toMatchObject({ size: '0.05', origSize: '0.05' })
  })

  it('marks algo orders as triggers with their trigger price', () => {
    const o = parseAlgoOrder({ instId: 'BTC-USDT-SWAP', algoId: '9', side: 'sell', ordType: 'conditional', sz: '2', slTriggerPx: '95000', cTime: String(NOW) }, '0.01', NOW)
    expect(o).toMatchObject({ venueOrderId: '9', type: 'stop_market', triggerPrice: '95000', isTrigger: true, reduceOnly: false })
  })

  it('exposes an OCO pair as stop_market and a trailing order as unknown', () => {
    expect(parseAlgoOrder({ instId: 'BTC-USDT-SWAP', algoId: '9', ordType: 'oco', sz: '1', tpTriggerPx: '110000', slTriggerPx: '90000' }, '0.01', NOW)!.type).toBe('stop_market')
    expect(parseAlgoOrder({ instId: 'ETH-USDT-SWAP', algoId: '8', ordType: 'move_order_stop', sz: '1' }, '0.1', NOW)!.type).toBe('unknown')
  })

  it('reads algoClOrdId and derives reduceOnly from posSide/side', () => {
    const algo = parseAlgoOrder({ instId: 'BTC-USDT-SWAP', algoId: '9', algoClOrdId: 'gtsl9', side: 'sell', posSide: 'long', ordType: 'conditional', sz: '2', slTriggerPx: '95000' }, '0.01', NOW)
    expect(algo).toMatchObject({ clientOrderId: 'gtsl9', reduceOnly: true })
    const netBuy = parseAlgoOrder({ instId: 'BTC-USDT-SWAP', algoId: '9', side: 'buy', ordType: 'conditional', sz: '2', slTriggerPx: '95000' }, '0.01', NOW)
    expect(netBuy!.reduceOnly).toBe(false)
  })

  it('refuses an open order on an unknown instrument', () => {
    expect(() => parseOpenOrder({ instId: 'XXX-USDT-SWAP', sz: '1' }, undefined, NOW)).toThrow(ProblemError)
  })
})

describe('OkxAccounts (fake server)', () => {
  it('reads an account snapshot with live positions', async () => {
    const { accounts } = stack()
    const snap = await accounts.accountState(tradeContext().account)
    expect(snap.margin.equity).toBe('1000.5')
    expect(snap.positions).toHaveLength(2)
    expect(snap.positions[0]).toMatchObject({ side: 'long', size: '0.02' })
  })

  it('skips flat positions on unknown instruments but keeps the rest', async () => {
    const fake = new FakeOkxTrade()
    fake.positions = [
      { instId: 'BTC-USD-SWAP', posSide: 'net', pos: '0', markPx: '100000', lever: '10' },
      { instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '2', avgPx: '99000', markPx: '100000', lever: '10' },
    ]
    const { accounts } = stack({ fake })
    const positions = await accounts.positions(tradeContext().account)
    expect(positions).toHaveLength(1)
    expect(positions[0]!.size).toBe('0.02')
  })

  it('merges normal pending orders and the three algo channels', async () => {
    const { fake, accounts } = stack()
    const open = await accounts.openOrders(tradeContext().account)
    expect(open).toHaveLength(3)
    expect(open.map((o) => o.venueOrderId).sort()).toEqual(['3122698', '5566', '7788'])
    expect(fake.callsTo('/api/v5/trade/orders-algo-pending')).toHaveLength(3)
    expect(fake.callsTo('/api/v5/trade/orders-algo-pending').map((c) => c.params.get('ordType'))).toEqual(['conditional', 'oco', 'move_order_stop'])
  })

  it('reads fills across all SWAPs when no symbol is given', async () => {
    const { accounts, fake } = stack()
    const fills = await accounts.fills(tradeContext().account, NOW - 60_000)
    expect(fills).toHaveLength(2)
    expect(fills[0]).toMatchObject({ size: '0.02', fee: '0.02' })
    const call = fake.callsFor('GET', '/api/v5/trade/fills')[0]!
    expect(call.params.get('instId')).toBeNull()
    expect(call.params.get('instType')).toBe('SWAP')
    expect(call.params.get('begin')).toBe(String(NOW - 60_000))
  })

  it('narrows fills to instId only when the caller asks', async () => {
    const { accounts, fake } = stack()
    await accounts.fills(tradeContext().account, NOW - 60_000, { symbol: 'BTC-USDT-SWAP' })
    expect(fake.callsFor('GET', '/api/v5/trade/fills')[0]!.params.get('instId')).toBe('BTC-USDT-SWAP')
  })

  it('rejects fills for an instrument without ctVal', async () => {
    const fake = new FakeOkxTrade()
    fake.fills = [{ instId: 'XXX-USDT-SWAP', tradeId: '1', fillSz: '1', fillPx: '10' }]
    const { accounts } = stack({ fake })
    await expect(accounts.fills(tradeContext().account, 0)).rejects.toMatchObject({ problem: { code: 1001 } })
  })

  it('reads a single order status with the upstream state string', async () => {
    const { accounts } = stack()
    const status = await accounts.orderStatus(tradeContext().account, { venueOrderId: '3122698' }, { symbol: 'BTC-USDT-SWAP', channel: 'order' })
    expect(status).toMatchObject({ found: true, status: 'partially_filled', venueOrderId: '3122698' })
    expect(status.filledSize).toBe('0.02')
  })

  it('maps 51603 (order does not exist) to found: false', async () => {
    const { accounts, fake } = stack()
    fake.fail('GET', '/api/v5/trade/order', { code: '51603', msg: 'Order does not exist' })
    const status = await accounts.orderStatus(tradeContext().account, { clientOrderId: 'gtnope' }, { symbol: 'BTC-USDT-SWAP', channel: 'order' })
    expect(status.found).toBe(false)
  })

  it('builds a startup snapshot (account + open orders + fills)', async () => {
    const { accounts } = stack()
    const snap = await accounts.startupSnapshot(tradeContext().account, NOW - 60_000)
    expect(snap.account.margin.equity).toBe('1000.5')
    expect(snap.openOrders).toHaveLength(3)
    expect(snap.fills).toHaveLength(2)
    expect(snap.fillsSince).toBe(NOW - 60_000)
    expect(snap.truncated).toBe(false)
  })

  it('rejects positions whose instrument has no ctVal', async () => {
    const fake = new FakeOkxTrade()
    fake.positions = [
      { instId: 'BTC-USD-SWAP', posSide: 'net', pos: '50', markPx: '100000' },
    ]
    const { accounts } = stack({ fake })
    await expect(accounts.positions(tradeContext().account)).rejects.toMatchObject({ problem: { code: 1001 } })
  })

  it('reads the account config (posMode decides posSide)', async () => {
    const { accounts } = stack()
    expect(await accounts.accountConfig()).toMatchObject({ posMode: 'net_mode' })
  })

  it('splits pending ids into orders and algos for the two cancel endpoints', async () => {
    const { accounts } = stack()
    const refs = await accounts.pendingRefs()
    expect(refs.orders).toEqual([{ instId: 'BTC-USDT-SWAP', venueOrderId: '3122698', clOrdId: 'gtopen1' }])
    expect(refs.algos.map((a) => a.venueOrderId).sort()).toEqual(['5566', '7788'])
  })
})
