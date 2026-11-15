// SPDX-License-Identifier: CPAL-1.0
// E（Agent 接口）的入口：在这里注册 Agent 面的 HTTP 路由与操作。B 只留这个钩子，内核启动时调用一次。
// 可用的服务都在 kernel 上：kernel.trading / kernel.takeover / kernel.agents / kernel.ledger / kernel.risk / kernel.bus ……
// Agent 主体（Bearer gtk_…）认证后得到 principal.kind === 'agent'；origin 由服务端盖章（actorType = llm-agent），不接受自报。
import type { Kernel } from '../kernel'
import { registerAgentOps } from './agent'
import { registerViewOps } from './views'
import type { OpRegistry, RouteRegistry } from './router'

export function registerApiRoutes(kernel: Kernel, ops: OpRegistry, _routes: RouteRegistry): void {
  // MCP 服务器用的操作：agent.<工具名>（17 个）+ agent.session。原始路由暂不需要。
  registerAgentOps(kernel, ops)
  registerViewOps(kernel, ops)
}
