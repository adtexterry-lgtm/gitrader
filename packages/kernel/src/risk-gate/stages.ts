// SPDX-License-Identifier: CPAL-1.0
import {
  GATE_ACTIONS, GATE_STAGES, effectiveDenyLlmLiveEntries, isDecimal, isLlmLiveEntryDenied, llmLiveEntryRuleHit,
} from '@gitrader/protocol'
import type {
  Decimal, GateAction, GateAdjustment, GateInput, GateStage, GateTarget, Instrument, Mandate, NormalizedIntentLike,
  PrecheckEstimates, Protector, RiskLimits, RiskPolicy, RuleCode, RuleHit,
} from '@gitrader/protocol'
import * as d from '../util/dec'
import { cleanGateValue } from './assemble'
import { checkStopRequired, checkTpsl } from './tpsl'

export interface GateStageEvaluation {
  byStage: Partial<Record<GateStage, RuleHit[]>>
  monitorHits: RuleHit[]
  estimates: PrecheckEstimates
  sizeCaps: Array<{ size: Decimal; hit: RuleHit }>
  allowedActions: Record<GateAction, boolean>
}

const ZERO = d.ZERO
const levelOf = (mandate: Mandate | null): number => mandate ? Number(mandate.level.slice(1)) : -1
const policyIdOf = (policy: RiskPolicy | null): string => policy?.policyId ?? 'pol_none'
const byInstrument = <T extends { instrumentId: string }>(items: readonly T[], instrumentId: string): T[] => items.filter((x) => x.instrumentId === instrumentId)
const orderOf = (i: GateInput): NormalizedIntentLike | undefined => i.target.kind === 'order' ? i.target.intent : undefined
const instrumentOf = (i: GateInput): Instrument | undefined => 'instrument' in i ? i.instrument : undefined
const targetInstrumentId = (i: GateInput): string | undefined => orderOf(i)?.instrumentId ?? ('instrumentId' in i.target ? i.target.instrumentId : undefined)
const asDecimal = (x: string | number): Decimal => d.str(d.D(String(x)))
const activeStates = (i: GateInput) => i.states.filter((s) => s.state !== 'ACTIVE' && (s.until === undefined || s.until > i.now))

export function effectiveGateAction(i: GateInput): GateAction {
  if (i.action === 'amend') return orderOf(i)?.reduceOnly === true ? 'reduce' : 'open'
  return i.action
}

export function effectiveGateLimits(i: GateInput): RiskLimits {
  const policy = i.policy
  if (!policy) return { maxSlippageBps: 50 }
  const relax = policy.temporaryRelax
  return relax && relax.from <= i.now && i.now < relax.until
    ? { ...policy.limits, ...relax.fields }
    : { ...policy.limits }
}

export function adjustedGateTarget(target: GateTarget, applied: GateAdjustment[]): GateTarget {
  const clean = cleanGateValue(target)
  if (clean.kind !== 'order') return clean
  const intent = { ...clean.intent }
  for (const adjustment of applied) if (adjustment.field === 'size') intent.size = asDecimal(adjustment.to as string | number)
  return { ...clean, intent }
}

function emptyStages(): Record<GateStage, RuleHit[]> {
  return {
    SYS: [], KILL: [], STATE: [], MANDATE: [], LLM: [], ALLOWLIST: [], CONST: [], EXPOSURE: [],
    BUYING_POWER: [], LOSS: [], RATE: [], PROTECTOR: [], APPROVAL: [], 'PROTECTOR:skipped': [],
  }
}

function applicableStages(i: GateInput, action: GateAction, skipped: boolean): Set<GateStage> {
  if (action === 'deadman_arm') return new Set()
  const stages = new Set<GateStage>(['SYS', 'KILL', 'STATE', 'MANDATE'])
  if (action === 'open' || action === 'leverage' || action === 'cancel_protective') stages.add('LLM')
  if (action === 'open' || action === 'leverage') stages.add('ALLOWLIST')
  if (action === 'open' || action === 'leverage' || action === 'reduce' && orderOf(i) !== undefined) stages.add('CONST')
  if (action === 'open') {
    stages.add('EXPOSURE'); stages.add('BUYING_POWER'); stages.add('LOSS'); stages.add('PROTECTOR')
  }
  if (action === 'leverage') stages.add('BUYING_POWER')
  if (action === 'open' || action === 'reduce' || action === 'cancel' || action === 'cancel_protective') stages.add('RATE')
  if (action === 'open' || action === 'leverage' || i.actorClass === 'agent' && action === 'cancel_protective') stages.add('APPROVAL')
  if (skipped) stages.add('PROTECTOR:skipped')
  return stages
}

/** fix-r4 C13：审批类命中的人话说明（解释串里仍带 expected=…; actual=…）。 */
const APPROVAL_MESSAGE = 'order needs human approval under this mandate; submit as proposal'

function addHit(
  byStage: Record<GateStage, RuleHit[]>, stage: GateStage, ruleId: string, code: RuleCode,
  limit: string | number, actual: string | number, unit: string, scope: string,
  action: RuleHit['action'] = 'deny', message?: string,
): RuleHit {
  const hit: RuleHit = { ruleId, code, ...(message ? { message } : {}), limit: asDecimal(limit), actual: asDecimal(actual), unit, action, scope }
  byStage[stage].push(hit)
  return hit
}

function addPredicateHit(
  byStage: Record<GateStage, RuleHit[]>, stage: GateStage, ruleId: string, code: RuleCode,
  expected: string, actual: string, scope: string, action: RuleHit['action'] = 'deny', message?: string,
): RuleHit {
  const explanation = `${message ? `${message}; ` : ''}expected=${expected}; actual=${actual}`
  return addHit(byStage, stage, ruleId, code, '0', '1', 'violations', scope, action, explanation)
}

function addSizeCap(
  byStage: Record<GateStage, RuleHit[]>, sizeCaps: Array<{ size: Decimal; hit: RuleHit }>, stage: GateStage,
  ruleId: string, code: RuleCode, limit: string | number, actual: string | number, unit: string, scope: string,
  size: d.Dec, message?: string, action: RuleHit['action'] = 'deny',
): void {
  const hit = addHit(byStage, stage, ruleId, code, limit, actual, unit, scope, action, message)
  sizeCaps.push({ size: d.str(d.max(ZERO, size)), hit })
}

