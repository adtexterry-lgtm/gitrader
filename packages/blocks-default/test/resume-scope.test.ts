// SPDX-License-Identifier: CPAL-1.0
// 停机作用域逐行显示与恢复：纯函数从 risk.state 的原因里分出全局 / 账户，恢复命令把作用域原样带给内核。
import type { BlockBridge } from '@gitrader/blocks-sdk'
import { describe, expect, it } from 'vitest'
import { resumeTrading } from '../src/actions'
import { stateRows } from '../src/model-risk'

const fakeBridge = (calls: Array<{ action: string; params?: unknown }>): BlockBridge => ({
  command: async (action: string, params?: unknown) => { calls.push({ action, ...(params !== undefined ? { params } : {}) }); return { ok: true } },
}) as unknown as BlockBridge

describe('停机作用域逐行恢复', () => {
  it('lists org and account halts as separate rows', () => {
    const rows = stateRows({
      tradingState: 'HALTED',
      accounts: [
        { accountId: 'acct_01JBZHAO', alias: '赵' },
        { accountId: 'acct_01JBLI', alias: '李' },
      ],
      reasons: [
        { scope: { type: 'org', id: 'org_local' }, state: 'HALTED', reason: 'kill switch: HALT 文件在' },
        { scope: { type: 'account', id: 'acct_01JBZHAO' }, state: 'REDUCING', reason: 'takeover halt_new: 赵的 Agent' },
        { scope: { type: 'account', id: 'acct_01JBZHAO' }, state: 'REDUCING', reason: '重复的暂停原因' },
      ],
    })
    expect(rows).toEqual([
      { scope: { type: 'org' }, label: '全局', state: 'HALTED', reason: 'kill switch: HALT 文件在' },
      { scope: { type: 'account', id: 'acct_01JBZHAO' }, label: '账户 赵', state: 'REDUCING', reason: 'takeover halt_new: 赵的 Agent' },
    ])
  })

  it('resumeTrading passes account scope', async () => {
    const calls: Array<{ action: string; params?: unknown }> = []
    await resumeTrading(fakeBridge(calls), { type: 'account', id: 'acct_01JBZHAO' })
    expect(calls).toEqual([{ action: 'trading_state.resume', params: { scope: { type: 'account', id: 'acct_01JBZHAO' }, reason: '人在检阅面恢复' } }])
  })

  it('default scope stays org', async () => {
    const calls: Array<{ action: string; params?: unknown }> = []
    await resumeTrading(fakeBridge(calls))
    expect(calls).toEqual([{ action: 'trading_state.resume', params: { scope: { type: 'org' }, reason: '人在检阅面恢复' } }])
  })
})

describe('agent self-halt on its mandate scope (persona finding N4)', () => {
  it('sticky mandate halt shows as its own resumable row', async () => {
    const rows = stateRows({ tradingState: 'REDUCING', reasons: [], sticky: [{ scope: { type: 'mandate', id: 'mdt_01ABCDEF123456' }, state: 'REDUCING', reason: 'agent halt_new' }] })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scope).toEqual({ type: 'mandate', id: 'mdt_01ABCDEF123456' })
    expect(rows[0]!.label).toContain('Agent 授权')
    const calls: Array<{ action: string; params?: unknown }> = []
    await resumeTrading(fakeBridge(calls), rows[0]!.scope)
    expect(calls[0]).toEqual({ action: 'trading_state.resume', params: { scope: { type: 'mandate', id: 'mdt_01ABCDEF123456' }, reason: '人在检阅面恢复' } })
  })
})
