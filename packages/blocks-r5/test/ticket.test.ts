// SPDX-License-Identifier: CPAL-1.0
// 下单票据：纯函数（名义 / 意图 / 摘要 / 比例）+ 提交路径（真 KernelClient + 假内核 + 真桥，清单权限照常校验）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostBridge, KernelClient, LinkHub, ATTESTATION_REQUIRED, type BlockBridge } from '@gitrader/blocks-sdk'
import { startFakeKernel, type FakeKernel } from '@gitrader/blocks-sdk/testing'
import { placeStop as placeOrder, cancelOrder, closePosition } from '../../blocks-default/src/actions'
import { chartPositionsManifest } from '../src/pages/chart'
import { cleanDec, sizeByPct, ticketIntent, ticketNotional, ticketSummary, type TicketForm } from '../src/model-chart'
import {
  afterInput, AVAILABLE_REFRESH_MS, confirmLocked, fillProgressOf, forAccount, inputSignature, liqEstimateLine, partialFillLine,
  previewEstimates, refreshWait, rejectionLine, rejectionOf, ticketStatus,
} from '../src/model-ticket'
import { fmtMoney } from '../src/model-records'
import { ACCT_LIVE, ACCT_PAPER, BTC, TICKET_PIN, designSet, installChartHandlers, type ChartLog, type ChartSet } from '../fixtures/chart'

const form = (over: Partial<TicketForm> = {}): TicketForm => ({ accountId: ACCT_LIVE, instrumentId: BTC, side: 'buy', type: 'limit', price: '64,800.0', size: '0.08', reduceOnly: false, ...over })

describe('下单票据 · 名义 = 价 × 量（十进制字符串，不经浮点）', () => {
  it('限价：64,800.0 × 0.08 = 5184.000（显示 5,184.00），与稿同数', () => {
    const n = ticketNotional(form())!
    expect(n).toEqual({ value: '5184.000', approx: false })
    expect(fmtMoney(n.value)).toBe('5,184.00')
  })
  it('浮点会错的组合照样精确：0.1 × 0.2 = 0.02，64210.5 × 0.07 = 4494.735', () => {
    expect(ticketNotional(form({ price: '0.1', size: '0.2' }))!.value).toBe('0.02')
    expect(ticketNotional(form({ price: '64210.5', size: '0.07' }))!.value).toBe('4494.735')
    expect(0.1 * 0.2).not.toBe(0.02)
  })
  it('市价没有输入价：用参考价估，标「约」；没有参考价就没有名义', () => {
    expect(ticketNotional(form({ type: 'market', price: '' }), '64812.0')).toEqual({ value: '5184.960', approx: true })
    expect(ticketNotional(form({ type: 'market', price: '' }), null)).toBeNull()
  })
  it('认不出的输入：空 / 字母 / 0 / 负数都不算数', () => {
    for (const bad of ['', 'abc', '0', '0.00', '-1', '1.2.3']) expect(cleanDec(bad)).toBeNull()
    expect(cleanDec(' 1,234.50 ')).toBe('1234.50')
    expect(ticketNotional(form({ size: '0' }))).toBeNull()
  })
  it('按可用额的比例换数量：可用 × 比例 ÷ 价，向下截 4 位；不足一个最小单位给 null', () => {
    expect(sizeByPct(8000, '64800', 25)).toBe('0.0308')
    expect(sizeByPct(8000, '64800', 100)).toBe('0.1234')
    expect(sizeByPct(0.001, '64800', 25)).toBeNull()
    expect(sizeByPct(null, '64800', 25)).toBeNull()
    expect(sizeByPct(8000, '', 25)).toBeNull()
  })
})

