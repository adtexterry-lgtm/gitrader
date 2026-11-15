// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 撤单 / 全撤 / 改单 / 杠杆 / 死人开关（全离线，假服务器）。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import { CANCEL_AFTER_MAX_SEC, CANCEL_ALGO_BATCH_MAX, CANCEL_BATCH_MAX } from '../src/trading'
import { NOW } from './helpers/fake-okx-trade'
import { stack, tradeContext } from './helpers/setup'

const ctx = (): ReturnType<typeof tradeContext> => tradeContext()

function intent(over: Record<string, unknown> = {}): OrderIntent {
  return {
    accountId: 'acct_test',
    instrumentId: 'okx:BTC-USDT-SWAP',
    side: 'buy',
    type: 'limit',
    size: '0.05',
    price: '100000',
    ...over,
  } as unknown as OrderIntent
}

describe('submit', () => {
  it('posts a limit order to /trade/order and acks it as open', async () => {
    const { fake, trading } = stack()
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gtclient1' })])
    expect(result.acks).toHaveLength(1)
    expect(result.acks[0]).toMatchObject({ status: 'open', venueOrderId: '3122698', clientOrderId: 'gtclient1' })
    expect(result.acks[0]!.filledSize).toBe('0')
    expect(result.requestWeight).toBe(1)
    const call = fake.callsFor('POST', '/api/v5/trade/order')[0]!
    expect(JSON.parse(call.body)).toMatchObject({ instId: 'BTC-USDT-SWAP', ordType: 'limit', sz: '5', px: '100000', clOrdId: 'gtclient1' })
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('posts conditional orders to /trade/order-algo and acks them as untriggered', async () => {
    const { fake, trading } = stack()
    const result = await trading.submit(ctx(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '95000', clientOrderId: 'gtstop1' })])
    expect(result.acks[0]!.status).toBe('untriggered')
    expect(fake.callsFor('POST', '/api/v5/trade/order-algo')).toHaveLength(1)
    expect(fake.callsFor('POST', '/api/v5/trade/order')).toHaveLength(0)
  })

  it('rejects an intent with tpsl (1004) without touching the network', async () => {
    const { fake, trading } = stack()
    const result = await trading.submit(ctx(), [intent({
      tpsl: { stopLoss: { triggerPrice: '95000' }, grouping: 'position' },
    })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(fake.callsFor('POST', '/api/v5/trade/order')).toHaveLength(0)
  })

  it('maps a per-row sCode into a classified problem', async () => {
    const { fake, trading } = stack()
    fake.rejectClOrdIds.set('gtpoor1', { sCode: '51008', sMsg: 'Insufficient balance' })
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gtpoor1' })])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.name).toBe('VENUE_INSUFFICIENT_MARGIN')
    expect(result.acks[0]!.problem?.venue?.message).toBe('Insufficient balance')
  })

  it('keeps intentIndex aligned when one order is rejected by the builder', async () => {
    const { trading } = stack()
    const result = await trading.submit(ctx(), [intent({ type: 'twap' }), intent({ clientOrderId: 'gtsecond' })])
    expect(result.acks.map((a) => a.intentIndex)).toEqual([0, 1])
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[1]!.status).toBe('open')
  })

  it('applies leverage before the order when the intent asks for it', async () => {
    const { fake, trading } = stack()
    await trading.submit(ctx(), [intent({ leverage: 10, marginMode: 'isolated' })])
    const lev = fake.callsFor('POST', '/api/v5/account/set-leverage')
    expect(lev).toHaveLength(1)
    expect(JSON.parse(lev[0]!.body)).toEqual({ instId: 'BTC-USDT-SWAP', lever: '10', mgnMode: 'isolated' })
  })
})

describe('cancel', () => {
  it('cancels by ordId', async () => {
    const { fake, trading } = stack()
    const [ack] = await trading.cancel(ctx(), [{ instrumentId: 'okx:BTC-USDT-SWAP', venueOrderId: '3122698' }])
    expect(ack!.ok).toBe(true)
    expect(JSON.parse(fake.callsFor('POST', '/api/v5/trade/cancel-order')[0]!.body)).toEqual({ instId: 'BTC-USDT-SWAP', ordId: '3122698' })
  })

  it('cancels by clOrdId', async () => {
    const { fake, trading } = stack()
    await trading.cancel(ctx(), [{ instrumentId: 'okx:BTC-USDT-SWAP', clientOrderId: 'gtopen1' }])
    expect(JSON.parse(fake.callsFor('POST', '/api/v5/trade/cancel-order')[0]!.body)).toEqual({ instId: 'BTC-USDT-SWAP', clOrdId: 'gtopen1' })
  })

  it('rejects a target with neither id', async () => {
    const { trading } = stack()
    const [ack] = await trading.cancel(ctx(), [{ instrumentId: 'okx:BTC-USDT-SWAP' }])
    expect(ack!.ok).toBe(false)
    expect(ack!.problem?.code).toBe(-32602)
  })

  it('reports an upstream failure as a problem instead of throwing', async () => {
    const { fake, trading } = stack()
    fake.fail('POST', '/api/v5/trade/cancel-order', { code: '51003', msg: 'Order does not exist' })
    const [ack] = await trading.cancel(ctx(), [{ instrumentId: 'okx:BTC-USDT-SWAP', venueOrderId: '1' }])
    expect(ack!.ok).toBe(false)
    expect(ack!.problem?.category).toBe('VENUE')
  })
})

describe('cancelAll', () => {
  it('batch-cancels normal orders and algo orders through their own endpoints', async () => {
    const { fake, trading } = stack()
    const acks = await trading.cancelAll(ctx(), 'okx:BTC-USDT-SWAP')
    expect(acks).toHaveLength(1)
    expect(acks[0]!.ok).toBe(true)
    const batch = fake.callsFor('POST', '/api/v5/trade/cancel-batch-orders')
    const algos = fake.callsFor('POST', '/api/v5/trade/cancel-algos')
    expect(batch).toHaveLength(1)
    expect(JSON.parse(batch[0]!.body)).toEqual([{ instId: 'BTC-USDT-SWAP', ordId: '3122698' }])
    expect(algos).toHaveLength(1)
    expect(JSON.parse(algos[0]!.body)).toEqual([{ instId: 'BTC-USDT-SWAP', algoId: '5566' }])
  })

  it('returns one ack per instrument when no instrument is given', async () => {
    const { trading } = stack()
    const acks = await trading.cancelAll(ctx())
    const ids = acks.map((a) => a.target.instrumentId).sort()
    expect(ids).toEqual(['okx:BTC-USDT-SWAP', 'okx:ETH-USDT-SWAP'])
    expect(acks.every((a) => a.ok)).toBe(true)
  })

  it('batch sizes match the documented limits', () => {
    expect(CANCEL_BATCH_MAX).toBe(20)
    expect(CANCEL_ALGO_BATCH_MAX).toBe(10)
  })
})

describe('amend', () => {
  it('a code-0 amend response with no rows is unknown (3006), never success', async () => {
    const { fake, trading } = stack()
    fake.fail('POST', '/api/v5/trade/amend-order', { code: '0', msg: '', data: [] }, 200)
    const result = await trading.amend(ctx(), {
      instrumentId: 'okx:BTC-USDT-SWAP',
      venueOrderId: '3122698',
      order: intent({ size: '0.06', price: '100100' }),
    })
    expect(result.acks[0]).toMatchObject({ status: 'unknown', problem: { code: 3006 } })
  })

  it('amends a plain limit order through /trade/amend-order', async () => {
    const { fake, trading } = stack()
    const result = await trading.amend(ctx(), {
      instrumentId: 'okx:BTC-USDT-SWAP',
      venueOrderId: '3122698',
      order: intent({ size: '0.06', price: '100100' }),
    })
    expect(result.acks[0]!.status).toBe('open')
    const body = JSON.parse(fake.callsFor('POST', '/api/v5/trade/amend-order')[0]!.body)
    expect(body).toEqual({ instId: 'BTC-USDT-SWAP', ordId: '3122698', newSz: '6', newPx: '100100' })
  })

  it('refuses to amend anything but a plain limit order (1004)', async () => {
    const { fake, trading } = stack()
    const result = await trading.amend(ctx(), {
      instrumentId: 'okx:BTC-USDT-SWAP',
      venueOrderId: '1',
      order: intent({ type: 'stop_market', price: undefined, triggerPrice: '95000' }),
    })
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(fake.callsFor('POST', '/api/v5/trade/amend-order')).toHaveLength(0)
  })

  it('needs a venue id or a client id', async () => {
    const { trading } = stack()
    const result = await trading.amend(ctx(), { instrumentId: 'okx:BTC-USDT-SWAP', order: intent() })
    expect(result.acks[0]!.problem?.code).toBe(-32602)
  })
})

describe('setLeverage', () => {
  it('posts set-leverage once and caches the value', async () => {
    const { fake, trading } = stack()
    await trading.setLeverage(ctx(), 'okx:BTC-USDT-SWAP', 5, 'cross')
    await trading.setLeverage(ctx(), 'okx:BTC-USDT-SWAP', 5, 'cross')
    expect(fake.callsFor('POST', '/api/v5/account/set-leverage')).toHaveLength(1)
    expect(trading.leverageState()).toEqual([{ instrumentId: 'okx:BTC-USDT-SWAP', leverage: 5, marginMode: 'cross' }])
  })

  it('rejects a leverage outside 1–125 before calling the venue', async () => {
    const { fake, trading } = stack()
    await expect(trading.setLeverage(ctx(), 'okx:BTC-USDT-SWAP', 0, 'cross')).rejects.toThrow(/1 to 125/)
    expect(fake.callsFor('POST', '/api/v5/account/set-leverage')).toHaveLength(0)
  })

  it('sends posSide only in hedge mode', async () => {
    const oneWay = stack()
    await oneWay.trading.setLeverage(ctx(), 'okx:BTC-USDT-SWAP', 3, 'cross')
    expect(JSON.parse(oneWay.fake.callsFor('POST', '/api/v5/account/set-leverage')[0]!.body).posSide).toBeUndefined()
    const hedge = stack({ positionMode: 'hedge' })
    await hedge.trading.setLeverage(ctx(), 'okx:BTC-USDT-SWAP', 3, 'cross')
    expect(JSON.parse(hedge.fake.callsFor('POST', '/api/v5/account/set-leverage')[0]!.body).posSide).toBe('long')
  })
})

describe('scheduleCancel (venue-side deadman)', () => {
  it('posts cancel-all-after with timeOut in whole seconds', async () => {
    const { fake, trading } = stack()
    await trading.scheduleCancel(ctx(), NOW + 30_000)
    expect(JSON.parse(fake.callsFor('POST', '/api/v5/trade/cancel-all-after')[0]!.body)).toEqual({ timeOut: '30' })
    await trading.scheduleCancel(ctx(), NOW + 10_000)
    expect(JSON.parse(fake.callsFor('POST', '/api/v5/trade/cancel-all-after')[1]!.body)).toEqual({ timeOut: '10' })
  })

  it('atMs = null clears the timer with timeOut=0', async () => {
    const { fake, trading } = stack()
    await trading.scheduleCancel(ctx(), null)
    expect(JSON.parse(fake.callsFor('POST', '/api/v5/trade/cancel-all-after')[0]!.body)).toEqual({ timeOut: '0' })
  })

  it('rejects 5 s and 10 min without sending a request', async () => {
    const { fake, trading } = stack()
    await expect(trading.scheduleCancel(ctx(), NOW + 5_000)).rejects.toMatchObject({ problem: { code: -32602 } })
    await expect(trading.scheduleCancel(ctx(), NOW + 10 * 60_000)).rejects.toMatchObject({ problem: { code: -32602 } })
    expect(fake.callsFor('POST', '/api/v5/trade/cancel-all-after')).toHaveLength(0)
    expect(CANCEL_AFTER_MAX_SEC).toBe(120)
  })

  it('surfaces an upstream failure as a ProblemError', async () => {
    const { fake, trading } = stack()
    fake.fail('POST', '/api/v5/trade/cancel-all-after', { code: '50013', msg: 'System busy' })
    let caught: { problem?: { name: string; retryable: boolean; venue?: { message: string } } } | undefined
    try {
      await trading.scheduleCancel(ctx(), NOW + 30_000)
    } catch (e) {
      caught = e as typeof caught
    }
    expect(caught?.problem?.name).toBe('VENUE_RATE_LIMITED')
    expect(caught?.problem?.retryable).toBe(true)
    expect(caught?.problem?.venue?.message).toContain('System busy')
  })
})

describe('per-row order outcomes', () => {
  it('turns a rejected cancel row into ok:false with its venue code', async () => {
    const { fake, trading } = stack()
    fake.cancelFail.set('3122698', { sCode: '51400', sMsg: 'Order cancellation failed as the order has been filled, canceled or does not exist' })
    const [ack] = await trading.cancel(ctx(), [{ instrumentId: 'okx:BTC-USDT-SWAP', venueOrderId: '3122698' }])
    expect(ack!.ok).toBe(false)
    expect(ack!.problem?.code).toBe(3001)
    expect(ack!.problem?.venue?.code).toBe(51400)
  })

  it('marks cancelAll failed when one batch row is rejected', async () => {
    const { fake, trading } = stack()
    fake.cancelFail.set('3122698', { sCode: '51400', sMsg: 'Order cancellation failed as the order has been filled, canceled or does not exist' })
    const [ack] = await trading.cancelAll(ctx(), 'okx:BTC-USDT-SWAP')
    expect(ack!.ok).toBe(false)
    expect(ack!.problem?.message).toContain('1 of 1 failed')
  })

  it('a cancel response with no rows is 3006, never success', async () => {
    const { fake, trading } = stack()
    fake.fail('POST', '/api/v5/trade/cancel-order', { code: '0', msg: '', data: [] }, 200)
    const [ack] = await trading.cancel(ctx(), [{ instrumentId: 'okx:BTC-USDT-SWAP', venueOrderId: '3122698' }])
    expect(ack!.ok).toBe(false)
    expect(ack!.problem?.code).toBe(3006)
  })

  it('pages through 150 pending orders and cancels them in eight batches', async () => {
    const { fake, trading } = stack()
    fake.ordersPending = Array.from({ length: 150 }, (_, i) => ({
      instId: 'BTC-USDT-SWAP', ordId: String(i + 1), clOrdId: `gtp${i + 1}`, side: 'buy',
      ordType: 'limit', sz: '1', px: '100000', state: 'live', cTime: String(NOW),
    }))
    fake.algoPending = { conditional: [], oco: [], move_order_stop: [] }
    const [ack] = await trading.cancelAll(ctx(), 'okx:BTC-USDT-SWAP')
    expect(ack!.ok).toBe(true)
    const pageCalls = fake.callsFor('GET', '/api/v5/trade/orders-pending')
    expect(pageCalls).toHaveLength(2)
    expect(pageCalls[1]!.params.get('after')).toBe('100')
    const batches = fake.callsFor('POST', '/api/v5/trade/cancel-batch-orders')
    expect(batches).toHaveLength(8)
    const ids = batches.flatMap((c) => (JSON.parse(c.body) as Array<{ ordId: string }>).map((r) => r.ordId))
    expect(ids).toHaveLength(150)
    expect(new Set(ids).size).toBe(150)
  })
})

describe('outcome-unknown codes', () => {
  it('a code-0 order response with no rows is unknown (3006), never success', async () => {
    const { fake, trading } = stack()
    fake.fail('POST', '/api/v5/trade/order', { code: '0', msg: '', data: [] }, 200)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gtempty1' })])
    expect(result.acks[0]).toMatchObject({ status: 'unknown', problem: { code: 3006 } })
  })

  it('50004 on a per-order row is 3006 and not retryable', async () => {
    const { fake, trading } = stack()
    fake.rejectClOrdIds.set('gtto1', { sCode: '50004', sMsg: 'Endpoint request timeout' })
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gtto1' })])
    expect(result.acks[0]).toMatchObject({ status: 'unknown', problem: { code: 3006, retryable: false } })
  })

  it('50004 on the envelope for a POST is 3006', async () => {
    const { fake, trading } = stack()
    fake.fail('POST', '/api/v5/trade/order', { code: '50004', msg: 'Endpoint request timeout', data: [] }, 200)
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gttimeout1' })])
    expect(result.acks[0]).toMatchObject({ status: 'unknown', problem: { code: 3006, retryable: false } })
  })

  it('51016 reconciles by clientOrderId instead of re-sending', async () => {
    const { fake, trading } = stack()
    fake.rejectClOrdIds.set('gtdup1', { sCode: '51016', sMsg: 'clOrdId already exists' })
    fake.orderQuery = { instId: 'BTC-USDT-SWAP', ordId: '999', clOrdId: 'gtdup1', state: 'live', accFillSz: '0' }
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gtdup1' })])
    expect(result.acks[0]).toMatchObject({ status: 'open', venueOrderId: '999' })
  })

  it('51016 with no query result is unknown (3006)', async () => {
    const { fake, trading } = stack()
    fake.rejectClOrdIds.set('gtdup2', { sCode: '51016', sMsg: 'clOrdId already exists' })
    fake.orderQuery = null
    const result = await trading.submit(ctx(), [intent({ clientOrderId: 'gtdup2' })])
    expect(result.acks[0]).toMatchObject({ status: 'unknown', problem: { code: 3006 } })
  })

  it('rejects ocoGroupId in submit without touching the network', async () => {
    const { fake, trading } = stack()
    const result = await trading.submit(ctx(), [intent({ ocoGroupId: 'oco1' })])
    expect(result.acks[0]!.problem?.code).toBe(1004)
    expect(fake.callsFor('POST', '/api/v5/trade/order')).toHaveLength(0)
  })
})

describe('order status lookup', () => {
  it('queries order-algo for an algo order submitted by this instance', async () => {
    const { fake, trading } = stack()
    await trading.submit(ctx(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '95000', clientOrderId: 'gtstop1' })])
    await trading.status(ctx().account, { clientOrderId: 'gtstop1' })
    const call = fake.callsFor('GET', '/api/v5/trade/order-algo')[0]!
    expect(call.params.get('algoClOrdId')).toBe('gtstop1')
  })

  it('queries the normal order endpoint with the recorded instId', async () => {
    const { fake, trading } = stack()
    await trading.submit(ctx(), [intent({ instrumentId: 'okx:ETH-USDT-SWAP', size: '0.35', price: '3000', clientOrderId: 'gteth1' })])
    await trading.status(ctx().account, { clientOrderId: 'gteth1' })
    expect(fake.callsFor('GET', '/api/v5/trade/order')[0]!.params.get('instId')).toBe('ETH-USDT-SWAP')
  })

  it('needs an explicit symbol for an unknown key', async () => {
    const { trading } = stack()
    await expect(trading.status(ctx().account, { clientOrderId: 'gtonce' })).rejects.toMatchObject({ problem: { code: -32602 } })
  })

  it('tries order then algo when given a symbol', async () => {
    const { fake, trading } = stack()
    fake.orderQuery = null
    fake.algoQuery = null
    const status = await trading.status(ctx().account, { clientOrderId: 'gtmissing' }, { symbol: 'BTC-USDT-SWAP' })
    expect(status.found).toBe(false)
    expect(fake.callsFor('GET', '/api/v5/trade/order')).toHaveLength(1)
    expect(fake.callsFor('GET', '/api/v5/trade/order-algo')).toHaveLength(1)
  })

  it('cancels an algo order through cancel-algos', async () => {
    const { fake, trading } = stack()
    await trading.submit(ctx(), [intent({ type: 'stop_market', price: undefined, triggerPrice: '95000', clientOrderId: 'gtstop1' })])
    const [ack] = await trading.cancel(ctx(), [{ instrumentId: 'okx:BTC-USDT-SWAP', clientOrderId: 'gtstop1' }])
    expect(ack!.ok).toBe(true)
    expect(fake.callsFor('POST', '/api/v5/trade/cancel-algos')).toHaveLength(1)
  })

  it('amend never invents a random client order id', async () => {
    const { trading } = stack()
    const onlyVenue = await trading.amend(ctx(), {
      instrumentId: 'okx:BTC-USDT-SWAP', venueOrderId: '3122698', order: intent({ size: '0.06', price: '100100' }),
    })
    expect(onlyVenue.acks[0]).toMatchObject({ clientOrderId: '', venueOrderId: '3122698' })
    const withClient = await trading.amend(ctx(), {
      instrumentId: 'okx:BTC-USDT-SWAP', clientOrderId: 'gtopen1', order: intent({ size: '0.06', price: '100100' }),
    })
    expect(withClient.acks[0]!.clientOrderId).toBe('gtopen1')
  })
})
