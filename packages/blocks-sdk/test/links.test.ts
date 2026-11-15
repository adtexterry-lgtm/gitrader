// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'
import { LinkHub } from '../src'

describe('联动组', () => {
  it('同通道同组广播，其他通道 / 其他组不受影响', () => {
    const hub = new LinkHub({ A: { symbol: 'hyperliquid:BTC' } })
    const a = vi.fn(); const b = vi.fn(); const other = vi.fn(); const acct = vi.fn()
    hub.subscribe('A', 'symbol', a)
    hub.subscribe('A', 'symbol', b)
    hub.subscribe('B', 'symbol', other)
    hub.subscribe('A', 'account', acct)
    expect(hub.set('A', 'symbol', 'hyperliquid:ETH', 'bi_chart_1')).toBe(true)
    expect(a).toHaveBeenCalledWith('hyperliquid:ETH', 'bi_chart_1')
    expect(b).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
    expect(acct).not.toHaveBeenCalled()
    expect(hub.get('A', 'symbol')).toBe('hyperliquid:ETH')
  })

  it('值没变不重复通知（含对象值）', () => {
    const hub = new LinkHub()
    const fn = vi.fn()
    hub.subscribe('A', 'timeRange', fn)
    hub.set('A', 'timeRange', { from: 1, to: 2 })
    hub.set('A', 'timeRange', { from: 1, to: 2 })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('取消订阅后不再收到；一个监听者抛错不影响其他', () => {
    const hub = new LinkHub()
    const ok = vi.fn()
    hub.subscribe('A', 'symbol', () => { throw new Error('boom') })
    const off = hub.subscribe('A', 'symbol', ok)
    hub.set('A', 'symbol', 'x:1')
    expect(ok).toHaveBeenCalledOnce()
    off()
    hub.set('A', 'symbol', 'x:2')
    expect(ok).toHaveBeenCalledOnce()
  })

  it('snapshot / load 往返，load 只通知有差异的组', () => {
    const hub = new LinkHub({ A: { symbol: 'hyperliquid:BTC', account: 'acct_1' } })
    const snap = hub.snapshot()
    const sym = vi.fn(); const acct = vi.fn()
    hub.subscribe('A', 'symbol', sym)
    hub.subscribe('A', 'account', acct)
    hub.load({ A: { symbol: 'hyperliquid:SOL', account: 'acct_1' } })
    expect(sym).toHaveBeenCalledWith('hyperliquid:SOL', 'load')
    expect(acct).not.toHaveBeenCalled()
    hub.load(snap)
    expect(hub.get('A', 'symbol')).toBe('hyperliquid:BTC')
  })
})
