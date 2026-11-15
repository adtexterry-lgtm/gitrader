// SPDX-License-Identifier: CPAL-1.0
// 批 10 · L2 修复回归（反证用）：L2-11 —— 持仓行的杠杆字段缺失 / 非数字时，
// 修前：`Math.round(num(...))` 得 NaN → `Math.max(1, NaN)` 仍是 NaN → NaN 直接进 Position.leverage
//       （NaN 参与保证金 / 风险比较时全部为 false，闸门静默放行）。
// 修后：4005 DATA_UNAVAILABLE 显式报错，Position 永远不会带 NaN 杠杆。
import { describe, expect, it } from 'vitest'
import type { AccountId, OrderIntent } from '@gitrader/protocol'
import { decimalOf, marginOfPositionRow, parsePosition, parsePositions } from '../src/parse'
import type { ParseContext, RawPosition } from '../src/parse'
import { FakeGate } from './helpers/fake-gate'
import { INSTRUMENT, makeConnector, tradeContext } from './helpers/connector'

const ctx: ParseContext = { accountId: 'acc_gate_1' as AccountId, now: 1_791_483_500_000 }

const positionRow = (over: Partial<RawPosition> = {}): RawPosition => ({
  contract: 'BTC_USDT', size: '100', leverage: '10', mode: 'single', entry_price: '99000', mark_price: '100000',
  value: '1000', margin: '99', unrealised_pnl: '10', realised_pnl: '2', liq_price: '90000',
  create_time: 1_791_483_400, update_time: 1_791_483_430, ...over,
} as RawPosition)

/** 取抛出来错误的 problem（不是 Problem 形状就返回 undefined —— 那本身就是反证失败）。 */
function problemOf(fn: () => unknown): { code: number; name: string } | undefined {
  try {
    fn()
  } catch (e) {
    return (e as { problem?: { code: number; name: string } }).problem
  }
  return undefined
}

describe('L2-11 杠杆算不出有限数 → 4005 DATA_UNAVAILABLE（NaN 不许进 Position）', () => {
  it('leverage 非数字且无 cross_leverage_limit：显式 4005，不是 NaN', () => {
    const problem = problemOf(() => marginOfPositionRow({ leverage: 'abc' }))
    expect(problem?.name).toBe('DATA_UNAVAILABLE')
    expect(problem?.code).toBe(4005)
  })

  it('两个字段都缺失（真实「数据缺失」场景）：显式 4005', () => {
    const problem = problemOf(() => marginOfPositionRow({}))
    expect(problem?.code).toBe(4005)
  })

  it('全仓行缺 cross_leverage_limit：显式 4005（不按杠杆 0 / NaN 静默放行）', () => {
    const problem = problemOf(() => marginOfPositionRow({ leverage: '0' }))
    expect(problem?.code).toBe(4005)
  })

  it('parsePosition 遇到坏杠杆行抛 4005，而不是产出 NaN 杠杆的 Position', () => {
    const problem = problemOf(() => parsePosition(positionRow({ leverage: 'not-a-number' }), ctx, decimalOf('0.0001')))
    expect(problem?.code).toBe(4005)
  })

  it('parsePositions 遇到坏行整体报错（不静默丢行、不产出 NaN）', () => {
    const problem = problemOf(() => parsePositions(
      [positionRow({ contract: 'BTC_USDT' }), positionRow({ contract: 'ETH_USDT', leverage: 'oops' })],
      ctx,
      () => decimalOf('0.0001'),
    ))
    expect(problem?.code).toBe(4005)
  })

  it('对照：正常行仍然解析出有限杠杆，且全部 Position.leverage 都是有限数', () => {
    const positions = parsePositions(
      [positionRow({ contract: 'BTC_USDT', leverage: '10' }), positionRow({ contract: 'ETH_USDT', leverage: '0', cross_leverage_limit: '20' })],
      ctx,
      () => decimalOf('0.0001'),
    )
    expect(positions).toHaveLength(2)
    expect(positions.map((p) => p.leverage)).toEqual([10, 20])
    expect(positions.every((p) => Number.isFinite(p.leverage))).toBe(true)
  })

  it('对照：marginOfPositionRow 的既有口径不变（leverage>0 逐仓、=0 全仓看上限）', () => {
    expect(marginOfPositionRow({ leverage: '10' })).toEqual({ mode: 'isolated', leverage: 10 })
    expect(marginOfPositionRow({ leverage: '0', cross_leverage_limit: '20' })).toEqual({ mode: 'cross', leverage: 20 })
  })
})

describe('L2-11b 持仓行缺 leverage 时不许推断成全仓（阻断隐式切保证金模式）', () => {
  const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
    accountId: 'acct_gateio_test',
    instrumentId: INSTRUMENT as OrderIntent['instrumentId'],
    side: 'buy',
    type: 'limit',
    size: '0.01' as OrderIntent['size'],
    price: '100.1' as OrderIntent['price'],
    ...over,
  })

  it('只有 cross_leverage_limit、没有 leverage：4005，不回 cross', () => {
    const problem = problemOf(() => marginOfPositionRow({ cross_leverage_limit: '10' }))
    expect(problem?.code).toBe(4005)
    expect(problem?.name).toBe('DATA_UNAVAILABLE')
  })

  it('leverage 是空串 + cross_leverage_limit：同样 4005', () => {
    expect(problemOf(() => marginOfPositionRow({ leverage: '', cross_leverage_limit: '10' }))?.code).toBe(4005)
  })

  it('对照：leverage=0 → cross/上限；leverage=5 → isolated/5（既有口径不变）', () => {
    expect(marginOfPositionRow({ leverage: '0', cross_leverage_limit: '10' })).toEqual({ mode: 'cross', leverage: 10 })
    expect(marginOfPositionRow({ leverage: '5' })).toEqual({ mode: 'isolated', leverage: 5 })
  })

  it('端到端：持仓行缺 leverage → 不发改杠杆、不下单、单张 rejected + 4005', async () => {
    const fake = new FakeGate()
    const ctx = makeConnector(fake)
    await ctx.connector.start()
    const rows = fake.positions as Array<Record<string, unknown>>
    const btc = rows.find((row) => row['contract'] === 'BTC_USDT')
    if (btc === undefined) throw new Error('fake BTC_USDT position row is missing')
    delete btc['leverage']
    btc['cross_leverage_limit'] = '10'

    const result = await ctx.connector.submit(tradeContext(), [intent({ leverage: 20 })])

    expect(fake.callsTo('/api/v4/futures/usdt/positions/BTC_USDT/leverage')).toHaveLength(0)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
    expect(result.acks[0]!.status).toBe('rejected')
    expect(result.acks[0]!.problem?.code).toBe(4005)
  })
})