describe('下单票据 · 表单 → 内核意图', () => {
  it('限价：{accountId, instrumentId, side, type, size, price, reduceOnly}，价量都是十进制字符串', () => {
    expect(ticketIntent(form())).toEqual({ ok: true, intent: { accountId: ACCT_LIVE, instrumentId: BTC, side: 'buy', size: '0.08', reduceOnly: false, type: 'limit', price: '64800.0' } })
  })
  it('市价不带价；止损用 triggerPrice，只减仓照带', () => {
    expect(ticketIntent(form({ type: 'market' }))).toMatchObject({ ok: true, intent: { type: 'market' } })
    expect((ticketIntent(form({ type: 'market' })) as { intent: Record<string, unknown> }).intent.price).toBeUndefined()
    expect(ticketIntent(form({ type: 'stop_market', side: 'sell', reduceOnly: true, price: '63100' }))).toMatchObject({ ok: true, intent: { type: 'stop_market', triggerPrice: '63100', side: 'sell', reduceOnly: true } })
  })
  it('本地只挡不是数字 / ≤ 0 / 没选账户，不替内核判风控', () => {
    expect(ticketIntent(form({ size: 'x' }))).toEqual({ ok: false, message: '数量要是大于 0 的数字' })
    expect(ticketIntent(form({ price: '' }))).toEqual({ ok: false, message: '价格要是大于 0 的数字' })
    expect(ticketIntent(form({ type: 'stop_market', price: '' }))).toEqual({ ok: false, message: '触发价要是大于 0 的数字' })
    expect(ticketIntent(form({ accountId: '' }))).toEqual({ ok: false, message: '先选账户' })
    // 超限的单本地照样放行（单笔上限 8,000，这里 64,800 × 5 = 324,000）：拒不拒由内核说了算
    expect(ticketIntent(form({ size: '5' })).ok).toBe(true)
  })
  it('武装行后果文案：「买 0.08 BTC-PERP @ 64,800.0 · 名义 5,184.00」', () => {
    expect(ticketSummary(form())).toBe('买 0.08 BTC @ 64,800.0 · 名义 5,184.00')
    expect(ticketSummary(form({ type: 'market', price: '' }), '64812.0')).toBe('买 0.08 BTC @ 市价 · 名义 约 5,184.96')
    expect(ticketSummary(form(), null, 'BTC-PERP')).toBe('买 0.08 BTC-PERP @ 64,800.0 · 名义 5,184.00')
  })
})

