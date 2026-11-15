// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '@gitrader/protocol/types'
import { entryToActivity, ruleText } from '../src/model-activity'
import { isAtOrBelowBase, isTighteningLimits, mandateNames, normalizeRisk, relaxLeftText, stateRows } from '../src/model-risk'
import { failureNotice, runCommand } from '../src/actions'

const entry = (type: LedgerEntry['type'], payload: Record<string, unknown>): LedgerEntry => ({ id: 'entry_fixture', seq: 1, ts: 10000,
  type, payload, subject: { orgId: 'org_local' }, origin: { actor: 'system:fixture', tool: 'test', via: 'internal' }, ruleHits: [] } as unknown as LedgerEntry)
describe('D5 state and feedback', () => {
  it('uses the trading-state rule instead of a misleading confirmation message', () => {
    const row = entry('order.rejected', { problem: { name: 'TRADING_STATE_INVALID', message: '需要你确认', venue: { message: '需要你确认' } } })
    expect(entryToActivity(row)?.why).toBe('当前交易状态不允许，先恢复交易')
    expect(entryToActivity(row)?.upstream).toBeUndefined()
    expect(ruleText({ code: 'TRADING_STATE', message: '需要你确认' } as never)).toBe('当前交易状态不允许，先恢复交易')
  })
  it('preserves scope on the first pushed activity and includes mandate stops despite global ACTIVE', () => {
    const activity = entryToActivity(entry('trading_state.changed', { scope: { type: 'account', id: 'acct_fixture' }, to: 'HALTED' }))!
    expect(activity.what).toContain('账户')
    expect(activity.what).not.toContain('全局')
    const raw = { tradingState: 'ACTIVE', reasons: [{ scope: { type: 'account', id: 'acct_fixture' }, state: 'REDUCING', reason: '账户停机' }], sticky: [{ scope: { type: 'mandate', id: 'mdt_fixture' }, state: 'HALTED', reason: '授权停机' }] }
    expect(normalizeRisk(raw).state).toBe('HALTED')
    expect(stateRows(raw).map((r) => r.scope.type)).toEqual(['account', 'mandate'])
  })
  it('returns actionable Chinese feedback for an unrecognized upstream failure', async () => {
    const bridge = { command: async () => { throw new Error('transport unavailable') } }
    const result = await runCommand(bridge as never, 'venue.reconnect')
    expect(result).toMatchObject({ ok: false, cancelled: false, upstream: 'transport unavailable' })
    // 维护者裁决：runCommand 不改写消息（只做中文化），恢复步骤由原本会静默失败的调用点用 failureNotice 补上
    if (!result.ok) {
      expect(result.message).toBe('引擎内部出错，这次操作没有完成')
      expect(failureNotice(result)).toBe('引擎内部出错，这次操作没有完成；先查看最新状态，确认结果后再重试')
    }
  })
  it('failureNotice maps trading-state rejections to the resume hint', () => {
    expect(failureNotice({ ok: false, cancelled: false, message: 'x', problem: 'TRADING_STATE_HALTED' })).toBe('当前交易状态不允许，先恢复交易；先查看最新状态，确认结果后再重试')
  })
})

