// SPDX-License-Identifier: CPAL-1.0
// fix-r4 C7：status() 追加 scopedStates —— 所有非 ACTIVE 作用域（含 mandate / instrument）；tradingState 语义不变。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const states = (): { scope: { type: string; id: string }; state: string; reason?: string; since?: number }[] => h.k.status().scopedStates as never

describe('status().scopedStates', () => {
  it('全 ACTIVE 时是空数组', () => {
    expect(states()).toEqual([])
    expect(h.k.status().tradingState).toBe('ACTIVE')
  })

  it('授权书 / 标的级的只减仓与停止都列出来，带原因与起始时间；tradingState 仍只看 org 与账户', async () => {
    const origin = h.human().origin
    h.k.tstate.set({ type: 'mandate', id: 'mnd_TEST1' }, 'REDUCING', '额度用尽，只许减仓', origin)
    h.k.tstate.set({ type: 'instrument', id: 'hyperliquid:BTC' }, 'HALTED', '标的停止', origin)
    const s = states()
    expect(s).toHaveLength(2)
    expect(s).toContainEqual({ scope: { type: 'mandate', id: 'mnd_TEST1' }, state: 'REDUCING', reason: '额度用尽，只许减仓', since: expect.any(Number) })
    expect(s).toContainEqual({ scope: { type: 'instrument', id: 'hyperliquid:BTC' }, state: 'HALTED', reason: '标的停止', since: expect.any(Number) })
    expect(h.k.status().tradingState).toBe('ACTIVE') // 原语义不变
  })

  it('org 级停止与未到期的保护器暂停也在；恢复后消失', async () => {
    const origin = h.human().origin
    h.k.tstate.set({ type: 'org', id: 'org_local' }, 'HALTED', 'kill', origin)
    h.k.tstate.pause({ type: 'account', id: h.paper.accountId }, 10, '冷却', 'cooldown', origin)
    expect(states().map((x) => `${x.scope.type}:${x.state}`).sort()).toEqual(['account:REDUCING', 'org:HALTED'])
    expect(h.k.status().tradingState).toBe('HALTED')
    h.k.tstate.set({ type: 'org', id: 'org_local' }, 'ACTIVE', 'back', origin, await h.pinProof())
    expect(states().map((x) => x.scope.type)).toEqual(['account'])
  })
})
