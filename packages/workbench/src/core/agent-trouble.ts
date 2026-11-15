// SPDX-License-Identifier: CPAL-1.0
// 跨包契约 K5（ux-fix2）：内核在 status / 健康快照里给 agentTrouble = { key, count, lastError, at } | null
// （某把 Agent 钥匙 5 分钟内连续失败 ≥3 次；成功一次清零）。工作台只读不判：为空不显示，不为空出一条横幅层级的提示，不弹模态。
import { t } from '../ui/lib/i18n.js'

export interface AgentTroubleInfo { key: string; count: number; lastError: string; at: number }

/** status 回包 → AgentTroubleInfo | null。字段缺失 / 形状不对一律当没有（老内核没有这个字段）。 */
export function agentTroubleOf(status: unknown): AgentTroubleInfo | null {
  const v = (status as { agentTrouble?: unknown } | null | undefined)?.agentTrouble ?? null
  if (!v || typeof v !== 'object') return null
  const { key, count, lastError, at } = v as Record<string, unknown>
  if (typeof key !== 'string' || !key || typeof count !== 'number' || !(count > 0)) return null
  return { key, count, lastError: typeof lastError === 'string' ? lastError : '', at: typeof at === 'number' ? at : 0 }
}

/** 内核的 lastError 是固定句式「工具.动作 原因」（中文原因）；英文界面只换原因，工具名照原样。 */
const REASONS = ['参数不对', '当前不支持这个动作', '内核处理出错', '调用失败']
const reason = (s: string) => s.replace(new RegExp(`(${REASONS.join('|')})$`), (m) => t(m))

/** 横幅文案：「<钥匙名> 连续 N 次调用没成功：<lastError>。可以在它的会话里让它重新读 gitrader 技能，或叫它先停下。」 */
export function agentTroubleText(x: AgentTroubleInfo): string {
  return x.lastError
    ? t('{0} 连续 {1} 次调用没成功：{2}。可以在它的会话里让它重新读 gitrader 技能，或叫它先停下。', x.key, x.count, reason(x.lastError))
    : t('{0} 连续 {1} 次调用没成功。可以在它的会话里让它重新读 gitrader 技能，或叫它先停下。', x.key, x.count)
}
