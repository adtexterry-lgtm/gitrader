// SPDX-License-Identifier: CPAL-1.0
// r7 WP-K：GQ-51 拒单通知去重（账本条目 + 总线事件归一）、GQ-52 幂等键（重试用同一个键，不同通知不同键）。
// 用假插件宿主直接驱动 NotifyOutlet（同 r6f-notify-queues 的做法），事件走真实的路由 / 模板 / 出口去重。
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/events'
import { NotifyOutlet } from '../src/notify/outlet'
import type { PluginHost } from '../src/plugins'
import type { NotifyConfig } from '../src/config'

interface Call { key: string; topic: string; params: Record<string, unknown> }
const outlets: NotifyOutlet[] = []
afterEach(() => { for (const o of outlets.splice(0)) o.stop() })

function world(result: (call: number) => unknown = () => ({ ok: true })) {
  const calls: Call[] = []
  const events = new EventBus(Date.now, () => {})
  const host = {
    get: () => ({}),
    callTool: async (_plugin: string, _tool: string, args: { notice: { key: string; topic: string }; params: Record<string, unknown> }): Promise<unknown> => {
      calls.push({ key: args.notice.key, topic: args.notice.topic, params: args.params })
      return result(calls.length)
    },
  } as unknown as PluginHost
  const config: NotifyConfig = { channels: [{ id: 'A', plugin: 'pA', minLevel: 'info', params: { url: 'https://example.invalid/hook' } }], rateLimit: { perChannelPerMinute: 100, dedupeWindowSec: 300 } }
  const outlet = new NotifyOutlet({ events, plugins: host, config: () => config, now: Date.now, log: () => {} })
  outlets.push(outlet)
  return { events, calls }
}
const until = async (check: () => boolean, ms = 3000): Promise<void> => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10)) }
const settle = (ms = 150): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 与 trading.ts 一致的两种来源：总线事件 risk.denials、账本条目 risk.denied（subject 带账户 / 预检 / 订单）。 */
const bus = (precheckId: string | undefined, orderId?: string) => ({ accountId: 'acct_k', ...(precheckId ? { precheckId } : {}), ...(orderId ? { orderId } : {}), ruleHits: [{ ruleId: 'size', actual: '12.50', limit: '10.00' }], ts: 1 })
const ledger = (precheckId: string, orderId?: string) => ({ type: 'risk.denied', subject: { accountId: 'acct_k', precheckId, ...(orderId ? { orderId } : {}) }, precheck: { precheckId, verdict: 'deny' }, ruleHits: [{ ruleId: 'size', actual: '12.50', limit: '10.00' }], payload: {} })

describe('GQ-51 一次拒单只发一条通知', () => {
  it('预检路径：账本 risk.denied + 总线 risk.denials 同一 precheckId → 1 条', async () => {
    const { events, calls } = world()
    events.publish('ledger.entry', ledger('pc_1'))
    events.publish('risk.denials', bus('pc_1'))
    await until(() => calls.length >= 1)
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('下单路径：总线事件只带 orderId、账本条目带 orderId + precheckId → 仍是 1 条', async () => {
    const { events, calls } = world()
    events.publish('ledger.entry', ledger('pc_9', 'ord_9'))
    events.publish('risk.denials', bus(undefined, 'ord_9'))
    await until(() => calls.length >= 1)
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('反例：不同 precheckId / 不同订单的拒单各发一条（不会被误合并）', async () => {
    const { events, calls } = world()
    events.publish('ledger.entry', ledger('pc_1'))
    events.publish('risk.denials', bus('pc_1'))
    events.publish('ledger.entry', ledger('pc_2'))
    events.publish('risk.denials', bus('pc_2'))
    events.publish('ledger.entry', ledger('pc_3', 'ord_3'))
    events.publish('risk.denials', bus(undefined, 'ord_4'))
    await until(() => calls.length >= 4)
    await settle()
    expect(calls).toHaveLength(4)
  })

  it('反例：保护器触发（无 precheckId / orderId）的 risk.denials 不受影响，照旧按内容发', async () => {
    const { events, calls } = world()
    events.publish('risk.denials', { accountId: 'acct_k', hit: { ruleId: 'p#loss', code: 'PROTECTOR' } })
    await until(() => calls.length >= 1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.topic).toBe('risk.denials')
  })
})

describe('GQ-52 幂等键', () => {
  it('可重试失败：内核最多调 2 次，两次同一个 params.idempotencyKey，且保留原 params', async () => {
    const { events, calls } = world(() => ({ ok: false, reason: 'http_503', retryable: true }))
    events.publish('takeover.alert', { takeoverId: 'tk_1', phase: 'failed', accountId: 'acct_k' })
    await until(() => calls.length >= 2, 4000)
    await settle(500)
    expect(calls).toHaveLength(2)
    const k = calls[0]!.params.idempotencyKey
    expect(typeof k).toBe('string')
    expect(k).toBe(calls[1]!.params.idempotencyKey)
    expect(calls[0]!.params.url).toBe('https://example.invalid/hook')
  })

  it('反例：插件标了 exhausted（自己已重试到头）只调 1 次；不同通知的键不同', async () => {
    const { events, calls } = world(() => ({ ok: false, reason: 'http_503', retryable: true, exhausted: true }))
    events.publish('takeover.alert', { takeoverId: 'tk_1', phase: 'failed', accountId: 'acct_k' })
    events.publish('takeover.alert', { takeoverId: 'tk_2', phase: 'failed', accountId: 'acct_k' })
    await until(() => calls.length >= 2)
    await settle(500)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.idempotencyKey).not.toBe(calls[1]!.params.idempotencyKey)
  })
})
