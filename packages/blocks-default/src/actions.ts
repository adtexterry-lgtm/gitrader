// SPDX-License-Identifier: CPAL-1.0
// 块发出的人面命令。块只调 bridge.command：需要在场证明时，内核回 ATTESTATION_REQUIRED，壳的 KernelClient 自动弹 PIN 层并带证明重发一次，
// 块看到的只有最终结果；用户关掉 PIN 层 = 命令没发生（cancelled）。错误文案按问题码查中文表，内核原文留在 upstream 给「详情」展开。
import { BridgeError, KernelError, ATTESTATION_REQUIRED, CODE_TIMEOUT, isLongCommand, type BlockBridge } from '@gitrader/blocks-sdk'
// 只取文案表本身：协议根入口会连带初始化 Ajv（new Function），被工作台的 CSP 拒绝
import { humanizeProblem, PROBLEM_TEXT } from '../../protocol/src/model/problem-text'
import type { AgentPermissionTier, TakeoverLevel } from '@gitrader/protocol/types'
import { C, ORG_SCOPE } from './api'
import { LEVEL_OF_TIER, TIER_LABEL } from './labels'
import type { KeyTier } from './model-activity'
import { t, tk } from '@gitrader/workbench/i18n'

export type CmdResult<T = unknown> = { ok: true; value: T } | { ok: false; cancelled: boolean; message: string; problem?: string; /** 内核 / 场所原文，给「详情」展开；不改写。 */ upstream?: string }

/** 已经是中文的原文（如「PIN 不对」）照用；英文原文查中文表，原文留在 upstream。 */
const HAS_ZH = /[一-龥]/
/** 参数类错误没有更细的子码时，内核原文本身就是具体原因（如缺哪一项），照原样显示——通用中文句反而丢信息。 */
const zhOrHuman = (name: string, raw: string, retryAfterMs?: number): string => {
  if (HAS_ZH.test(raw)) return tk(raw)
  // 表里没有的码（插件 / 实验注册表等专用码）：原文本身就是具体原因，照原样显示，不换成笼统的「出错了」
  if (!PROBLEM_TEXT[name]) return raw
  const zh = tk(humanizeProblem({ name, message: raw, ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}) }, { surface: 'ui' }).zh)
  return name === 'INVALID_PARAMS' && zh === tk(PROBLEM_TEXT.INVALID_PARAMS?.zh ?? '') ? raw : zh
}

/**
 * 原本会静默失败的出口由调用方自己 toast.err(failureNotice(r))：中文说明 + 恢复步骤。
 * 不改写 runCommand 的 message（上游原文不改写），也不在这里弹 toast（避免与调用方自己的提示重复）。
 */
export function failureNotice(r: Extract<CmdResult, { ok: false }>): string {
  const message = r.problem?.startsWith('TRADING_STATE') ? t('当前交易状态不允许，先恢复交易') : r.message
  return t('{0}；先查看最新状态，确认结果后再重试', HAS_ZH.test(message) ? tk(message) : t('操作失败（{0}）', message))
}

/** 长命令超时后：各块（持仓 / 风险）监听这个 window 事件重读快照，不自动重发命令（修复轮 4 · C9）。 */
export const REFRESH_EVENT = 'gitrader:refresh'
export const TIMEOUT_NOTICE = t('还没收到内核回执，结果未知。正在核对持仓与对账')

export async function runCommand<T = unknown>(bridge: BlockBridge, action: string, params?: unknown): Promise<CmdResult<T>> {
  try {
    return { ok: true, value: await bridge.command<T>(action, params) }
  } catch (e) {
    if (e instanceof KernelError && e.code === CODE_TIMEOUT && isLongCommand(action)) {
      // 客户端自己的超时（不是上游报错）：说明结果未知并主动核对；原文留在 upstream。不重发。
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REFRESH_EVENT))
      return { ok: false, cancelled: false, message: TIMEOUT_NOTICE, problem: 'TIMEOUT', upstream: e.message }
    }
    if (e instanceof KernelError) {
      // 用户在 PIN 层点了取消：客户端把原来的 ATTESTATION_REQUIRED 再抛出来。
      if (e.problemName === ATTESTATION_REQUIRED && e.cancelled) return { ok: false, cancelled: true, message: t('已取消'), problem: e.problemName }
      const wait = (e.problem as { retryAfterMs?: unknown } | undefined)?.retryAfterMs
      const retryAfterMs = typeof wait === 'number' ? wait : undefined
      return {
        ok: false, cancelled: false,
        message: zhOrHuman(e.problemName ?? 'INTERNAL', e.message, retryAfterMs),
        ...(e.problemName ? { problem: e.problemName } : {}),
        upstream: e.message,
      }
    }
    if (e instanceof BridgeError) return { ok: false, cancelled: false, message: zhOrHuman(e.code, e.message), problem: e.code, upstream: e.message }
    const code = (e as { code?: unknown }).code
    const raw = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
    return {
      ok: false, cancelled: false,
      message: zhOrHuman(typeof code === 'string' ? code : 'INTERNAL', raw),
      ...(typeof code === 'string' ? { problem: code } : {}),
      upstream: raw,
    }
  }
}

