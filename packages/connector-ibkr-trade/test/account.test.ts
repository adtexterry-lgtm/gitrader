// SPDX-License-Identifier: CPAL-1.0
// 账户读取：摘要 / 限制标志、持仓、挂单、成交与佣金、启动对账、多账户隔离。
import { afterEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { formatIbTime, ibTimeToMs, isTerminalState, openOrderType } from '../src/account'
import * as M from '../src/messages'
import { makeHarness, tick } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => {
  if (h !== undefined) await h.close()
  h = undefined
})

describe('account · 账户摘要与限制', () => {
  it('摘要标签原样进 restrictions（日内次数、购买力、账户类型）', async () => {
    h = await makeHarness()
    const tags = await h.connector.accounts.summary()
    expect(tags.NetLiquidation).toBe('100000.00')
    const r = h.connector.accountRestrictions()
    expect(r.dayTradesRemaining).toBe('3')
    expect(r.buyingPower).toBe('100000.00')
    expect(r.accountType).toBe('INDIVIDUAL')
    expect(r.tradingBlocked).toBe(false)
    expect(r.accountBlocked).toBe(false)
    expect(r.raw.DayTradesRemaining).toBe('3')
  })

  it('AccountReady=false 不再推断冻结（IB 摘要没有冻结标志）', async () => {
    h = await makeHarness({ tws: { summary: { AccountReady: 'false', NetLiquidation: '1000' } } })
    await h.connector.accounts.summary()
    const r = h.connector.accountRestrictions() as unknown as Record<string, unknown>
    expect(r.accountReady).toBeUndefined()
    expect(r.tradingBlocked).toBe(false)
    expect(r.accountBlocked).toBe(false)
    expect(r.raw).toMatchObject({ AccountReady: 'false' })
  })

  it('账户快照：权益 / 可用 / 保证金 / 比率 / 币种', async () => {
    h = await makeHarness()
    const snap = await h.connector.accountState(h.ref)
    expect(snap.accountModel).toBe('standard')
    expect(snap.balances[0]!.asset).toBe('USD')
    expect(snap.balances[0]!.total).toBe('100000')
    expect(snap.balances[0]!.available).toBe('50000')
    expect(snap.balances[0]!.hold).toBe('50000')
    expect(snap.margin.equity).toBe('100000')
    expect(snap.margin.model).toBe('standard')
    expect(snap.source).toBe('rest')
  })

  it('摘要值是 IB 原样两位小数：accountState 不抛，数值规范化', async () => {
    h = await makeHarness({
      tws: { summary: { NetLiquidation: '123456.78', AvailableFunds: '23456.78', InitMarginReq: '1000.00', MaintMarginReq: '500.00', Leverage: '2.00' } },
    })
    const snap = await h.connector.accountState(h.ref)
    expect(snap.balances[0]!.total).toBe('123456.78')
    expect(snap.balances[0]!.available).toBe('23456.78')
    expect(snap.balances[0]!.hold).toBe('100000')
    expect(snap.margin.initialMargin).toBe('1000')
    expect(snap.margin.maintenanceMargin).toBe('500')
    expect(snap.margin.leverage).toBe(2)
  })

  it('摘要缺失或不是数字 → 0（不抛）', async () => {
    h = await makeHarness({ tws: { summary: { NetLiquidation: 'n/a', AvailableFunds: '50000.00' } } })
    const snap = await h.connector.accountState(h.ref)
    expect(snap.balances[0]!.total).toBe('0')
    expect(snap.balances[0]!.available).toBe('50000')
    expect(snap.margin.equity).toBe('0')
    expect(snap.margin.leverage).toBe(1)
  })

  it('持仓来自 POSITION 专用消息（不是账户摘要）', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'AAPL', position: 25, avgCost: 90 }] } })
    const rows = await h.connector.positions()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.instrumentId).toBe('ibkr:AAPL')
    expect(rows[0]!.side).toBe('long')
    expect(rows[0]!.size).toBe('25')
    expect(rows[0]!.entryPrice).toBe('90')
  })

  it('空头持仓记 side=short，数量取绝对值', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'MSFT', position: -10, avgCost: 300 }] } })
    const rows = await h.connector.positions()
    expect(rows[0]!.side).toBe('short')
    expect(rows[0]!.size).toBe('10')
  })

  it('碎股持仓按十进制原样报（100.5）', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'AAPL', position: 100.5, avgCost: 90 }] } })
    const rows = await h.connector.positions()
    expect(rows[0]!.side).toBe('long')
    expect(rows[0]!.size).toBe('100.5')
  })

  it('零持仓行被过滤掉', async () => {
    h = await makeHarness({ tws: { positions: [{ symbol: 'AAPL', position: 0, avgCost: 0 }] } })
    expect(await h.connector.positions()).toHaveLength(0)
  })

  it('多账户：摘要与持仓只取本账户，不串号', async () => {
    h = await makeHarness({
      connector: { account: 'DU1' },
      tws: {
        accounts: ['DU1', 'DU2'],
        positions: [
          { symbol: 'AAPL', position: 100, avgCost: 90, account: 'DU1' },
          { symbol: 'MSFT', position: 50, avgCost: 300, account: 'DU2' },
        ],
      },
    })
    const tags = await h.connector.accounts.summary()
    expect(tags.NetLiquidation).toBe('100000.00')
    const rows = await h.connector.positions()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.instrumentId).toBe('ibkr:AAPL')
  })
})

