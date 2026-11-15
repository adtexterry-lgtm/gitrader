// SPDX-License-Identifier: CPAL-1.0
// 账户读取（假服务器）：持仓专用端点、余额口径、挂单、成交去重、单张状态（venueOrderId 与 text 扫描）、
// 启动对账、资金费、持仓模式缓存。全部离线。
import { beforeEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { encodeClientOrderId } from '../src/orders'
import { FakeGate, contractRow, NOW } from './helpers/fake-gate'
import { accountRef, ETH_INSTRUMENT, INSTRUMENT, makeConnector, problemOf } from './helpers/connector'

const ID_A = '0123456789abcdef0123456789abcdef'
const ID_B = 'fedcba9876543210fedcba9876543210'

const fake = new FakeGate()
let ctx = makeConnector(fake)

beforeEach(() => {
  fake.reset()
  ctx = makeConnector(fake)
})

describe('持仓（教训 5：专用端点）', () => {
  it('1. 持仓来自 /futures/usdt/positions，张数折成币数', async () => {
    await ctx.connector.start()
    const positions = await ctx.connector.positions(accountRef)
    expect(fake.callsTo('/api/v4/futures/usdt/positions')).toHaveLength(1)
    expect(positions).toHaveLength(2)
    expect(positions[0]).toMatchObject({ instrumentId: INSTRUMENT, side: 'long', size: '0.01', leverage: 10 })
    expect(positions[1]).toMatchObject({ instrumentId: ETH_INSTRUMENT, side: 'short', size: '2.5' })
  })

  it('2. 零仓位行被丢弃（不产出空持仓）', async () => {
    await ctx.connector.start()
    const positions = await ctx.connector.positions(accountRef)
    expect(positions.some((p) => p.instrumentId === 'gateio:SOL_USDT')).toBe(false)
  })

  it('3. 持仓端点带 X-Gate-Size-Decimal: 1', async () => {
    await ctx.connector.start()
    await ctx.connector.positions(accountRef)
    const call = fake.callsTo('/api/v4/futures/usdt/positions')[0]!
    expect(call.headers['x-gate-size-decimal']).toBe('1')
  })

  it('4. 只查一个合约：请求不带 contract（集合端点不发它），结果在本地过滤', async () => {
    await ctx.connector.start()
    const positions = await ctx.connector.positions(accountRef, 'BTC_USDT')
    const call = fake.callsTo('/api/v4/futures/usdt/positions')[0]!
    expect(call.params.get('contract')).toBeNull()
    expect(call.params.get('holding')).toBe('true')
    expect(positions.map((p) => p.instrumentId)).toEqual([INSTRUMENT])
  })
})

describe('账户快照', () => {
  it('5. 余额取 available，冻结 = position_margin + order_margin；权益 = total + 未实现盈亏', async () => {
    const snapshot = await ctx.connector.accountState(accountRef)
    expect(snapshot.balances[0]).toMatchObject({ asset: 'USDT', total: '1020.5', available: '900.25', hold: '104.5' })
    expect(snapshot.margin.equity).toBe('1041')
    expect(snapshot.source).toBe('rest')
    expect(snapshot.stale).toBe(false)
  })

  it('6. 快照里同时有持仓（两次请求：accounts + positions）', async () => {
    const snapshot = await ctx.connector.accountState(accountRef)
    expect(snapshot.positions).toHaveLength(2)
    expect(fake.callsTo('/api/v4/futures/usdt/accounts')).toHaveLength(1)
    expect(fake.callsTo('/api/v4/futures/usdt/positions')).toHaveLength(1)
  })

  it('7. available 已是「扣掉挂单占用」口径，如实标注', async () => {
    expect((await ctx.connector.accountState(accountRef)).availableDeductsOpenOrders).toBe(true)
  })

  it('8. 账户请求失败 → ProblemError（不是空快照）', async () => {
    fake.fail('GET', '/api/v4/futures/usdt/accounts', { label: 'INVALID_SIGNATURE', message: 'bad sign' }, 401)
    const problem = await problemOf(() => ctx.connector.accountState(accountRef))
    expect(problem.code).toBe(3005)
    expect(problem.venue?.message).toContain('bad sign')
  })
})

describe('挂单 / 成交', () => {
  it('9. 挂单端点带 status=open，剩余量按 left 折币数', async () => {
    await ctx.connector.start()
    const open = await ctx.connector.openOrders(accountRef)
    expect(fake.last()!.params.get('status')).toBe('open')
    expect(open[0]).toMatchObject({ venueOrderId: '7001', clientOrderId: 't-open-1', size: '0.004', origSize: '0.01' })
  })

  it('10. 成交端点不带 from，早于 sinceMs 的成交本地滤掉', async () => {
    const fills = await ctx.connector.fills(accountRef, 1_791_483_425_000)
    const call = fake.callsTo('/api/v4/futures/usdt/my_trades')[0]!
    expect(call.params.get('from')).toBeNull()
    expect(call.params.get('limit')).toBe('100')
    expect(call.params.get('offset')).toBe('0')
    expect(fills.map((f) => f.venueFillId)).toEqual(['BTC_USDT:90002'])
  })

  it('fills 显式标的在全量响应后精确过滤', async () => {
    fake.myTrades = [
      { id: 'btc-1', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_430, fee: '0.006' },
      { id: 'eth-1', contract: 'ETH_USDT', size: '1', create_time: 1_791_483_430, fee: '0.006' },
    ]
    await ctx.connector.start()
    const fills = await ctx.connector.fills(accountRef, 1_791_483_400_000, { instrumentId: INSTRUMENT })
    expect(fills.map((fill) => fill.venueFillId)).toEqual(['BTC_USDT:btc-1'])
    expect(fake.callsTo('/api/v4/futures/usdt/my_trades')[0]!.params.get('contract')).toBeNull()
  })

  it('11. 零数量但有成交号的行保留（平仓尾笔），交给内核去重', async () => {
    const fills = await ctx.connector.fills(accountRef, 0)
    const zero = fills.find((f) => f.venueFillId === 'BTC_USDT:90002')
    expect(zero).toBeDefined()
    expect(zero!.size).toBe('0')
  })

  it('12. 手续费与 Gate 同号（正 = 付出）并标 USDT', async () => {
    const fills = await ctx.connector.fills(accountRef, 0)
    expect(fills[0]).toMatchObject({ fee: '0.006', feeCcy: 'USDT', liquidity: 'taker' })
  })

  it('13. my_trades 失败 → ProblemError', async () => {
    fake.fail('GET', '/api/v4/futures/usdt/my_trades', { label: 'INVALID_SIGNATURE', message: 'bad' }, 401)
    expect((await problemOf(() => ctx.connector.fills(accountRef, 0))).code).toBe(3005)
  })
})

describe('单张订单状态', () => {
  it('14. 按 venueOrderId 查详情：状态落成内核认得的词、成交额按 left 折算', async () => {
    await ctx.connector.start()
    const found = await ctx.connector.orderStatus(accountRef, { venueOrderId: '7001' })
    expect(found.found).toBe(true)
    expect(found.status).toBe('partially_filled')
    expect((found.raw as { status?: string }).status).toBe('open')
    expect(found.filledSize).toBe('0.006')
    expect(fake.callsFor('GET', '/api/v4/futures/usdt/orders/7001')).toHaveLength(1)
  })

  it('15. 查不到的单 → found=false（不抛错）', async () => {
    await ctx.connector.start()
    const found = await ctx.connector.orderStatus(accountRef, { venueOrderId: '999999' })
    expect(found.found).toBe(false)
  })

  it('16. 只给 clientOrderId 时按 text 有界扫描挂单', async () => {
    await ctx.connector.start()
    ;(fake.openOrders[0] as Record<string, unknown>)['text'] = encodeClientOrderId(ID_A)
    const found = await ctx.connector.orderStatus(accountRef, { clientOrderId: ID_A, instrumentId: INSTRUMENT })
    expect(found.found).toBe(true)
    expect(found.venueOrderId).toBe('7001')
    expect(fake.last()!.params.get('contract')).toBe('BTC_USDT')
  })

  it('17. text 扫描也覆盖已结束订单（finished 列表）', async () => {
    await ctx.connector.start()
    ;(fake.finishedOrders[0] as Record<string, unknown>)['text'] = encodeClientOrderId(ID_B)
    const found = await ctx.connector.orderStatus(accountRef, { clientOrderId: ID_B })
    expect(found.found).toBe(true)
    expect(found.status).toBe('filled')
  })

  it('18. 两边都查不到的 text → found=false', async () => {
    const found = await ctx.connector.orderStatus(accountRef, { clientOrderId: '0123456789abcdef0123456789abcdea' })
    expect(found.found).toBe(false)
  })

  it('19. 既不给 venueOrderId 也不给 clientOrderId → INVALID_PARAMS', async () => {
    expect((await problemOf(() => ctx.connector.orderStatus(accountRef, {}))).code).toBe(-32602)
  })
})

describe('启动对账 / 资金费 / 持仓模式', () => {
  it('20. 启动对账：账户 + 挂单 + 成交三样齐全，truncated=false', async () => {
    await ctx.connector.start()
    const snap = await ctx.connector.startupSnapshot(accountRef, 1_791_483_000_000)
    expect(snap.account.positions).toHaveLength(2)
    expect(snap.openOrders).toHaveLength(1)
    expect(snap.fills.length).toBeGreaterThan(0)
    expect(snap.fillsSince).toBe(1_791_483_000_000)
    expect(snap.truncated).toBe(false)
  })

  it('21. 资金费流水走 account_book?type=fund，时间换毫秒', async () => {
    const rows = await ctx.connector.fundingPayments(1_791_400_000_000, 1_791_500_000_000, 'BTC_USDT')
    const call = fake.callsTo('/api/v4/futures/usdt/account_book')[0]!
    expect(call.params.get('type')).toBe('fund')
    expect(call.params.get('from')).toBe('1791400000')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.ts).toBe(1_791_480_000_000)
  })

  it('22. 持仓模式读 accounts 并缓存（30 s 内只请求一次）', async () => {
    expect(await ctx.connector.positionMode()).toBe('single')
    expect(await ctx.connector.positionMode()).toBe('single')
    expect(fake.callsTo('/api/v4/futures/usdt/accounts')).toHaveLength(1)
  })

  it('23. position_mode 缺失时回落 in_dual_mode', async () => {
    fake.account = { currency: 'USDT', total: '1', in_dual_mode: true }
    expect(await ctx.connector.positionMode()).toBe('dual')
  })

  it('24. 取不到模式时返回空串（不猜成单向）', async () => {
    fake.fail('GET', '/api/v4/futures/usdt/accounts', { label: 'INTERNAL', message: 'boom' }, 500)
    expect(await ctx.connector.positionMode()).toBe('')
  })
})