export const approveProposal = (b: BlockBridge, proposalId: string) => runCommand(b, C.approve, { id: proposalId })
export const rejectProposal = (b: BlockBridge, proposalId: string) => runCommand(b, C.reject, { id: proposalId })

export const takeover = (b: BlockBridge, level: TakeoverLevel) =>
  runCommand(b, C.takeover(level), { reason: t('人在检阅面触发'), scope: ORG_SCOPE })

export type ResumeScope = { type: 'org' } | { type: 'account' | 'mandate' | 'group' | 'instrument'; id: string }

/** 恢复交易：只有人，要在场证明；scope 缺省 = 全局。 */
export const resumeTrading = (b: BlockBridge, scope: ResumeScope = ORG_SCOPE) => runCommand(b, C.resume, { scope, reason: t('人在检阅面恢复') })

/** 大模型实盘开仓保护：deny=true 打开（收紧，会话即可）；deny=false 关闭（放宽，要 PIN）。 */
export const setLlmLiveGuard = (b: BlockBridge, deny: boolean) => runCommand(b, C.llmLive, { deny })

export const reconnectVenue = (b: BlockBridge, venue: string) => runCommand(b, C.reconnect, { venue })

/** 改一把钥匙的档位 = 用新级别重签它的授权书（人面动作，要 PIN）。额度与白名单沿用原授权书；内核按级别校验必填项并原样回错。 */
export function setKeyTier(b: BlockBridge, key: KeyTier, tier: AgentPermissionTier): Promise<CmdResult> {
  const m = key.mandate
  if (!m) return Promise.resolve({ ok: false, cancelled: false, message: t('找不到「{0}」的授权，无法改成{1}', key.name, TIER_LABEL[tier]) })
  const input = {
    subject: m.subject, level: LEVEL_OF_TIER[tier], accounts: m.accounts, venueAllowlist: m.venueAllowlist, instrumentAllowlist: m.instrumentAllowlist,
    limits: m.limits, notAfter: m.notAfter, heartbeat: m.heartbeat, approval: m.approval, denyLlmLiveEntries: m.denyLlmLiveEntries,
  }
  return runCommand(b, C.mandateUpdate, { mandateId: m.mandateId, input })
}

/**
 * 下单类结果：内核 order.place / position.close 回 PlaceResult（{order?, proposal?, problem?}），被风控拒或场所拒是正常返回、不是抛错（G3：不以没抛错当成功）。
 * 有 problem 或订单状态是 denied / rejected → 失败，消息用内核原文。
 */
function placed(r: CmdResult): CmdResult {
  if (!r.ok || typeof r.value !== 'object' || r.value === null) return r
  const v = r.value as { order?: { status?: string; problem?: { message?: string } }; problem?: { message?: string; name?: string } }
  const p = v.problem ?? (v.order && (v.order.status === 'denied' || v.order.status === 'rejected') ? v.order.problem ?? { message: v.order.status } : undefined)
  const name = (p as { name?: string } | undefined)?.name
  return p ? { ok: false, cancelled: false, message: String(p.message ?? ''), upstream: String(p.message ?? ''), ...(name ? { problem: name } : {}) } : r
}

/**
 * 平仓（size 缺省 = 全部；给了就是部分平仓，内核取 min(size, 持仓)）。市价平仓单只有「全部成交」才算成功（返工 B-2）：
 * 内核可能回 partially_filled / cancelled / expired / submitted（结果未知），都按失败报——消息用内核原文（order.problem），没有原文时给状态与成交量原值。
 */
export async function closePosition(b: BlockBridge, args: { accountId: string; instrumentId: string; size?: string }): Promise<CmdResult> {
  const r = placed(await runCommand(b, C.closePosition, { ...args, reason: t('人在持仓卡平仓') }))
  if (!r.ok || typeof r.value !== 'object' || r.value === null) return r
  const o = (r.value as { order?: { status?: string; size?: string; filledSize?: string; problem?: { message?: string; name?: string } } }).order
  if (!o || o.status === 'filled' || (o.filledSize !== undefined && o.size !== undefined && Number(o.filledSize) >= Number(o.size))) return r
  return { ok: false, cancelled: false, message: o.problem?.message ?? `${String(o.status)} ${String(o.filledSize ?? '0')}/${String(o.size ?? '')}`, ...(o.problem?.name ? { problem: o.problem.name } : {}) }
}

/** 挂止损单（stopIntent 生成的 stop_market + reduceOnly + triggerPrice）。 */
export const placeStop = async (b: BlockBridge, intent: Record<string, unknown>) => placed(await runCommand(b, C.place, { intent }))

/** 撤单：内核回 {ok, problem?}，ok=false 也是失败。 */
export async function cancelOrder(b: BlockBridge, accountId: string, orderId: string): Promise<CmdResult> {
  const r = await runCommand<{ ok?: boolean; problem?: { message?: string } }>(b, C.cancel, { accountId, orderId })
  if (r.ok && r.value && r.value.ok === false) return { ok: false, cancelled: false, message: String(r.value.problem?.message ?? 'ok: false') }
  return r
}