describe('account · 挂单与状态', () => {
  it('挂单映射：类型 / 数量 / reduceOnly=false / trigger', async () => {
    h = await makeHarness()
    await h.connector.submit(h.ctx, [
      { accountId: 'acct_ibkr_paper' as never, instrumentId: 'ibkr:AAPL', side: 'buy', type: 'limit', size: asDecimal('10'), price: asDecimal('100.5'), clientOrderId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never },
    ])
    const rows = await h.connector.openOrders(h.ref)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('limit')
    expect(rows[0]!.side).toBe('buy')
    expect(rows[0]!.origSize).toBe('10')
    expect(rows[0]!.price).toBe('100.5')
    expect(rows[0]!.reduceOnly).toBe(false)
    expect(rows[0]!.isTrigger).toBe(false)
    expect(rows[0]!.clientOrderId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('并发 openOrderRows 串行化：两次都拿到完整列表', async () => {
    h = await makeHarness({ tws: { openOrdersDelayMs: 80 } })
    await h.connector.submit(h.ctx, [
      { accountId: 'acct_ibkr_paper' as never, instrumentId: 'ibkr:AAPL', side: 'buy', type: 'limit', size: asDecimal('10'), price: asDecimal('100.5'), clientOrderId: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as never },
    ])
    await h.connector.submit(h.ctx, [
      { accountId: 'acct_ibkr_paper' as never, instrumentId: 'ibkr:AAPL', side: 'buy', type: 'limit', size: asDecimal('5'), price: asDecimal('99.5'), clientOrderId: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' as never },
    ])
    const [first, second] = await Promise.all([h.connector.accounts.openOrderRows(), h.connector.accounts.openOrderRows()])
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
  })

  it('bracket 子腿挂单的 clientOrderId 是 null（orderRef 带 #tp / #sl）', async () => {
    h = await makeHarness()
    await h.connector.submit(h.ctx, [
      {
        accountId: 'acct_ibkr_paper' as never,
        instrumentId: 'ibkr:AAPL',
        side: 'buy',
        type: 'limit',
        size: asDecimal('10'),
        price: asDecimal('100.5'),
        clientOrderId: 'f1b2c3d4e5f60718293a4b5c6d7e8f90' as never,
        tpsl: { takeProfit: { triggerPrice: asDecimal('120'), price: asDecimal('120') }, stopLoss: { triggerPrice: asDecimal('90') }, grouping: 'order' },
      },
    ])
    const rows = await h.connector.openOrders(h.ref)
    expect(rows).toHaveLength(3)
    expect(rows.filter((o) => o.clientOrderId === null)).toHaveLength(2)
    expect(rows.find((o) => o.clientOrderId === 'f1b2c3d4e5f60718293a4b5c6d7e8f90')).toBeDefined()
  })

  it('openOrderType 把 IB 单型映射成协议枚举（TRAIL → unknown，不假装）', () => {
    expect(openOrderType('LMT')).toBe('limit')
    expect(openOrderType('STP')).toBe('stop_market')
    expect(openOrderType('STP LMT')).toBe('stop_limit')
    expect(openOrderType('TRAIL')).toBe('unknown')
  })

  it('isTerminalState：Filled / Cancelled / ApiCancelled / Inactive', () => {
    for (const s of ['Filled', 'Cancelled', 'ApiCancelled', 'Inactive']) expect(isTerminalState(s), s).toBe(true)
    for (const s of ['Submitted', 'PreSubmitted', 'PendingSubmit']) expect(isTerminalState(s), s).toBe(false)
  })

  it('按 clientOrderId 查单：本进程提交过的单能找到（状态原话 + 已成交量）', async () => {
    h = await makeHarness()
    await h.connector.submit(h.ctx, [
      { accountId: 'acct_ibkr_paper' as never, instrumentId: 'ibkr:AAPL', side: 'buy', type: 'limit', size: asDecimal('10'), price: asDecimal('100.5'), clientOrderId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as never },
    ])
    const st = await h.connector.orderStatus(h.ref, { clientOrderId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
    expect(st.found).toBe(true)
    expect(st.status).toBe('Submitted')
    expect(st.filledSize).toBe('0')
  })

  it('查一张没见过的单 → found:false（不编状态）', async () => {
    h = await makeHarness()
    const st = await h.connector.orderStatus(h.ref, { clientOrderId: 'cccccccccccccccccccccccccccccccc' })
    expect(st.found).toBe(false)
    expect(st.status).toBeUndefined()
  })
})

describe('account · 成交与佣金', () => {
  it('成交带 execId 去重键、佣金与买卖方向', async () => {
    h = await makeHarness({
      tws: { executions: [{ symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 10, price: 100.5, commission: 1.25 }] },
    })
    const fills = await h.connector.fills(h.ref, 0)
    expect(fills).toHaveLength(1)
    expect(fills[0]!.venueFillId).toBe('0000e001')
    expect(fills[0]!.side).toBe('buy')
    expect(fills[0]!.size).toBe('10')
    expect(fills[0]!.fee).toBe('1.25')
    expect(fills[0]!.feeCcy).toBe('USD')
    expect(fills[0]!.instrumentId).toBe('ibkr:AAPL')
  })

  it('开仓成交 realizedPnl = Double.MAX → 记 0，不抛', async () => {
    h = await makeHarness({
      tws: { executions: [{ symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 1, price: 100 }] },
    })
    const fills = await h.connector.fills(h.ref, 0)
    expect(fills[0]!.realizedPnl).toBe('0')
  })

  it('卖出成交（SLD）→ sell', async () => {
    h = await makeHarness({
      tws: { executions: [{ symbol: 'AAPL', orderId: 101, permId: 5001, side: 'SLD', shares: 5, price: 99, commission: 1 }] },
    })
    const fills = await h.connector.fills(h.ref, 0)
    expect(fills[0]!.side).toBe('sell')
  })

  it('sinceMs 之前的成交被过滤掉（请求 time 字段仍发空串）', async () => {
    h = await makeHarness({
      tws: { executions: [{ symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 1, price: 100, time: '20261021 10:00:00 US/Eastern' }] },
    })
    const after = ibTimeToMs('20261021 10:00:00 US/Eastern') + 1000
    expect(await h.connector.fills(h.ref, after)).toHaveLength(0)
    expect(await h.connector.fills(h.ref, 0)).toHaveLength(1)
    const frame = h.tws.frames(M.OUT.REQ_EXECUTIONS)[0]!
    expect(frame.fields[5]).toBe('')
  })

  it('两空格 / 无时区的成交：给了 twsTimeZone 才换算', async () => {
    h = await makeHarness({
      connector: { twsTimeZone: 'America/New_York' },
      tws: { executions: [{ symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 1, price: 100, time: '20261021  10:00:00' }] },
    })
    const fills = await h.connector.fills(h.ref, 0)
    expect(fills).toHaveLength(1)
    expect(fills[0]!.ts).toBe(Date.UTC(2026, 9, 21, 14, 0, 0))
  })

  it('无时区且没选项：成交不丢，ts 用 clock 并 warn 一次', async () => {
    const warns: string[] = []
    h = await makeHarness({
      connector: { onWarn: (m) => warns.push(m) },
      tws: { executions: [{ symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 1, price: 100, time: '20261021 10:00:00' }] },
    })
    const fills = await h.connector.fills(h.ref, 9_999_999_999_999)
    expect(fills).toHaveLength(1)
    expect(fills[0]!.ts).toBe(h.clock.now)
    expect(warns.filter((w) => w.includes('no timezone'))).toHaveLength(1)
  })

  it('IB 时间串三种格式 → ms', () => {
    expect(ibTimeToMs('1697882400')).toBe(1697882400000)
    expect(ibTimeToMs('20261021 10:00:00 US/Eastern')).toBe(Date.UTC(2026, 9, 21, 14, 0, 0))
    expect(ibTimeToMs('20261021  10:00:00', 'America/New_York')).toBe(Date.UTC(2026, 9, 21, 14, 0, 0))
    expect(ibTimeToMs('20261021 10:00:00')).toBeNaN()
    expect(ibTimeToMs('20261021 10:00:00 Not/AZone')).toBeNaN()
    expect(ibTimeToMs('bad')).toBeNaN()
    expect(formatIbTime(Date.UTC(2026, 9, 21, 10, 0, 0))).toBe('20261021 10:00:00')
  })

  it('重启后 ledger 为空：成交按 orderRef 对账，filledSize 取最大 cumQty', async () => {
    const clientOrderId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    h = await makeHarness({
      tws: {
        executions: [
          { symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 3, cumQty: 3, price: 100, orderRef: clientOrderId },
          { symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 5, cumQty: 5, price: 100, orderRef: clientOrderId },
        ],
      },
    })
    const r = await h.connector.reconcile(clientOrderId, h.ref)
    expect(r.found).toBe(true)
    expect(r.status).toBe('Filled')
    expect(r.filledSize).toBe('5')
    expect(r.venueOrderId).toBe('5001')
  })

  it('启动对账快照：账户 + 挂单 + 成交', async () => {
    h = await makeHarness({
      tws: { executions: [{ symbol: 'AAPL', orderId: 101, permId: 5001, side: 'BOT', shares: 2, price: 100 }], positions: [{ symbol: 'AAPL', position: 2, avgCost: 100 }] },
    })
    const snap = await h.connector.startupSnapshot(h.ref, 0)
    expect(snap.account.balances[0]!.total).toBe('100000')
    expect(snap.fills).toHaveLength(1)
    expect(snap.truncated).toBe(false)
    expect(snap.fillsSince).toBe(0)
  })
})

describe('account · 请求帧形状与撤订阅', () => {
  it('摘要请求带 tags 表；收齐后发 cancelAccountSummary', async () => {
    h = await makeHarness()
    await h.connector.accounts.summary()
    await tick(30)
    const frame = h.tws.frames(M.OUT.REQ_ACCOUNT_SUMMARY)[0]!
    expect(frame.fields[4]).toContain('DayTradesRemaining')
    expect(frame.fields[4]).toContain('BuyingPower')
    expect(h.tws.frames(M.OUT.CANCEL_ACCOUNT_SUMMARY)).toHaveLength(1)
    expect(h.tws.frames(M.OUT.CANCEL_ACCOUNT_SUMMARY)[0]!.fields[2]).toBe(frame.fields[2])
  })

  it('持仓请求没有账户参数；收齐后发 cancelPositions', async () => {
    h = await makeHarness()
    await h.connector.positions()
    await tick(30)
    const frame = h.tws.frames(M.OUT.REQ_POSITIONS)[0]!
    expect(frame.fields).toEqual(['61', '1'])
    expect(h.tws.frames(M.OUT.CANCEL_POSITIONS)).toHaveLength(1)
    expect(h.tws.frames(M.OUT.CANCEL_POSITIONS)[0]!.fields).toEqual(['64', '1'])
  })
})
