// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { agentCardCounts, fmtAgentCount, localDayStart, stableKeyOrder, AGENT_DASH } from '../src/model-agent-card'

describe('agent card counts', () => {
  it('counts come from risk.stats, not the feed window', () => {
    const stats = {
      denied: 6,
      review: 2,
      deduplicatedBy: 'subject',
      byActor: {
        'agent:key-a': { denied: 4, review: 1, rules: { max_order_notional: 4 }, proposals: 7 },
        'agent:key-b': { denied: 0, review: 0, rules: {} },
      },
      byRule: {},
    }
    expect(agentCardCounts(stats, 'key-a')).toEqual({ proposals: 7, blocked: 4 })
    // actor 今天没有记录 = 0（回包可用，不显示 —）。
    expect(agentCardCounts(stats, 'key-b')).toEqual({ proposals: 0, blocked: 0 })
    expect(agentCardCounts(stats, 'key-missing')).toEqual({ proposals: 0, blocked: 0 })
  })

  it('local day boundary', () => {
    const now = new Date(2026, 2, 8, 15, 42, 13, 500).getTime()
    expect(localDayStart(now)).toBe(new Date(2026, 2, 8, 0, 0, 0, 0).getTime())
    const justAfterMidnight = new Date(2026, 2, 9, 0, 0, 1, 0).getTime()
    expect(localDayStart(justAfterMidnight)).toBe(new Date(2026, 2, 9, 0, 0, 0, 0).getTime())
  })

  it('stats failure shows a dash', () => {
    for (const bad of [undefined, null, 'error', {}, { byActor: null }]) {
      const counts = agentCardCounts(bad, 'key-a')
      expect(counts).toEqual({ proposals: null, blocked: null })
      expect(fmtAgentCount(counts.proposals)).toBe(AGENT_DASH)
      expect(fmtAgentCount(counts.blocked)).toBe(AGENT_DASH)
    }
    expect(fmtAgentCount(0)).toBe('0')
    expect(fmtAgentCount(7)).toBe('7')
  })

  it('stable order by creation time', () => {
    const keys = [
      { keyId: 'b', name: 'Beta' },
      { keyId: 'a', name: 'Alpha' },
      { keyId: 'c', name: 'Charlie' },
    ]
    const createdAt = new Map([['a', 300], ['b', 100], ['c', 200]])
    const order = stableKeyOrder(keys, (keyId) => createdAt.get(keyId) ?? null)
    expect(order.map((k) => k.keyId)).toEqual(['b', 'c', 'a'])
    // 同一组钥匙换个动作顺序重排，结果不变（不随动作跳位）。
    const shuffled = [keys[1]!, keys[2]!, keys[0]!]
    expect(stableKeyOrder(shuffled, (keyId) => createdAt.get(keyId) ?? null).map((k) => k.keyId)).toEqual(['b', 'c', 'a'])
    // 没有创建时间的按名字排在后面。
    const noCreated = [
      { keyId: 'z', name: 'Zulu' },
      { keyId: 'a', name: 'Alpha' },
      { keyId: 'm', name: 'Mike' },
    ]
    expect(stableKeyOrder(noCreated, () => null).map((k) => k.keyId)).toEqual(['a', 'm', 'z'])
  })
})
