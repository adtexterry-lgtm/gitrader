// SPDX-License-Identifier: CPAL-1.0
// A2 追加：UX-10 内核侧（没有连接记录时 state 也参考连接器实时状态）、UX-20 内核侧（取整命中的 zh 不再写「精度不对」）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zhHits } from '../src/api/agent-out'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

describe('UX-20 取整命中的 zh', () => {
  it('action=limit：说已按最小步长取整；其余仍是精度不对', () => {
    const [a] = zhHits([{ code: 'SIZE_PRECISION', action: 'limit', limit: '0.00125', actual: '0.001374' }])
    expect(a!.zh).toContain('取整')
    expect(a!.zh).not.toContain('精度不对')
    const [b] = zhHits([{ code: 'SIZE_PRECISION', action: 'deny', limit: '0.00125', actual: '0.001374' }])
    expect(b!.zh).toBe('下单数量精度不对')
  })
})

describe('UX-10 没有连接记录的场所', () => {
  let h: Harness
  beforeEach(async () => { h = await makeHarness() })
  afterEach(async () => { await h.cleanup() })
  it('连接器 WS 已掉线时 state 不能还是 connected', () => {
    h.live.status = () => ({ venue: 'hyperliquid', environment: 'testnet', ts: 0, wsState: 'disconnected', stale: true, source: 'none', lastMessageTs: 0 })
    expect(h.k.venueConnection('hyperliquid').state).toBe('disconnected')
  })
})
