// SPDX-License-Identifier: CPAL-1.0
// Agent 活动与待批块的纯逻辑：账本条目 → 事件流条目（谁 · 做了什么 · 为什么 · 结果 · 撞了哪条规则）、提案 → 待批卡片、钥匙与授权书 → 档位。
import type { AgentKey, AgentPermissionTier, LedgerEntry, Mandate, Origin, RuleHit } from '@gitrader/protocol/types'
import { matchesActorFilter, originActorType, type ActorFilterId } from '@gitrader/workbench'
// 只取文案表本身：协议根入口会连带初始化 Ajv（new Function），被工作台的 CSP 拒绝
import { humanizeRuleHit } from '../../protocol/src/model/problem-text'
import { approvalRule } from './display'
import { CONTROL_LABEL, RULE_LABEL, TIER_OF_LEVEL } from './labels'
import { arr, fmtLoose, isRec, listOf, str, symbolOf, toNum, type Rec } from './util'
import { t, tk } from '@gitrader/workbench/i18n'

export { matchesActorFilter }
export const originActorTypeOf = originActorType
export type { ActorFilterId }

// ---- 事件流 ---------------------------------------------------------------------------

/** 事件流里要的账本类型（其余如快照、会话、对账是噪音）。查询时也按这个清单过滤。 */
export const ACTIVITY_TYPES = [
  'order.intent', 'order.accepted', 'order.amended', 'risk.denied', 'order.rejected', 'order.cancelled', 'fill',
  'proposal.created', 'proposal.decided', 'proposal.executed', 'proposal.failed', 'proposal.expired', 'proposal.withdrawn',
  'takeover.requested', 'takeover.applied', 'takeover.completed', 'takeover.failed', 'mandate.downgraded', 'mandate.issued', 'mandate.changed', 'mandate.revoked',
  'protector.triggered', 'trading_state.changed', 'policy.relaxed', 'policy.reverted', 'note', 'annotation',
] as const satisfies readonly LedgerEntry['type'][]
const ACTIVITY_SET: ReadonlySet<string> = new Set(ACTIVITY_TYPES)

export type ResultTone = 'ok' | 'warn' | 'err' | 'flat'
export interface ActivityItem {
  instrumentId?: string
  id: string
  seq: number
  ts: number
  origin: Origin
  type: LedgerEntry['type']
  /** 做了什么（一句）。 */
  what: string
  why?: string
  result?: { label: string; tone: ResultTone }
  /** 撞了哪条规则（结构化字段拼出来的文案，上游原文另放 upstream）。 */
  rules: string[]
  /** 中性提示（如精度取整），不是拦截，界面用小字渲染。 */
  notes?: string[]
  /** 提案票号 / 接管编号：settleProposals、foldTakeovers 按它们归并同一件事的多行。 */
  ticket?: string
  takeoverId?: string
  /** 场所 / 内核给的原文，不改写。 */
  upstream?: string
}

/** 内部字面量或需要换算的单位：这些单位走中文映射表（否则界面上会露出 `violations`、原始毫秒）。 */
const HUMANIZE_UNITS: ReadonlySet<string> = new Set(['violations', 'ms', 'bp', 'ratio', 'x', 's', '%'])
/** 不该出现在界面上的内部字面量。 */
const INTERNAL_TOKENS = /violations|expected=|actual=/

const sideWord = (s: unknown) => (s === 'buy' ? t('买入') : s === 'sell' ? t('卖出') : '')
const stateWord: Record<string, string> = { ACTIVE: t('正常交易'), REDUCING: t('只减仓'), HALTED: t('已停止') }
const takeoverWord: Record<string, string> = { halt_new: t('停止新开仓'), cancel_all: t('撤销挂单'), flatten_all: t('全部平仓') }

/** 一条规则命中的中文描述。
 *  message 本身是中文（内核已经把话写好）时用 `; expected=` 之前的部分；单位是内部字面量（`violations`）或原始时长（`ms`）时
 *  查中文映射表；其余仍是 RULE_LABEL 的紧凑行（「规则名 · 上限 X · 实际 Y」）。任何路径都不会把内部字面量写到界面上。 */
export function ruleText(h: RuleHit): string {
  if (h.code.startsWith('TRADING_STATE')) return t('当前交易状态不允许，先恢复交易')
  const message = typeof h.message === 'string' ? h.message : ''
  const cut = (s: string, mark: string): string => s.split(mark)[0] ?? s
  const zh = cut(cut(message, '; expected='), '; actual=').trim()
  if (/^[一-龥]/.test(zh) && !INTERNAL_TOKENS.test(zh)) return tk(zh)
  const hit = { code: h.code, ruleId: h.ruleId, limit: h.limit, actual: h.actual, unit: h.unit }
  if (h.ruleId?.endsWith('#duplicateIntent')) return tk(humanizeRuleHit(hit)) // fix-r4 C13：重复意图不说「冷却还需 N 秒」
  if (HUMANIZE_UNITS.has(h.unit) || INTERNAL_TOKENS.test(zh)) return tk(humanizeRuleHit(hit))
  const unit = h.unit && h.unit !== 'entries' ? ` ${h.unit}` : ''
  const label = RULE_LABEL[h.code] ?? h.code
  const line = t('{0} · 上限 {1}{2} · 实际 {3}{4}', label, fmtLoose(h.limit), unit, MONEY_UNITS.has(h.unit) ? fmtMoney2(h.actual) : fmtLoose(h.actual), unit)
  return INTERNAL_TOKENS.test(line) ? tk(humanizeRuleHit(hit)) : line
}