describe('fix-r4 C12 名字代替编号 / C1 临时放宽', () => {
  const sticky = [{ scope: { type: 'mandate', id: 'mdt_01HTRBBE' }, state: 'REDUCING', reason: 'agent halt_new' }]
  it('授权书停机行写 Agent「名字」，吊销的带（已撤销），查不到写 Agent 授权，任何情形都不露编号尾号', () => {
    const named = stateRows({ tradingState: 'ACTIVE', reasons: [], sticky, mandateNames: { mdt_01HTRBBE: '阿珍的AI' } })
    expect(named[0]!.label).toBe('Agent「阿珍的AI」')
    expect(stateRows({ tradingState: 'ACTIVE', reasons: [], sticky, mandateNames: { mdt_01HTRBBE: '阿珍的AI（已撤销）' } })[0]!.label).toBe('Agent「阿珍的AI（已撤销）」')
    const unnamed = stateRows({ tradingState: 'ACTIVE', reasons: [], sticky })
    expect(unnamed[0]!.label).toBe('Agent 授权')
    expect(unnamed[0]!.label).not.toContain('HTRBBE')
  })
  it('mandateNames 从原始钥匙表取名，吊销的加后缀', () => {
    expect(mandateNames({ keys: [{ keyId: 'k1', mandateId: 'mdt_a', name: 'A', status: 'active' }, { keyId: 'k2', mandateId: 'mdt_b', name: 'B', status: 'revoked' }, { keyId: 'k3', name: 'C' }] }))
      .toEqual({ mdt_a: 'A', mdt_b: 'B（已撤销）' })
  })
  it('normalizeRisk 带出 policy.temporaryRelax（until > now 才算），到期后为 null', () => {
    const raw = { tradingState: 'ACTIVE', limits: { maxOrderNotional: '3000' }, policy: { temporaryRelax: { fields: { maxOrderNotional: '3000' }, from: 1000, until: 5000, revertToVersion: 1 } } }
    expect(normalizeRisk(raw, 4000).relax).toEqual({ until: 5000, fields: ['maxOrderNotional'], values: { maxOrderNotional: '3000' } })
    expect(normalizeRisk(raw, 5000).relax).toBeNull()
    expect(normalizeRisk({ tradingState: 'ACTIVE', policy: { temporaryRelax: null } }, 4000).relax).toBeNull()
    expect(normalizeRisk({ tradingState: 'ACTIVE' }, 4000).relax).toBeNull()
  })
  it('剩余时间文案', () => {
    const min = 60_000
    expect(relaxLeftText(200 * min, 0)).toBe('剩 3 小时 20 分')
    expect(relaxLeftText(12 * min, 0)).toBe('剩 12 分')
    expect(relaxLeftText(30_000, 0)).toBe('剩不到 1 分')
  })
})

describe('fix-r4 C9 长命令超时', () => {
  it('takeover / position.close / trading_state.resume 超时：中文说明结果未知并发刷新事件，不重发；其他命令的超时文案不变', async () => {
    const { KernelError, CODE_TIMEOUT } = await import('@gitrader/blocks-sdk')
    const calls: string[] = []
    const bridge = { command: async (a: string) => { calls.push(a); throw new KernelError(CODE_TIMEOUT, `command 超时（60000 ms）；结果未知，请先核对状态再重试`) } }
    let refreshed = 0
    const on = () => { refreshed += 1 }
    ;(globalThis as { window?: unknown }).window ??= new EventTarget()
    const w = (globalThis as unknown as { window: EventTarget }).window
    w.addEventListener('gitrader:refresh', on)
    try {
      const r = await runCommand(bridge as never, 'takeover.flatten_all', {})
      expect(r).toMatchObject({ ok: false, cancelled: false, message: '还没收到内核回执，结果未知。正在核对持仓与对账' })
      expect(calls).toEqual(['takeover.flatten_all'])
      expect(refreshed).toBe(1)
      const other = await runCommand(bridge as never, 'venue.reconnect', {})
      expect(refreshed).toBe(1)
      expect(other.ok === false && other.message).toContain('超时')
    } finally { w.removeEventListener('gitrader:refresh', on) }
  })
})

describe('fix-r4 M3 收紧 / 放宽按基线判断', () => {
  const raw = { tradingState: 'ACTIVE', limits: { maxOrderNotional: '9000' }, policy: { limits: { maxOrderNotional: '5000' }, temporaryRelax: { fields: { maxOrderNotional: '9000' }, from: 1, until: 9000, revertToVersion: 1 } } }
  it('baseLimits 取 policy.limits，没有时退回生效值', () => {
    expect(normalizeRisk(raw, 4000).baseLimits).toEqual({ maxOrderNotional: '5000' })
    expect(normalizeRisk({ limits: { maxOrderNotional: '100' } }, 4000).baseLimits).toEqual({ maxOrderNotional: '100' })
  })
  it('介于基线与放宽值之间 = 放宽；≤ 基线（含等于）= 可走 tighten', () => {
    const base = normalizeRisk(raw, 4000).baseLimits
    expect(isAtOrBelowBase({ maxOrderNotional: '7000' }, base)).toBe(false)
    expect(isAtOrBelowBase({ maxOrderNotional: '5000' }, base)).toBe(true)
    expect(isAtOrBelowBase({ maxOrderNotional: '3000' }, base)).toBe(true)
    expect(isAtOrBelowBase({ maxLeverage: 8 }, { maxLeverage: 5 })).toBe(false)
    expect(isAtOrBelowBase({ maxOrderNotional: 'abc' }, base)).toBe(false)
    // 旧判断不变：严格更小才算「收紧」
    expect(isTighteningLimits({ maxOrderNotional: '5000' }, base)).toBe(false)
    expect(isTighteningLimits({ maxOrderNotional: '3000' }, base)).toBe(true)
  })
})
