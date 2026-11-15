// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { applySymbolFilter, pageOf, recordSymbols, type RecRow } from '../src/model-records'
import { designSet } from '../fixtures/records'

const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime()

/** 三个页签的全部行：成交 / 委托 / 资金费。标的选项只看这份全量数据。 */
const allRows = (): RecRow[] => {
  const set = designSet(NOW)
  return [
    ...pageOf('fills', { items: set.fills }).rows,
    ...pageOf('orders', { items: set.orders }).rows,
    ...pageOf('funding', { items: set.funding }).rows,
  ]
}

describe('记录 · 标的筛选', () => {
  it('symbol options come from all rows', () => {
    const rows = allRows()
    const options = recordSymbols(rows)
    expect(options).toEqual(['hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL', 'kernel-sim:BTC', 'kernel-sim:ETH'])
    // 筛掉只剩 BTC 后，再问全量行仍然是同一份选项：选项不由筛选后的数据生成。
    const btcOnly = applySymbolFilter(rows, 'hyperliquid:BTC')
    expect(recordSymbols(btcOnly)).toEqual(['hyperliquid:BTC'])
    expect(recordSymbols(rows)).toEqual(options)
  })

  it('null filter keeps everything', () => {
    const rows = allRows()
    const kept = applySymbolFilter(rows, null)
    expect(kept).toHaveLength(rows.length)
    expect(kept).toEqual(rows)
  })

  it('filter by symbol', () => {
    const rows = allRows()
    const btc = applySymbolFilter(rows, 'hyperliquid:BTC')
    expect(btc.length).toBeGreaterThan(0)
    expect(btc.every((r) => r.instrumentId === 'hyperliquid:BTC')).toBe(true)
    // 显示名也能筛（路由可能只带 BTC）；同一显示名跨场所的行都留下。
    const byName = applySymbolFilter(rows, 'BTC')
    expect(byName.length).toBeGreaterThan(btc.length)
    expect(byName.every((r) => r.symbol === 'BTC')).toBe(true)
  })
})