/** UX-20 显示层：按名义额下单时取整前的数量是长尾小数（0.001610656100762645）；只多留取整后精度 3 位，截掉的部分用 ≈ 标出。 */
export function trimFrom(from: string, to: string): string {
  const keep = (to.split('.')[1]?.length ?? 0) + 3
  const [int, dec = ''] = from.split('.')
  return dec.length > keep ? `≈${int}.${dec.slice(0, keep)}` : from
}

/**
 * 命中分流（C13）：limit / warn 是「已自动修正 / 仅提示」，不是拒绝，不进红色规则行；SIZE_PRECISION 改成中性小字（notes）；
 * 预检结论是 deny 时 review（需人批）命中不再显示，免得被拦的单还挂「需要你确认」。
 */
export function splitHits(hits: readonly Rec[], verdict?: string): { rules: string[]; notes: string[] } {
  const rules: string[] = []
  const notes: string[] = []
  for (const h of hits) {
    // 只有精度取整（SIZE_PRECISION 且已自动修正）是中性提示；别的 limit / warn（风控自动缩量、降杠杆等）是真实风控动作，照旧进规则行；deny 的精度命中仍是拒绝
    if (h.code === 'SIZE_PRECISION' && (h.action === 'limit' || h.action === 'warn')) {
      const m = typeof h.message === 'string' ? /([\d.]+)\s*->\s*([\d.]+)/.exec(h.message) : null
      // 数量原样写（取整前后的差就在小数尾巴上，fmtLoose 会把它抹掉）
      const from = h.actual !== undefined ? String(h.actual) : m?.[1]
      const to = h.limit !== undefined ? String(h.limit) : m?.[2]
      if (from && to) notes.push(t('数量按精度取整：{0} → {1}{2}', trimFrom(from, to), to, typeof h.unit === 'string' && h.unit ? ` ${h.unit}` : ''))
      continue
    }
    if (verdict === 'deny' && h.action === 'review') continue
    rules.push(ruleText(h as unknown as RuleHit))
  }
  return { rules, notes }
}

/** 界面上的规则行（r4）：「规则名，上限 X，实际 Y」——每行可见中点 ≤ 1；ruleText 的「 · 」格式不变（模型与测试按它断言）。 */
export const ruleLine = (r: string): string => r.replace(/ · /g, t('，'))

/** 保护单的形态：显式 tpslRole 优先；没有时看 reduceOnly + 触发价（take 类算止盈，其余算止损）。 */
function protectiveRoleOf(...recs: (Rec | undefined)[]): 'sl' | 'tp' | null {
  let inferred: 'sl' | 'tp' | null = null
  for (const r of recs) {
    if (!r) continue
    const role = str(r.tpslRole)
    if (role === 'sl' || role === 'tp') return role
    const take = str(r.type)?.startsWith('take_') === true
    if (inferred === null && r.reduceOnly === true && str(r.triggerPrice) !== undefined) inferred = take ? 'tp' : 'sl'
  }
  return inferred
}

const protectiveWord = (role: 'sl' | 'tp'): string => (role === 'tp' ? t('止盈') : t('止损'))

/** 接管载荷里的「已撤 N 张，保留止损 M 张」；没有 keptProtective 字段时回到原文案（老内核）。 */
function keptProtectiveText(p: Rec): string | null {
  const cancelled = toNum(p.cancelled)
  const kept = toNum(p.keptProtective)
  if (cancelled === null || p.keptProtective === undefined) return null
  const head = t('已撤 {0} 张', fmtLoose(cancelled))
  return kept !== null && kept > 0 ? t('{0}，保留止损 {1} 张', head, fmtLoose(kept)) : head
}

function intentWhat(p: Rec): string {
  const i = isRec(p.intent) ? p.intent : p
  const size = toNum(i.size)
  const sym = typeof i.instrumentId === 'string' ? symbolOf(i.instrumentId) : ''
  const px = toNum(i.price)
  const tpsl = isRec(i.tpsl) ? i.tpsl : undefined
  const sl = tpsl && isRec(tpsl.stopLoss) ? str(tpsl.stopLoss.triggerPrice) : undefined
  const tp = tpsl && isRec(tpsl.takeProfit) ? str(tpsl.takeProfit.triggerPrice) : undefined
  const base = [sideWord(i.side), size !== null ? fmtLoose(size) : '', sym, px !== null ? `@ ${fmtLoose(px)}` : ''].filter(Boolean).join(' ')
  // fix-r2 K1：意图只是计划；止损真挂上的证据是子单的 order.accepted（见下面 order.accepted 分支「止损已挂上」）
  return `${base}${sl ? t('，计划挂止损 {0}（随开仓）', fmtLoose(sl)) : ''}${tp ? t('，止盈 {0}', fmtLoose(tp)) : ''}`
}

function reasonOf(e: LedgerEntry): string | undefined {
  const p = isRec(e.payload) ? e.payload : ({} as Rec)
  const intent = isRec(p.intent) ? p.intent : undefined
  return str(p.reason) ?? str(intent?.reason) ?? str(p.note) ?? str(p.text)
}

