// SPDX-License-Identifier: CPAL-1.0
// 差异计算：逐类断言（订单 / 成交 / 权益 / 能力声明），以及「一侧缺能力 ≠ 一致」这条硬规矩。
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffRuns, summarize, severityText } from '../lib/diff.mjs'
import { backtestRun, paperRun, absentPaper } from './fixtures/runs.mjs'

test('两侧完全一致：只出「回测没有订单对象」一条能力声明，无阻断', () => {
  const d = diffRuns(backtestRun(), paperRun())
  assert.equal(d.rows.filter((r) => r.kind === 'capability').length, 1)
  assert.equal(d.rows.filter((r) => r.kind === 'capability')[0].key, 'orders')
  assert.equal(d.summary.bySeverity.blocking, 0)
  assert.equal(d.summary.verdict, 'partly-unverifiable')
})

test('订单：纸面缺一张单 → 阻断行，判读指向「单没到场所」', () => {
  const paper = paperRun()
  paper.orders = paper.orders.slice(0, 1)
  paper.capabilities.orders = true
  const bt = backtestRun({ orders: [{ seq: 1, clientOrderId: 'c1', side: 'buy', type: 'market', size: 1, price: null, status: 'filled', createdAt: 1, updatedAt: 1 }, { seq: 2, clientOrderId: 'c2', side: 'sell', type: 'market', size: 1, price: null, status: 'filled', createdAt: 2, updatedAt: 2 }], capabilities: { orders: true, fills: true, equity: true, equityCurve: true } })
  const d = diffRuns(bt, paper)
  const miss = d.rows.filter((r) => r.kind === 'orders' && r.field === '*' && r.paper === 'missing')
  assert.equal(miss.length, 1)
  assert.equal(miss[0].severity, 'blocking')
  assert.equal(miss[0].key, 'c2')
  assert.equal(d.summary.verdict, 'divergent')
})

test('订单：数量漂移 → 应修；状态漂移 → 阻断', () => {
  const bt = backtestRun({ orders: [{ seq: 1, clientOrderId: 'c1', side: 'buy', type: 'market', size: 1, price: null, status: 'filled', createdAt: 1, updatedAt: 1 }, { seq: 2, clientOrderId: 'c2', side: 'sell', type: 'market', size: 1, price: null, status: 'filled', createdAt: 2, updatedAt: 2 }], capabilities: { orders: true, fills: true, equity: true, equityCurve: true } })
  const paper = paperRun()
  paper.orders[0] = { ...paper.orders[0], size: 0.999 }
  paper.orders[1] = { ...paper.orders[1], status: 'cancelled' }
  const d = diffRuns(bt, paper)
  const size = d.rows.find((r) => r.kind === 'orders' && r.field === 'size')
  const status = d.rows.find((r) => r.kind === 'orders' && r.field === 'status')
  assert.equal(size.severity, 'fix')
  assert.equal(size.delta, -0.001)
  assert.equal(status.severity, 'blocking')
})

test('成交：价格不同 → 阻断，判读点出两种成交模型', () => {
  const paper = paperRun()
  paper.fills[0] = { ...paper.fills[0], price: 100.4 }
  const d = diffRuns(backtestRun(), paper, { priceEpsAbs: 1e-9 })
  const price = d.rows.find((r) => r.kind === 'fills' && r.field === 'price')
  assert.equal(price.severity, 'blocking')
  assert.equal(Math.round(price.delta * 10) / 10, 0.4)
  assert.ok(price.judgement.includes('下一根开盘价'))
})

