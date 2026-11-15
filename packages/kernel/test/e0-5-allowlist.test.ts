// SPDX-License-Identifier: CPAL-1.0
// 白名单规范化 + 授权书缺项中文列表（E0-5）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mandateGaps, normalizeInstrumentAllowlist } from '../src/agents'
import { KernelError } from '../src/util/errors'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const CATALOG = [
  { instrumentId: 'hyperliquid:BTC', marketGroup: null },
  { instrumentId: 'hyperliquid:ETH', marketGroup: null },
  { instrumentId: 'hyperliquid:SOL', marketGroup: null },
  { instrumentId: 'paper:BTC', marketGroup: 'sim' },
]

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

describe('E0-5 白名单规范化', () => {
  it('bare symbol expands to unique venue:symbol', () => {
    const r = normalizeInstrumentAllowlist(['btc'], CATALOG)
    expect(r.list).toEqual(['hyperliquid:BTC'])
    expect(r.notes).toEqual(['已补全为 hyperliquid:BTC'])
    expect(r.unknown).toEqual([])
    // 已带场所前缀且在目录里 → 原样
    expect(normalizeInstrumentAllowlist(['hyperliquid:ETH'], CATALOG).list).toEqual(['hyperliquid:ETH'])
    // 多个主市场匹配 → 取第一个并提示
    const multi = normalizeInstrumentAllowlist(['btc'], [
      { instrumentId: 'venueA:BTC', marketGroup: '' },
      { instrumentId: 'venueB:BTC', marketGroup: undefined },
    ])
    expect(multi.list).toEqual(['venueA:BTC'])
    expect(multi.notes[0]).toContain('BTC 有多个场所，已选 venueA:BTC')
  })

  it('unknown symbol lists nearest three', () => {
    const r = normalizeInstrumentAllowlist(['BTCC'], CATALOG)
    expect(r.list).toEqual([])
    expect(r.unknown).toHaveLength(1)
    const u = r.unknown[0]!
    expect(u.input).toBe('BTCC')
    expect(u.nearest).toHaveLength(3)
    expect(u.nearest[0]).toBe('hyperliquid:BTC')
  })

  it('missing L2 fields reported as list', () => {
    const gaps = mandateGaps({ subject: { type: 'agentKey', id: 'ak_1' }, level: 'L2', accounts: ['acct_1' as never] }, Date.now())
    expect(gaps.map((g) => g.field)).toEqual(['venueAllowlist', 'instrumentAllowlist', 'limits.maxOrderNotional', 'limits.maxDailyNotional'])
    expect(gaps.map((g) => g.zh)).toEqual(['允许的场所', '允许的标的', '单笔上限', '每日上限'])
    // 中文档位名与「有效期」原因
    const l3 = mandateGaps({
      subject: { type: 'agentKey', id: 'ak_1' }, level: 'L3', accounts: ['acct_1' as never],
      venueAllowlist: ['hyperliquid'], instrumentAllowlist: ['hyperliquid:BTC'],
      limits: { maxOrderNotional: '1' as never, maxDailyNotional: '2' as never, maxDailyLoss: '1' as never, autoMaxOrderNotional: '1' as never },
      notAfter: Date.now() + 100 * 86_400_000,
    }, Date.now())
    expect(l3).toHaveLength(2)
    expect(l3.every((g) => g.field === 'heartbeat' || g.field === 'notAfter')).toBe(true)
    const expiry = l3.find((g) => g.field === 'notAfter')!
    expect(expiry.zh).toContain('有效期')
    expect(expiry.zh).toContain('90')
  })

  it('issueMandate error is chinese and keeps original text', async () => {
    const pin = await h.pinProof()
    let err: unknown
    try {
      h.k.agents.issueMandate(
        { subject: { type: 'agentKey', id: 'ak_1' }, level: 'L2', accounts: [h.paper.accountId] } as never,
        pin,
        h.human('mandate.issue').origin,
      )
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(KernelError)
    const problem = (err as KernelError).problem
    expect(problem.name).toBe('INVALID_PARAMS')
    expect(problem.message).toContain('「需确认」档还需要：允许的场所、允许的标的、单笔上限、每日上限。可以加 --preset starter 一键用默认值')
    expect(problem.message).toContain('原文：invalid mandate: L2 requires venueAllowlist; L2 requires instrumentAllowlist; L2 requires limits.maxOrderNotional; L2 requires limits.maxDailyNotional')
  })
})