/** 账本条目 → 事件流条目；不在清单里的类型返回 null。 */
export function entryToActivity(e: LedgerEntry): ActivityItem | null {
  if (!ACTIVITY_SET.has(e.type)) return null
  const p = isRec(e.payload) ? e.payload : ({} as Rec)
  const blockedByState = arr(e.ruleHits).some((h) => isRec(h) && String(h.code).startsWith('TRADING_STATE'))
    || (isRec(p.problem) && String(p.problem.name ?? '').startsWith('TRADING_STATE'))
  const { rules, notes } = splitHits(arr(e.ruleHits).filter(isRec), e.precheck?.verdict)
  const instrumentId = str(e.subject.instrumentId) ?? str(p.instrumentId) ?? (isRec(p.intent) ? str(p.intent.instrumentId) : undefined)
  const base = { id: e.id, seq: e.seq, ts: e.ts, origin: e.origin, type: e.type, rules, ...(notes.length ? { notes } : {}),
    ...(e.subject.ticket ? { ticket: String(e.subject.ticket) } : {}), ...(e.subject.takeoverId ? { takeoverId: String(e.subject.takeoverId) } : {}), ...(instrumentId ? { instrumentId } : {}),
    ...(blockedByState ? { why: t('当前交易状态不允许，先恢复交易') } : reasonOf(e) ? { why: reasonOf(e) } : {}) }
  const verdict = e.precheck?.verdict
  const res = (label: string, tone: ResultTone) => ({ result: { label, tone } })
  switch (e.type) {
    case 'annotation': {
      if (p.kind === 'kernel.started') return { ...base, what: t('内核已重启'), ...res(t('已启动'), 'flat') }
      if (p.kind === 'strategy.stopped_unmanaged') {
        const list = arr(p.positions).filter(isRec).map((x) => `${String(x.instrumentId)} ${String(x.size)}`).join(t('、'))
        return { ...base, what: t('策略已停，{0} 的持仓仍在、已无策略管理', list), ...res(t('需要处理'), 'warn') }
      }
      return null
    }
    case 'order.intent': {
      const i = isRec(p.intent) ? p.intent : p
      const role = protectiveRoleOf(p, i)
      const trigger = str(i.triggerPrice)
      const what = role ? t('挂{0}{1}', protectiveWord(role), trigger ? ` ${fmtLoose(trigger)}` : '') : t('提交订单 {0}', intentWhat(p)).trim()
      return { ...base, what, ...(verdict === 'deny' ? res(t('被拦截'), 'err') : verdict === 'review' ? res(t('转提案'), 'warn') : res(t('通过预检'), 'ok')) }
    }
    case 'order.accepted': {
      // fix-r2 K1：只把保护子单（随开仓 / 重启后领养）与重启后补挂的止损算作活动；普通回执不进事件流
      const role = str(p.tpslRole)
      if (e.origin.tool === 'startup:protect') return { ...base, what: t('止损已补挂（重启后发现仓位没有止损）'), ...res(t('已补挂'), 'ok') }
      if (role !== 'sl' && role !== 'tp') return null
      if (str(p.status) === 'rejected') return { ...base, what: t('{0}没挂上', protectiveWord(role)), ...res(t('被拒'), 'err') }
      return { ...base, what: t('{0}已挂上', protectiveWord(role)), ...res(t('已挂上'), 'ok') }
    }
    case 'order.amended': {
      const before = isRec(p.before) ? p.before : undefined
      const after = isRec(p.after) ? p.after : undefined
      const role = protectiveRoleOf(p, isRec(p.intent) ? p.intent : undefined)
      const trigger = after ? str(after.triggerPrice) : undefined
      const wasTrigger = !!before && str(before.triggerPrice) !== undefined
      const protective = role !== null || trigger !== undefined || wasTrigger
      const word = protectiveWord(role ?? 'sl')
      return { ...base, what: protective ? t('改{0}{1}', word, trigger ? ` ${fmtLoose(trigger)}` : '') : t('改单'), ...res(t('已改单'), 'ok') }
    }
    case 'risk.denied': {
      const msg = isRec(p.problem) ? str(p.problem.message) : undefined
      return { ...base, what: t('订单被拦截'), ...res(t('被拦截'), 'err'), ...(!blockedByState && msg ? { upstream: msg } : {}) }
    }
    case 'order.rejected': {
      const prob = isRec(p.problem) ? p.problem : undefined
      const venue = prob && isRec(prob.venue) ? str(prob.venue.message) : undefined
      return { ...base, what: t('场所拒绝了订单'), ...res(t('被拒绝'), 'err'), ...(!blockedByState && venue ? { upstream: venue } : !blockedByState && prob && str(prob.message) ? { upstream: str(prob.message) as string } : {}) }
    }
    case 'order.cancelled': return { ...base, what: p.action === 'cancel_all' ? t('撤销挂单 {0}', toNum(p.cancelled) ?? '').trim() : t('撤销挂单'), ...res(t('已撤销'), 'flat') }
    case 'fill': {
      const order = isRec(p.order) ? p.order : undefined
      const role = protectiveRoleOf(p, order)
      const type = str(p.type) ?? str(order?.type)
      const protective = role ?? (type === 'stop_market' || type === 'stop_limit' ? 'sl' : type === 'take_market' || type === 'take_limit' ? 'tp' : null)
      if (!protective) return { ...base, what: t('成交 {0}', intentWhat(p)).trim(), ...res(t('已成交'), 'ok') }
      const size = toNum(p.size) ?? toNum(p.filledSize)
      const px = toNum(p.price) ?? toNum(p.avgFillPrice)
      const legs = [size !== null ? fmtLoose(size) : '', px !== null ? `@ ${fmtLoose(px)}` : ''].filter(Boolean).join(' ')
      return { ...base, what: t('{0}触发成交{1}', protectiveWord(protective), legs ? ` ${legs}` : ''), ...res(t('已成交'), 'ok') }
    }
    case 'proposal.created': return { ...base, what: t('提出提案 {0}', e.subject.ticket ?? '').trim(), ...(verdict === 'deny' ? res(t('被拦截'), 'err') : res(t('待批'), 'warn')) }
    case 'proposal.decided': return { ...base, what: t('{0}提案 {1}', p.decision === 'rejected' ? t('拒绝') : t('批准'), e.subject.ticket ?? '').trim(), ...(p.decision === 'rejected' ? res(t('已拒绝'), 'flat') : res(t('已批准'), 'ok')) }
    case 'proposal.executed': return { ...base, what: t('执行提案 {0}', e.subject.ticket ?? '').trim(), ...res(t('已执行'), 'ok') }
    case 'proposal.failed': return { ...base, what: t('提案执行失败 {0}', e.subject.ticket ?? '').trim(), ...res(t('失败'), 'err') }
    case 'proposal.expired': return { ...base, what: t('提案过期 {0}', e.subject.ticket ?? '').trim(), ...res(t('已过期'), 'flat') }
    case 'proposal.withdrawn': return { ...base, what: t('撤回提案 {0}', e.subject.ticket ?? '').trim(), ...res(t('已撤回'), 'flat') }
    // 请求只是「已发出」（IXD F3-2）：结果看随后的 takeover.completed / failed，不把请求写成已执行。
    case 'takeover.requested': return { ...base, what: t('接管：{0}', takeoverWord[String(p.level)] ?? String(p.level ?? '')), ...(str(p.reason) ? { why: str(p.reason) as string } : {}), ...res(t('已发出'), 'warn') }
    case 'takeover.completed': {
      const kept = keptProtectiveText(p)
      return { ...base, what: t('接管完成：{0}{1}', takeoverWord[String(p.level)] ?? String(p.level ?? ''), kept ? ` · ${kept}` : ''), ...res(t('已完成'), 'ok') }
    }
    case 'takeover.applied': {
      const kept = keptProtectiveText(p)
      return { ...base, what: t('接管执行：{0}{1}', takeoverWord[String(p.level)] ?? String(p.level ?? ''), kept ? ` · ${kept}` : ''), ...res(t('已执行'), 'ok') }
    }
    case 'takeover.failed': return { ...base, what: t('接管未完成：{0}', takeoverWord[String(p.level)] ?? ''), ...res(t('失败'), 'err') }
    case 'mandate.downgraded': return { ...base, what: t('降低 Agent 权限'), ...(str(p.reason) ? { why: str(p.reason) as string } : {}), ...res(t('已降级'), 'warn') }
    // UX-34：engines bind 给纸面账户自动签的引擎授权（发起工具是 engine.bind）不是给哪个 AI 开权限，按授权对象写
    case 'mandate.issued': return { ...base, what: /(^|:)engine\.bind$/.test(e.origin.tool ?? '') ? t('绑定引擎授权（纸面）') : t('签发 Agent 权限'), ...res(t('已生效'), 'ok') }
    case 'mandate.changed': return { ...base, what: t('调整 Agent 权限'), ...res(t('已生效'), 'ok') }
    case 'mandate.revoked': return { ...base, what: t('撤销 Agent 权限'), ...res(t('已撤销'), 'warn') }
    case 'protector.triggered': return { ...base, what: t('保护器触发 {0}', str(p.protector) ?? '').trim(), ...res(t('已暂停'), 'warn') }
    case 'trading_state.changed': {
      const scope = isRec(p.scope) ? p.scope : e.subject.accountId ? { type: 'account', id: e.subject.accountId } : null
      const label = scope?.type === 'account' ? t('账户 {0}', String(scope.id).slice(-6)) : scope?.type === 'mandate' ? t('Agent 授权') : scope?.type === 'org' ? t('全局') : t('当前作用域')
      return { ...base, what: t('{0}：交易状态 → {1}', label, stateWord[String(p.to)] ?? String(p.to ?? '')), ...(str(p.reason) ? { why: str(p.reason) as string } : {}), ...res(stateWord[String(p.to)] ?? '', p.to === 'ACTIVE' ? 'ok' : p.to === 'HALTED' ? 'err' : 'warn') }
    }
    case 'policy.relaxed': {
      const until = toNum(p.until)
      const what = p.change === 'temporaryRelax' ? (until !== null ? t('临时放宽限额，至 {0}', new Date(until).toTimeString().slice(0, 5)) : t('临时放宽限额'))
        : p.change === 'allow_llm_live_entries' ? t('允许 LLM 实盘开仓')
        : p.change === 'relax' ? t('修改风控上限') : t('修改风控策略')
      return { ...base, what, ...res(t('已生效'), 'warn') }
    }
    case 'policy.reverted': return { ...base, what: t('临时放宽已到期收回'), ...res(t('已收回'), 'ok') }
    case 'note': return { ...base, what: t('记了一条笔记'), ...res(t('已记录'), 'flat') }
    default: return null
  }
}

