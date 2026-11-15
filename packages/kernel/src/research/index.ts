// SPDX-License-Identifier: CPAL-1.0
// MCP 工具 research 的内核实现（第六轮 C 包）：九个动作，全部只读——研究不开下单路径，不写交易类账本。
//   optimize / walk_forward / factor_report  → 起引擎里的异步作业（x-gitrader.research.run），回 { jobId, kind, state }
//   status / result / cancel                → 只凭 jobId 转给引擎（result 默认摘要，part = trials | folds | factors 分页）
//   backtest_report / portfolio / search    → 同步，在内核里算（只读、无策略代码）
// 策略代码只在引擎里跑：本目录不 import engine-core / optimizer / bots。
import { RESEARCH_PARTS, makeProblem } from '../proto'
import type { Kernel } from '../kernel'
import type { ActorCtx } from '../trading'
import { KernelError } from '../util/errors'
import { bad, needString } from './args'
import { callResearchEngine } from './engine-rpc'
import { portfolioOf } from './portfolio'
import { backtestReport } from './report'
import { searchInstruments } from './search'

export interface ResearchCtx {
  k: Kernel
  actor: ActorCtx
  /** 调用方能看的账户（Agent = 授权书覆盖的账户；人面 = 全部）。portfolio 只认这一份。 */
  accountIds: readonly string[]
  /** 会话标识（用于作业归属校验）。 */
  sessionKey: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function researchAction(c: ResearchCtx, action: string, args: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'optimize': case 'walk_forward': case 'factor_report': {
      if (!isObj(args.spec)) throw bad(`${action} needs spec (an object); see discover tool_help {"tool":"research"}`)
      const res = await callResearchEngine(c.k, 'x-gitrader.research.run', { kind: action, spec: args.spec })
      if (isObj(res) && typeof res.jobId === 'string') c.k.research.recordJob(res.jobId, c.sessionKey)
      return res
    }
    case 'status': case 'cancel': {
      const jobId = needString(args.jobId, 'jobId')
      c.k.research.assertJobOwner(jobId, c.sessionKey)
      return callResearchEngine(c.k, `x-gitrader.research.${action}`, { jobId })
    }
    case 'result': {
      const jobId = needString(args.jobId, 'jobId')
      c.k.research.assertJobOwner(jobId, c.sessionKey)
      const part = args.part
      if (part !== undefined && !(RESEARCH_PARTS as readonly unknown[]).includes(part)) throw bad(`part must be one of ${RESEARCH_PARTS.join(', ')}`)
      return callResearchEngine(c.k, 'x-gitrader.research.result', {
        jobId, ...(part !== undefined ? { part } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      })
    }
    case 'backtest_report': {
      const ready = c.k.gep.status().find((g) => g.state === 'ready')
      if (!ready) throw new KernelError(makeProblem('VENUE_UNAVAILABLE', 'no engine is connected (gitrader engines bind / check engines.list)'))
      return backtestReport(c.k, c.actor, ready.engineId, args)
    }
    case 'portfolio': {
      const given = typeof args.accountId === 'string' && args.accountId ? args.accountId : undefined
      if (given === undefined && c.accountIds.length === 0) throw bad('this key covers no account; pass accountId (see account list)')
      const acct = c.k.accounts.get(given ?? c.accountIds[0]!)
      if (!c.accountIds.includes(acct.accountId)) throw new KernelError(makeProblem('MANDATE_LIMIT', `account ${acct.alias} is not covered by this mandate`))
      return portfolioOf(c.k, acct.accountId)
    }
    case 'search': return searchInstruments(c.k, args)
  }
  throw bad(`unknown action ${action}`)
}
