// SPDX-License-Identifier: CPAL-1.0
// 测试夹具：手造的极简运行记录（不含任何真实行情），用于逐行断言差异表。
import { emptyRun, PARITY_SCHEMA } from '../../lib/artifact.mjs'

export const T = 1_760_000_000_000

export function backtestRun(over = {}) {
  const run = emptyRun('backtest', {
    runId: 'job_test',
    instrument: 'hyperliquid:BTC',
    interval: '1h',
    source: { kind: 'gep-backtest' },
    clock: { mode: 'event-time', start: T, end: T + 3_600_000 },
  })
  run.capabilities = { orders: false, fills: true, equity: true, equityCurve: true }
  run.fills = [
    { seq: 1, ts: T, side: 'buy', price: 100, size: 1, fee: 0.045, realizedPnl: 0, orderRef: null, fillId: 'bt-000001', reason: 'entry' },
    { seq: 2, ts: T + 3_600_000, side: 'sell', price: 110, size: 1, fee: 0.0495, realizedPnl: 10, orderRef: null, fillId: 'bt-000002', reason: 'target' },
  ]
  run.equity = [{ t: T, v: 10_000 }, { t: T + 3_600_000, v: 10_010 }]
  run.finalEquity = 10_010
  run.notes = ['回测侧没有订单对象']
  return Object.assign(run, over)
}

export function paperRun(over = {}) {
  const run = emptyRun('paper', {
    runId: 'paper:acct_test',
    instrument: 'hyperliquid:BTC',
    interval: '1h',
    source: { kind: 'paper-state', accountId: 'acct_test' },
    clock: { mode: 'system', start: T, end: T + 3_600_000 },
  })
  run.capabilities = { orders: true, fills: true, equity: true, equityCurve: true }
  run.orders = [
    { seq: 1, clientOrderId: 'c1', venueOrderId: 'v1', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', tif: 'ioc', size: 1, filledSize: 1, price: null, avgFillPrice: 100, status: 'filled', createdAt: T, updatedAt: T },
    { seq: 2, clientOrderId: 'c2', venueOrderId: 'v2', instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'market', tif: 'ioc', size: 1, filledSize: 1, price: null, avgFillPrice: 110, status: 'filled', createdAt: T + 3_600_000, updatedAt: T + 3_600_000 },
  ]
  run.fills = [
    { seq: 1, ts: T, side: 'buy', price: 100, size: 1, fee: 0.045, realizedPnl: 0, orderRef: 'c1', fillId: 'simf-000001', reason: 'taker' },
    { seq: 2, ts: T + 3_600_000, side: 'sell', price: 110, size: 1, fee: 0.0495, realizedPnl: 10, orderRef: 'c2', fillId: 'simf-000002', reason: 'taker' },
  ]
  run.equity = [{ t: T, v: 10_000 }, { t: T + 3_600_000, v: 10_010 }]
  run.finalEquity = 10_010
  run.notes = []
  return Object.assign(run, over)
}

/** 纸面侧缺席（停机分支）用的空记录。 */
export function absentPaper() {
  const run = emptyRun('paper', {
    runId: 'paper:absent',
    instrument: 'hyperliquid:BTC',
    interval: '1h',
    source: { kind: 'absent', reason: 'no replay entry' },
    clock: { mode: 'none', start: null, end: null },
  })
  run.capabilities = { orders: false, fills: false, equity: false, equityCurve: false }
  run.notes = ['停机分支']
  return run
}

/** 造一份 PaperVenue.exportState() 形状的 state（Fx = 18 位定点，JSON 化成 {$b}）。 */
export function paperStateFixture() {
  const fx = (n) => ({ $b: (BigInt(Math.round(n * 1e9)) * 10n ** 9n).toString() })
  return {
    v: 1,
    orderSeq: 2,
    fillSeq: 2,
    accounts: [{
      id: 'acct_test',
      ccy: 'USDC',
      initial: fx(10_000),
      cash: fx(10_010),
      realized: fx(10),
      fees: fx(0.0945),
      funding: fx(0),
      leverage: { $m: [['hyperliquid:BTC', 1]] },
      positions: { $m: [] },
      orders: [
        { venueOrderId: 'v1', clientOrderId: 'c1', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', tif: 'ioc', size: fx(1), filled: fx(1), price: null, triggerPrice: null, triggerMarket: false, avgPx: fx(100), fee: fx(0.045), reduceOnly: false, leverage: 1, status: 'filled', role: 'parent', waitingParent: false, slippageCap: null, createdAt: T, updatedAt: T, closedAt: T },
        { venueOrderId: 'v2', clientOrderId: 'c2', instrumentId: 'hyperliquid:BTC', side: 'sell', type: 'market', tif: 'ioc', size: fx(1), filled: fx(1), price: null, triggerPrice: null, triggerMarket: false, avgPx: fx(110), fee: fx(0.0495), reduceOnly: false, leverage: 1, status: 'filled', role: 'parent', waitingParent: false, slippageCap: null, createdAt: T + 3_600_000, updatedAt: T + 3_600_000, closedAt: T + 3_600_000 },
      ],
      fills: [
        { venueOrderId: 'v1', clientOrderId: 'c1', venueFillId: 'simf-000001', instrumentId: 'hyperliquid:BTC', side: 'buy', price: '100', size: '1', fee: '0.045', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '0', ts: T },
        { venueOrderId: 'v2', clientOrderId: 'c2', venueFillId: 'simf-000002', instrumentId: 'hyperliquid:BTC', side: 'sell', price: '110', size: '1', fee: '0.0495', feeCcy: 'USDC', liquidity: 'taker', realizedPnl: '10', ts: T + 3_600_000 },
      ],
      createdAt: T,
    }],
  }
}
