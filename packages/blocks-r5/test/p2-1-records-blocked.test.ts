// SPDX-License-Identifier: CPAL-1.0
// GQ-37：记录页「被拦」页签（risk.denials → 行）与显式路由出口。
import { describe, expect, it } from 'vitest'
import { TABS, applySymbolFilter, pageOfBlocked, recordsHash } from '../src/model-records'
import { ACCT_LIVE, denialsOf } from '../fixtures/records'

describe('records · 被拦', () => {
  it('blocked tab exists after funding', () => {
    expect(TABS.map((t) => t.id)).toEqual(['fills', 'orders', 'funding', 'blocked'])
    expect(TABS.at(-1)!.label).toBe('被拦')
  })
  it('maps risk.denied ledger entries to rows with the rule text and actor', () => {
    const page = pageOfBlocked(denialsOf(1_800_000_000_000), { names: { 'agent:key_claude': 'Claude Code' } })
    expect(page.error).toBeNull()
    expect(page.next).toBeUndefined()
    expect(page.rows).toHaveLength(2)
    expect(page.rows[1]).toMatchObject({ kind: 'blocked', symbol: 'BTC', instrumentId: 'hyperliquid:BTC', accountId: ACCT_LIVE, what: '订单被拦截', actor: { kind: 'agent', name: 'Claude Code' } })
    const rules = (page.rows[1] as { rules: string[] }).rules
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.join(' ')).toContain('2,428.92')
  })
  it('ignores non-denial entries and malformed payloads without throwing (反例)', () => {
    expect(pageOfBlocked([{ type: 'fill', id: 'x', origin: {}, subject: {} }]).rows).toEqual([])
    expect(pageOfBlocked('nope').error).not.toBeNull()
    expect(pageOfBlocked({ ok: false, error: { message: 'METHOD_NOT_FOUND risk.denials' } }).error).toBe('METHOD_NOT_FOUND risk.denials')
    expect(pageOfBlocked({ entries: denialsOf(0) }).rows).toHaveLength(2)
  })
  it('symbol filter applies to blocked rows', () => {
    const rows = pageOfBlocked(denialsOf(0)).rows
    expect(applySymbolFilter(rows, 'hyperliquid:ETH').map((r) => r.symbol)).toEqual(['ETH'])
  })
})

describe('records · 显式路由出口', () => {
  it('keeps the colon readable and escapes the rest', () => {
    expect(recordsHash('hyperliquid:BTC')).toBe('#/records/hyperliquid:BTC')
    expect(recordsHash('hyperliquid:xyz:TSLA')).toBe('#/records/hyperliquid:xyz:TSLA')
    expect(recordsHash('a/b')).toBe('#/records/a%2Fb')
  })
})
