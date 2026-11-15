// SPDX-License-Identifier: CPAL-1.0
// 私有流归一（纯函数）：只认 futures.usertrades / futures.orders / futures.positions / futures.balances；
// 保留成交号（去重键）、执行类型、零仓平仓行、强平标记。
import { describe, expect, it } from 'vitest'
import { decimalOf, normalizeGateEvent } from '../src/parse'
import type { MultiplierOf } from '../src/parse'
import { NOW } from './helpers/fake-gate'

const of: MultiplierOf = (c) => (c === 'BTC_USDT' ? decimalOf('0.0001') : c === 'ETH_USDT' ? decimalOf('0.01') : undefined)
const opts = { now: NOW, contractSize: of }

const trade = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 90001, create_time: 1_791_483_420.5, contract: 'BTC_USDT', order_id: '7001', size: '60',
  price: '100100', role: 'taker', text: 't-open-1', fee: '0.006', ...over,
})

describe('私有流归一', () => {
  it('同号 usertrades 按 contract 隔离；缺 ID 的非零量仍为空串', () => {
    const { events } = normalizeGateEvent({
      channel: 'futures.usertrades',
      result: [trade({ id: 90001, contract: 'BTC_USDT' }), trade({ id: 90001, contract: 'ETH_USDT' }), trade({ id: '', size: '60' })],
    }, opts)
    expect(events.map((event) => event.venueFillId)).toEqual(['BTC_USDT:90001', 'ETH_USDT:90001', ''])
  })

  it('1. futures.usertrades → 归一事件，保留成交号作为去重键', () => {
    const { channel, events } = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade()] }, opts)
    expect(channel).toBe('futures.usertrades')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      channel: 'usertrades', venueFillId: 'BTC_USDT:90001', venueOrderId: '7001', clientOrderId: 't-open-1',
      instrumentId: 'gateio:BTC_USDT', side: 'buy', price: '100100', size: '0.006', fee: '0.006',
      feeCcy: 'USDT', liquidity: 'taker', ts: 1_791_483_420_500,
    })
  })

  it('2. futures.orders → 只带状态与订单号，成交号为空（不是成交事件）', () => {
    const { events } = normalizeGateEvent({
      channel: 'futures.orders',
      result: [{ id: 7001, contract: 'BTC_USDT', size: '100', left: '0', status: 'finished', finish_as: 'filled', text: 't-a', create_time: 1_791_483_430 }],
    }, opts)
    expect(events[0]).toMatchObject({ channel: 'orders', venueFillId: '', venueOrderId: '7001', mapped: 'filled', status: 'finished' })
  })

  it('3. 其它 channel（futures.tickers 等）→ 空事件表，channel 原样带回', () => {
    const out = normalizeGateEvent({ channel: 'futures.tickers', result: [{ contract: 'BTC_USDT' }] }, opts)
    expect(out.events).toEqual([])
    expect(out.positions).toEqual([])
    expect(out.balances).toEqual([])
    expect(out.channel).toBe('futures.tickers')
  })

  it('4. 零数量但有成交号的行保留（平仓尾笔）', () => {
    const { events } = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ size: '0' })] }, opts)
    expect(events).toHaveLength(1)
    expect(events[0]!.size).toBe('0')
    expect(events[0]!.venueFillId).toBe('BTC_USDT:90001')
  })

  it('5. 既无成交号又无数量 → 丢弃', () => {
    const { events } = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ id: '', size: '0' })] }, opts)
    expect(events).toEqual([])
  })

  it('6. 执行类型原样带出（maker / taker）', () => {
    const { events } = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ role: 'maker' })] }, opts)
    expect(events[0]!.liquidity).toBe('maker')
  })

  it('7. 卖方向为负张数 → side 为 sell，数量取绝对值', () => {
    const { events } = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ size: '-60' })] }, opts)
    expect(events[0]!.side).toBe('sell')
    expect(events[0]!.size).toBe('0.006')
  })

  it('8. 手续费与 Gate 同号（不取反）', () => {
    const { events } = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ fee: '0.001' })] }, opts)
    expect(events[0]!.fee).toBe('0.001')
    const negative = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ id: 90002, fee: '-0.003' })] }, opts)
    expect(negative.events[0]!.fee).toBe('-0.003')
  })

  it('9. 没有乘数 → 抛 DATA_UNAVAILABLE（绝不按 1 折）', () => {
    expect(() => normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ contract: 'NOPE_USDT' })] }, opts))
      .toThrow(/quanto_multiplier unknown/)
  })

  it('10. 时间缺失时回落注入的 now', () => {
    const { events } = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ create_time: undefined })] }, opts)
    expect(events[0]!.ts).toBe(NOW)
  })

  it('11. finish_as 参与状态映射（ioc → cancelled）', () => {
    const { events } = normalizeGateEvent({
      channel: 'futures.orders',
      result: [{ id: 1, contract: 'BTC_USDT', size: '1', status: 'finished', finish_as: 'ioc' }],
    }, opts)
    expect(events[0]!.mapped).toBe('cancelled')
  })

  it('12. 非对象 / 空 payload 不炸，返回空事件', () => {
    expect(normalizeGateEvent(null, opts).events).toEqual([])
    expect(normalizeGateEvent({}, opts).events).toEqual([])
    expect(normalizeGateEvent({ channel: 'futures.usertrades', result: 'nope' }, opts).events).toEqual([])
    expect(normalizeGateEvent({ channel: 'futures.usertrades', result: [null, 1] }, opts).events).toEqual([])
  })

  it('13. 未知状态 → mapped 为 null（不猜）', () => {
    const { events } = normalizeGateEvent({ channel: 'futures.orders', result: [{ id: 1, contract: 'BTC_USDT', status: 'weird' }] }, opts)
    expect(events[0]!.mapped).toBeNull()
    expect(events[0]!.status).toBe('weird')
  })

  it('14. 多条事件保序（同一帧内不改顺序）', () => {
    const { events } = normalizeGateEvent({
      channel: 'futures.usertrades',
      result: [trade({ id: 1 }), trade({ id: 2 }), trade({ id: 3 })],
    }, opts)
    expect(events.map((e) => e.venueFillId)).toEqual(['BTC_USDT:1', 'BTC_USDT:2', 'BTC_USDT:3'])
  })

  it('15. 强平 / 自动减仓成交带 liquidation 标记，普通成交没有', () => {
    const liq = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ text: 'liquidation' })] }, opts)
    expect(liq.events[0]!.liquidation).toBe(true)
    const adl = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ id: 2, text: 'auto_deleveraging' })] }, opts)
    expect(adl.events[0]!.liquidation).toBe(true)
    const normal = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade()] }, opts)
    expect(normal.events[0]!.liquidation).toBeUndefined()
  })

  it('16. futures.positions：零仓行 → flat / size 0；非零 → 按 mode 与符号折币数', () => {
    const { positions } = normalizeGateEvent({
      channel: 'futures.positions',
      result: [
        { contract: 'BTC_USDT', size: '0', mode: 'single', leverage: '10', entry_price: '0', time_ms: NOW },
        { contract: 'ETH_USDT', size: '-250', mode: 'single', leverage: '20', entry_price: '3100', time_ms: NOW },
      ],
    }, opts)
    expect(positions).toHaveLength(2)
    expect(positions[0]).toMatchObject({ side: 'flat', size: '0', marginMode: 'isolated', leverage: 10 })
    expect(positions[1]).toMatchObject({ side: 'short', size: '2.5', marginMode: 'isolated', leverage: 20, entryPrice: '3100' })
  })

  it('17. futures.balances：只给总额与变动，不冒充 available', () => {
    const { balances } = normalizeGateEvent({
      channel: 'futures.balances',
      result: [{ balance: '100.5', change: '-1', currency: 'usdt', type: 'fee' }],
    }, opts)
    expect(balances).toHaveLength(1)
    expect(balances[0]).toMatchObject({ asset: 'USDT', total: '100.5', change: '-1', reason: 'fee' })
    expect(Object.prototype.hasOwnProperty.call(balances[0], 'available')).toBe(false)
  })

  it('18. usertrades 有 create_time_ms 时 ts 用它', () => {
    const { events } = normalizeGateEvent({
      channel: 'futures.usertrades',
      result: [trade({ create_time: 1_791_483_420.5, create_time_ms: 1_791_483_421_250 })],
    }, opts)
    expect(events[0]!.ts).toBe(1_791_483_421_250)
  })

  it('19. usertrades 的 venueOrderId 取 order_id，orders 的取 id_string ?? id', () => {
    const fill = normalizeGateEvent({ channel: 'futures.usertrades', result: [trade({ order_id: '8001' })] }, opts)
    expect(fill.events[0]!.venueOrderId).toBe('8001')
    const order = normalizeGateEvent({ channel: 'futures.orders', result: [{ id: 1, id_string: '2111713079019438081', contract: 'BTC_USDT', size: '1' }] }, opts)
    expect(order.events[0]!.venueOrderId).toBe('2111713079019438081')
  })
})
