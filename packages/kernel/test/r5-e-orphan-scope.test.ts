// SPDX-License-Identifier: CPAL-1.0
// R5 / GQ-66：删除账户后账户级 HALTED 残留，工作台显示「已停止 · 账户 …」——展示层过滤孤儿账户作用域。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const ORPHAN = { type: 'account' as const, id: 'acct_GONE0000000000000000000001' }
const states = (): Array<{ scope: { type: string; id: string }; state: string }> => h.k.status().scopedStates as never
const riskState = async () => (await h.k.ops.call(h.k, 'risk.state', { principal: h.session, params: {}, transport: 'ws' })) as { sticky: Array<{ scope: { type: string; id: string } }>; pauses: Array<{ scope: { type: string; id: string } }> }

describe('GQ-66 孤儿账户作用域状态', () => {
  it('不在配置里的账户的 HALTED：status 与 risk.state 都不再展示；状态仍在库里（同 id 加回来仍停止）', async () => {
    h.k.tstate.set(ORPHAN, 'HALTED', '启动对账失败', h.human().origin)
    expect(states().some((s) => s.scope.id === ORPHAN.id)).toBe(false)
    expect((await riskState()).sticky.some((s) => s.scope.id === ORPHAN.id)).toBe(false)
    expect(h.k.tstate.get(ORPHAN)).toBe('HALTED')                                  // 没有被清掉
  })

  it('反例：现有账户的 HALTED、授权书级 REDUCING 照旧展示', async () => {
    h.k.tstate.set({ type: 'account', id: h.paper.accountId }, 'HALTED', 'x', h.human().origin)
    h.k.tstate.set({ type: 'mandate', id: 'mnd_TEST1' }, 'REDUCING', 'y', h.human().origin)
    const kinds = states().map((s) => `${s.scope.type}:${s.state}`).sort()
    expect(kinds).toEqual(['account:HALTED', 'mandate:REDUCING'])
    expect((await riskState()).sticky.length).toBe(2)
  })

  it('保护器暂停（pauses）指向孤儿账户也不展示', () => {
    h.k.tstate.pause(ORPHAN, 10, '冷却', 'cooldown', h.human().origin)
    expect(states().some((s) => s.scope.id === ORPHAN.id)).toBe(false)
  })
})
