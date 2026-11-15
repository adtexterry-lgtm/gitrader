// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import {
  actorView, buildRecordChain, exportParams, fmtMoney, fmtPrice, fmtPriceBy, fmtQty, fmtRate, groupLabel, groupRecords, headTotals, mergeRows, normalizeAccounts, orderPrice,
  pageOf, queryParams, rangeOfLink, sourceOf, statusWord, sumStr, timeBounds, toFill, toFunding, tone, typeWord, type FillRow, type FundingRow, type OrderRow, type RecRow,
} from '../src/model-records'
import { ACCT_LIVE, ACCT_PAPER, accounts, bigSet, designSet, recordsQuery } from '../fixtures/records'

const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime()
const MINUS = '−'
const acct = normalizeAccounts(accounts)
const fills = (set = designSet(NOW)): FillRow[] => pageOf('fills', { items: set.fills }, { names: { 'agent:key_claude': 'Claude Code' } }).rows as FillRow[]
const orders = (): OrderRow[] => pageOf('orders', { items: designSet(NOW).orders }, { tickets: { prop_0006: 'T-0006', prop_0005: 'T-0005' } }).rows as OrderRow[]

describe('记录 · 分组排序', () => {
  it('实盘组在上、纸面组在下，与行的到达顺序无关', () => {
    const rows = fills()
    const paperFirst = [...rows.filter((r) => r.accountId === ACCT_PAPER), ...rows.filter((r) => r.accountId === ACCT_LIVE)]
    const groups = groupRecords(paperFirst, acct)
    expect(groups.map((g) => g.mode)).toEqual(['live', 'paper'])
    expect(groups.map((g) => g.alias)).toEqual(['hl-main', 'paper-1'])
    expect(groups.map(groupLabel)).toEqual(['实盘 10', '纸面 5'])
  })
  it('账户表里没有的账户排在最后，不冒充实盘或纸面', () => {
    const rows = fills().slice(0, 3).map((r) => ({ ...r, accountId: 'acct_unknown' }))
    const groups = groupRecords([...rows, ...fills().slice(10, 11)], acct)
    expect(groups.map((g) => g.mode)).toEqual(['paper', ''])
  })
})

describe('记录 · 小计只在组内加', () => {
  it('成交：组小计 = 本组已实现，实盘与纸面不相加（与稿同数 +32.90 / +10.00）', () => {
    const groups = groupRecords(fills(), acct)
    expect(fmtMoney(groups[0]!.total, true)).toBe('+32.90')
    expect(fmtMoney(groups[1]!.total, true)).toBe('+10.00')
  })
  it('卡头手续费实盘 / 纸面各自只加本组（16.55 / 1.16），不出合计', () => {
    const totals = headTotals(groupRecords(fills(), acct), 'fee')
    expect(fmtMoney(totals.live)).toBe('16.55')
    expect(fmtMoney(totals.paper)).toBe('1.16')
  })
  it('十进制精确：0.1 + 0.2 = 0.3，不走浮点', () => {
    expect(sumStr(['0.1', '0.2'])).toBe('0.3')
    expect(sumStr(['-96.00', '88.00', '36'])).toBe('28.00')
    expect(sumStr([null, 'x'])).toBeNull()
  })
  it('没有可加的数时小计为空，不写 0', () => {
    const groups = groupRecords(orders(), acct)
    expect(groups.every((g) => g.total === null && g.fee === null)).toBe(true)
  })
})

describe('记录 · origin 为空不归人', () => {
  it('origin 缺失 → 未知，不是「你」', () => {
    expect(actorView(null)).toEqual({ kind: 'unknown', name: '未知' })
    expect(actorView(undefined).kind).toBe('unknown')
    expect(sourceOf(null)).toBe('—')
  })
  it('成交行没有 origin 时执行方写「未知」', () => {
    const doc = { ...designSet(NOW).fills[2], origin: null, ticket: undefined }
    const row = toFill(doc) as FillRow
    expect(row.actor.kind).toBe('unknown')
    expect(row.actor.name).toBe('未知')
    expect(row.source).toBe('—')
  })
  it('人 / 引擎 / 系统 / Agent 各按行为人大类，Agent 名取钥匙名', () => {
    const rows = fills()
    expect(rows[0]!.actor).toEqual({ kind: 'agent', name: 'Claude Code' })
    expect(rows[0]!.source).toBe('T-0006')
    expect(rows[1]!.actor.kind).toBe('system')
    expect(rows[1]!.source).toBe('保护器')
    expect(rows[2]!.actor).toEqual({ kind: 'human', name: '你' })
    expect(rows[2]!.source).toBe('手动')
    expect(rows[4]!.actor).toEqual({ kind: 'engine', name: 'ema-trend' })
    expect(rows[4]!.source).toBe('策略')
  })
})

