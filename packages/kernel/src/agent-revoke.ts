// SPDX-License-Identifier: CPAL-1.0
// 吊销一把 Agent 钥匙的完整动作：作废其授权书下待批的提案，并统计该钥匙名下的持仓与挂单。
// 名下遗留只统计、不自动平仓、不自动撤单（持仓与挂单的处理留给人）。
import type { Kernel } from './kernel'
import type { HumanProof } from './auth'
import type { AgentKey, Origin, Proposal, ProposalDecision } from './proto'
import type { ActorCtx } from './trading'
import * as d from './util/dec'

export interface RevokeResult {
  key: AgentKey
  /** 被作废提案的票号。 */
  withdrawn: string[]
  openPositions: number
  openOrders: number
}

const WITHDRAW_NOTE = '钥匙已撤销，提案自动作废'

/** 吊销钥匙 → 作废该授权书下 pending 提案 → 报出该钥匙名下遗留的持仓 / 挂单数。 */
export function revokeAgentKeyFully(k: Kernel, keyId: string, proof: HumanProof, origin: Origin): RevokeResult {
  // 先记下 mandateId：revokeKey 会同时撤销授权书，返回的 key 里仍带着它。
  const mandateId = k.agents.getKey(keyId)?.mandateId
  const key = k.agents.revokeKey(keyId, proof, origin)
  const withdrawn: string[] = []
  if (mandateId !== undefined) {
    for (const p of k.trading.listProposals({ status: 'pending', mandateId, limit: 1000 })) {
      // 现有撤回路径只允许提出者撤回：以这把钥匙的身份（提案自己的 origin）发起，账本里仍归属该钥匙。
      const ctx: ActorCtx = { principal: { kind: 'agent', keyId, mandateId }, origin: p.origin }
      const w = k.trading.withdraw(p.ticket, ctx)
      const noted: Proposal = {
        ...w,
        decision: { by: (origin.actor.startsWith('user:') ? origin.actor : 'user:usr_local') as ProposalDecision['by'], at: k.clock.now(), note: WITHDRAW_NOTE },
      }
      k.docs.put('proposal', noted.proposalId, noted)
      withdrawn.push(p.ticket)
    }
  }
  // 归属判断沿用 other-owner reduction：持仓看订单 origin.actor；挂单另外认订单上的 mandateId。
  const actor = `agent:${keyId}`
  let openPositions = 0
  for (const account of k.accounts.list()) {
    const instruments = new Set(k.orders.list({ accountId: account.accountId, limit: 1000 }).map((o) => o.instrumentId))
    for (const instrumentId of instruments) {
      const owners = k.orders.positionOwners(account.accountId, instrumentId)
      if (owners.actors.includes(actor) && !d.isZero(d.D(owners.net))) openPositions++
    }
  }
  const openOrders = k.orders.list({ openOnly: true, limit: 1000 }).filter((o) => o.origin.actor === actor || o.mandateId === mandateId).length
  return { key, withdrawn, openPositions, openOrders }
}
