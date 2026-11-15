// SPDX-License-Identifier: CPAL-1.0
// K5：按 Agent 钥匙数“连续失败的调用”（只在内存里，不写账本、不动 schema）。成功一次清零。
// 5 分钟内连续失败 ≥3 次才算“卡住”，健康 / 状态快照里给出 agentTrouble，供工作台提示用户。

export interface AgentTroubleInfo { key: string; count: number; lastError: string; at: number }

const WINDOW_MS = 5 * 60_000
const THRESHOLD = 3
/** 只有 Agent 自己写错的才计数；风控 / 级别 / 审批 / 场所类拒绝是正常流程，不算它“卡住”。 */
const AGENT_FAULT = new Set(['INVALID_PARAMS', 'CAPABILITY_UNSUPPORTED', 'INTERNAL', 'INTERNAL_ERROR'])
const REASON: Record<string, string> = { INVALID_PARAMS: '参数不对', CAPABILITY_UNSUPPORTED: '当前不支持这个动作', INTERNAL: '内核处理出错', INTERNAL_ERROR: '内核处理出错' }

export class AgentTrouble {
  private readonly m = new Map<string, { at: number[]; lastError: string }>()
  constructor(private readonly now: () => number) {}

  /** 记一次失败。lastError 是固定句式（工具.动作 + 原因），不含令牌也不含参数原文。 */
  fail(keyId: string, problemName: string, tool: string, action: string): void {
    if (!keyId || !AGENT_FAULT.has(problemName)) return
    const t = this.now()
    const e = this.m.get(keyId) ?? { at: [], lastError: '' }
    e.at = [...e.at.filter((x) => t - x <= WINDOW_MS), t]
    e.lastError = `${tool}.${action} ${REASON[problemName] ?? '调用失败'}`
    this.m.set(keyId, e)
  }

  ok(keyId: string): void { this.m.delete(keyId) }

  /** 失败次数最多（同数取最近）的一把钥匙；没有达到阈值返回 null。nameOf 把 keyId 换成钥匙名。 */
  worst(nameOf: (keyId: string) => string): AgentTroubleInfo | null {
    const t = this.now()
    let best: AgentTroubleInfo | null = null
    for (const [id, e] of this.m) {
      const live = e.at.filter((x) => t - x <= WINDOW_MS)
      if (live.length < THRESHOLD) continue
      const cand = { key: nameOf(id), count: live.length, lastError: e.lastError, at: live[live.length - 1]! }
      if (!best || cand.count > best.count || (cand.count === best.count && cand.at > best.at)) best = cand
    }
    return best
  }
}