describe('记录 · 资金费按小时', () => {
  it('账本条目 payload.payment 是金额；rate / notional 缺了为 null 而不是编造', () => {
    const first = designSet(NOW).funding.find((e) => (e.subject as { instrumentId: string }).instrumentId === 'hyperliquid:BTC')!
    const row = toFunding(first) as FundingRow
    expect(row.payment).toBe('-0.08')
    expect(row.rate).toBe('0.00001')
    expect(toFunding({ ...first, payload: { payment: '-0.5', ccy: 'USDC' } })?.rate).toBeNull()
    expect(toFunding({ ...first, type: 'fill' })).toBeNull()
  })
  it('整点时刻每小时每标的一条；实盘 108 条合计 −3.85、纸面 14 条合计 −0.17（与稿同数）', () => {
    const rows = pageOf('funding', { items: designSet(NOW).funding }).rows as FundingRow[]
    expect(rows.every((r) => new Date(r.ts).getMinutes() === 0 && new Date(r.ts).getSeconds() === 0)).toBe(true)
    const groups = groupRecords(rows, acct)
    expect(groups.map((g) => g.rows.length)).toEqual([108, 14])
    expect(fmtMoney(groups[0]!.total)).toBe(`${MINUS}3.85`)
    expect(fmtMoney(groups[1]!.total)).toBe(`${MINUS}0.17`)
    const perHour = rows.filter((r) => r.accountId === ACCT_LIVE && r.ts === rows[0]!.ts)
    expect(perHour.map((r) => r.symbol).sort()).toEqual(['BTC', 'ETH', 'SOL'])
  })
  it('费率换成百分数，负号用 U+2212', () => {
    expect(fmtRate('0.00001')).toBe('0.0010%')
    expect(fmtRate('0.000013')).toBe('0.0013%')
    expect(fmtMoney('-0.08')).toBe(`${MINUS}0.08`)
  })
})

describe('记录 · 数字写法', () => {
  it('价格至少 1 位小数、数量至少 2 位、金额 2 位，千分位', () => {
    expect(fmtPrice('64930')).toBe('64,930.0')
    expect(fmtPrice('151.2')).toBe('151.2')
    expect(fmtQty('30')).toBe('30.00')
    expect(fmtQty('0.05')).toBe('0.05')
    expect(fmtMoney('3246.5')).toBe('3,246.50')
  })
  it('金额四舍五入远离零；零不带正负号，也不着色', () => {
    expect(fmtMoney('0.005')).toBe('0.01')
    expect(fmtMoney('-0.005')).toBe(`${MINUS}0.01`)
    expect(fmtMoney('0', true)).toBe('0.00')
    expect(fmtMoney('-0.001')).toBe('0.00')
    expect(tone('0')).toBe('zero')
    expect(tone('-0.001')).toBe('zero')
    expect(tone('36')).toBe('up')
    expect(tone('-96')).toBe('down')
    expect(fmtMoney('abc')).toBe('—')
  })
  it('名义 = 价 × 量，十进制精确', () => {
    const [first] = fills()
    expect(first!.notional).toBe('3246.50')
    expect(fmtMoney(first!.notional)).toBe('3,246.50')
  })
})

