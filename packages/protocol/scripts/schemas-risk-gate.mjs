// SPDX-License-Identifier: Apache-2.0
// 风控闸门协议 schema（r1）；字段与枚举由协议类型和常量驱动。
import { a, arr, b, c, enm, i, konst, m, n, ne, nullable, obj, rec, s, when } from './lib.mjs'

export function riskGateSchemas(K) {
  const defs = {}
  const put = (name, schema) => { defs[name] = schema }
  const local = (name) => ({ $ref: `#/$defs/${name}` })

  put('GateTarget', {
    oneOf: [
      obj({
        kind: konst(K.GATE_TARGET_KINDS[0]),
        intent: { allOf: [m('OrderIntent'), obj({ size: c('Decimal'), tif: enm(K.TIME_IN_FORCE), clientOrderId: c('ClientOrderId') }, ['size', 'tif', 'clientOrderId'])] },
      }, ['kind', 'intent']),
      obj({
        kind: konst(K.GATE_TARGET_KINDS[1]),
        targets: arr(obj({ orderId: s(), clientOrderId: s(), tpslRole: enm(K.TPSL_ROLES) }, ['orderId', 'clientOrderId'])),
      }, ['kind', 'targets']),
      obj({ kind: konst(K.GATE_TARGET_KINDS[2]), instrumentId: c('InstrumentId'), keepProtective: b() }, ['kind', 'keepProtective']),
      obj({
        kind: konst(K.GATE_TARGET_KINDS[3]), instrumentId: c('InstrumentId'), leverage: n(), marginMode: enm(K.MARGIN_MODES),
      }, ['kind', 'instrumentId', 'leverage']),
      obj({ kind: konst(K.GATE_TARGET_KINDS[4]), atMs: nullable(c('Ms')) }, ['kind', 'atMs']),
    ],
  })

  put('GateAccountView', obj({
    equity: c('Decimal'), available: c('Decimal'), availableDeductsOpenOrders: b(),
    positions: arr(obj({
      instrumentId: c('InstrumentId'), side: enm(K.POSITION_SIDES), size: c('Decimal'), notional: c('Decimal'), leverage: n(),
    }, ['instrumentId', 'side', 'size', 'notional', 'leverage'])),
    openOrders: arr(obj({ instrumentId: c('InstrumentId'), side: enm(K.ORDER_SIDES), notional: c('Decimal'), count: i({ minimum: 0 }) }, ['instrumentId', 'side', 'notional', 'count'])),
    stopLossOrderIds: arr(s()), asOf: c('Ms'), confirmedAt: c('Ms'), stale: b(),
  }, ['equity', 'available', 'availableDeductsOpenOrders', 'positions', 'openOrders', 'stopLossOrderIds', 'asOf', 'stale']))

  put('ReservedView', obj({
    account: obj({ margin: c('Decimal'), notional: c('Decimal'), count: i({ minimum: 0 }) }, ['margin', 'notional', 'count']),
    byInstrument: rec(obj({
      long: obj({ notional: c('Decimal'), count: i({ minimum: 0 }) }, ['notional', 'count']),
      short: obj({ notional: c('Decimal'), count: i({ minimum: 0 }) }, ['notional', 'count']),
    }, ['long', 'short'])),
    today: obj({ notional: c('Decimal'), count: i({ minimum: 0 }) }, ['notional', 'count']),
    lastMinute: obj({ count: i({ minimum: 0 }) }, ['count']),
  }, ['account', 'byInstrument', 'today', 'lastMinute']))

  put('GateAdjustment', {
    oneOf: [
      obj({
        ruleId: ne(), code: enm(K.RULE_CODES), field: enm(K.GATE_ADJUSTMENT_FIELDS.filter((field) => field !== 'markPrice')),
        from: { anyOf: [c('Decimal'), n(), b()] }, to: { anyOf: [c('Decimal'), n(), b()] },
        unit: s(),
      }, ['ruleId', 'code', 'field', 'from', 'to', 'unit'], { not: { required: ['kind'] } }),
      obj({
        ruleId: ne(), code: konst('STALE_PRICE'), field: konst('markPrice'), kind: konst('warning'),
        from: c('Decimal'), to: c('Decimal'), unit: s(),
      }, ['ruleId', 'code', 'field', 'kind', 'from', 'to', 'unit']),
    ],
  })

  put('PrecheckStats', obj({
    dayStartEquity: c('Decimal'), dailyNotional: c('Decimal'), mandateDailyNotional: c('Decimal'),
    ordersLastMinute: i({ minimum: 0 }), mandateOrdersLastMinute: i({ minimum: 0 }),
    ordersToday: i({ minimum: 0 }), mandateOrdersToday: i({ minimum: 0 }), lastOpenTs: c('Ms'), duplicateOf: s(),
  }, ['dailyNotional', 'mandateDailyNotional', 'ordersLastMinute', 'mandateOrdersLastMinute', 'ordersToday', 'mandateOrdersToday']))

  put('VenueRules', obj({
    maxOpenOrders: obj({ cap: n({ minimum: 0 }), current: n({ minimum: 0 }) }, ['cap', 'current']),
    marketPriceBandBps: n({ minimum: 0 }), minOrderNotional: c('Decimal'),
  }))

  put('StateReason', obj({
    scope: m('TradingScope'), state: m('TradingState'), reason: s(), until: c('Ms'), protector: s(),
  }, ['scope', 'state', 'reason']))

  put('ProtectorPreVerdict', {
    oneOf: [
      obj({ action: konst(K.PROTECTOR_PRE_ACTIONS[0]) }, ['action']),
      obj({ action: konst(K.PROTECTOR_PRE_ACTIONS[1]), code: enm(K.RULE_CODES), message: s() }, ['action', 'message']),
      obj({ action: konst(K.PROTECTOR_PRE_ACTIONS[2]), field: konst(K.GATE_ADJUSTMENT_FIELDS[0]), to: c('Decimal'), message: s() }, ['action', 'field', 'to', 'message']),
      obj({ action: konst(K.PROTECTOR_PRE_ACTIONS[3]), scope: enm(K.PROTECTOR_PAUSE_SCOPES), minutes: n({ minimum: 0, maximum: 1440 }), message: s() }, ['action', 'scope', 'minutes', 'message']),
    ],
  })

  put('ProtectorResult', obj({
    pluginId: ne(), version: ne(), sourceDigest: c('Sha256'), order: i({ minimum: 0 }), mode: enm(K.PROTECTOR_MODES), seq: i({ minimum: 0 }),
    result: { oneOf: [local('ProtectorPreVerdict'), obj({ action: konst('unavailable'), reason: s() }, ['action', 'reason'])] },
    durationUs: n({ minimum: 0 }),
  }, ['pluginId', 'version', 'sourceDigest', 'order', 'mode', 'seq', 'result', 'durationUs']))

  put('GateTicket', obj({
    ticketId: ne(), precheckId: c('PckId'), bootId: ne(), accountId: c('AcctId'), action: enm(K.GATE_ACTIONS),
    targetDigest: c('Sha256'), issuedAt: c('Ms'), expiresAt: c('Ms'), sig: ne(),
  }, ['ticketId', 'precheckId', 'bootId', 'accountId', 'action', 'targetDigest', 'issuedAt', 'expiresAt', 'sig']))

  const inputProperties = {
    precheckId: c('PckId'), dryRun: b(), action: enm(K.GATE_ACTIONS), actorClass: enm(K.ACTOR_CLASSES),
    target: local('GateTarget'), originalTargetDigest: c('Sha256'), originActorType: enm(K.ORIGIN_ACTOR_TYPES),
    account: obj({ accountId: c('AcctId'), venue: c('VenueId'), mode: enm(K.GATE_ACCOUNT_MODES), groupIds: arr(s()) }, ['accountId', 'venue', 'mode', 'groupIds']),
    instrument: m('Instrument'), snapshot: local('GateAccountView'),
    mark: obj({ price: c('Decimal'), ts: c('Ms'), source: konst('venue_mark') }, ['price', 'ts', 'source']),
    cancelPriceChecks: arr(obj({
      instrumentId: c('InstrumentId'),
      quote: s(),
      mark: obj({ price: c('Decimal'), ts: c('Ms'), source: konst('venue_mark') }, ['price', 'ts', 'source']),
    }, ['instrumentId'])),
    last: obj({ price: c('Decimal'), ts: c('Ms') }, ['price', 'ts']),
    mandate: nullable(a('Mandate')), mandateIntegrity: obj({ ok: b(), problems: arr(s()) }, ['ok', 'problems']),
    policy: nullable(m('RiskPolicy')), policyIntegrity: obj({ ok: b(), problems: arr(s()) }, ['ok', 'problems']),
    path: enm(K.GATE_PATHS), now: c('Ms'), stats: local('PrecheckStats'), rate: obj({ used: n(), limit: n() }, ['used', 'limit']),
    reserved: local('ReservedView'), states: arr(local('StateReason')), assemblyAdjustments: arr(local('GateAdjustment')),
    killSwitch: obj({ tripped: b(), source: enm(K.GATE_KILL_SOURCES), reason: s() }, ['tripped']),
    venueRules: local('VenueRules'), protectorResults: arr(local('ProtectorResult')),
  }
  const inputRequired = [
    'precheckId', 'dryRun', 'action', 'actorClass', 'target', 'originActorType', 'account', 'snapshot', 'mandate', 'mandateIntegrity',
    'policy', 'policyIntegrity', 'path', 'now', 'stats', 'reserved', 'states', 'killSwitch', 'protectorResults',
  ]
  put('GateInput', {
    ...obj(inputProperties, inputRequired),
    allOf: [when({
      properties: { target: { properties: { kind: enm(K.GATE_TARGET_KINDS[0], K.GATE_TARGET_KINDS[3]) }, required: ['kind'] } },
      required: ['target'],
    }, { required: ['instrument'] }), {
      oneOf: [
        obj({ action: enm(K.GATE_ACTIONS[0], K.GATE_ACTIONS[1], K.GATE_ACTIONS[4]), target: obj({ kind: konst(K.GATE_TARGET_KINDS[0]) }, ['kind']) }, ['action', 'target']),
        obj({ action: enm(K.GATE_ACTIONS[2], K.GATE_ACTIONS[3]), target: obj({ kind: enm(K.GATE_TARGET_KINDS[1], K.GATE_TARGET_KINDS[2]) }, ['kind']) }, ['action', 'target']),
        obj({ action: konst(K.GATE_ACTIONS[5]), target: obj({ kind: konst(K.GATE_TARGET_KINDS[3]) }, ['kind']) }, ['action', 'target']),
        obj({ action: enm(K.GATE_ACTIONS[6], K.GATE_ACTIONS[7]), target: obj({ kind: konst(K.GATE_TARGET_KINDS[4]) }, ['kind']) }, ['action', 'target']),
      ],
    }],
  })

  const policyRef = nullable(obj({ policyId: c('PolId'), version: i({ minimum: 0 }), digest: c('Sha256') }, ['policyId', 'version', 'digest']))
  put('GateSnapshot', obj({
    ...Object.fromEntries(Object.entries(inputProperties).filter(([key]) => key !== 'target' && key !== 'policy')),
    policy: policyRef,
  }, inputRequired.filter((key) => key !== 'target').map((key) => key === 'policy' ? 'policy' : key)))

  put('GateDecision', {
    allOf: [m('PrecheckResult'), obj({
      gate: obj({ schema: konst(K.GATE_SCHEMA), rulesetVersion: ne() }, ['schema', 'rulesetVersion']),
      decision: enm(K.GATE_DECISIONS), action: enm(K.GATE_ACTIONS), targetDigest: c('Sha256'), adjustedTargetDigest: c('Sha256'),
      applied: arr(local('GateAdjustment')),
      allowedActions: obj(Object.fromEntries(K.GATE_ACTIONS.map((action) => [action, b()])), [...K.GATE_ACTIONS]),
      irreversibility: enm(K.GATE_IRREVERSIBILITIES),
      escalation: obj({ to: konst('human_approval'), reason: enm(K.RULE_CODES) }, ['to', 'reason']),
      stages: arr(enm(K.GATE_STAGES)), monitorHits: arr(m('RuleHit')), snapshotDigest: c('Sha256'),
      policyRef,
      mandateRef: obj({
        mandateId: c('MdtId'), version: i({ minimum: 0 }), digest: c('Sha256'),
        effectiveLevel: enm(K.MANDATE_LEVELS), effectiveStatus: enm(K.MANDATE_STATUSES),
      }, ['mandateId', 'version', 'digest', 'effectiveLevel', 'effectiveStatus']),
      dryRun: b(),
      attestation: { allOf: [m('Attestation'), obj({ method: konst(K.ATTESTATION_METHODS.find((method) => method === 'system')), by: konst('kernel') }, ['method', 'by'])] },
    }, [
      'gate', 'decision', 'action', 'targetDigest', 'adjustedTargetDigest', 'applied', 'allowedActions', 'irreversibility',
      'stages', 'monitorHits', 'snapshotDigest', 'policyRef', 'dryRun', 'attestation',
    ])],
  })

  put('ConformanceCase', obj({
    name: ne(), input: local('GateInput'),
    expect: obj({
      decision: enm(K.GATE_DECISIONS), verdict: enm(K.PRECHECK_VERDICTS), codes: arr(enm(K.RULE_CODES)),
      applied: arr(local('GateAdjustment')),
      allowedActions: obj(Object.fromEntries(K.GATE_ACTIONS.map((action) => [action, b()])), [...K.GATE_ACTIONS]),
    }, ['decision', 'verdict', 'codes', 'applied', 'allowedActions']),
  }, ['name', 'input', 'expect']))

  return {
    RiskGate: {
      domain: 'risk-gate', name: 'RiskGate', title: 'Risk Gate Protocol',
      schema: { anyOf: ['GateInput', 'GateDecision', 'GateTicket', 'GateTarget', 'ProtectorPreVerdict'].map(local), $defs: defs },
    },
  }
}
