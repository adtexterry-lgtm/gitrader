// SPDX-License-Identifier: CPAL-1.0
// 人面入口（CLI `gitrader research …` 走它）：与 MCP 的 agent.research 同一份实现，主体是本机会话 / service 令牌，账户范围 = 全部账户。
import type { Kernel } from '../kernel'
import type { OpRegistry } from '../api/router'
import { researchAction } from './index'

export function registerResearchOps(k: Kernel, ops: OpRegistry): void {
  ops.register('research.call', { auth: 'human', kind: 'command' }, (ctx, params) => {
    const { action, ...args } = params
    const sessionKey = k.auth.operationRateKey(ctx.principal) ?? 'human'
    return researchAction({ k, actor: ctx.actor, accountIds: k.accounts.list().map((a) => a.accountId), sessionKey }, typeof action === 'string' ? action : '', args)
  })
}