const SETTLE_RESULT: Record<string, { label: string; tone: ResultTone }> = {
  'proposal.executed': { label: t('已执行'), tone: 'ok' }, 'proposal.failed': { label: t('失败'), tone: 'err' },
  'proposal.expired': { label: t('已过期'), tone: 'flat' }, 'proposal.withdrawn': { label: t('已撤回'), tone: 'flat' },
}
/** 提案状态回写：创建行永远带着创建那一刻的「待批 + 需要确认」；同票有后续行时，把创建行改成最新状态并去掉待确认规则行。 */
export function settleProposals(list: readonly ActivityItem[]): ActivityItem[] {
  const latest = new Map<string, ActivityItem>()
  for (const x of list) if (x.ticket && x.type !== 'proposal.created' && x.type.startsWith('proposal.') && x.result && (!latest.has(x.ticket) || latest.get(x.ticket)!.seq < x.seq)) latest.set(x.ticket, x)
  return list.map((x) => {
    const next = x.type === 'proposal.created' && x.result?.label === t('待批') && x.ticket ? latest.get(x.ticket) : undefined
    if (!next) return x
    return { ...x, result: SETTLE_RESULT[next.type] ?? next.result!, rules: x.rules.filter((r) => !approvalRule(r)) }
  })
}

/** 接管折叠：同一次接管已有完成 / 失败行时，隐藏「已发出 / 已执行」两行（完成行的文案已带结果）。 */
export function foldTakeovers(list: readonly ActivityItem[]): ActivityItem[] {
  const done = new Set(list.filter((x) => x.takeoverId && (x.type === 'takeover.completed' || x.type === 'takeover.failed')).map((x) => x.takeoverId))
  return list.filter((x) => !(x.takeoverId && done.has(x.takeoverId) && (x.type === 'takeover.requested' || x.type === 'takeover.applied')))
}