function coreActionMode(action: GateAction, actorClass: GateInput['actorClass']): 'deny' | 'warn' | 'none' {
  if (action === 'deadman_arm') return 'none'
  if (action === 'open' || action === 'leverage') return 'deny'
  if (action === 'reduce' || action === 'cancel') return 'warn'
  return actorClass === 'agent' ? 'deny' : 'warn'
}

function ratio(value: d.Dec, equity: d.Dec): d.Dec {
  return d.gt(equity, ZERO) ? d.div(value, equity, 8) : d.gt(value, ZERO) ? d.D('1000000') : ZERO
}

function positive(x: string | undefined): d.Dec { return x === undefined ? ZERO : d.max(ZERO, d.D(x)) }
function pendingNotional(i: GateInput, instrumentId: string): d.Dec {
  const open = byInstrument(i.snapshot.openOrders, instrumentId).reduce((sum, o) => d.add(sum, positive(o.notional)), ZERO)
  const r = i.reserved.byInstrument[instrumentId]
  return d.add(open, d.add(positive(r?.long.notional), positive(r?.short.notional)))
}
function allOtherExposure(i: GateInput, instrumentId: string): d.Dec {
  const positions = i.snapshot.positions.filter((p) => p.instrumentId !== instrumentId).reduce((s, p) => d.add(s, positive(p.notional)), ZERO)
  const open = i.snapshot.openOrders.filter((o) => o.instrumentId !== instrumentId).reduce((s, o) => d.add(s, positive(o.notional)), ZERO)
  const reserved = Object.entries(i.reserved.byInstrument).filter(([id]) => id !== instrumentId).reduce((s, [, r]) => d.add(s, d.add(positive(r.long.notional), positive(r.short.notional))), ZERO)
  return d.add(positions, d.add(open, reserved))
}
function exposureAfterOrder(i: GateInput, intent: NormalizedIntentLike, unitNotional: d.Dec): { current: d.Dec; afterPosition: d.Dec; afterExposure: d.Dec } {
  const pos = i.snapshot.positions.find((p) => p.instrumentId === intent.instrumentId)
  const current = pos ? positive(pos.notional) : ZERO
  const size = d.D(intent.size)
  const afterPosition = d.add(current, d.mul(size, unitNotional))
  return { current, afterPosition, afterExposure: d.add(afterPosition, pendingNotional(i, intent.instrumentId)) }
}

function sizeForExposure(cap: d.Dec, positionNotional: d.Dec, unitNotional: d.Dec, pending: d.Dec, otherExposure: d.Dec = ZERO): d.Dec {
  const room = d.max(ZERO, d.sub(d.sub(d.sub(cap, positionNotional), pending), otherExposure))
  return d.div(room, unitNotional)
}

/** 估算强平价；结果 ≤ 0（如 1 倍买单，代数上恰为 0）等于「不会被强平」，返回 undefined，调用处不输出该字段（fix-r4）。 */
function liquidationEstimate(price: d.Dec, side: 'buy' | 'sell', leverage: number, maxLeverage: number | undefined): Decimal | undefined {
  const sign = side === 'buy' ? d.ONE : d.D('-1')
  const maint = d.div(d.ONE, d.D(maxLeverage && maxLeverage > 0 ? maxLeverage * 2 : 40))
  const marginPerUnit = d.mul(price, d.sub(d.div(d.ONE, d.D(leverage > 0 ? leverage : 1)), maint))
  const denom = d.sub(d.ONE, d.mul(maint, sign))
  const liq = d.sub(price, d.div(d.mul(sign, marginPerUnit), denom))
  return d.gt(liq, ZERO) ? d.str(liq) : undefined
}

function mandateAllows(i: GateInput, action: GateAction): boolean {
  if (i.actorClass !== 'agent') return true
  if (action === 'deadman_arm') return true
  if (action === 'deadman_disarm' || action === 'cancel_protective') return false
  const m = i.mandate
  if (!m) return false
  const level = levelOf(m)
  if (level <= 0) return false
  return true
}

function allowedActionsFor(i: GateInput): Record<GateAction, boolean> {
  const states = activeStates(i)
  const restricted = i.killSwitch.tripped || states.length > 0
  const halted = i.killSwitch.tripped || states.some((state) => state.state === 'HALTED')
  const allowed = {} as Record<GateAction, boolean>
  for (const action of GATE_ACTIONS) {
    let ok = mandateAllows(i, action)
    if (action === 'deadman_arm') ok = true
    if (action === 'deadman_disarm') ok = i.actorClass !== 'agent'
    if (action === 'cancel_protective' && i.actorClass === 'agent') ok = false
    if (restricted && (action === 'open' || action === 'leverage')) ok = false
    if (restricted && action === 'cancel_protective' && i.actorClass === 'agent') ok = false
    if (halted && i.actorClass === 'agent' && (action === 'reduce' || action === 'amend')) ok = false
    allowed[action] = ok
  }
  allowed.amend = allowed.reduce
  return allowed
}

