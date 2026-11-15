// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
// @ts-expect-error The JSX shell component is outside the package TypeScript compilation boundary.
import { requestRows } from '../src/shell/AgentRequestCard.jsx'

const req = { requestId: 'akr_demo', state: 'pending', createdAt: 1000, expiresAt: 61000, input: {
  name: '演示助手', host: 'codex', tier: 'confirm', expiresInDays: 30,
  mandate: { accounts: ['paper-1', 'paper-2'], venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['BTC', 'hyperliquid:ETH', 'hyperliquid:SOL', 'hyperliquid:AVAX'], limits: { maxOrderNotional: '123.45', maxDailyNotional: '999.99' } },
} }
describe('requestRows', () => {
  it('lists every grant field with venue prefix', () => {
    expect(requestRows(req, 1000).rows).toEqual([
      ['宿主', 'codex'], ['档位', '需确认 · 每笔开仓等你批'], ['账户', 'paper-1、paper-2'], ['场所', 'hyperliquid'],
      ['标的', 'hyperliquid:BTC、hyperliquid:ETH、hyperliquid:SOL、hyperliquid:AVAX'],
      ['单笔 / 日额', '123.45 / 999.99'], ['有效期', '30 天'], ['剩余时间', '01:00'],
    ])
  })
  it('countdown and expiry', () => {
    expect(requestRows(req, 60001)).toMatchObject({ expired: false, remaining: 1 })
    expect(requestRows(req, 61000)).toMatchObject({ expired: true, remaining: 0 })
    expect(requestRows(req, 62000).rows.at(-1)).toEqual(['剩余时间', '00:00'])
  })
})