/**
 * 被拦的提案合成一行（UX-20）：提案创建行（被拦截）与它同时落账的「订单被拦截」行说的是一件事（同一次调用、同一个理由），只留提案行（带票号）。
 * 认同一次调用：requestId 相同；或同一个行为人、同一个标的、相隔 2 秒内（账本里两行的 requestId 不一定一致）。
 */
/** UX-20 显示层：金额类单位的「实际」最多保留 2 位小数（数量类仍保留原精度）。 */
const MONEY_UNITS = new Set(['USDC', 'USD', 'USDT'])
const fmtMoney2 = (v: unknown): string => { const n = toNum(v); return n === null ? fmtLoose(v) : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(n) }

export function foldBlockedProposals(list: readonly ActivityItem[]): ActivityItem[] {
  const blocked = list.filter((x) => x.type === 'proposal.created' && x.result?.tone === 'err')
  if (!blocked.length) return list as ActivityItem[]
  const same = (p: ActivityItem, x: ActivityItem) => p.origin.requestId === x.origin.requestId
    || (p.origin.actor === x.origin.actor && Math.abs(p.ts - x.ts) <= 2000 && (p.instrumentId ?? '') === (x.instrumentId ?? ''))
  return list.filter((x) => !(x.type === 'risk.denied' && blocked.some((p) => same(p, x))))
}

/** 渲染前的一次整理：提案状态回写 + 接管折叠 + 被拦提案合并。 */
export const tidyActivity = (list: readonly ActivityItem[]): ActivityItem[] => foldBlockedProposals(foldTakeovers(settleProposals(list)))

/**
 * ux-fix2 B2 · Agent 自身出错第 2 层：大模型 Agent 自己的调用被拦 / 被拒，且不需要人批准——这是它自己的事，不打扰人。
 * 活动流照常记一笔，但语气放平（不标红）、挂一句「它会按原因自己调整」，连续相同的合成一行。要人批准的（approvalRule）不在此列。
 */
export function agentMiss(it: ActivityItem): boolean {
  if (originActorType(it.origin) !== 'llm-agent' || it.rules.some(approvalRule)) return false
  return it.type === 'risk.denied' || it.type === 'order.rejected' || (it.type === 'proposal.created' && it.result?.tone === 'err')
}

/** 连续相同的 Agent 失败合成一行（留最新那条，repeat = 合进来的条数，含自己）；只合显示，不改计数。 */
export function foldAgentMisses(list: readonly ActivityItem[]): Array<ActivityItem & { repeat?: number }> {
  const out: Array<ActivityItem & { repeat?: number }> = []
  const key = (x: ActivityItem) => [x.origin.actor, x.type, x.what, x.result?.label ?? '', x.upstream ?? '', ...x.rules].join('\n')
  for (const x of list) {
    const prev = out[out.length - 1]
    if (prev && agentMiss(prev) && agentMiss(x) && key(prev) === key(x)) { prev.repeat = (prev.repeat ?? 1) + 1; continue }
    out.push({ ...x })
  }
  return out
}