function mandateChecks(i: GateInput, action: GateAction, byStage: Record<GateStage, RuleHit[]>): void {
  const m = i.mandate
  if (action === 'deadman_disarm' && i.actorClass === 'agent') {
    addPredicateHit(byStage, 'MANDATE', `${m?.mandateId ?? 'pol_none'}#deadmanDisarm`, 'MANDATE_LEVEL', 'human_or_system', 'agent', 'mandate')
    return
  }
  if (!m) {
    if (i.actorClass === 'agent' && action !== 'deadman_arm') addPredicateHit(byStage, 'MANDATE', 'pol_none#level', 'MANDATE_LEVEL', 'L1', 'missing', 'mandate')
    return
  }
  const id = m.mandateId
  const add = (field: string, code: RuleCode, limit: string | number, actual: string | number, actionKind: RuleHit['action'] = 'deny', message?: string): void => {
    addHit(byStage, 'MANDATE', `${id}#${field}`, code, limit, actual, field, 'mandate', actionKind, message)
  }
  const addPredicate = (field: string, code: RuleCode, expected: string, actual: string, actionKind: RuleHit['action'] = 'deny', message?: string): void => {
    addPredicateHit(byStage, 'MANDATE', `${id}#${field}`, code, expected, actual, 'mandate', actionKind, message)
  }
  if (i.actorClass === 'agent' && !i.mandateIntegrity.ok) { addPredicate('integrity', 'MANDATE_EXPIRED', 'valid', 'invalid', 'deny', 'mandate integrity is invalid'); return }
  if ((m.status !== 'active' && m.status !== 'downgraded') || i.now >= m.notAfter || i.now < m.notBefore) {
    add('validity', 'MANDATE_EXPIRED', m.notAfter, i.now, 'deny', `mandate is ${m.status === 'active' || m.status === 'downgraded' ? 'outside its validity window' : m.status}`)
    return
  }
  if (!m.accounts.includes(i.account.accountId as never)) addPredicate('accounts', 'MANDATE_LIMIT', m.accounts.join(','), i.account.accountId, 'deny', 'account is not covered by this mandate')
  const level = levelOf(m)
  if (level === 0) { addPredicate('level', 'MANDATE_LEVEL', 'L1', m.level, 'deny', '这把钥匙是只读档，不能下单'); return }
  if (i.actorClass !== 'agent' || action === 'deadman_arm') return
  if (i.account.mode === 'live') {
    const min = i.path === 'direct' ? 3 : 2
    if (level < min) addPredicate('level', 'MANDATE_LEVEL', `L${min}`, m.level, 'deny', `这把钥匙的档位不够：实盘账户${i.path === 'direct' ? '直接下单' : '提案'}至少要 L${min} 档`)
  }
  if (action === 'open' && i.account.mode === 'live' && level >= 3) {
    if (m.limits.autoMaxOrderNotional === undefined) addPredicate('autoMaxOrderNotional', 'MANDATE_INCOMPLETE', 'required', 'missing', 'review')
    if (m.limits.maxDailyLoss === undefined) addPredicate('maxDailyLoss', 'MANDATE_INCOMPLETE', 'required', 'missing', 'review')
    if (!m.instrumentAllowlist?.length) addPredicate('instrumentAllowlist', 'MANDATE_INCOMPLETE', 'non-empty', 'empty', 'review')
  }
}

/** Shared execution / risk reference for limit, trigger-market and ordinary market orders. */
export function gateRefPrice(intent: { type: string; price?: string | null; triggerPrice?: string | null } | undefined, mark?: string): string | undefined {
  if (intent?.price != null) return intent.price
  if (intent?.triggerPrice != null && ['stop_market', 'take_market', 'trailing_stop'].includes(intent.type)) return intent.triggerPrice
  return mark
}

