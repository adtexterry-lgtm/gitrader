// SPDX-License-Identifier: CPAL-1.0
// 视觉轮 r4（C2）三张卡与总览条的纯逻辑：批后仓位、实盘 / 纸面分开、最急一张、引信、队列、限额语气、视图选择、最后活动。
import { describe, expect, it } from 'vitest'
import { ACCT_LIVE, ACCT_PAPER, NOW, scenario } from '../fixtures/scenarios'
import { agoText, fuseRatio, netPosText, parseView, pendingQueue, positionAfter, queueView, ruleLine, soonest, toPending, type PendingCard } from '../src/model-activity'
import { normalizeAccounts, normalizeSummary } from '../src/model-positions'
import { toneOf, totalsByMode } from '../src/model-risk'

const cards = (): PendingCard[] => pendingQueue(new Map(scenario('pending').proposals.map((p) => [String((p as unknown as Record<string, unknown>).proposalId), p as unknown as Record<string, unknown>])))
const card = (id: string, expiresAt: number): PendingCard => ({ ...cards()[0]!, proposalId: id, ticket: `T-${id}`, expiresAt })

describe('批后仓位（IA §2.3）', () => {
  it('positionAfter：空 1.2 + 卖出 2 → 空 3.2；无仓 + 买入 0.5 → 多 0.5；多 0.5 + 卖出 2 → 空 1.5；平到 0 → 无仓位', () => {
    expect(netPosText(positionAfter({ side: 'short', size: 1.2 }, [{ side: 'sell', size: 2 }]))).toBe('空 3.2')
    expect(netPosText(positionAfter(null, [{ side: 'buy', size: 0.5 }]))).toBe('多 0.5')
    expect(netPosText(positionAfter({ side: 'long', size: 0.5 }, [{ side: 'sell', size: 2 }]))).toBe('空 1.5')
    expect(positionAfter({ side: 'long', size: 0.5 }, [{ side: 'sell', size: 0.5 }])).toBeNull()
    expect(netPosText(null)).toBe('无仓位')
    // 浮点尾巴不进界面
    expect(positionAfter(null, [{ side: 'buy', size: 0.1 }, { side: 'buy', size: 0.2 }])).toEqual({ side: 'long', size: 0.3 })
  })
  it('提案腿带标的 / 方向 / 数量（toPending 追加字段，旧字段不变）', () => {
    const c = toPending(scenario('pending').proposals[1] as unknown as Record<string, unknown>)!
    expect(c.legs[0]).toMatchObject({ text: '卖出 2 ETH @ 3,190', instrumentId: 'hyperliquid:ETH', side: 'sell', size: 2 })
  })
})

describe('总览条：实盘 / 纸面分开（IA §2.1）', () => {
  const sc = scenario('pending')
  const accts = normalizeAccounts(sc.accounts)
  const sums = Object.fromEntries(Object.entries(sc.summaries).map(([k, v]) => [k, normalizeSummary(v)]))
  it('totalsByMode：实盘 12,480.20 / +128.40 / +1.04%；纸面 9,987.50 / −12.50；不相加', () => {
    const t = totalsByMode(accts, sums)
    expect(t.main).toBe('live')
    expect(t.live!.equity).toBeCloseTo(12480.2)
    expect(t.live!.today).toBeCloseTo(128.4)
    expect(t.live!.pct!.toFixed(2)).toBe('1.04')
    expect(t.paper!.equity).toBeCloseTo(9987.5)
    expect(t.paper!.today).toBeCloseTo(-12.5)
    expect(t.paper!.pct!.toFixed(3)).toBe('-0.125')
  })
  it('totalsByMode：shadow 账户两栏都不进（审稿 B-1）——live + shadow 不相加；只有 shadow 时不标实盘权益', () => {
    const SH = 'acct_shadow'
    const s = { ...sums, [SH]: { equity: 50000, available: null, dayStartEquity: 50000, dayPnl: null } }
    const t = totalsByMode([...accts, { accountId: SH, mode: 'shadow' }], s)
    expect(t.live!.equity).toBeCloseTo(12480.2)
    expect(t.live!.accounts).toBe(1)
    expect(t.paper!.equity).toBeCloseTo(9987.5)
    expect(t.main).toBe('live')
    const only = totalsByMode([{ accountId: SH, mode: 'shadow' }], s)
    expect(only).toEqual({ live: null, paper: null, main: null })
  })
  it('totalsByMode：只有纸面账户时 main = 纸面；一个账户都没有 = null；缺日初时用 dayPnl', () => {
    const paperOnly = totalsByMode(accts.filter((a) => a.accountId === ACCT_PAPER), sums)
    expect(paperOnly.main).toBe('paper')
    expect(paperOnly.live).toBeNull()
    expect(totalsByMode([], {}).main).toBeNull()
    const t = totalsByMode([{ accountId: ACCT_LIVE, mode: 'live' }], { [ACCT_LIVE]: { equity: 1000, available: null, dayStartEquity: null, dayPnl: 10 } })
    expect(t.live).toMatchObject({ equity: 1000, today: 10 })
    expect(t.live!.pct!.toFixed(4)).toBe('1.0101')
  })
})

