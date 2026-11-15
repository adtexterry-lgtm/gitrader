// SPDX-License-Identifier: CPAL-1.0
// 账单.csv 的执行方 = 成交所属订单的下单主体（人=你，Agent=钥匙名，吊销的加「（已撤销）」），账户列=别名。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { mkOrigin } from '../src/util/origin'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const intent = (size: string): OrderIntent => ({ accountId: h.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: size as never, leverage: 2, reason: 'bill test' } as OrderIntent)
const bill = (name: string): string[] => {
  const dir = join(h.home, name)
  h.k.ledger.export({ dir, exportedBy: mkOrigin('user:usr_local', 'test.export', 'internal'), markdown: true })
  return readFileSync(join(dir, '账单.csv'), 'utf8').slice(1).trim().split('\n').slice(1)
}

describe('账单.csv 执行方与账户', () => {
  it('Agent 下单的成交 = 钥匙名；人下单的成交 = 你；账户列是别名而不是 acct_ 编号', async () => {
    const a = await makeAgent(h, 'paper')
    const byAgent = await h.k.trading.place({ intent: intent('0.003') }, a.ctx())
    h.clock.advance(6000) // 过冷却
    const byHuman = await h.k.trading.place({ intent: intent('0.004') }, h.human())
    expect(byAgent.order?.status).toBe('filled')
    expect(byHuman.order?.status).toBe('filled')
    const keyName = h.k.agents.getKey(a.keyId)!.name
    // 成交条目自己的 origin 是场所/系统时，执行方靠订单的下单主体查出来，这是本例要守的路径
    const fills = h.k.ledger.query({ types: ['fill'], limit: 10 })
    expect(fills.some((f) => !/^(user|agent):/.test(f.origin.actor))).toBe(true)
    const rows = bill('bill-actors')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(new RegExp(`,paper,.*,${keyName}$`))
    expect(rows[1]).toMatch(/,paper,.*,你$/)
    expect(rows.join('\n')).not.toContain('acct_')
  })

  it('钥匙被吊销后，历史成交的执行方加「（已撤销）」', async () => {
    const a = await makeAgent(h, 'paper')
    await h.k.trading.place({ intent: intent('0.003') }, a.ctx())
    h.k.agents.revokeKey(a.keyId, h.sessionProof(), h.human().origin)
    const keyName = h.k.agents.getKey(a.keyId)!.name
    expect(bill('bill-revoked')[0]).toMatch(new RegExp(`,paper,.*,${keyName}（已撤销）$`))
  })
})
