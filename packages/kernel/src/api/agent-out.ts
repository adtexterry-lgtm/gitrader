// SPDX-License-Identifier: CPAL-1.0
// Agent 面出参的人话补充（GQ-44）：只加 zh / note / warnings 字段，不改任何放行 / 拒绝判定，英文原文（ruleHits[].message、venue.message）原样保留。
import { humanizeRuleHit } from '../proto'

type Hit = { code: string; [k: string]: unknown }

/** 给 Agent 的改法提示（只加文字，不参与任何判定）：拒单后一眼知道下一次该怎么写。 */
export function hintOf(h: Hit): string | undefined {
  const ruleId = String(h.ruleId ?? '')
  switch (h.code) {
    case 'TPSL_INVALID':
      return ruleId.endsWith('tpsl:grouping')
        ? 'tpsl.grouping 只能写 "order"（随单挂止损止盈）。例："tpsl":{"grouping":"order","stopLoss":{"triggerPrice":"<买单取参考价下方约 1%，卖单取上方>"}}'
        : '买单：止损价低于参考价、止盈价高于参考价；卖单相反。价格要是正的十进制字符串。重新看价（market quote）再算。'
    case 'SIZE_PRECISION':
      // 内核已按步长取整（action 'limit'）：没有需要 Agent 再做的事，不给「改法」。
      if (h.action === 'limit') return undefined
      return `size 必须是该标的最小步长的整数倍${h.limit !== undefined ? `，合法值例如 ${String(h.limit)}` : ''}。更省事：不给 size，只给 notional（名义金额）并加 "rounding":"passive"，由内核取整；下单前可用 market search 查标的规格。`
    case 'NEEDS_APPROVAL':
      return '这不是参数错：这把钥匙每单都要人批准。改用 propose（order）提交提案并写清 reason，然后让用户在待批里点批准；不要重复直接下单。'
    case 'STOP_REQUIRED':
      return '开仓必须随单带止损：加 "tpsl":{"grouping":"order","stopLoss":{"triggerPrice":"<参考价下方约 1%>"}}。'
    default:
      return undefined
  }
}
const MONEY_UNITS = new Set(['USDC', 'USDT', 'USD', 'USDE', 'DAI'])
const money2 = (v: unknown): unknown => (typeof v === 'string' && /^-?\d+\.\d{3,}$/.test(v) ? (Math.round(Number(v) * 100) / 100).toFixed(2) : v)
/** 仅用于生成 zh 文案：计价币种的金额保留 2 位小数；ruleHits 里的原值（limit / actual）一字不动。 */
const zhText = (h: Hit): string => humanizeRuleHit((MONEY_UNITS.has(String(h.unit)) ? { ...h, limit: money2(h.limit), actual: money2(h.actual) } : h) as never)
export const zhHits = (hits: readonly Hit[] = []): Array<Hit & { zh: string; hint?: string }> => hits.map((h) => {
  const hint = hintOf(h)
  return { ...h, zh: zhText(h), ...(hint ? { hint } : {}) }
})
export const zhNote = (hits: readonly Hit[] = []): string | undefined => hits.length ? [...new Set(hits.map(zhText))].join('；') : undefined
/** 开仓意图没带止损：只提示，不影响判定。 */
export const stopAdvice = (intents: readonly any[]): string[] => // eslint-disable-line @typescript-eslint/no-explicit-any
  intents.some((i) => i && !i.reduceOnly && !i.tpsl?.stopLoss)
    ? ['这张单没带止损（tpsl.stopLoss）。开仓请随单一起提交止损，成交后不要单独补挂；风控策略要求止损时没带会被直接拒绝。'] : []

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) // eslint-disable-line @typescript-eslint/no-explicit-any

/** 成功返回里：precheck / 顶层 / problem 里的 ruleHits 加 zh，顶层加 note；无止损加 warnings（与已有合并）。 */
export function decorateOut(data: unknown, intents: readonly unknown[]): unknown {
  if (!isObj(data)) return data
  const out: Record<string, any> = { ...data } // eslint-disable-line @typescript-eslint/no-explicit-any
  let hits: Hit[] = []
  if (isObj(out.precheck) && Array.isArray(out.precheck.ruleHits) && out.precheck.ruleHits.length) { hits = out.precheck.ruleHits; out.precheck = { ...out.precheck, ruleHits: zhHits(hits) } }
  if (Array.isArray(out.ruleHits) && out.ruleHits.length) { hits = hits.length ? hits : out.ruleHits; out.ruleHits = zhHits(out.ruleHits) }
  if (isObj(out.problem) && Array.isArray(out.problem.ruleHits) && out.problem.ruleHits.length) { hits = hits.length ? hits : out.problem.ruleHits; out.problem = { ...out.problem, ruleHits: zhHits(out.problem.ruleHits) } }
  const note = zhNote(hits)
  if (note) out.note = note
  const adv = stopAdvice(intents)
  if (adv.length) out.warnings = [...(Array.isArray(out.warnings) ? out.warnings : []), ...adv]
  return out
}