export function evaluateGateStages(i: GateInput, approvedPluginLimits?: ReadonlyMap<string, Decimal>, originalApprovalNotional?: Decimal): GateStageEvaluation {
  const byStage = emptyStages()
  const monitorHits: RuleHit[] = []
  const sizeCaps: Array<{ size: Decimal; hit: RuleHit }> = []
  const policy = i.policy
  const limits = effectiveGateLimits(i)
  const action = effectiveGateAction(i)
  const intent = orderOf(i)
  const targetId = targetInstrumentId(i)
  const ruleBase = policyIdOf(policy)
  const pos = targetId ? i.snapshot.positions.find((p) => p.instrumentId === targetId) : undefined
  const isOpening = action === 'open'
  const isLev = action === 'leverage' && i.target.kind === 'leverage'
  const reference = gateRefPrice(intent, i.mark?.price)
  const refPrice = reference === undefined ? undefined : d.D(reference)
  const size = intent ? d.D(intent.size) : ZERO
  const contract = d.D(instrumentOf(i)?.contractSize ?? '1')
  const unitNotional = refPrice ? d.mul(refPrice, contract) : ZERO
  const orderNotional = refPrice && intent ? d.mul(size, unitNotional) : ZERO
  const approvalNotional = d.D(originalApprovalNotional ?? d.str(orderNotional))
  const lev = i.target.kind === 'leverage' ? i.target.leverage : intent?.leverage ?? pos?.leverage ?? 1
  const oldLev = pos && pos.leverage > 0 ? d.D(pos.leverage) : d.ONE
  const newLev = d.D(lev > 0 ? lev : 1)
  const positionNotional = pos ? positive(pos.notional) : ZERO
  const deltaNum = d.max(ZERO, d.mul(positionNotional, d.sub(oldLev, newLev)))
  const marginDen = d.mul(newLev, oldLev)
  const marginNeedNum = d.add(d.mul(orderNotional, oldLev), deltaNum)
  const openMode = coreActionMode(action, i.actorClass)

  // SYS: policy integrity and account / mark freshness.
  if (action !== 'deadman_arm') {
    if (!policy || !i.policyIntegrity.ok) {
      addPredicateHit(byStage, 'SYS', `${ruleBase}#integrity`, 'TRADING_STATE', 'ACTIVE', 'HALTED', 'org', openMode === 'none' ? 'warn' : openMode, `risk policy failed verification: ${i.policyIntegrity.problems[0] ?? 'missing'}`)
    }
    const mode = action === 'reduce' ? 'deny' : coreActionMode(action, i.actorClass)
    const staleAccountMs = policy?.failClosed.staleAccountMs ?? 30_000
    if (mode !== 'none' && i.snapshot.stale) {
      addPredicateHit(byStage, 'SYS', `${ruleBase}#staleAccount`, 'ACCOUNT_UNKNOWN', 'fresh', 'stale', 'account', mode)
    } else if (mode !== 'none' && i.snapshot.confirmedAt !== undefined && i.now - i.snapshot.confirmedAt > staleAccountMs) {
      addHit(byStage, 'SYS', `${ruleBase}#staleAccount`, 'ACCOUNT_UNKNOWN', staleAccountMs, i.now - i.snapshot.confirmedAt, 'ms', 'account', mode)
    }
    if ((i.target.kind === 'order' || i.target.kind === 'leverage') && mode !== 'none') {
      const stalePriceMs = policy?.failClosed.stalePriceMs ?? 5_000
      const invalidMark = !i.mark ? 'missing' : i.mark.source !== 'venue_mark' ? `source=${i.mark.source ?? 'missing'}` : !isDecimal(i.mark.price) || i.mark.price === '0' || i.mark.price.startsWith('-') ? `price=${i.mark.price}` : !Number.isInteger(i.mark.ts) || i.mark.ts < 0 || i.mark.ts > i.now ? `timestamp=${i.mark.ts}` : undefined
      if (invalidMark !== undefined) addPredicateHit(byStage, 'SYS', `${ruleBase}#failClosed`, 'STALE_PRICE', 'positive venue_mark', invalidMark, 'org', mode)
      else if (i.mark && i.now - i.mark.ts > stalePriceMs) {
        const actionMode = coreActionMode(action, i.actorClass)
        const staleMode = action === 'reduce' ? i.actorClass === 'agent' ? 'review' : 'warn' : actionMode === 'none' ? 'warn' : actionMode
        addHit(byStage, 'SYS', `${ruleBase}#failClosed`, 'STALE_PRICE', stalePriceMs, i.now - i.mark.ts, 'ms', 'org', staleMode)
      }
    }
    if ((i.actorClass === 'agent' || i.actorClass === 'human' || i.actorClass === 'system') && (i.target.kind === 'cancel' || i.target.kind === 'cancel_all') && i.cancelPriceChecks !== undefined) {
      const stalePriceMs = policy?.failClosed.stalePriceMs ?? 5_000
      for (const check of i.cancelPriceChecks) {
        const mark = check.mark
        const invalidMark = !mark ? 'missing' : mark.source !== 'venue_mark' ? `source=${mark.source ?? 'missing'}` : !isDecimal(mark.price) || mark.price === '0' || mark.price.startsWith('-') ? `price=${mark.price}` : !Number.isInteger(mark.ts) || mark.ts < 0 || mark.ts > i.now ? `timestamp=${mark.ts}` : undefined
        const ruleId = `${ruleBase}#cancelPrice:${check.instrumentId}`
        if (i.actorClass === 'agent') {
          if (invalidMark !== undefined) addPredicateHit(byStage, 'SYS', ruleId, 'STALE_PRICE', 'positive venue_mark', invalidMark, 'org', 'deny')
          else if (mark && i.now - mark.ts > stalePriceMs) addHit(byStage, 'SYS', ruleId, 'STALE_PRICE', stalePriceMs, i.now - mark.ts, 'ms', 'org', 'deny')
        } else if (invalidMark === undefined && mark && i.now - mark.ts > stalePriceMs) {
          addHit(byStage, 'SYS', ruleId, 'STALE_PRICE', stalePriceMs, i.now - mark.ts, 'ms', 'org', 'warn')
        }
      }
    }
  }

  // SYS: 附带止损止盈的价位与用法检查（ADR-2）。
  const tpslProblems = action === 'open' && intent
    ? checkTpsl({ side: intent.side, ref: refPrice, tpsl: intent.tpsl, actorClass: i.actorClass })
    : []
  for (const problem of tpslProblems) {
    addPredicateHit(byStage, 'SYS', `${ruleBase}#${problem.ruleId}`, 'TPSL_INVALID', problem.limit, problem.actual, 'org', 'deny', problem.message)
  }
  // ADR-3：Agent 开仓必须带止损（策略开启时；字段缺省 = 不要求）。
  if (checkStopRequired({ policyOn: policy?.requireStopOnAgentOpen === true, action, actorClass: i.actorClass, hasStop: intent?.tpsl?.stopLoss !== undefined })) {
    addPredicateHit(byStage, 'SYS', `${ruleBase}#requireStop`, 'STOP_REQUIRED', 'tpsl.stopLoss', 'missing', 'org', 'deny', 'Agent 开仓必须带止损（tpsl.stopLoss）；可在设置里关闭这条要求（需要 PIN）')
  }

  // KILL and STATE retain protective / reduce paths according to actor class.
  if (i.killSwitch.tripped && action !== 'deadman_arm') {
    const mode = action === 'reduce' && i.actorClass === 'agent' ? 'review' : coreActionMode(action, i.actorClass)
    if (mode !== 'none') addPredicateHit(byStage, 'KILL', `${ruleBase}#killSwitch`, 'KILL_SWITCH', 'ACTIVE', i.killSwitch.source ?? 'tripped', 'org', mode, i.killSwitch.reason)
  }
  if (action !== 'deadman_arm') for (const state of activeStates(i)) {
    const mode = action === 'reduce' && i.actorClass === 'agent' && state.state === 'HALTED' ? 'review' : coreActionMode(action, i.actorClass)
    if (mode !== 'none') addPredicateHit(byStage, 'STATE', `${ruleBase}#${state.protector ?? 'tradingState'}`, state.protector ? 'PROTECTOR' : 'TRADING_STATE', 'ACTIVE', state.state, state.scope.type, mode, state.reason)
  }

  // MANDATE, LLM, and allowlists.
  if (action !== 'deadman_arm') mandateChecks(i, action, byStage)
  if (policy && i.path !== 'proposal' && action !== 'deadman_arm' && (action === 'open' || action === 'leverage' || action === 'cancel_protective') && i.actorClass === 'agent') {
    const deny = effectiveDenyLlmLiveEntries(i.mandate?.denyLlmLiveEntries === undefined ? [policy.denyLlmLiveEntries] : [policy.denyLlmLiveEntries, i.mandate.denyLlmLiveEntries])
    if (isLlmLiveEntryDenied({ actorType: i.originActorType, accountMode: i.account.mode, opensOrIncreasesExposure: true, fromHumanApprovedProposal: i.path === 'approved', deny })) byStage.LLM.push(llmLiveEntryRuleHit(policy.policyId))
  }
  if (policy && (isOpening || isLev)) {
    const accountVenues = limits.venueAllowlist
    if (accountVenues?.length && !accountVenues.includes(i.account.venue)) addPredicateHit(byStage, 'ALLOWLIST', `${ruleBase}#venueAllowlist`, 'VENUE_NOT_ALLOWED', accountVenues.join(','), i.account.venue, 'account')
    const accountInstruments = limits.instrumentAllowlist
    if (accountInstruments?.length && targetId && !accountInstruments.includes(targetId as never)) addPredicateHit(byStage, 'ALLOWLIST', `${ruleBase}#instrumentAllowlist`, 'INSTRUMENT_NOT_ALLOWED', accountInstruments.join(','), targetId, 'account')
    const mandateVenues = i.mandate?.venueAllowlist
    if (mandateVenues?.length && !mandateVenues.includes(i.account.venue)) addPredicateHit(byStage, 'ALLOWLIST', `${i.mandate!.mandateId}#venueAllowlist`, 'VENUE_NOT_ALLOWED', mandateVenues.join(','), i.account.venue, 'mandate')
    const mandateInstruments = i.mandate?.instrumentAllowlist
    if (mandateInstruments?.length && targetId && !mandateInstruments.includes(targetId as never)) addPredicateHit(byStage, 'ALLOWLIST', `${i.mandate!.mandateId}#instrumentAllowlist`, 'INSTRUMENT_NOT_ALLOWED', mandateInstruments.join(','), targetId, 'mandate')
  }

  // CONST: only order / leverage targets use these checks.
  const instrument = instrumentOf(i)
  if (intent && instrument) {
    const size = d.D(intent.size)
    const minimum = d.D(instrument.size.min)
    if (d.lte(size, ZERO) || d.lt(size, minimum)) {
      addHit(byStage, 'CONST', `${instrument.instrumentId}#sizePrecision`, 'SIZE_PRECISION', d.str(minimum), d.str(size), instrument.base, 'instrument')
    }
    if (intent.reduceOnly === true) {
      const position = i.snapshot.positions.find((item) => item.instrumentId === intent.instrumentId)
      const opposite = position && (position.side === 'long' ? intent.side === 'sell' : intent.side === 'buy')
      const rawSize = i.assemblyAdjustments?.find((adjustment) => adjustment.field === 'size')?.from ?? intent.size
      if (!position || !opposite || d.gt(d.D(rawSize as string), d.D(position.size))) {
        addPredicateHit(byStage, 'CONST', `${intent.instrumentId}#reduceOnly`, 'REDUCE_ONLY_MISMATCH', 'opposite side and requested size <= position', `${intent.side}:${rawSize}; position=${position ? `${position.side}:${position.size}` : 'missing'}`, 'instrument', 'review')
      }
    }
    if (intent.expiresAt !== undefined && (!Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= i.now + 2_000)) {
      addPredicateHit(byStage, 'CONST', `${intent.instrumentId}#intentExpiry`, 'INTENT_EXPIRED', `safe integer > ${i.now + 2_000}`, String(intent.expiresAt), 'order')
    }
  }
  if (policy && isLev) {
    const target = i.target as Extract<GateTarget, { kind: 'leverage' }>
    const caps: Array<[number | undefined, string, string]> = [[limits.maxLeverage, `${ruleBase}#maxLeverage`, 'account'], [i.mandate?.limits.maxLeverage, `${i.mandate?.mandateId}#maxLeverage`, 'mandate'], [instrument?.maxLeverage, `${instrument?.instrumentId}#maxLeverage`, 'instrument']]
    for (const [cap, id, scope] of caps) if (cap !== undefined && target.leverage > cap) addHit(byStage, 'CONST', id, scope === 'mandate' ? 'MANDATE_LIMIT' : 'LEVERAGE', cap, target.leverage, 'x', scope)
    if (pos) {
      const currentMargin = d.div(positive(pos.notional), d.D(pos.leverage > 0 ? pos.leverage : 1))
      const nextMargin = d.div(positive(pos.notional), d.D(target.leverage > 0 ? target.leverage : 1))
      const need = d.max(ZERO, d.sub(nextMargin, currentMargin))
      const available = d.max(ZERO, d.sub(d.D(i.snapshot.available), d.D(i.reserved.account.margin)))
      if (d.gt(need, available)) addHit(byStage, 'BUYING_POWER', `${ruleBase}#margin`, 'INSUFFICIENT_MARGIN', d.str(available), d.str(need), instrument?.quote ?? 'account', 'account')
    }
  }
  if (policy && isOpening && intent && targetId) {
    const venueRules = i.venueRules
    const levCaps: Array<[number | undefined, string, string]> = [[limits.maxLeverage, `${ruleBase}#maxLeverage`, 'account'], [i.mandate?.limits.maxLeverage, `${i.mandate?.mandateId}#maxLeverage`, 'mandate'], [instrument?.maxLeverage, `${instrument?.instrumentId}#maxLeverage`, 'instrument']]
    for (const [cap, id, scope] of levCaps) if (cap !== undefined && lev > cap) addHit(byStage, 'CONST', id, scope === 'mandate' ? 'MANDATE_LIMIT' : 'LEVERAGE', cap, lev, 'x', scope)
    if (refPrice && d.gt(unitNotional, ZERO)) {
      const maxOrderCaps: Array<[Decimal | undefined, string, string, RuleCode]> = [[limits.maxOrderNotional, `${ruleBase}#maxOrderNotional`, 'account', 'ORDER_NOTIONAL'], [i.mandate?.limits.maxOrderNotional, `${i.mandate?.mandateId}#maxOrderNotional`, 'mandate', 'MANDATE_LIMIT']]
      for (const [cap, id, scope, code] of maxOrderCaps) if (cap !== undefined && d.gt(orderNotional, d.D(cap))) {
        const capSize = d.div(d.D(cap), unitNotional)
        addSizeCap(byStage, sizeCaps, 'CONST', id, code, cap, d.str(orderNotional), instrument?.quote ?? 'account', scope, capSize)
      }
      if (intent.maxSlippageBps !== undefined && intent.maxSlippageBps > limits.maxSlippageBps) addHit(byStage, 'CONST', `${ruleBase}#maxSlippageBps`, 'SLIPPAGE', limits.maxSlippageBps, intent.maxSlippageBps, 'bps', 'account')

      const minNotional = venueRules?.minOrderNotional ?? instrument?.minNotional
      if (minNotional !== undefined && d.lt(orderNotional, d.D(minNotional))) addHit(byStage, 'CONST', `${i.account.venue}#minOrderNotional`, 'ORDER_NOTIONAL', minNotional, d.str(orderNotional), instrument?.quote ?? 'account', 'venue')
      if (venueRules?.marketPriceBandBps !== undefined && i.mark && intent.price !== undefined && (intent.type === 'market' || intent.tif === 'ioc')) {
        const diff = d.abs(d.sub(d.D(intent.price), d.D(i.mark.price)))
        const bpsNumerator = d.mul(diff, d.D('10000'))
        const bps = d.div(bpsNumerator, d.D(i.mark.price), 8)
        if (d.gt(bpsNumerator, d.mul(d.D(i.mark.price), d.D(venueRules.marketPriceBandBps)))) addHit(byStage, 'CONST', `${i.account.venue}#marketPriceBandBps`, 'VENUE_RULE', venueRules.marketPriceBandBps, d.str(bps), 'bps', 'venue')
      }
    }
  }
  if (i.venueRules?.maxOpenOrders && intent && i.venueRules.maxOpenOrders.current + 1 > i.venueRules.maxOpenOrders.cap) {
    const trigger = ['stop_market', 'stop_limit', 'take_market', 'take_limit', 'trailing_stop'].includes(intent.type)
    const warn = action === 'reduce' || intent.reduceOnly === true || trigger
    addHit(byStage, 'CONST', `${i.account.venue}#maxOpenOrders`, 'VENUE_RULE', i.venueRules.maxOpenOrders.cap, i.venueRules.maxOpenOrders.current + 1, 'orders', 'venue', warn ? 'warn' : 'deny')
  }

  // EXPOSURE and daily notional.
  if (policy && isOpening && intent && targetId && refPrice && d.gt(unitNotional, ZERO)) {
    const equity = d.D(i.snapshot.equity)
    const exposure = exposureAfterOrder(i, intent, unitNotional)
    const pending = pendingNotional(i, targetId)
    const constraints: Array<{ cap: d.Dec; current: d.Dec; code: RuleCode; id: string; raw: string; scope: string }> = []
    if (limits.maxPositionNotionalRatio !== undefined) constraints.push({ cap: d.mul(equity, d.D(limits.maxPositionNotionalRatio)), current: exposure.afterExposure, code: 'POSITION_NOTIONAL', id: `${ruleBase}#maxPositionNotionalRatio`, raw: limits.maxPositionNotionalRatio, scope: 'account' })
    if (limits.maxTotalNotionalRatio !== undefined) constraints.push({ cap: d.mul(equity, d.D(limits.maxTotalNotionalRatio)), current: d.add(allOtherExposure(i, targetId), exposure.afterExposure), code: 'TOTAL_NOTIONAL', id: `${ruleBase}#maxTotalNotionalRatio`, raw: limits.maxTotalNotionalRatio, scope: 'account' })
    if (i.mandate?.limits.maxPositionNotional !== undefined) constraints.push({ cap: d.D(i.mandate.limits.maxPositionNotional), current: exposure.afterExposure, code: 'MANDATE_LIMIT', id: `${i.mandate.mandateId}#maxPositionNotional`, raw: i.mandate.limits.maxPositionNotional, scope: 'mandate' })
    for (const c of constraints) if (d.gt(c.current, c.cap)) {
      const other = c.code === 'TOTAL_NOTIONAL' ? allOtherExposure(i, targetId) : ZERO
      const sizeCap = sizeForExposure(c.cap, exposure.current, unitNotional, pending, other)
      const actual = c.code === 'POSITION_NOTIONAL' || c.code === 'TOTAL_NOTIONAL' ? d.str(ratio(c.current, equity)) : d.str(c.current)
      const limit = c.code === 'POSITION_NOTIONAL' || c.code === 'TOTAL_NOTIONAL' ? d.str(d.D(c.raw)) : c.raw
      addSizeCap(byStage, sizeCaps, 'EXPOSURE', c.id, c.code, limit, actual, c.code === 'POSITION_NOTIONAL' || c.code === 'TOTAL_NOTIONAL' ? 'ratio' : instrument?.quote ?? 'account', c.scope, sizeCap)
    }
    const dailyCaps: Array<[Decimal | undefined, d.Dec, string, string, RuleCode]> = [
      [limits.maxDailyNotional, d.add(d.D(i.stats.dailyNotional), d.D(i.reserved.today.notional)), `${ruleBase}#maxDailyNotional`, 'account', 'DAILY_NOTIONAL'],
      [i.mandate?.limits.maxDailyNotional, d.add(d.D(i.stats.mandateDailyNotional), d.D(i.reserved.today.notional)), `${i.mandate?.mandateId}#maxDailyNotional`, 'mandate', 'MANDATE_LIMIT'],
    ]
    for (const [cap, used, id, scope, code] of dailyCaps) if (cap !== undefined && d.gt(d.add(used, orderNotional), d.D(cap))) {
      addSizeCap(byStage, sizeCaps, 'EXPOSURE', id, code, cap, d.str(d.add(used, orderNotional)), instrument?.quote ?? 'account', scope, d.div(d.max(ZERO, d.sub(d.D(cap), used)), unitNotional))
    }
    const ids = new Set<string>()
    for (const p of i.snapshot.positions) ids.add(p.instrumentId)
    for (const o of i.snapshot.openOrders) if (o.count > 0) ids.add(o.instrumentId)
    for (const [id, value] of Object.entries(i.reserved.byInstrument)) if (value.long.count > 0 || value.short.count > 0) ids.add(id)
    const after = ids.size + (ids.has(targetId) ? 0 : 1)
    for (const [cap, id, scope, code] of [[limits.maxOpenPositions, `${ruleBase}#maxOpenPositions`, 'account', 'OPEN_POSITIONS'], [i.mandate?.limits.maxOpenPositions, `${i.mandate?.mandateId}#maxOpenPositions`, 'mandate', 'MANDATE_LIMIT']] as const) {
      if (cap !== undefined && after > cap) addHit(byStage, 'EXPOSURE', id, code, cap, after, 'count', scope)
    }
  }

  // BUYING_POWER for new orders.
  if (policy && isOpening && intent && targetId && refPrice && d.gt(unitNotional, ZERO)) {
    const available = d.max(ZERO, d.sub(d.D(i.snapshot.available), d.D(i.reserved.account.margin)))
    if (d.gt(marginNeedNum, d.mul(available, marginDen))) {
      const capNumerator = d.max(ZERO, d.sub(d.mul(available, marginDen), deltaNum))
      const maxSize = d.div(capNumerator, d.mul(unitNotional, oldLev))
      const required = d.div(marginNeedNum, marginDen, 18)
      addSizeCap(byStage, sizeCaps, 'BUYING_POWER', `${ruleBase}#margin`, 'INSUFFICIENT_MARGIN', d.str(available), d.str(required), instrument?.quote ?? 'account', 'account', maxSize)
    }
  }

  // LOSS: account drawdown ratio and mandate absolute loss.
  if (policy && isOpening && i.stats.dayStartEquity !== undefined) {
    const equity = d.D(i.snapshot.equity), start = d.D(i.stats.dayStartEquity)
    if (d.gt(start, ZERO)) {
      const loss = d.sub(start, equity)
      if (d.gt(loss, ZERO)) {
        const lossRatio = d.div(loss, start, 8)
        if (limits.maxDailyLossRatio !== undefined && d.gte(loss, d.mul(start, d.D(limits.maxDailyLossRatio)))) addHit(byStage, 'LOSS', `${ruleBase}#maxDailyLossRatio`, 'DAILY_LOSS', limits.maxDailyLossRatio, d.str(lossRatio), 'ratio', 'account')
        if (i.mandate?.limits.maxDailyLoss !== undefined && d.gte(loss, d.D(i.mandate.limits.maxDailyLoss))) addHit(byStage, 'LOSS', `${i.mandate.mandateId}#maxDailyLoss`, 'MANDATE_LIMIT', i.mandate.limits.maxDailyLoss, d.str(loss), instrument?.quote ?? 'account', 'mandate')
      }
    }
  }

  // RATE: order budgets, cancellation budgets, and duplicate intents.
  if (policy) {
    if (isOpening) {
      const orderCaps: Array<[number | undefined, number, string, string]> = [[limits.maxOrdersPerMinute, i.stats.ordersLastMinute, `${ruleBase}#maxOrdersPerMinute`, 'account'], [i.mandate?.limits.maxOrdersPerMinute, i.stats.mandateOrdersLastMinute, `${i.mandate?.mandateId}#maxOrdersPerMinute`, 'mandate']]
      for (const [cap, used, id, scope] of orderCaps) if (cap !== undefined && used + 1 > cap) addHit(byStage, 'RATE', id, 'RATE_BUDGET', cap, used + 1, 'orders/min', scope)
      if (i.rate && i.rate.used + 1 > i.rate.limit) addHit(byStage, 'RATE', `${i.account.venue}#rateBudget`, 'RATE_BUDGET', i.rate.limit, i.rate.used + 1, 'weight/min', 'venue')
      const daily: Array<[number | undefined, number, string, string]> = [[limits.maxDailyOrders, i.stats.ordersToday, `${ruleBase}#maxDailyOrders`, 'account'], [i.mandate?.limits.maxDailyOrders, i.stats.mandateOrdersToday, `${i.mandate?.mandateId}#maxDailyOrders`, 'mandate']]
      for (const [cap, used, id, scope] of daily) if (cap !== undefined && used + 1 > cap) addHit(byStage, 'RATE', id, scope === 'mandate' ? 'MANDATE_LIMIT' : 'RATE_BUDGET', cap, used + 1, 'orders/day', scope)
      if (i.stats.duplicateOf) addHit(byStage, 'RATE', `${ruleBase}#duplicateIntent`, 'COOLDOWN', limits.duplicateIntentWindowSec ?? 10, 0, 's', 'account')
    } else if (action === 'reduce') {
      const orderCaps: Array<[number | undefined, number, string, string]> = [[limits.maxOrdersPerMinute, i.stats.ordersLastMinute, `${ruleBase}#maxOrdersPerMinute`, 'account'], [i.mandate?.limits.maxOrdersPerMinute, i.stats.mandateOrdersLastMinute, `${i.mandate?.mandateId}#maxOrdersPerMinute`, 'mandate']]
      for (const [cap, used, id, scope] of orderCaps) if (cap !== undefined && used + 1 > cap) addHit(byStage, 'RATE', id, 'RATE_BUDGET', cap, used + 1, 'orders/min', scope, 'warn')
      const reductionWeight = intent?.expiresAt === undefined ? 1 : 5
      if (i.rate && i.rate.used + reductionWeight > i.rate.limit) addHit(byStage, 'RATE', `${i.account.venue}#rateBudget`, 'RATE_BUDGET', i.rate.limit, i.rate.used + reductionWeight, 'weight/min', 'venue', 'warn')
    } else if ((action === 'cancel' || action === 'cancel_protective') && i.actorClass !== 'system' && i.rate) {
      if (i.rate.used + 1 > i.rate.limit) addHit(byStage, 'RATE', `${i.account.venue}#rateBudget`, 'RATE_BUDGET', i.rate.limit, i.rate.used + 1, 'weight/min', 'venue', 'warn')
    }
  }

  // PROTECTOR: cooldown plus plugin/template decisions.
  const orderedProtectors = (policy?.protectors ?? []).map((protector, index) => ({ protector, index })).sort((a, b) => (a.protector.order ?? 0) - (b.protector.order ?? 0) || a.index - b.index).map(({ protector }) => protector)
  // Approved path only carries human-approved proposals, so cooldown (an agent-side throttle) does not apply there.
  if (policy && isOpening && i.path !== 'approved') for (const protector of orderedProtectors) {
    if (protector.kind === 'cooldown' && protector.afterOpenSec > 0 && i.stats.lastOpenTs !== undefined) {
      const gap = i.now - i.stats.lastOpenTs
      if (gap < protector.afterOpenSec * 1000) {
        if (protector.mode === 'monitor') monitorHits.push({ ruleId: `${ruleBase}#cooldown`, code: 'COOLDOWN', limit: asDecimal(protector.afterOpenSec), actual: asDecimal(Math.max(0, Math.floor(gap / 1000))), unit: 's', action: 'warn', scope: 'account' })
        else addHit(byStage, 'PROTECTOR', `${ruleBase}#cooldown`, 'COOLDOWN', protector.afterOpenSec, Math.max(0, Math.floor(gap / 1000)), 's', 'account')
      }
    }
  }
  const configuredPlugins = orderedProtectors.filter((p): p is Extract<Protector, { kind: 'plugin' }> => p.kind === 'plugin')
  let unavailableEnforce = false
  for (const protector of configuredPlugins) {
    if (!isOpening) continue
    const orderNo = protector.order ?? 0
    const result = i.protectorResults.find((r) => r.pluginId === protector.pluginId && r.order === orderNo)
    const mode = protector.mode ?? 'enforce'
    if (!result || result.result.action === 'unavailable') {
      if (mode === 'monitor') {
        monitorHits.push({ ruleId: `${protector.pluginId}#${orderNo}`, code: 'PROTECTOR_UNAVAILABLE', message: 'expected=available; actual=unavailable', limit: asDecimal('0'), actual: asDecimal('1'), unit: 'violations', action: 'warn', scope: 'plugin' })
      } else unavailableEnforce = true
      continue
    }
    if (result.result.action === 'pass') continue
    let code: RuleCode = result.result.action === 'block' ? result.result.code ?? 'PROTECTOR' : 'PROTECTOR'
    let actual: string | number = result.result.action === 'pause' ? result.result.minutes : result.result.action === 'limit' ? result.result.to : 1
    let limit: string | number = result.result.action === 'pause' ? 1440 : result.result.action === 'limit' ? intent?.size ?? '0' : 0
    let message = 'message' in result.result ? result.result.message : 'plugin protector result'
    let hitAction: RuleHit['action'] = result.result.action === 'limit' ? 'limit' : 'deny'
    const approvedLimitKey = `${protector.pluginId}\u0000${orderNo}`
    if (result.result.action === 'limit' && approvedPluginLimits?.get(approvedLimitKey) === result.result.to && intent && d.lte(d.D(intent.size), d.D(result.result.to))) continue
    const invalid = result.result.action === 'pause' && !(result.result.minutes > 0 && result.result.minutes <= 1440)
      || result.result.action === 'limit' && (!intent || d.lte(d.D(result.result.to), ZERO) || d.gte(d.D(result.result.to), d.D(intent.size)))
    if (invalid && mode === 'enforce') { unavailableEnforce = true; continue }
    if (invalid) { code = 'PROTECTOR_UNAVAILABLE'; hitAction = 'warn'; message = 'invalid protector result'; limit = 1; actual = 0 }
    const hit: RuleHit = { ruleId: `${protector.pluginId}#${orderNo}`, code, message, limit: asDecimal(limit), actual: asDecimal(actual), unit: result.result.action, action: mode === 'monitor' ? 'warn' : hitAction, scope: 'plugin' }
    if (mode === 'monitor') monitorHits.push(hit)
    else {
      byStage.PROTECTOR.push(hit)
      if (hitAction === 'limit' && result.result.action === 'limit' && !invalid) sizeCaps.push({ size: result.result.to, hit })
    }
    if (invalid && mode === 'enforce') unavailableEnforce = true
  }
  // APPROVAL: only agent actions requiring a human decision.
  if (i.actorClass === 'agent' && action !== 'deadman_arm' && action !== 'deadman_disarm') {
    if (action === 'cancel_protective' && i.path !== 'approved') addPredicateHit(byStage, 'APPROVAL', `${i.mandate?.mandateId ?? ruleBase}#approval`, 'NEEDS_APPROVAL', 'approved', 'direct', 'mandate', 'review', APPROVAL_MESSAGE)
    else if (action === 'open' && i.path !== 'approved' && i.mandate?.level === 'L2') addPredicateHit(byStage, 'APPROVAL', `${i.mandate.mandateId}#approval`, 'NEEDS_APPROVAL', 'approved', i.path, 'mandate', 'review', APPROVAL_MESSAGE)
    else if ((action === 'open' || action === 'leverage') && i.account.mode === 'live' && i.path === 'proposal') addPredicateHit(byStage, 'APPROVAL', `${i.mandate?.mandateId ?? ruleBase}#approval`, 'NEEDS_APPROVAL', 'approved', 'proposal', 'mandate', 'review', APPROVAL_MESSAGE)
    else if (action === 'open' && i.path !== 'approved' && i.mandate?.limits.autoMaxOrderNotional !== undefined && d.gt(approvalNotional, d.D(i.mandate.limits.autoMaxOrderNotional))) {
      const cap = i.mandate.limits.autoMaxOrderNotional
      addHit(byStage, 'APPROVAL', `${i.mandate.mandateId}#autoMaxOrderNotional`, 'NEEDS_APPROVAL', cap, d.str(approvalNotional), instrument?.quote ?? 'account', 'mandate', 'review')
    }
  }

  const otherBlocking = [...GATE_STAGES].filter((s) => s !== 'PROTECTOR' && s !== 'PROTECTOR:skipped').some((s) => byStage[s].some((h) => h.action === 'deny' || h.action === 'review'))
  let skipped = false
  if (unavailableEnforce) {
    if (otherBlocking) skipped = true
    else addPredicateHit(byStage, 'PROTECTOR', `${ruleBase}#protectorUnavailable`, 'PROTECTOR_UNAVAILABLE', 'available', 'unavailable', 'plugin')
  }

  // Estimates preserve M1's precheck values for order targets.
  let estimates: PrecheckEstimates = {}
  if (intent) {
    const taker = instrument?.fees?.taker ?? '0.00045'
    const maker = instrument?.fees?.maker ?? '0.00015'
    const isTaker = intent.type === 'market' || intent.tif === 'ioc'
    const fee = d.mul(orderNotional, d.D(isTaker ? taker : maker))
    // 附带合规止损时给出最大亏损估算；无止损或止损不合规不加该键。
    const stopLoss = intent.tpsl?.stopLoss
    const maxLoss = action === 'open' && stopLoss !== undefined && refPrice !== undefined && !tpslProblems.some((problem) => problem.ruleId === 'tpsl:stopLoss')
      ? d.str(d.add(d.mul(d.mul(size, contract), d.abs(d.sub(refPrice, d.D(stopLoss.triggerPrice)))), fee))
      : undefined
    const liquidationPrice = refPrice ? liquidationEstimate(refPrice, intent.side, lev, instrument?.maxLeverage) : undefined
    estimates = {
      notional: d.str(orderNotional),
      marginRequired: action === 'reduce' ? '0' as Decimal : d.str(d.div(marginNeedNum, marginDen, 18)),
      feeEstimate: d.str(fee),
      ...(maxLoss !== undefined ? { maxLoss } : {}),
      ...(liquidationPrice ? { liquidationPrice } : {}),
      ...(intent.maxSlippageBps !== undefined ? { slippageBps: intent.maxSlippageBps } : {}),
      ...(i.rate ? { rateBudgetRemaining: Math.max(0, i.rate.limit - i.rate.used) } : {}),
    }
  }
  const applicable = applicableStages(i, action, skipped)
  const returnedStages: Partial<Record<GateStage, RuleHit[]>> = {}
  for (const stage of GATE_STAGES) if (applicable.has(stage)) returnedStages[stage] = byStage[stage]
  return { byStage: returnedStages, monitorHits, estimates, sizeCaps, allowedActions: allowedActionsFor(i) }
}