describe('记录 · 解析与续读', () => {
  it('{ok:false,error} 当失败，错误原文照留；缺 items 也是失败', () => {
    expect(pageOf('fills', { ok: false, error: { name: 'DATA_UNAVAILABLE', message: 'The local fixture cannot provide this view.' } }).error).toBe('The local fixture cannot provide this view.')
    expect(pageOf('fills', {}).error).toMatch(/items/)
    expect(pageOf('fills', { items: [{ junk: 1 }, null] }).rows).toEqual([])
  })
  it('委托：已拦截带内核原文，类型 / 状态 / 价格文案，来源取票号', () => {
    const rows = orders()
    const denied = rows.find((r) => r.status === 'denied')!
    expect(denied.problem).toBe('单笔上限 8,000，实际 32,105')
    expect(denied.source).toBe('无')
    expect(statusWord('denied')).toEqual({ word: '已拦截', tone: 'danger' })
    expect(statusWord('filled').tone).toBe('dim')
    const stop = rows.find((r) => r.type === 'stop_market')!
    expect(typeWord(stop)).toBe('止损　只减仓')
    expect(orderPrice(stop)).toEqual({ text: '63,100.0', market: false })
    const market = rows.find((r) => r.type === 'market')!
    expect(orderPrice(market)).toEqual({ text: '市价', market: true })
    expect(rows.find((r) => r.id === 'ord_00001')!.source).toBe('T-0006')
  })
  it('游标续读到底：1200 笔不重复、不丢行、时间倒序', () => {
    const set = bigSet(NOW)
    let cursor: string | undefined
    let rows: RecRow[] = []
    let pages = 0
    do {
      const page = pageOf('fills', recordsQuery(set, queryParams('fill', { range: 'all' }, NOW, cursor, 100)))
      expect(page.error).toBeNull()
      rows = mergeRows(rows, page.rows)
      cursor = page.next
      pages += 1
    } while (cursor && pages < 30)
    expect(pages).toBe(12)
    expect(rows).toHaveLength(1200)
    expect(new Set(rows.map((r) => r.id)).size).toBe(1200)
    expect(rows.every((r, i) => i === 0 || rows[i - 1]!.ts >= r.ts)).toBe(true)
  })
  it('游标绑定筛选条件：续读时换了时间界就被拒（与内核同），所以块在首页取一次「现在」并沿用', () => {
    const set = bigSet(NOW)
    const first = recordsQuery(set, queryParams('fill', { range: '7d' }, NOW, undefined, 100))
    expect(first.next).toBeDefined()
    expect(() => recordsQuery(set, queryParams('fill', { range: '7d' }, NOW + 60_000, first.next, 100))).toThrow(/cursor does not match/)
    expect(recordsQuery(set, queryParams('fill', { range: '7d' }, NOW, first.next, 100)).items).toHaveLength(100)
  })
  it('续读合并按 id 去重并保持顺序', () => {
    expect(mergeRows([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'c' }]).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('记录 · 事件链', () => {
  it('成交行的链：意图 → 预检 → 待批 → 批准 → 提交 → 成交（T-0006 一笔）', () => {
    const set = designSet(NOW)
    const entries = set.ledger.filter((e) => (e.subject as { orderId?: string }).orderId === 'ord_00001') as never[]
    const chain = buildRecordChain(entries, { 'agent:key_claude': 'Claude Code' })
    expect(chain.map((n) => n.label)).toEqual(['意图', '预检 需批准', '待批 T-0006', '批准', '提交', '成交'])
    expect(chain[0]!.actor).toEqual({ kind: 'agent', name: 'Claude Code' })
    expect(chain[3]!.actor).toEqual({ kind: 'human', name: '你' })
  })
  it('多笔成交合成一个节点，被拦截与被拒绝用危险色', () => {
    const origin = { actor: 'user:u', actorType: 'human', tool: 't', requestId: 'r', via: 'ui' }
    const mk = (seq: number, type: string, ts: number) => ({ schema: 'gitrader-ledger/1', recordedAt: 1, subject: {}, attestation: 'kernel-observed', seq, id: `l${seq}`, ts, type, origin, payload: {} }) as never
    const chain = buildRecordChain([mk(1, 'order.intent', 10), mk(2, 'fill', 20), mk(3, 'fill', 30), mk(4, 'risk.denied', 15)])
    expect(chain.map((n) => n.label)).toEqual(['意图', '预检 拒绝', '成交 ×2'])
    expect(chain[1]!.tone).toBe('danger')
    expect(chain[2]!.ts).toBe(30)
  })
})

describe('记录 · 筛选参数', () => {
  it('预设时间 = 现在 − N 天、不设上限；全部不带时间；联动区间两端都带', () => {
    expect(timeBounds({ range: '7d' }, NOW)).toEqual({ sinceTs: NOW - 7 * 86_400_000 })
    expect(timeBounds({ range: 'all' }, NOW)).toEqual({})
    expect(timeBounds({ range: '7d', custom: { from: 5, to: 9 } }, NOW)).toEqual({ sinceTs: 5, untilTs: 9 })
    expect(rangeOfLink({ from: 5, to: 9 })?.custom).toEqual({ from: 5, to: 9 })
    expect(rangeOfLink({ from: 9, to: 5 })).toBeNull()
  })
  it('查询参数：只带有值的筛选，游标原样回传', () => {
    expect(queryParams('fill', { range: '1d', accountId: 'a1', instrumentId: 'hyperliquid:BTC', actorType: 'llm-agent' }, NOW, 'CUR', 50)).toEqual({
      kind: 'fill', limit: 50, sinceTs: NOW - 86_400_000, accountId: 'a1', instrumentId: 'hyperliquid:BTC', actorType: 'llm-agent', cursor: 'CUR',
    })
    expect(queryParams('funding', { range: 'all' }, NOW)).toEqual({ kind: 'funding', limit: 100 })
  })
  it('导出范围：首条 seq 作 fromSeq、末条作 toSeq；没有条目不发命令', () => {
    expect(exportParams({ seq: 7 })).toEqual({ fromSeq: 7 })
    expect(exportParams({ seq: 7 }, { seq: 90 })).toEqual({ fromSeq: 7, toSeq: 90 })
    expect(exportParams(undefined)).toBeNull()
  })
})

describe('记录 · 资金费认内核字段', () => {
  const entry = { id: 'led_f16', type: 'funding', ts: NOW, subject: { accountId: ACCT_PAPER, instrumentId: 'hyperliquid:BTC' }, payload: { instrumentId: 'hyperliquid:BTC', amount: '-0.12', rate: '0.00001', intervalMs: 3_600_000, positionSize: '2' } }
  it('funding rows accept the kernel amount field', () => {
    const row = toFunding(entry) as FundingRow
    expect(row.payment).toBe('-0.12')
    expect(row.rate).toBe('0.00001')
    expect(row.notional).toBeNull()
  })
  it('funding with payment still parses', () => {
    const row = toFunding({ ...entry, payload: { payment: '-0.34', ccy: 'USDC' } }) as FundingRow
    expect(row.payment).toBe('-0.34')
    expect(row.rate).toBeNull()
    expect(row.ccy).toBe('USDC')
  })
})

describe('记录 · 价格按标的精度显示（X1 ②，只改展示）', () => {
  const rule = { tick: '0.01', maxDecimals: 2 } as never
  it('有价格规则：按规则截位，去掉多余尾零；不改原值', () => {
    expect(fmtPriceBy('12345.678912', rule)).toBe('12,345.67')
    expect(fmtPriceBy('64930.50000000', rule)).toBe('64,930.5')
    expect(fmtPriceBy('0.00001234', { tick: '0.000001', maxDecimals: 6 } as never)).toBe('0.000012')
  })
  it('取不到规则：不再固定 8 位小数，去掉多余尾零，仍至少 1 位小数', () => {
    expect(fmtPriceBy('12345.67800000')).toBe('12,345.678')
    expect(fmtPriceBy('64930.00000000')).toBe('64,930.0')
    expect(fmtPriceBy('0.12345678')).toBe('0.12345678')
    expect(fmtPriceBy(undefined)).toBe('—')
  })
  it('委托价格列同样跟规则；市价照旧', () => {
    const o = { type: 'limit', price: '63100.123456', triggerPrice: null } as never
    expect(orderPrice(o, rule)).toEqual({ text: '63,100.12', market: false })
    expect(orderPrice(o)).toEqual({ text: '63,100.123456', market: false })
    expect(orderPrice({ type: 'market' } as never, rule)).toEqual({ text: '市价', market: true })
  })
})
