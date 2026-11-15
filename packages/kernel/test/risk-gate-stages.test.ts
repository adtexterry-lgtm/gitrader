// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { validateBySchemaId } from '@gitrader/protocol'
import { asDecimal, type AccountId, type ClientOrderId, type Decimal, type GateInput, type GateStage, type GateTarget, type InstrumentId, type Mandate, type PrecheckId, type RiskPolicy, type RuleHit, type Sha256Digest, type VenueId } from '@gitrader/protocol'
import { adjustedGateTarget, effectiveGateAction, effectiveGateLimits, evaluateGateStages } from '../src/risk-gate/stages'

const decimal = (value: string): Decimal => asDecimal(value)
const accountId = 'acct_test' as AccountId
const instrumentId: InstrumentId = 'venue:asset'
const intentOrder = (extra: Partial<Extract<GateTarget, { kind: 'order' }>['intent']> = {}): Extract<GateTarget, { kind: 'order' }>['intent'] => ({
  accountId, instrumentId, side: 'buy', type: 'limit', size: decimal('2'), price: decimal('10'),
  tif: 'gtc', clientOrderId: '0123456789abcdef0123456789abcdef' as ClientOrderId, ...extra,
})
const policy = (extra: Partial<RiskPolicy> = {}): RiskPolicy => ({
  policyId: 'pol_test', version: 1, scope: { type: 'account', id: accountId },
  limits: { maxSlippageBps: 50 }, failClosed: { stalePriceMs: 5000, staleAccountMs: 30000, onMissingPrice: 'deny' },
  dailyResetAt: '00:00Z', valuationCcy: 'USD',
  attestation: { method: 'system', by: 'kernel', at: 1, digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Sha256Digest, sig: 'signature' },
  ...extra,
})
const mandate = (level: Mandate['level'] = 'L3', extra: Partial<Mandate> = {}): Mandate => ({
  mandateId: 'mdt_test', version: 1, subject: { type: 'agentKey', id: 'ak_test' }, level,
  accounts: [accountId], instrumentAllowlist: [instrumentId], venueAllowlist: ['venue' as VenueId],
  limits: { maxOrderNotional: decimal('100000'), maxDailyNotional: decimal('100000'), maxDailyLoss: decimal('100000'), autoMaxOrderNotional: decimal('100000') },
  notBefore: 0, notAfter: 100000, status: 'active', issuedBy: 'user:test',
  attestation: { method: 'system', by: 'kernel', at: 1, digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Sha256Digest, sig: 'signature' },
  ...extra,
})
const base = (overrides: Partial<GateInput> = {}): GateInput => {
  const input: GateInput = {
  precheckId: 'pck_test' as PrecheckId, dryRun: true, action: 'open', actorClass: 'agent', originActorType: 'engine',
  account: { accountId, venue: 'venue' as VenueId, mode: 'paper', groupIds: [] },
  snapshot: { equity: decimal('1000'), available: decimal('1000'), availableDeductsOpenOrders: false, positions: [], openOrders: [], stopLossOrderIds: [], asOf: 0 as GateInput['now'], stale: false },
  mark: { price: decimal('10'), ts: 1000 as GateInput['now'], source: 'venue_mark' }, mandate: mandate(), mandateIntegrity: { ok: true, problems: [] },
  policy: policy(), policyIntegrity: { ok: true, problems: [] }, path: 'direct', now: 1000,
  stats: { dailyNotional: decimal('0'), mandateDailyNotional: decimal('0'), ordersLastMinute: 0, mandateOrdersLastMinute: 0, ordersToday: 0, mandateOrdersToday: 0 },
  reserved: { account: { margin: decimal('0'), notional: decimal('0'), count: 0 }, byInstrument: {}, today: { notional: decimal('0'), count: 0 }, lastMinute: { count: 0 } },
  states: [], killSwitch: { tripped: false }, protectorResults: [], target: { kind: 'order', intent: intentOrder() },
  instrument: { instrumentId, venue: 'venue' as VenueId, symbol: 'ASSET', displaySymbol: 'ASSET', kind: 'perp', base: 'ASSET', quote: 'USD', settle: 'USD', settlement: 'linear', contractSize: decimal('1'), venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading', price: { sigFigs: 5, maxDecimals: 2 }, size: { step: decimal('1'), decimals: 0, min: decimal('1') }, minNotional: decimal('1'), maxLeverage: 20, marginModes: ['cross'], orderTypes: ['limit'], tif: ['gtc'], triggerPriceTypes: ['mark'], fundingIntervalMs: 60000, fees: { maker: decimal('0'), taker: decimal('0'), source: 'venue' }, updatedAt: 0 },
  }
  return Object.assign(input, overrides)
}
const hits = (i: GateInput, stage: GateStage): RuleHit[] => evaluateGateStages(i).byStage[stage] ?? []

describe('risk gate stages', () => {
  it('values trigger-market orders at triggerPrice and trigger-limit orders at price', () => {
    const trigger = base({ target: { kind: 'order', intent: intentOrder({ type: 'stop_market', price: undefined, triggerPrice: decimal('30') }) } })
    expect(evaluateGateStages(trigger).estimates.notional).toBe('60')
    const limit = base({ target: { kind: 'order', intent: intentOrder({ type: 'stop_limit', price: decimal('25'), triggerPrice: decimal('30') }) } })
    expect(evaluateGateStages(limit).estimates.notional).toBe('50')
  })

  it.each([
    ['mandate account membership', base({ mandate: mandate('L3', { accounts: ['acct_other' as AccountId] }) }), 'MANDATE_LIMIT', 'expected=acct_other'],
    ['account instrument allowlist', base({ policy: policy({ limits: { maxSlippageBps: 50, instrumentAllowlist: ['venue:other' as InstrumentId] } }) }), 'INSTRUMENT_NOT_ALLOWED', 'expected=venue:other'],
    ['proposal approval path', base({ account: { accountId, venue: 'venue' as VenueId, mode: 'live', groupIds: [] }, path: 'proposal' }), 'NEEDS_APPROVAL', 'expected=approved'],
    ['missing mark', base({ mark: undefined }), 'STALE_PRICE', 'expected=positive venue_mark'],
  ])('encodes nonnumeric %s as a decimal predicate hit', (_name, input, code, expectedMessage) => {
    const evaluation = evaluateGateStages(input as GateInput)
    const hit = Object.values(evaluation.byStage).flat().find((candidate) => candidate.code === code)
    expect(hit).toBeDefined()
    expect(hit).toMatchObject({ limit: decimal('0'), actual: decimal('1'), unit: 'violations' })
    expect(hit?.message).toContain(expectedMessage)
    expect(validateBySchemaId('urn:gitrader:schema:model:0.1:RuleHit', hit).ok).toBe(true)
  })

  it('applies action and actor policy to SYS, KILL, STATE, and allowedActions', () => {
    const broken = base({ policyIntegrity: { ok: false, problems: ['bad'] } })
    expect(hits(broken, 'SYS').map((h) => h.code)).toContain('TRADING_STATE')
    expect(hits({ ...broken, action: 'reduce' }, 'SYS').every((h) => h.action === 'warn')).toBe(true)
    expect(hits({ ...broken, action: 'deadman_arm' }, 'SYS')).toHaveLength(0)
    const killed = evaluateGateStages(base({ killSwitch: { tripped: true }, action: 'open' }))
    expect(killed.byStage.KILL?.[0]?.code).toBe('KILL_SWITCH')
    expect(killed.allowedActions.open).toBe(false)
    expect(killed.allowedActions.deadman_arm).toBe(true)
    expect(killed.allowedActions.cancel_protective).toBe(false)
    expect(evaluateGateStages(base({ actorClass: 'human', killSwitch: { tripped: true } })).allowedActions.cancel_protective).toBe(true)
  })

  it('uses confirmedAt or stale, never legacy asOf, for account freshness', () => {
    const stale = base({ now: 31001, snapshot: { ...base().snapshot, asOf: 0, confirmedAt: 1000 } })
    expect(hits(stale, 'SYS').map((h) => h.code)).toContain('ACCOUNT_UNKNOWN')
    const legacy = base({ snapshot: { ...base().snapshot, asOf: 0 } })
    expect(hits(legacy, 'SYS').map((h) => h.code)).not.toContain('ACCOUNT_UNKNOWN')
    const staleReduce = base({ action: 'reduce', snapshot: { ...base().snapshot, stale: true } })
    expect(hits(staleReduce, 'SYS')).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_UNKNOWN', action: 'deny' }))
  })

  it('collects independent constant violations and preserves the legacy maxOrderNotional rule id', () => {
    const i = base({
      target: { kind: 'order', intent: intentOrder({ leverage: 5, size: decimal('4') }) },
      policy: policy({ limits: { maxSlippageBps: 50, maxLeverage: 2, maxOrderNotional: decimal('20') } }),
    })
    expect(hits(i, 'CONST').map((h) => h.ruleId)).toContain('pol_test#maxLeverage')
    expect(hits(i, 'CONST').map((h) => h.ruleId)).toContain('pol_test#maxOrderNotional')
  })

  it('includes reserved exposure and reserved margin in open-order checks', () => {
    const i = base({
      policy: policy({ limits: { maxSlippageBps: 50, maxPositionNotionalRatio: decimal('0.1'), maxTotalNotionalRatio: decimal('0.1') } }),
      target: { kind: 'order', intent: intentOrder({ size: decimal('4') }) },
      snapshot: { ...base().snapshot, available: decimal('1'), positions: [{ instrumentId, side: 'long', size: decimal('5'), notional: decimal('50'), leverage: 1 }], openOrders: [{ instrumentId, side: 'buy', notional: decimal('10'), count: 1 }] },
      reserved: { account: { margin: decimal('5'), notional: decimal('7'), count: 1 }, byInstrument: { [instrumentId]: { long: { notional: decimal('7'), count: 1 }, short: { notional: decimal('0'), count: 0 } } }, today: { notional: decimal('0'), count: 0 }, lastMinute: { count: 0 } },
    })
    expect(hits(i, 'EXPOSURE').map((h) => h.code)).toContain('POSITION_NOTIONAL')
    expect(hits(i, 'BUYING_POWER').map((h) => h.code)).toContain('INSUFFICIENT_MARGIN')
  })

  it('accounts for existing and other-instrument exposure when computing size caps', () => {
    const positionCap = base({
      policy: policy({ limits: { maxSlippageBps: 50, maxPositionNotionalRatio: decimal('0.1') } }),
      target: { kind: 'order', intent: intentOrder({ size: decimal('3') }) },
      snapshot: { ...base().snapshot, positions: [{ instrumentId, side: 'long', size: decimal('7'), notional: decimal('70'), leverage: 1 }], openOrders: [{ instrumentId, side: 'buy', notional: decimal('10'), count: 1 }] },
    })
    expect(evaluateGateStages(positionCap).sizeCaps).toContainEqual(expect.objectContaining({ size: '2', hit: expect.objectContaining({ code: 'POSITION_NOTIONAL' }) }))

    const totalCap = base({
      policy: policy({ limits: { maxSlippageBps: 50, maxTotalNotionalRatio: decimal('0.1') } }),
      target: { kind: 'order', intent: intentOrder({ size: decimal('5') }) },
      snapshot: { ...base().snapshot, positions: [
        { instrumentId, side: 'long', size: decimal('2'), notional: decimal('20'), leverage: 1 },
        { instrumentId: 'venue:other', side: 'long', size: decimal('3'), notional: decimal('30'), leverage: 1 },
      ], openOrders: [{ instrumentId, side: 'buy', notional: decimal('10'), count: 1 }] },
    })
    expect(evaluateGateStages(totalCap).sizeCaps).toContainEqual(expect.objectContaining({ size: '4', hit: expect.objectContaining({ code: 'TOTAL_NOTIONAL' }) }))
  })

  it('checks leverage cap and margin increase for leverage targets', () => {
    const i = base({
      action: 'leverage', target: { kind: 'leverage', instrumentId: 'venue:asset', leverage: 10 },
      policy: policy({ limits: { maxSlippageBps: 50, maxLeverage: 5 } }),
      snapshot: { ...base().snapshot, available: decimal('0'), positions: [{ instrumentId, side: 'long', size: decimal('2'), notional: decimal('100'), leverage: 20 }] },
    })
    expect(hits(i, 'CONST').map((h) => h.code)).toContain('LEVERAGE')
    expect(hits(i, 'BUYING_POWER').map((h) => h.code)).toContain('INSUFFICIENT_MARGIN')
  })

  it('warns instead of blocking when trigger orders hit the venue order cap', () => {
    const i = base({ target: { kind: 'order', intent: intentOrder({ type: 'stop_market', triggerPrice: decimal('9') }) }, venueRules: { maxOpenOrders: { cap: 10, current: 10 } } })
    expect(hits(i, 'CONST')).toContainEqual(expect.objectContaining({ code: 'VENUE_RULE', action: 'warn' }))
  })

  it('exempts system cancellations from rate checks and warns when reduce budget is exhausted', () => {
    const systemCancel = base({ action: 'cancel', actorClass: 'system', rate: { used: 1, limit: 1 }, policy: policy({ limits: { maxSlippageBps: 50, maxCancelsPerMinute: 1 } }) })
    const agentCancel = { ...systemCancel, actorClass: 'agent' as const }
    expect(hits(systemCancel, 'RATE')).toHaveLength(0)
    expect(hits(agentCancel, 'RATE').some((h) => h.code === 'RATE_BUDGET')).toBe(true)
    const reducing = base({ action: 'reduce', rate: { used: 1, limit: 1 } })
    expect(hits(reducing, 'RATE').every((h) => h.action === 'warn')).toBe(true)
  })

  it('separates monitor results and marks missing enforce results skipped after another denial', () => {
    const monitorPolicy = policy({ protectors: [{ kind: 'plugin', pluginId: 'plug_monitor', order: 1, mode: 'monitor', source: { pluginId: 'plug_monitor', version: '1' } }] })
    const monitor = base({ policy: monitorPolicy, protectorResults: [{ pluginId: 'plug_monitor', version: '1', sourceDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', order: 1, mode: 'monitor', seq: 1, result: { action: 'block', code: 'PROTECTOR', message: 'fixture monitor block' }, durationUs: 0 }] })
    expect(evaluateGateStages(monitor).monitorHits).toEqual([expect.objectContaining({ action: 'warn' })])
    const enforcePolicy = policy({ protectors: [{ kind: 'plugin', pluginId: 'plug_enforce', order: 1, source: { pluginId: 'plug_enforce', version: '1' } }] })
    const denied = base({ policy: enforcePolicy, killSwitch: { tripped: true } })
    expect(evaluateGateStages(denied).byStage['PROTECTOR:skipped']).toEqual([])
    expect(hits(base({ policy: enforcePolicy }), 'PROTECTOR').map((h) => h.code)).toContain('PROTECTOR_UNAVAILABLE')
  })

  it('accepts valid plugin limits and evaluates protectors by stable order', () => {
    const protectors = [
      { kind: 'cooldown' as const, afterOpenSec: 2, mode: 'enforce' as const, order: 2 },
      { kind: 'cooldown' as const, afterOpenSec: 1, mode: 'enforce' as const, order: 1 },
      { kind: 'plugin' as const, pluginId: 'plug_two', order: 2, source: { pluginId: 'plug_two', version: '1' } },
      { kind: 'plugin' as const, pluginId: 'plug_one', order: 1, source: { pluginId: 'plug_one', version: '1' } },
    ]
    const input = base({
      now: 5000,
      stats: { ...base().stats, lastOpenTs: 4500 },
      policy: policy({ protectors }),
      protectorResults: [
        { pluginId: 'plug_two', version: '1', sourceDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', order: 2, mode: 'enforce', seq: 1, result: { action: 'limit', field: 'size', to: decimal('1'), message: 'fixture limit' }, durationUs: 0 },
        { pluginId: 'plug_one', version: '1', sourceDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', order: 1, mode: 'enforce', seq: 1, result: { action: 'block', code: 'PROTECTOR', message: 'fixture blocked' }, durationUs: 0 },
      ],
    })
    const result = evaluateGateStages(input)
    expect(result.sizeCaps).toContainEqual(expect.objectContaining({ size: '1', hit: expect.objectContaining({ ruleId: 'plug_two#2', action: 'limit' }) }))
    expect(result.byStage.PROTECTOR?.map((h) => h.ruleId)).toEqual(['pol_test#cooldown', 'pol_test#cooldown', 'plug_one#1', 'plug_two#2'])
    expect(result.byStage.PROTECTOR?.slice(0, 2).map((h) => h.limit)).toEqual(['1', '2'])
  })

  it('returns only applicable stage keys and omits price checks for targetless cancel and arm', () => {
    const cancel = base({ action: 'cancel', target: { kind: 'cancel', targets: [{ orderId: 'order_test', clientOrderId: '0123456789abcdef0123456789abcdef' }] }, mark: undefined })
    const result = evaluateGateStages(cancel)
    expect(Object.keys(result.byStage)).not.toContain('ALLOWLIST')
    expect(Object.keys(result.byStage)).not.toContain('EXPOSURE')
    expect(Object.keys(result.byStage)).not.toContain('PROTECTOR')
    expect(hits(cancel, 'SYS').map((h) => h.code)).not.toContain('STALE_PRICE')
    expect(evaluateGateStages(base({ action: 'deadman_arm', target: { kind: 'deadman', atMs: 2000 } })).byStage).toEqual({})
  })

  it('preserves explicit false LLM policy and separates mandate enforcement from allowed actions', () => {
    const withoutOverride = mandate()
    delete (withoutOverride as Partial<Mandate>).denyLlmLiveEntries
    const llm = base({
      account: { accountId: 'acct_test', venue: 'venue', mode: 'live', groupIds: [] },
      path: 'direct', originActorType: 'llm-agent',
      policy: policy({ denyLlmLiveEntries: false }), mandate: withoutOverride,
    })
    expect(hits(llm, 'LLM').map((h) => h.code)).not.toContain('LLM_LIVE_ENTRY')
    const invalid = evaluateGateStages(base({ mandateIntegrity: { ok: false, problems: ['bad'] } }))
    expect(invalid.byStage.MANDATE?.map((h) => h.code)).toContain('MANDATE_EXPIRED')
    expect(invalid.byStage.MANDATE).toContainEqual(expect.objectContaining({ code: 'MANDATE_EXPIRED', action: 'deny' }))
    expect(invalid.allowedActions.open).toBe(true)
  })

  it('compares drawdown ratios and market price bands without display rounding', () => {
    const loss = base({
      snapshot: { ...base().snapshot, equity: decimal('970000000.003') },
      stats: { ...base().stats, dayStartEquity: decimal('1000000000') },
      policy: policy({ limits: { maxSlippageBps: 50, maxDailyLossRatio: decimal('0.029999999995') } }),
    })
    expect(hits(loss, 'LOSS').map((h) => h.code)).toContain('DAILY_LOSS')
    const band = base({
      target: { kind: 'order', intent: intentOrder({ type: 'market', tif: 'ioc', price: decimal('100.00000000001') }) },
      mark: { price: decimal('100'), ts: 1000 as GateInput['now'], source: 'venue_mark' },
      instrument: base().instrument,
      venueRules: { marketPriceBandBps: 0 },
    })
    expect(hits(band, 'CONST').map((h) => h.code)).toContain('VENUE_RULE')
  })

  it('uses the input action except that amend follows the amended intent', () => {
    const i = base({ action: 'amend', target: { kind: 'order', intent: intentOrder({ reduceOnly: true }) } })
    expect(effectiveGateAction(i)).toBe('reduce')
    expect(effectiveGateAction(base({ action: 'amend' }))).toBe('open')
    expect(effectiveGateLimits(base({ policy: policy({ temporaryRelax: { fields: { maxOrderNotional: decimal('2') }, from: 500, until: 1500, revertToVersion: 1 } }) }))).toMatchObject({ maxOrderNotional: '2' })
  })

  it('fix-r4 C13：审批命中带人话说明，解释串里仍有 expected=…', () => {
    const live = base({ account: { accountId, venue: 'venue' as VenueId, mode: 'live', groupIds: [] }, path: 'proposal' })
    const hit = Object.values(evaluateGateStages(live).byStage).flat().find((h) => h.code === 'NEEDS_APPROVAL')
    expect(hit?.message).toContain('order needs human approval under this mandate; submit as proposal')
    expect(hit?.message).toContain('expected=approved; actual=proposal')
  })

  it('fix-r4：1 倍买单强平价代数上为 0 → 不输出 liquidationPrice；2 倍买单照常输出', () => {
    const buy = (leverage: number) => evaluateGateStages(base({ target: { kind: 'order', intent: intentOrder({ side: 'buy', leverage }) } })).estimates
    expect(buy(1)).not.toHaveProperty('liquidationPrice')
    expect(Number(buy(2).liquidationPrice)).toBeGreaterThan(0)
  })

  it('clones targets and applies only size adjustments', () => {
    const original: GateTarget = { kind: 'order', intent: intentOrder({ size: decimal('5'), leverage: 3 }) }
    const adjusted = adjustedGateTarget(original, [
      { ruleId: 'pol_test#maxOrderNotional', code: 'ORDER_NOTIONAL', field: 'size', from: decimal('5'), to: decimal('2'), unit: 'size' },
      { ruleId: 'pol_test#maxLeverage', code: 'LEVERAGE', field: 'leverage', from: 3, to: 2, unit: 'x' },
    ])
    expect(adjusted).not.toBe(original)
    expect((adjusted as Extract<GateTarget, { kind: 'order' }>).intent.size).toBe('2')
    expect((adjusted as Extract<GateTarget, { kind: 'order' }>).intent.leverage).toBe(3)
    expect((original as Extract<GateTarget, { kind: 'order' }>).intent.size).toBe('5')
  })
})
