// SPDX-License-Identifier: CPAL-1.0
// 持仓卡（r4）的纯函数：ROE、距强平、分组与小计、新仓 / 近强平标记、现有止损、止损价本地先挡、止损单意图、部分平仓数量、有待批。数字对照夹具（pending 场景）。
import { describe, expect, it } from 'vitest'
import { ACCT_LIVE, ACCT_PAPER, NOW, scenario } from '../fixtures/scenarios'
import { buildRows, checkStopPrice, currentStop, groupRows, isNew, liqDistancePct, nearLiq, normalizeAccounts, normalizeOrders, partialSize, pendingOf, roePct, stopIntent, type OrderLite, type PositionRow } from '../src/model-positions'

const sc = scenario('pending')
const orders = Object.fromEntries(Object.entries(sc.orders).map(([k, v]) => [k, normalizeOrders(v)]))
const rows = buildRows(normalizeAccounts(sc.accounts), sc.positions, orders)
const row = (sym: string): PositionRow => rows.find((r) => r.symbol === sym)!
const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

describe('持仓卡纯函数', () => {
  it('ROE：BTC 53.58 ÷ (0.08 × 64,880.2 ÷ 4) = +4.13%；缺杠杆返回 null', () => {
    expect(r2(roePct(row('BTC')))).toBe(4.13)
    expect(roePct({ ...row('BTC'), leverage: null })).toBeNull()
  })

  it('距强平：BTC 19.7%；SOL 纸面 17.4%；强平价缺失返回 null', () => {
    expect(r1(liqDistancePct(row('BTC')))).toBe(19.7)
    expect(r1(liqDistancePct(row('SOL')))).toBe(17.4)
    expect(liqDistancePct({ ...row('BTC'), liquidationPrice: null })).toBeNull()
  })

  it('分组：实盘组在上、纸面组在下；小计 +70.86 / −42.00，不跨组相加', () => {
    const g = groupRows([...rows].reverse())
    expect(g.map((x) => [x.accountId, x.mode, x.rows.length])).toEqual([[ACCT_LIVE, 'live', 3], [ACCT_PAPER, 'paper', 1]])
    expect(r2(g[0]!.subtotal)).toBe(70.86)
    expect(r2(g[1]!.subtotal)).toBe(-42)
  })

  it('组内按开仓时间稳定排序（同时刻按 key，与价格无关）；新仓追加组末', () => {
    const base = groupRows(rows)[0]!.rows.map((r) => r.symbol)
    expect(base).toEqual(['BTC', 'ETH', 'xyz:TSLA'])
    // 价格变化（名义变了）不换位
    const moved = rows.map((r) => (r.symbol === 'TSLA' || r.symbol === 'xyz:TSLA' ? { ...r, notional: 999999 } : r))
    expect(groupRows(moved)[0]!.rows.map((r) => r.symbol)).toEqual(base)
    const fresh: PositionRow = { ...row('BTC'), key: `${ACCT_LIVE}|hyperliquid:AAA|long`, symbol: 'AAA', instrumentId: 'hyperliquid:AAA', openedAt: NOW }
    expect(groupRows([fresh, ...rows])[0]!.rows.map((r) => r.symbol)).toEqual([...base, 'AAA'])
  })

  it('isNew：10 分钟内为真，满 10 分钟为假', () => {
    expect(isNew({ openedAt: NOW - 9 * 60_000 }, NOW)).toBe(true)
    expect(isNew({ openedAt: NOW - 10 * 60_000 }, NOW)).toBe(false)
    expect(isNew({ openedAt: null }, NOW)).toBe(false)
  })

  it('nearLiq：≤ 5% 为真', () => {
    expect(nearLiq({ markPrice: 100, liquidationPrice: 95 })).toBe(true)
    expect(nearLiq({ markPrice: 100, liquidationPrice: 94.9 })).toBe(false)
    expect(nearLiq(row('BTC'))).toBe(false)
  })

  it('currentStop：只认同账户同标的、未完成、reduceOnly 的 stop_market；多张取最近', () => {
    const o = (over: Partial<OrderLite>): OrderLite => ({ accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'sell', reduceOnly: true, createdAt: 1, origin: null, orderId: 'o', type: 'stop_market', status: 'untriggered', triggerPrice: 60000, ...over })
    const list = [
      o({ orderId: 'old', createdAt: 1, triggerPrice: 60000 }),
      o({ orderId: 'new', createdAt: 2, triggerPrice: 61000 }),
      o({ orderId: 'done', createdAt: 9, status: 'cancelled' }),
      o({ orderId: 'notro', createdAt: 9, reduceOnly: false }),
      o({ orderId: 'lim', createdAt: 9, type: 'limit' }),
      o({ orderId: 'other', createdAt: 9, instrumentId: 'hyperliquid:ETH' }),
      o({ orderId: 'acct', createdAt: 9, accountId: ACCT_PAPER }),
    ]
    expect(currentStop(row('BTC'), list)?.orderId).toBe('new')
    expect(currentStop(row('BTC'), list.slice(2))).toBeNull()
    expect(row('BTC').stop).toBeNull() // 夹具里没有止损单
  })

  it('checkStopPrice：多头须低于标记价、空头须高于；非数字 / ≤ 0 拒', () => {
    expect(checkStopPrice(row('BTC'), '60,000')).toEqual({ ok: true, price: '60000' })
    expect(checkStopPrice(row('BTC'), '65000')).toEqual({ ok: false, message: '多头止损价要低于标记价' })
    expect(checkStopPrice(row('ETH'), '3100')).toEqual({ ok: false, message: '空头止损价要高于标记价' })
    expect(checkStopPrice(row('ETH'), '3300').ok).toBe(true)
    for (const bad of ['abc', '0', '-5', '', '1e3']) expect(checkStopPrice(row('BTC'), bad).ok).toBe(false)
  })

  it('stopIntent：方向相反、stop_market、reduceOnly、size = 持仓数量、带 triggerPrice', () => {
    expect(stopIntent(row('BTC'), '60000')).toEqual({ accountId: ACCT_LIVE, instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'stop_market', size: '0.08', triggerPrice: '60000', reduceOnly: true, reason: '人在持仓卡设止损' })
    expect(stopIntent(row('ETH'), '3300')).toMatchObject({ side: 'buy', size: '1.2' })
  })

  it('partialSize：25% / 50% / 全部按步进（持仓小数位与 4 位取细）向下截断且不超过持仓；截到 0 返回 null', () => {
    expect(partialSize(row('BTC'), 25)).toBe('0.02')
    expect(partialSize(row('BTC'), 50)).toBe('0.04')
    expect(partialSize(row('BTC'), 100)).toBe('0.08')
    expect(partialSize(row('SOL'), 25)).toBe('7.5') // 返工 S-2：原来是 7
    expect(partialSize(row('ETH'), 25)).toBe('0.3')
    const one = { size: 1, position: { size: '1' } as never }
    expect(partialSize(one, 25)).toBe('0.25') // 返工 S-2：原来是 null
    expect(partialSize(one, 50)).toBe('0.5')
    expect(partialSize({ size: 0.01, position: { size: '0.01' } as never }, 25)).toBe('0.0025')
    expect(partialSize({ size: 0.123456, position: { size: '0.123456' } as never }, 50)).toBe('0.061728')
    expect(partialSize({ size: 0.0001, position: { size: '0.0001' } as never }, 25)).toBeNull()
    expect(Number(partialSize(row('SOL'), 100))).toBeLessThanOrEqual(30)
  })

  it('有待批：同账户、腿里有该标的的待批提案，取最急一张', () => {
    const props = sc.proposals as unknown as Record<string, unknown>[]
    expect(pendingOf(row('ETH'), props)).toBe((props.find((p) => p.ticket === 'T-20261010-0008') as { proposalId: string }).proposalId)
    expect(pendingOf(row('BTC'), props)).toBe((props.find((p) => p.ticket === 'T-20261010-0007') as { proposalId: string }).proposalId)
    expect(pendingOf(row('SOL'), props)).toBeNull()
    expect(pendingOf(row('xyz:TSLA'), props)).toBeNull()
  })
})