describe('下单票据 · 拒绝 / 部分成交 / 强平价估算', () => {
  const sigOf = (over: Partial<TicketForm> = {}) => inputSignature(form(over))

  it('non-retryable rejection disables confirm until an input changes', () => {
    const sig = sigOf()
    const s = ticketStatus(rejectionOf({ message: '单笔上限 8,000，实际 324,000', problem: 'RULE_DENIED', retryable: false }), sig)
    expect(confirmLocked(s)).toBe(true)
    // 键上方那行：中文原因 + 括号里的内核原文（不改写）
    expect(rejectionLine(s)).toBe('风控规则拦下了这笔单（单笔上限 8,000，实际 324,000）')
    // 输入没变 → 锁着
    expect(confirmLocked(afterInput(s, sig))).toBe(true)
    expect(rejectionLine(afterInput(s, sig))).toBe(rejectionLine(s))
    // 数量 / 价格 / 方向 / 类型任一变了 → 解锁、原因行消失
    for (const over of [{ size: '0.09' }, { price: '64,100' }, { side: 'sell' as const }, { type: 'stop_market' as const }]) {
      const next = afterInput(s, sigOf(over))
      expect(confirmLocked(next), JSON.stringify(over)).toBe(false)
      expect(rejectionLine(next), JSON.stringify(over)).toBeNull()
    }
    // 规则命中用 humanizeRuleHit 那句；问题码表说不重试的也置灰
    expect(rejectionOf({ message: 'over limit', problem: 'RULE_DENIED', ruleHits: [{ code: 'ORDER_NOTIONAL', limit: '8000', actual: '324000', unit: 'USDC' }] })).toEqual({
      text: '单笔名义 324000 USDC 超过上限 8000 USDC（over limit）', retryable: false,
    })
    expect(confirmLocked(ticketStatus(rejectionOf({ message: 'venue said no', problem: 'VENUE_REJECTED' }), sig))).toBe(true)
    // 没有原文（成功 / 取消 / 空回包）没有拒绝
    expect(rejectionOf({ message: '  ' })).toBeNull()
    expect(rejectionOf(null)).toBeNull()
  })

  it('retryable rejection keeps confirm enabled', () => {
    const sig = sigOf()
    const s = ticketStatus(rejectionOf({ message: '行情太久没更新，这笔单被拦下', problem: 'STALE_PRICE', retryable: true }), sig)
    expect(confirmLocked(s)).toBe(false)
    expect(rejectionLine(s)).toContain('（行情太久没更新，这笔单被拦下）')
    // 回包没带 retryable 时按问题码表推：STALE_PRICE 可重试，RULE_DENIED 不可
    expect(confirmLocked(ticketStatus(rejectionOf({ message: 'stale', problem: 'STALE_PRICE' }), sig))).toBe(false)
    expect(confirmLocked(ticketStatus(rejectionOf({ message: 'denied', problem: 'RULE_DENIED' }), sig))).toBe(true)
  })

  it('partial fill line shows and hides', () => {
    const order = (over: Record<string, unknown> = {}) => ({ orderId: 'ord_new_1', size: '0.08', filledSize: '0', status: 'open', ...over })
    // 回执包一层 {order}，推送是裸的；两形状都认
    expect(partialFillLine(fillProgressOf({ order: order({ filledSize: '0.03', status: 'partially_filled' }) }))).toBe('部分成交 0.03 / 0.08')
    expect(partialFillLine(fillProgressOf(order({ filledSize: '0.03', status: 'partially_filled' })))).toBe('部分成交 0.03 / 0.08')
    expect(partialFillLine(fillProgressOf(order({ filledSize: '0.08', status: 'filled' })))).toBeNull()
    expect(partialFillLine(fillProgressOf(order({ filledSize: '0.03', status: 'cancelled' })))).toBeNull()
    expect(partialFillLine(fillProgressOf(order()))).toBeNull()
    expect(partialFillLine(null)).toBeNull()
    expect(fillProgressOf({ size: '0.08' })).toBeNull()
  })

  it('liquidation estimate is labelled', () => {
    const est = (v: Record<string, unknown>) => v as unknown as Parameters<typeof liqEstimateLine>[0]
    expect(liqEstimateLine(est({ liquidationPrice: '52100' }))).toBe('52,100.0（估算）')
    expect(liqEstimateLine(est({ liquidationPrice: null }))).toBeNull()
    expect(liqEstimateLine(est({ notional: '5184.96' }))).toBeNull()
    expect(liqEstimateLine(null)).toBeNull()
    expect(liqEstimateLine(previewEstimates({ precheck: { estimates: { liquidationPrice: '52100' } } }))).toBe('52,100.0（估算）')
    expect(previewEstimates({ estimates: { liquidationPrice: '4580.0' } })).toEqual({ liquidationPrice: '4580.0' })
    expect(liqEstimateLine(previewEstimates({ order: { orderId: 'ord_new_1' } }))).toBeNull()
  })

  it('可用额重查只认本账户推送，且节流 ≥ 1 秒', () => {
    expect(forAccount({ accountId: ACCT_LIVE, fillId: 'f1' }, ACCT_LIVE)).toBe(true)
    expect(forAccount({ accountId: ACCT_PAPER }, ACCT_LIVE)).toBe(false)
    expect(forAccount({ orderId: 'ord_1' }, ACCT_LIVE)).toBe(true)
    expect(refreshWait(0, 5_000)).toBe(0)
    expect(refreshWait(10_000, 10_200)).toBe(AVAILABLE_REFRESH_MS - 200)
    expect(refreshWait(10_000, 12_000)).toBe(0)
  })
})

