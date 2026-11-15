// SPDX-License-Identifier: CPAL-1.0
// K4（R3-04）：下单后、回执前被杀；Agent 用同一个 clientOrderId 重发 → 内核返回原订单，成交只有一笔。
import { afterEach, describe, expect, it } from 'vitest'
import { makeCrashHarness, settle, stopIntent } from './helpers/crash-points'
import type { CrashHarness } from './helpers/crash-points'

let h: CrashHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('K4 idempotency survives a crash', () => {
  it.each(Array.from({ length: 10 }, (_, i) => i))('same clientOrderId after crash+restart returns the original order, one fill (run %i)', async () => {
    h = await makeCrashHarness()
    const cloid = 'a4'.repeat(16)
    const intent = { ...stopIntent(h.paperAccountId()), clientOrderId: cloid } as never
    const crashed = h.arm('beforeRecordChildren')
    const first = settle(h.world.k.trading.place({ intent }, h.world.human))
    await crashed
    expect((await first).ok).toBe(false) // 调用方看到的是连接断开 / 结果未知
    const w = await h.restart()
    const lookedUp = await w.k.trading.lookup({ clientOrderId: cloid }, w.human)
    expect(lookedUp).toMatchObject({ found: true, order: { status: 'filled' } })
    const again = await w.k.trading.place({ intent }, w.human)
    expect(again.order?.orderId).toBe(lookedUp.order!.orderId)
    expect(w.k.orders.fills({ accountId: h.paperAccountId() }).filter((f) => f.clientOrderId === cloid)).toHaveLength(1)
    expect(w.paper.orders(h.paperAccountId()).filter((o) => o.role === 'parent')).toHaveLength(1)
  })
})