/** 把一批账本条目规整成事件流（按 seq 降序，去重，最多 max 条）。 */
export function activityOf(entries: readonly LedgerEntry[], max = 200): ActivityItem[] {
  const seen = new Set<string>()
  const out: ActivityItem[] = []
  for (const e of entries) {
    const it = entryToActivity(e)
    if (!it || seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  return out.sort((a, b) => b.seq - a.seq).slice(0, max)
}

/** 壳发现内核重启（/api/health 的 startedAt 变了）时发的窗口事件；与壳约定同名。 */
export const KERNEL_RESTART_EVENT = 'gitrader:kernel-restarted'

/** 「内核已重启」本地行：只在本页内存里，不落盘、不写内核账本；复用 entryToActivity 里 kernel.started 的映射。seq 取现有最大值 + 0.5，排在已有条目之上、之后的真实条目之下。 */
export function kernelRestartItem(ts: number, list: readonly ActivityItem[]): ActivityItem {
  const entry = {
    schema: 'gitrader-ledger/1', seq: list.reduce((m, x) => Math.max(m, x.seq), 0) + 0.5, id: `local-kernel-restart-${ts}`, ts, recordedAt: ts, type: 'annotation',
    origin: { actor: 'system:kernel', actorType: 'system', tool: 'kernel.restart', requestId: `local-${ts}`, via: 'internal' }, subject: {}, payload: { kind: 'kernel.started' },
  } as unknown as LedgerEntry
  return entryToActivity(entry) as ActivityItem
}

export function mergeActivity(list: readonly ActivityItem[], item: ActivityItem, max = 200): ActivityItem[] {
  if (list.some((x) => x.id === item.id)) return list as ActivityItem[]
  return [item, ...list].sort((a, b) => b.seq - a.seq).slice(0, max)
}

export function normalizeLedger(raw: unknown): LedgerEntry[] {
  return listOf(raw, 'entries').filter(isRec).filter((e) => typeof e.type === 'string' && isRec(e.origin) && typeof e.id === 'string') as unknown as LedgerEntry[]
}

/** 来源筛选：LLM 来源的动作永远可筛（ActorFilter 的 llm-agent 档），这里只做过滤。 */
export function filterActivity(list: readonly ActivityItem[], filter: ActorFilterId): ActivityItem[] {
  return filter === 'all' ? [...list] : list.filter((x) => matchesActorFilter(x.origin, filter))
}

/** 过滤片上的计数（IXD 流程 5：每片都带数，「LLM Agent」片的数 = LLM 来源的条数）。 */
export function activityCounts(list: readonly ActivityItem[]): Record<ActorFilterId, number> {
  const n: Record<ActorFilterId, number> = { all: list.length, human: 0, engine: 0, 'llm-agent': 0, system: 0 }
  for (const x of list) n[originActorType(x.origin)] += 1
  return n
}

// ---- 待批提案 ---------------------------------------------------------------------------

/** r4 追加：instrumentId / side / size（批后仓位用）。 */
export interface PendingLeg { text: string; notional: number | null; instrumentId?: string; side?: 'buy' | 'sell'; size?: number | null }
export interface PendingCard {
  proposalId: string
  ticket: string
  /** 下单类提案的账户（卡上写「账户别名 · 实盘 / 纸面」，IXD F1-3）。 */
  accountId: string | null
  expiresAt: number
  reason: string
  origin: Origin | null
  legs: PendingLeg[]
  /** control 类提案（启动策略等）。 */
  control?: string
  verdict: 'allow' | 'deny' | 'review' | null
  liquidationPrice: number | null
  slippageBps: number | null
  marginRequired: number | null
  notional: number | null
  rules: string[]
  notes?: string[]
  priceBounds?: { referencePrice: string; maxDriftBps: number }
  /** 第一条 intent 的附带保护单（原文十进制字符串；缺就不写）。 */
  stopLoss?: string
  takeProfit?: string
  /** 预检估算的最大亏损（`precheck.estimates.maxLoss`，带合规止损时才有）。 */
  maxLoss?: string
  feeEstimate?: string
  /** 内核说的：批准这张票是否要 PIN 在场证明（老内核没有这个字段）。 */
  approvalNeedsPin?: boolean
}

/** 批准键上是否画锁：只有内核明确说「不用 PIN」（false）才不画；字段缺失（老内核）保持画锁。 */
export function showsApproveLock(card: Pick<PendingCard, 'approvalNeedsPin'>): boolean {
  return card.approvalNeedsPin !== false
}

export function normalizeProposals(raw: unknown): Rec[] {
  return listOf(raw, 'proposals').filter(isRec)
}

function legOf(i: Rec): PendingLeg {
  const size = toNum(i.size)
  const notional = toNum(i.notional)
  const px = toNum(i.price)
  const sym = typeof i.instrumentId === 'string' ? symbolOf(i.instrumentId) : ''
  const text = [sideWord(i.side), size !== null ? fmtLoose(size) : notional !== null ? t('{0} 名义', fmtLoose(notional)) : '', sym, px !== null ? `@ ${fmtLoose(px)}` : i.type === 'market' ? t('市价') : ''].filter(Boolean).join(' ')
  const est = size !== null && px !== null ? size * px : notional
  const side = i.side === 'buy' || i.side === 'sell' ? i.side : undefined
  return { text, notional: est, ...(typeof i.instrumentId === 'string' ? { instrumentId: i.instrumentId } : {}), ...(side ? { side } : {}), size }
}

/** 提案 → 待批卡片；不是待审状态返回 null。 */
export function toPending(p: Rec): PendingCard | null {
  if (p.status !== 'pending') return null
  const proposalId = str(p.proposalId)
  const ticket = str(p.ticket)
  const expiresAt = toNum(p.expiresAt)
  if (!proposalId || !ticket || expiresAt === null) return null
  const pre = isRec(p.precheck) ? p.precheck : ({} as Rec)
  const est = isRec(pre.estimates) ? pre.estimates : ({} as Rec)
  const intents = p.kind === 'control' && isRec(p.intents) ? null : arr(p.intents).filter(isRec)
  const control = p.kind === 'control' && isRec(p.intents) ? (CONTROL_LABEL[String(p.intents.controlKind)] ?? String(p.intents.controlKind)) : undefined
  const legs = (intents ?? []).map(legOf)
  const first = intents && intents.length ? intents[0] : undefined
  const tpsl = first && isRec(first.tpsl) ? first.tpsl : undefined
  const stopLoss = tpsl && isRec(tpsl.stopLoss) ? str(tpsl.stopLoss.triggerPrice) : undefined
  const takeProfit = tpsl && isRec(tpsl.takeProfit) ? str(tpsl.takeProfit.triggerPrice) : undefined
  const maxLoss = str(est.maxLoss)
  const feeEstimate = str(est.feeEstimate)
  const v = pre.verdict
  const hits = splitHits(arr(pre.ruleHits).filter(isRec), typeof v === 'string' ? v : undefined)
  return {
    proposalId, ticket, accountId: str(p.accountId) ?? null, expiresAt, reason: str(p.reason) ?? '', origin: isRec(p.origin) ? (p.origin as unknown as Origin) : null,
    legs, ...(control ? { control } : {}),
    verdict: v === 'allow' || v === 'deny' || v === 'review' ? v : null,
    liquidationPrice: ((n) => (n !== null && n > 0 ? n : null))(toNum(est.liquidationPrice)), slippageBps: toNum(est.slippageBps), marginRequired: toNum(est.marginRequired),
    notional: toNum(est.notional) ?? (legs.every((l) => l.notional !== null) && legs.length ? legs.reduce((x, l) => x + (l.notional ?? 0), 0) : null),
    rules: hits.rules, ...(hits.notes.length ? { notes: hits.notes } : {}),
    ...(isRec(p.priceBounds) && typeof p.priceBounds.referencePrice === 'string' && typeof p.priceBounds.maxDriftBps === 'number' ? { priceBounds: { referencePrice: p.priceBounds.referencePrice, maxDriftBps: p.priceBounds.maxDriftBps } } : {}),
    ...(stopLoss ? { stopLoss } : {}), ...(takeProfit ? { takeProfit } : {}), ...(maxLoss ? { maxLoss } : {}), ...(feeEstimate ? { feeEstimate } : {}),
    ...(typeof p.approvalNeedsPin === 'boolean' ? { approvalNeedsPin: p.approvalNeedsPin } : {}),
  }
}

/** 审批卡上的附带保护一行：有止损 / 止盈才有一行，最多亏只在预检给出估算是拼上。 */
export function protectionLine(c: Pick<PendingCard, 'stopLoss' | 'takeProfit' | 'maxLoss'>): string | null {
  if (!c.stopLoss && !c.takeProfit) return null
  const parts: string[] = []
  if (c.stopLoss) parts.push(t('附带止损 {0}', fmtLoose(c.stopLoss)))
  if (c.takeProfit) parts.push(c.stopLoss ? t('止盈 {0}', fmtLoose(c.takeProfit)) : t('附带止盈 {0}', fmtLoose(c.takeProfit)))
  if (c.maxLoss) {
    const n = toNum(c.maxLoss)
    parts.push(t('最多亏 ≈ {0}', n === null ? fmtLoose(c.maxLoss) : fmtLoose(Math.round(n * 100) / 100)))
  }
  return parts.join(' · ')
}

/** 提案列表 / 事件 → 待批队列（只留待审、按到期时间升序，最急的在最前）。 */
export function pendingQueue(proposals: ReadonlyMap<string, Rec>): PendingCard[] {
  return [...proposals.values()].map(toPending).filter((x): x is PendingCard => x !== null).sort((a, b) => a.expiresAt - b.expiresAt)
}

/**
 * 批准 / 拒绝命令的结果（IXD F1-1 · G3：不以「没抛错」当成功）。内核批准后重新预检再执行，执行失败是**正常返回**一张 failed 提案。
 * executed = 已批准且已执行；failed = 已批准但执行失败（message 是内核 / 场所原文）；approved = 已批准（还在执行，结果随事件到）；rejected = 已拒绝。
 */
export type DecisionOutcome = { kind: 'executed' | 'approved' | 'rejected' } | { kind: 'failed'; message: string }
export function decisionOutcome(action: 'approve' | 'reject', value: unknown): DecisionOutcome {
  if (action === 'reject') return { kind: 'rejected' }
  const p = isRec(value) ? value : ({} as Rec)
  if (p.status === 'executed') return { kind: 'executed' }
  if (p.status === 'failed') {
    const ex = isRec(p.execution) ? p.execution : ({} as Rec)
    const prob = isRec(ex.problem) ? ex.problem : undefined
    const venue = prob && isRec(prob.venue) ? str(prob.venue.message) : undefined
    return { kind: 'failed', message: str(prob?.message) ?? venue ?? str(ex.result) ?? 'failed' }
  }
  return { kind: 'approved' }
}

/** 事件载荷是一个完整 Proposal；状态离开 pending 就从表里去掉。 */
export function applyProposal(map: ReadonlyMap<string, Rec>, p: unknown): Map<string, Rec> {
  const next = new Map(map)
  if (isRec(p) && typeof p.proposalId === 'string') {
    if (p.status === 'pending') next.set(p.proposalId, p)
    else next.delete(p.proposalId)
  }
  return next
}

// ---- 视觉轮 r4：三张卡的纯逻辑（待批卡 · Agent 卡 · 视图选择）-------------------------------------

/** Agent 块的视图（config.view）：pending 待批卡 / keys Agent 卡 / feed 活动卡；缺省或认不出 = null（旧的全量视图）。 */
export type AgentView = 'pending' | 'keys' | 'feed'
export function parseView(config: unknown): AgentView | null {
  const v = isRec(config) ? config.view : undefined
  return v === 'pending' || v === 'keys' || v === 'feed' ? v : null
}

/** 一个标的上的净仓位（批后仓位用）。 */
export interface NetPos { side: 'long' | 'short'; size: number }
/** 现有仓位 + 提案各腿（同一标的）→ 批后仓位；平到 0 = null（无仓位）。数量按 1e-8 取整，免得 0.1 + 0.2 这类浮点尾巴进界面。 */
export function positionAfter(current: NetPos | null, legs: ReadonlyArray<{ side?: string; size?: number | null }>): NetPos | null {
  let n = current ? (current.side === 'long' ? current.size : -current.size) : 0
  for (const l of legs) { const s = l.size ?? 0; if (l.side === 'buy') n += s; else if (l.side === 'sell') n -= s }
  n = Math.round(n * 1e8) / 1e8
  return n === 0 ? null : { side: n > 0 ? 'long' : 'short', size: Math.abs(n) }
}
/** 「空 3.2」「多 0.5」「无仓位」。 */
export const netPosText = (p: NetPos | null): string => (p ? `${p.side === 'long' ? t('多') : t('空')} ${fmtLoose(p.size)}` : t('无仓位'))

/** 最急的一张（到期最早、还没过期）；没有返回 null。 */
export function soonest(cards: readonly PendingCard[], now: number): PendingCard | null {
  let best: PendingCard | null = null
  for (const c of cards) if (c.expiresAt > now && (!best || c.expiresAt < best.expiresAt)) best = c
  return best
}

/**
 * 引信长度 = 剩余 / 时限（VISUAL §4：03:05 / 05:00 = 61.7%）。协议的提案没有创建时刻，时限按 5 分钟窗口算，剩余超过 5 分钟的满格；过期 = 0。
 * ponytail: 固定 5 分钟窗口；内核给出提案的创建时刻（或 TTL）后改成按单算。
 */
export const FUSE_WINDOW_MS = 5 * 60_000
export function fuseRatio(card: Pick<PendingCard, 'expiresAt'>, now: number): number {
  return Math.max(0, Math.min(1, (card.expiresAt - now) / FUSE_WINDOW_MS))
}

/** 待批卡的当前一张 + 卡底队列（按 id 锚定：selected 还在就一直是它；队列按到期先后，超过 3 行时末行写「另 N 张」）。 */
export function queueView(cards: readonly PendingCard[], selected: string | null, maxRows = 3): { current: PendingCard | null; rows: PendingCard[]; more: number } {
  const current = cards.find((c) => c.proposalId === selected) ?? cards[0] ?? null
  const rest = cards.filter((c) => c !== current)
  if (rest.length <= maxRows) return { current, rows: rest, more: 0 }
  return { current, rows: rest.slice(0, maxRows - 1), more: rest.length - (maxRows - 1) }
}

/** 钥匙最后活动：「20 秒前」「3 分钟前」「1 小时前」「2 天前」；没有记录写「还没有活动」。 */
export function agoText(ts: number | null, now: number): string {
  if (ts === null) return t('还没有活动')
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return t('{0} 秒前', s)
  if (s < 3600) return t('{0} 分钟前', Math.floor(s / 60))
  if (s < 86400) return t('{0} 小时前', Math.floor(s / 3600))
  return t('{0} 天前', Math.floor(s / 86400))
}

// ---- Agent 权限（钥匙 + 授权书）------------------------------------------------------------

export interface KeyTier {
  keyId: string
  name: string
  host: string
  status: string
  mandateId: string
  /** 有效档位（IXD F4-3）：授权书到期 / 撤销 / 暂停时按只读算，不再显示授权书上写的级别。 */
  tier: AgentPermissionTier
  /** 有效档位的补充：已到期 / 已撤销 / 已暂停 / 已降级；正常生效时没有。 */
  note?: string
  /** 授权书到期时刻（菜单头显示）。 */
  notAfter: number | null
  mandate: Mandate | null
  /** r4：钥匙最后活动时刻（AgentKey.lastSeenAt；没有为 null）。 */
  lastSeenAt: number | null
}

const MANDATE_NOTE: Record<string, string> = { expired: t('已到期'), revoked: t('已撤销'), suspended: t('已暂停'), downgraded: t('已降级') }

export function keyTiers(keysRaw: unknown, mandatesRaw: unknown, now: number = Date.now()): KeyTier[] {
  const mandates = new Map<string, Mandate>()
  for (const m of listOf(mandatesRaw, 'mandates').filter(isRec)) if (typeof m.mandateId === 'string') mandates.set(m.mandateId, m as unknown as Mandate)
  return listOf(keysRaw, 'keys').filter(isRec).flatMap((k) => {
    const key = k as unknown as AgentKey
    if (!key.keyId || key.status === 'revoked') return []
    const m = mandates.get(key.mandateId) ?? null
    const notAfter = m ? toNum(m.notAfter) : null
    const st = m ? (m.status !== 'active' ? String(m.status) : notAfter !== null && notAfter <= now ? 'expired' : 'active') : 'active'
    // 降级的授权书级别本身已经降下来，照级别显示并标「已降级」；到期 / 撤销 / 暂停一律按只读
    const tier: AgentPermissionTier = !m ? 'read_only' : st === 'active' || st === 'downgraded' ? TIER_OF_LEVEL[m.level] : 'read_only'
    const note = MANDATE_NOTE[st]
    return [{ keyId: key.keyId, name: key.name, host: key.host, status: key.status, mandateId: key.mandateId, tier, ...(note ? { note } : {}), notAfter, mandate: m, lastSeenAt: toNum((k as Rec).lastSeenAt) }]
  })
}

/**
 * actor `agent:<keyId>` → 钥匙名（事件流里 LLM Agent 的称呼）。
 * 读原始钥匙表（也接受 KeyTier 列表），不经 keyTiers 过滤：吊销的钥匙仍保留署名，名字后缀「（已撤销）」（R-50），
 * 否则吊销后活动流 / 持仓开仓方会退回「LLM Agent」。档位只对有效钥匙有意义，那部分仍由 keyTiers 过滤。
 */
export function actorNames(keys: unknown): Record<string, string> {
  return Object.fromEntries(listOf(keys, 'keys').filter(isRec).flatMap((k) => {
    const id = typeof k.keyId === 'string' ? k.keyId : ''
    const name = typeof k.name === 'string' ? k.name : ''
    if (!id || !name) return []
    return [[`agent:${id}`, k.status === 'revoked' ? t('{0}（已撤销）', name) : name]]
  }))
}