test('成交：价格差在容差内不算行；时间差在容差内记备注；数量差记阻断', () => {
  const paper = paperRun()
  paper.fills[0] = { ...paper.fills[0], price: 100.0000001, ts: paper.fills[0].ts + 5 }
  const tight = diffRuns(backtestRun(), paper, { priceEpsAbs: 1e-6, timeToleranceMs: 10 })
  assert.equal(tight.rows.filter((r) => r.kind === 'fills' && r.field === 'price').length, 0)
  assert.equal(tight.rows.filter((r) => r.kind === 'fills' && r.field === 'ts').length, 1)
  const loose = diffRuns(backtestRun(), paper, { priceEpsAbs: 1e-12, timeToleranceMs: 10 })
  assert.equal(loose.rows.filter((r) => r.kind === 'fills' && r.field === 'price').length, 1)

  const shortPaper = paperRun()
  shortPaper.fills[0] = { ...shortPaper.fills[0], size: 0.5 }
  const d = diffRuns(backtestRun(), shortPaper, { timeToleranceMs: 10 })
  const size = d.rows.find((r) => r.kind === 'fills' && r.field === 'size')
  assert.equal(size.severity, 'blocking')
  assert.equal(size.delta, -0.5)
})

test('成交：多一笔 / 少一笔都记阻断，且各自的方向可读', () => {
  const more = paperRun()
  more.fills.push({ seq: 3, ts: 1_760_007_200_000, side: 'buy', price: 105, size: 0.2, fee: 0.01, realizedPnl: 0, orderRef: 'c3', fillId: 'simf-000003', reason: 'taker' })
  const d1 = diffRuns(backtestRun(), more)
  const extra = d1.rows.find((r) => r.kind === 'fills' && r.backtest === 'missing')
  assert.equal(extra.severity, 'blocking')
  assert.ok(extra.judgement.includes('纸面多成交'))

  const less = paperRun()
  less.fills = less.fills.slice(0, 1)
  const d2 = diffRuns(backtestRun(), less)
  const missing = d2.rows.find((r) => r.kind === 'fills' && r.paper === 'missing')
  assert.equal(missing.severity, 'blocking')
  assert.ok(missing.judgement.includes('回测成交在纸面找不到'))
})

test('最终权益：容差内记备注，超出记阻断，并报出差值', () => {
  const near = paperRun({ finalEquity: 10_010.0000001 })
  const d1 = diffRuns(backtestRun(), near)
  const eq1 = d1.rows.find((r) => r.kind === 'equity' && r.key === 'finalEquity')
  assert.equal(eq1.severity, 'note')

  const far = paperRun({ finalEquity: 9_800 })
  const d2 = diffRuns(backtestRun(), far)
  const eq2 = d2.rows.find((r) => r.kind === 'equity' && r.key === 'finalEquity')
  assert.equal(eq2.severity, 'blocking')
  assert.equal(eq2.delta, -210)
  assert.equal(d2.summary.verdict, 'divergent')
})

test('纸面侧缺席：全部记「无法核对」，绝不记成一致，也不把回测的单记成缺失', () => {
  const d = diffRuns(backtestRun(), absentPaper())
  assert.equal(d.rows.filter((r) => r.kind === 'orders' || r.kind === 'fills').length, 0)
  const caps = d.rows.filter((r) => r.kind === 'capability')
  assert.equal(caps.length, 3)
  assert.ok(caps.every((r) => r.severity === 'note' && r.judgement.includes('无法核对')))
  assert.equal(d.summary.bySeverity.blocking, 0)
  assert.equal(d.summary.verdict, 'partly-unverifiable')
})

test('summarize：按类别与严重度计数；严重度中文映射固定', () => {
  const rows = [
    { kind: 'fills', severity: 'blocking' },
    { kind: 'fills', severity: 'fix' },
    { kind: 'equity', severity: 'note' },
    { kind: 'capability', severity: 'note' },
  ]
  const s = summarize(rows)
  assert.deepEqual(s.byKind, { orders: 0, fills: 2, equity: 1, capability: 1 })
  assert.deepEqual(s.bySeverity, { blocking: 1, fix: 1, note: 2 })
  assert.equal(s.verdict, 'divergent')
  assert.equal(severityText('blocking'), '阻断')
  assert.equal(severityText('fix'), '应修')
  assert.equal(severityText('note'), '备注')
})
