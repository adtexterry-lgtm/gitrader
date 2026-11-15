// SPDX-License-Identifier: Apache-2.0
// 模式 A 必测（声明 execution.modeA）：A1–A3。模式 B 必测 B1–B5 见 mode-b.ts。
import { expect } from 'vitest'
import { sleep } from '../session'
import { boot, feed, intentOf, placeCalls, provokesOrders, type Case } from './common'

function hasKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKey(x, key))
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => k === key || hasKey(x, key))
  return false
}

export const MODE_A_CASES: Case[] = [
  {
    id: 'A1', title: '拒单不绕过：收到 2001 后，窗口内同向同标的小单合计不超过被拒原单的单笔上限',
    requires: ['execution.modeA'],
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      t.host.calls.length = 0
      t.host.orders.clear()
      t.host.denyAboveNotional = 1
      await feed(t, s, 4, { seed: 20, settle: false })
      await s.waitFor(() => t.host.placed.some((p) => p.result.problem?.code === 2001), 2000)
      const denied = t.host.placed.find((p) => p.result.problem?.code === 2001)
      if (!denied) return skip('the injected risk denial was never exercised')
      const limit = Number(denied.result.problem!.ruleHits![0]!.limit)
      const side = intentOf(denied).side
      const instrument = intentOf(denied).instrumentId
      const startIdx = t.host.placed.indexOf(denied)
      const deadline = Date.now() + t.timing.splitWatchMs
      while (Date.now() < deadline) {
        await feed(t, s, 10, { seed: 21 + Math.floor(Math.random() * 1000), settle: false })
        await sleep(Math.min(400, t.timing.splitWatchMs / 4))
        if (Date.now() + 100 >= deadline) break
      }
      const after = t.host.placed.slice(startIdx + 1).filter((p) => intentOf(p).side === side && intentOf(p).instrumentId === instrument)
      const total = after.reduce((sum, p) => sum + Number(intentOf(p).size ?? 0) * t.host.lastPrice, 0)
      expect(total, `same-direction orders after the denial add up to ${total}, limit is ${limit}`).toBeLessThanOrEqual(limit)
      s.close()
    },
  },
  {
    id: 'A2', title: '不自设 builder：引擎提交的意图里不出现 builder 字段',
    requires: ['execution.modeA'],
    async run(t, skip) {
      const { s, instanceId } = await boot(t)
      if (!instanceId) skip('engine has no strategy to drive')
      if (!(await provokesOrders(t, s))) skip('engine placed no order on the synthetic feed')
      for (const c of placeCalls(t)) {
        expect(hasKey(c.params, 'builder'), 'orders must not carry a builder field').toBe(false)
        expect(hasKey(c.params, 'builderFee')).toBe(false)
      }
      s.close()
    },
  },
  {
    id: 'A3', title: '只用工作台连接：假场所只从宿主收到订单',
    requires: ['execution.modeA'],
    async run(_t, skip) {
      skip('direct-connection attempts cannot be detected from outside the process; recorded as "not tested" per contract A3')
    },
  },
]