describe('下单票据 · 提交路径', () => {
  let kernel: FakeKernel
  let client: KernelClient
  let set: ChartSet
  let log: ChartLog
  let bridge: BlockBridge
  const attestCalls: Array<{ action: string }> = []

  beforeEach(async () => {
    kernel = await startFakeKernel()
    set = designSet(Date.UTC(2026, 9, 23, 12, 0, 0))
    log = installChartHandlers(kernel, set)
    const r = await fetch(`${kernel.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: kernel.bootstrapToken }) })
    const tok = ((await r.json()) as { sessionToken: string }).sessionToken
    client = new KernelClient({ url: kernel.wsUrl, getToken: () => tok })
    await client.connect()
    attestCalls.length = 0
    // 与壳的 PIN 弹层同一入口：缺证明时内核回 ATTESTATION_REQUIRED，attestor 给 PIN，客户端带证明重发一次
    client.setAttestor(async (req) => { attestCalls.push({ action: req.action }); return { method: 'pin', pin: TICKET_PIN } }, { retry: true })
    const manifest = {
      schema: 'gitrader-block/1', id: 'block.gitrader.positions', name: 't', version: '0.1.0', vendor: { name: 'gitrader' }, license: 'CPAL-1.0', entry: { module: './i.js', element: 'g5-positions' },
      isolation: 'inline', size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 }, inputs: { events: chartPositionsManifest.events, queries: chartPositionsManifest.queries },
      permissions: chartPositionsManifest.permissions, actions: chartPositionsManifest.actions, linkGroups: chartPositionsManifest.linkGroups,
    } as const
    bridge = createHostBridge({ manifest: manifest as never, instanceId: 't1', kernel: client, hub: new LinkHub({ A: {} }), trusted: true, isUserActive: () => true })
  })
  afterEach(async () => { client.close(); await kernel.close() })

  const intent = (over: Partial<TicketForm> = {}) => (ticketIntent(form(over)) as { intent: Record<string, unknown> }).intent

  it('实盘账户：先回 ATTESTATION_REQUIRED，attestor 给 PIN 后带证明重发，命令成功（走 PIN 重试路径）', async () => {
    const r = await placeOrder(bridge, intent())
    expect(r.ok).toBe(true)
    expect(attestCalls).toEqual([{ action: 'order.place' }])
    expect(kernel.commands.map((c) => (c.attestation ? 'attested' : 'bare'))).toEqual(['bare', 'attested'])
    expect(log.placed).toHaveLength(1)
    expect(log.placed[0]).toMatchObject({ accountId: ACCT_LIVE, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.08', price: '64800.0' })
    // 订单进了挂单表
    expect((set.orders[ACCT_LIVE] ?? []).some((o) => o.price === '64800.0')).toBe(true)
  })

  it('PIN 弹层被取消 = 什么都没发生：返回 cancelled，不下单', async () => {
    client.setAttestor(async () => null, { retry: true })
    const r = await placeOrder(bridge, intent())
    expect(r).toMatchObject({ ok: false, cancelled: true })
    expect(log.placed).toHaveLength(0)
    expect(ATTESTATION_REQUIRED).toBe('ATTESTATION_REQUIRED')
  })

  it('纸面账户不要在场证明：一次命令就成', async () => {
    const r = await placeOrder(bridge, intent({ accountId: ACCT_PAPER }))
    expect(r.ok).toBe(true)
    expect(attestCalls).toEqual([])
    expect(kernel.commands.map((c) => (c.attestation ? 'attested' : 'bare'))).toEqual(['bare'])
  })

  it('风控拒绝：内核原文一字不改地回到界面（订单被拒是正常返回，不是抛错，不能当成功）', async () => {
    set.reject = '单笔上限 8,000，实际 324,000'
    const r = await placeOrder(bridge, intent({ size: '5' }))
    expect(r).toMatchObject({ ok: false, cancelled: false, message: '单笔上限 8,000，实际 324,000', problem: 'RULE_DENIED' })
  })

  it('撤单 / 平仓：同一条 PIN 路径，被拒时同样回原文', async () => {
    const c = await cancelOrder(bridge, ACCT_LIVE, 'ord_stop_btc')
    expect(c.ok).toBe(true)
    expect(log.cancelled).toEqual([{ accountId: ACCT_LIVE, orderId: 'ord_stop_btc' }])
    expect(attestCalls.map((x) => x.action)).toEqual(['order.cancel'])
    set.reject = 'Order could not immediately match against any resting orders.'
    const x = await closePosition(bridge, { accountId: ACCT_LIVE, instrumentId: BTC })
    expect(x).toMatchObject({ ok: false, message: 'Order could not immediately match against any resting orders.' })
    set.reject = '场所拒绝了撤单'
    const y = await cancelOrder(bridge, ACCT_LIVE, 'nope')
    expect(y).toMatchObject({ ok: false, message: '场所拒绝了撤单' })
  })

  it('清单没声明的命令桥直接拒（票据只能发 order.place / order.cancel / position.close）', async () => {
    await expect(bridge.command('proposal.approve', { id: 'x' })).rejects.toMatchObject({ code: 'ACTION_NOT_DECLARED' })
    await expect(bridge.command('order.cancel_all', {})).rejects.toMatchObject({ code: 'ACTION_NOT_DECLARED' })
  })
})
