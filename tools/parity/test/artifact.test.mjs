// SPDX-License-Identifier: CPAL-1.0
// 规范形：两侧归一 + 结构校验。合成数据，不读盘、不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fromBacktestResult, fromPaperState, validateArtifact, fxToNumber, PARITY_SCHEMA } from '../lib/artifact.mjs'
import { paperStateFixture } from './fixtures/runs.mjs'

test('fromBacktestResult：trades → fills，订单能力声明为 false（回测没有订单对象）', () => {
  const result = {
    jobId: 'job_1',
    engine: { id: 'engine-core', version: '0.1.0' },
    stats: { finalEquity: 10_010.5 },
    equity: [{ t: 1_700_000_000_000, v: 10_000 }, { t: 1_700_003_600_000, v: 10_010.5 }],
    trades: [
      { t: 1_700_000_000_000, side: 'buy', price: 100.5, size: 0.5, pnl: 0, fee: 0.02, reason: 'entry' },
      { t: 1_700_003_600_000, side: 'sell', price: 101.5, size: 0.5, pnl: 0.5, fee: 0.023, reason: 'target' },
    ],
    warnings: ['funding not modelled'],
    assumptions: { fillModel: 'next-bar-open' },
  }
  const run = fromBacktestResult(result, { instrument: 'hyperliquid:BTC', interval: '1m' })
  assert.equal(run.schema, PARITY_SCHEMA)
  assert.equal(run.side, 'backtest')
  assert.equal(run.fills.length, 2)
  assert.equal(run.fills[0].fillId, 'bt-000001')
  assert.equal(run.fills[1].side, 'sell')
  assert.equal(run.capabilities.orders, false)
  assert.equal(run.capabilities.fills, true)
  assert.equal(run.finalEquity, 10_010.5)
  assert.equal(run.clock.mode, 'event-time')
  assert.equal(run.clock.start, 1_700_000_000_000)
  assert.ok(run.notes.some((n) => n.includes('没有订单对象')))
  assert.deepEqual(validateArtifact(run), { ok: true, errors: [] })
})

test('fromPaperState：解析 18 位定点 {$b}，订单/成交/权益都归一；末点 = cash + 未实现', () => {
  const run = fromPaperState(paperStateFixture(), { accountId: 'acct_test' })
  assert.equal(run.side, 'paper')
  assert.equal(run.orders.length, 2)
  assert.equal(run.fills.length, 2)
  assert.equal(run.fills[0].price, 100)
  assert.equal(run.fills[0].size, 1)
  assert.equal(run.fills[1].realizedPnl, 10)
  assert.equal(run.orders[0].clientOrderId, 'c1')
  assert.equal(run.orders[0].status, 'filled')
  assert.equal(run.capabilities.orders, true)
  assert.equal(run.finalEquity, 10_010)
  assert.equal(run.clock.mode, 'system')
  assert.ok(run.notes.some((n) => n.includes('paper state 只保留最近')))
})

test('fxToNumber：bigint / {$b} / 十进制串 / number 四种输入一致，坏值返回 null', () => {
  assert.equal(fxToNumber(10n ** 18n), 1)
  assert.equal(fxToNumber({ $b: (15n * 10n ** 17n).toString() }), 1.5)
  assert.equal(fxToNumber('2.25'), 2.25)
  assert.equal(fxToNumber(3), 3)
  assert.equal(fxToNumber({ $b: 'not-a-number' }), null)
  assert.equal(fxToNumber(Number.NaN), null)
  assert.equal(fxToNumber(null), null)
})

test('validateArtifact：缺 instrument / 坏成交 / 坏 schema 都报错，且一列全给出', () => {
  const bad = { schema: 'x', side: 'paper', capabilities: {}, orders: [], fills: [{ ts: 'nope', price: 1, size: 1, side: 'hold' }], equity: [{ t: 1, v: 'x' }], finalEquity: null }
  const { ok, errors } = validateArtifact(bad)
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.includes('schema must be')))
  assert.ok(errors.some((e) => e.includes('instrument is required')))
  assert.ok(errors.some((e) => e.includes('fills[0].ts')))
  assert.ok(errors.some((e) => e.includes('fills[0].side')))
  assert.ok(errors.some((e) => e.includes('equity[0].v')))
})