describe('待批卡：最急 / 引信 / 队列', () => {
  it('soonest：取 expiresAt 最小、还没过期的待批；0 张返回 null', () => {
    expect(soonest(cards(), NOW)!.ticket).toBe('T-20261010-0008')
    expect(soonest([], NOW)).toBeNull()
    expect(soonest([card('a', NOW - 1), card('b', NOW + 5000)], NOW)!.proposalId).toBe('b')
  })
  it('fuseRatio：03:05 / 05:00 = 0.617；剩余超过 5 分钟满格；过期 = 0', () => {
    expect(fuseRatio({ expiresAt: NOW + 185_000 }, NOW)).toBeCloseTo(0.617, 3)
    expect(fuseRatio({ expiresAt: NOW + 9 * 60_000 }, NOW)).toBe(1)
    expect(fuseRatio({ expiresAt: NOW - 1 }, NOW)).toBe(0)
  })
  it('queueView：按 id 锚定，新提案追加不替换当前；> 3 行时「另 N 张」', () => {
    const list = [card('a', NOW + 1), card('b', NOW + 2), card('c', NOW + 3)]
    expect(queueView(list, 'b').current!.proposalId).toBe('b')
    expect(queueView(list, 'b').rows.map((x) => x.proposalId)).toEqual(['a', 'c'])
    // 更急的新提案到了：当前一张不换，新提案只进队列
    const withNew = [card('z', NOW), ...list]
    expect(queueView(withNew, 'b').current!.proposalId).toBe('b')
    expect(queueView(withNew, 'b').rows.map((x) => x.proposalId)).toEqual(['z', 'a', 'c'])
    expect(queueView(withNew, 'b').more).toBe(0)
    // 选中的不在了：退到第一张
    expect(queueView(list, 'gone').current!.proposalId).toBe('a')
    // 队列 4 张 > 3 行：前 2 行 + 「另 2 张」
    const five = [...withNew, card('y', NOW + 9)]
    const v = queueView(five, 'b')
    expect(v.rows.map((x) => x.proposalId)).toEqual(['z', 'a'])
    expect(v.more).toBe(2)
    expect(queueView([], null)).toEqual({ current: null, rows: [], more: 0 })
  })
  it('规则行显示：每行可见中点 ≤ 1（「 · 」写成「，」）', () => {
    expect(ruleLine('需人批准 · 上限 2,000 USDC · 实际 32,105 USDC')).toBe('需人批准，上限 2,000 USDC，实际 32,105 USDC')
  })
})

describe('风险卡 / 视图 / Agent 卡', () => {
  it('toneOf：0.84 中性、0.85 warn、1.0 down（数字与细条同源）', () => {
    expect([0.84, 0.85, 1.0].map(toneOf)).toEqual(['flat', 'warn', 'down'])
  })
  it('parseView：pending / keys / feed；缺省与未知返回 null（全量视图）', () => {
    expect(['pending', 'keys', 'feed'].map((v) => parseView({ view: v }))).toEqual(['pending', 'keys', 'feed'])
    expect(parseView({})).toBeNull()
    expect(parseView(undefined)).toBeNull()
    expect(parseView({ view: 'chart' })).toBeNull()
  })
  it('agoText：20 秒前 / 1 小时前 / 分钟 / 天；没有记录写字（不写 —）', () => {
    expect(agoText(NOW - 20_000, NOW)).toBe('20 秒前')
    expect(agoText(NOW - 3_600_000, NOW)).toBe('1 小时前')
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(agoText(NOW - 2 * 86_400_000, NOW)).toBe('2 天前')
    expect(agoText(null, NOW)).toBe('还没有活动')
  })
})