describe('先读后算：乘数、翻页、成交窗口、强平', () => {
  it('25. 未 start() 时 positions() 先拉 /contracts/{contract} 再折币数', async () => {
    ;(fake.positions[0] as Record<string, unknown>)['size'] = '10000'
    const positions = await ctx.connector.positions(accountRef)
    expect(fake.callsFor('GET', '/api/v4/futures/usdt/contracts/BTC_USDT')).toHaveLength(1)
    expect(positions[0]).toMatchObject({ instrumentId: INSTRUMENT, size: '1' })
  })

  it('26. 缓存外合约按 /contracts/{c} 补拉；拉不到就 reject（不按 1 折）', async () => {
    fake.contracts = [...(fake.contracts as Record<string, unknown>[]), contractRow({ name: 'XRP_USDT', quanto_multiplier: '10', order_size_min: '1' })]
    fake.positions = [{ contract: 'XRP_USDT', size: '1000', leverage: '10', value: '1000' }]
    const positions = await ctx.connector.positions(accountRef)
    expect(positions[0]).toMatchObject({ size: '10000' })
    fake.positions = [{ contract: 'YOB_USDT', size: '1000', leverage: '10', value: '1000' }]
    expect((await problemOf(() => ctx.connector.positions(accountRef))).code).toBe(1001)
  })

  it('27. 持仓翻页：首个请求带 holding=true 且不带 contract；按 contract 本地过滤', async () => {
    const bulk: unknown[] = []
    for (let i = 0; i < 120; i++) bulk.push({ contract: 'BTC_USDT', size: '100', leverage: '10', value: '1000', mode: 'single' })
    bulk.push({ contract: 'ETH_USDT', size: '-250', leverage: '20', value: '7500', mode: 'single' })
    fake.positions = bulk
    await ctx.connector.start()
    const eth = await ctx.connector.positions(accountRef, 'ETH_USDT')
    expect(eth.map((p) => p.instrumentId)).toEqual(['gateio:ETH_USDT'])
    const calls = fake.callsTo('/api/v4/futures/usdt/positions')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]!.params.get('holding')).toBe('true')
    expect(calls[0]!.params.get('contract')).toBeNull()
  })

  it('28. 挂单翻页：250 张分 3 页读全；1200 张超上限 → 报错不交半张', async () => {
    const rows: unknown[] = []
    for (let i = 0; i < 250; i++) rows.push({ id: 10_000 + i, text: `t-${i}`, contract: 'BTC_USDT', size: '1', left: '1', price: '100', status: 'open', create_time: 1_791_483_410 })
    fake.openOrders = rows
    await ctx.connector.start()
    const open = await ctx.connector.openOrders(accountRef)
    expect(open).toHaveLength(250)
    const calls = fake.callsFor('GET', '/api/v4/futures/usdt/orders')
    expect(calls).toHaveLength(3)
    expect(calls[0]!.params.get('limit')).toBe('100')
    expect(calls[0]!.params.get('offset')).toBe('0')
    const many: unknown[] = []
    for (let i = 0; i < 1200; i++) many.push({ id: 20_000 + i, text: `t-${i}`, contract: 'BTC_USDT', size: '1', left: '1', price: '100', status: 'open', create_time: 1_791_483_410 })
    fake.openOrders = many
    const problem = await problemOf(() => ctx.connector.openOrders(accountRef))
    expect(problem.code).toBe(3003)
    expect(problem.retryable).toBe(false)
  })

  it('29. 成交翻页：limit 2 读两页；满页仍晚于 since 才算 truncated；见到更早就停', async () => {
    const small = makeConnector(fake, { accounts: { fillsPageLimit: 2 } })
    fake.myTrades = [
      { id: 'a', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_430, fee: '0.006' },
      { id: 'b', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_425, fee: '0.006' },
      { id: 'c', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_420, fee: '0.006' },
    ]
    const fills = await small.connector.fills(accountRef, 1_791_483_400_000)
    expect(fills.map((f) => f.venueFillId)).toEqual(['BTC_USDT:c', 'BTC_USDT:b', 'BTC_USDT:a'])
    expect(fake.callsTo('/api/v4/futures/usdt/my_trades')).toHaveLength(2)
    fake.reset()
    const tiny = makeConnector(fake, { accounts: { fillsPageLimit: 2 } })
    const many: unknown[] = []
    for (let i = 0; i < 20; i++) many.push({ id: `${i}`, contract: 'BTC_USDT', size: '1', create_time: 1_791_483_430, fee: '0.006' })
    fake.myTrades = many
    expect((await tiny.connector.startupSnapshot(accountRef, 1_791_483_400_000)).truncated).toBe(true)
    fake.myTrades = [
      { id: 'new', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_430, fee: '0.006' },
      { id: 'old', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_100, fee: '0.006' },
    ]
    const snap = await tiny.connector.startupSnapshot(accountRef, 1_791_483_400_000)
    expect(snap.truncated).toBe(false)
    expect(snap.fills.map((f) => f.venueFillId)).toEqual(['BTC_USDT:new'])
  })

  it('30. 手续费与 Gate 同号：0.12 记 0.12，-0.003 返佣记 -0.003', async () => {
    fake.myTrades = [
      { id: '1', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_430, fee: '0.12' },
      { id: '2', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_431, fee: '-0.003' },
    ]
    await ctx.connector.start()
    const fills = await ctx.connector.fills(accountRef, 0)
    expect(fills.map((f) => f.fee)).toEqual(['0.12', '-0.003'])
  })

  it('31. 账户维持保证金 = 各持仓之和；保证金率 = mm / equity', async () => {
    fake.positions = [
      { contract: 'BTC_USDT', size: '100', leverage: '10', value: '1000', maintenance_rate: '0.005', mode: 'single' },
      { contract: 'ETH_USDT', size: '-250', leverage: '20', value: '7500', maintenance_rate: '0.01', mode: 'single' },
    ]
    await ctx.connector.start()
    const snapshot = await ctx.connector.accountState(accountRef)
    expect(snapshot.margin.equity).toBe('1041')
    expect(snapshot.margin.maintenanceMargin).toBe('80')
    expect(Number(snapshot.margin.marginRatio)).toBeCloseTo(80 / 1041, 12)
  })

  it('32. 强平 / 自动减仓成交带 liquidation，普通成交没有', async () => {
    fake.myTrades = [
      { id: '1', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_430, fee: '0.006', text: 'liquidation' },
      { id: '2', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_431, fee: '0.006', text: 'auto_deleveraging' },
      { id: '3', contract: 'BTC_USDT', size: '1', create_time: 1_791_483_432, fee: '0.006', text: 't-normal' },
    ]
    await ctx.connector.start()
    const fills = await ctx.connector.fills(accountRef, 0)
    expect(fills.map((f) => f.liquidation)).toEqual([true, true, undefined])
  })

  it('33. 早于 sinceMs 的成交不查乘数：合约已下市的旧成交不让 fills() 报错', async () => {
    const gonePath = '/api/v4/futures/usdt/contracts/GONE_USDT'
    fake.myTrades = [
      { id: 'btc-1', contract: 'BTC_USDT', size: '1', create_time: NOW / 1000, fee: '0.006' },
      { id: 'gone-1', contract: 'GONE_USDT', size: '10', create_time: (NOW - 30 * 86_400_000) / 1000, fee: '0.01' },
    ]
    await ctx.connector.start()
    const fills = await ctx.connector.fills(accountRef, NOW - 60_000)
    expect(fills.map((f) => f.venueFillId)).toEqual(['BTC_USDT:btc-1'])
    expect(fills[0]).toMatchObject({ instrumentId: INSTRUMENT, size: '0.0001' })
    expect(fake.callsTo(gonePath)).toHaveLength(0)
  })

  it('34. 同一张已下市合约的成交若落在 sinceMs 之后，仍按「乘数拿不到就报错」拒（不按 1 折）', async () => {
    fake.myTrades = [
      { id: 'gone-2', contract: 'GONE_USDT', size: '10', create_time: NOW / 1000, fee: '0.01' },
    ]
    await ctx.connector.start()
    const problem = await problemOf(() => ctx.connector.fills(accountRef, NOW - 60_000))
    expect(problem.code).toBe(1001)
  })

  it('35. 备忘上限 10000：第 10001 条挤掉最早一条，最新一条还在', () => {
    for (let i = 0; i < 10_001; i++) {
      ctx.accounts.rememberTrigger(`trig-${i}`, {
        contract: 'BTC_USDT', rule: 2, triggerPrice: asDecimal('90'), size: '-100', at: NOW, venueOrderId: `po:${i}`,
      })
    }
    expect(ctx.accounts.clientIdOfTrigger('po:0')).toBeNull()
    expect(ctx.accounts.clientIdOfTrigger('po:10000')).toBe('trig-10000')
  })
})
