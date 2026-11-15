// SPDX-License-Identifier: Apache-2.0
// Agent 接口（契约 §5：钥匙、授权书、提案、接管、confirmToken）与账本（§6）的 JSON Schema 定义。
import { a, anyObj, arr, b, c, enm, i, konst, m, n, ne, nullable, obj, propIs, s, when } from './lib.mjs'

export function agentSchemas(K) {
  const out = {}
  const add = (domain, name, schema) => { out[`${domain}:${name}`] = { domain, name, title: name, schema } }
  const levels = enm(K.MANDATE_LEVELS)

  add('agent', 'AgentKey', obj({
    keyId: c('AkId'), name: ne(), host: enm(K.AGENT_HOSTS), mandateId: c('MdtId'), status: enm(K.AGENT_KEY_STATUSES),
    createdAt: c('Ms'), expiresAt: c('Ms'), lastSeenAt: nullable(c('Ms')), createdBy: c('UserActor'),
  }, ['keyId', 'name', 'host', 'mandateId', 'status', 'createdAt', 'expiresAt', 'lastSeenAt', 'createdBy']))

  const mandateLimits = obj({
    maxOrderNotional: c('Decimal'), maxDailyNotional: c('Decimal'), maxDailyLoss: c('Decimal'), maxPositionNotional: c('Decimal'),
    maxOpenPositions: i({ minimum: 0 }), maxLeverage: n({ exclusiveMinimum: 0 }), autoMaxOrderNotional: c('Decimal'), maxOrdersPerMinute: i({ minimum: 1 }),
    maxDailyOrders: i({ minimum: 1 }), maxCancelsPerMinute: i({ minimum: 1 }), duplicateIntentWindowSec: n({ minimum: 0 }),
  })
  add('agent', 'MandateLimits', mandateLimits)

  add('agent', 'Mandate', {
    ...obj({
      mandateId: c('MdtId'), version: i({ minimum: 1 }),
      subject: obj({ type: enm(K.MANDATE_SUBJECT_TYPES), id: ne() }, ['type', 'id']),
      level: levels, accounts: arr(c('AcctId')),
      venueAllowlist: arr(c('VenueId')), instrumentAllowlist: arr(c('InstrumentId')),
      limits: a('MandateLimits'), notBefore: c('Ms'), notAfter: c('Ms'),
      heartbeat: obj({
        intervalSec: n({ exclusiveMinimum: 0 }), timeoutSec: n({ exclusiveMinimum: 0 }),
        onTimeout: obj({ downgradeTo: levels, takeover: enm('none', 'halt_new', 'cancel_all') }, ['downgradeTo', 'takeover']),
      }, ['intervalSec', 'timeoutSec', 'onTimeout']),
      approval: obj({ pendingTtlSec: n({ exclusiveMinimum: 0 }), executeWithinSec: n({ exclusiveMinimum: 0 }), presenceAboveNotional: c('Decimal') }, ['pendingTtlSec', 'executeWithinSec', 'presenceAboveNotional']),
      promotion: obj({
        next: levels,
        criteria: obj({ minDays: n(), minSamples: i(), maxDrawdownRatio: c('Decimal'), maxHeartbeatTimeouts: i(), minApprovalRatio: c('Decimal') }),
        progress: obj({ days: n(), samples: i(), drawdownRatio: c('Decimal'), heartbeatTimeouts: i(), eligible: b() }, ['days', 'samples', 'drawdownRatio', 'heartbeatTimeouts', 'eligible']),
      }, ['next', 'criteria', 'progress']),
      temporaryRelax: nullable(m('TemporaryRelax')),
      denyLlmLiveEntries: b({ default: true, description: '缺省 = true；LLM 来源的实盘开仓一律拒绝' }),
      status: enm(K.MANDATE_STATUSES), issuedBy: c('UserActor'), attestation: m('Attestation'),
    }, ['mandateId', 'version', 'subject', 'level', 'accounts', 'limits', 'notBefore', 'notAfter', 'status', 'issuedBy', 'attestation']),
    allOf: [
      when(propIs('level', ['L2', 'L3', 'L4']), { required: ['venueAllowlist', 'instrumentAllowlist'] }),
      when(propIs('level', 'L2'), { properties: { limits: { required: ['maxOrderNotional', 'maxDailyNotional'] } } }),
      when(propIs('level', ['L3', 'L4']), {
        required: ['heartbeat'],
        properties: { limits: { required: ['maxOrderNotional', 'maxDailyNotional', 'maxDailyLoss', 'autoMaxOrderNotional'] } },
      }),
    ],
  })

  add('agent', 'ControlIntent', obj({ controlKind: enm(K.CONTROL_KINDS), params: anyObj() }, ['controlKind', 'params']))

  add('agent', 'Proposal', {
    ...obj({
      proposalId: c('PropId'), ticket: c('Ticket'), kind: enm('order', 'control'), status: enm(K.PROPOSAL_STATUSES), accountId: c('AcctId'),
      intents: { oneOf: [arr(m('OrderIntent'), { minItems: 1, maxItems: K.PROPOSAL_DEFAULTS.maxIntents }), a('ControlIntent')] },
      intentsDigest: c('Sha256'), reason: s({ minLength: 1, maxLength: 2000 }),
      evidence: arr(m('EvidenceRef')), precheck: m('PrecheckResult'),
      priceBounds: obj({ referencePrice: c('Decimal'), maxDriftBps: n({ minimum: 0 }) }, ['referencePrice', 'maxDriftBps']),
      mandateId: c('MdtId'), expiresAt: c('Ms'),
      decision: nullable(obj({ by: s({ pattern: '^(user|mandate):.+$' }), at: c('Ms'), attestation: m('Attestation'), note: s() }, ['by', 'at'])),
      execution: nullable(obj({ orderIds: arr(c('OrdId')), at: c('Ms'), result: ne(), problem: m('Problem') }, ['orderIds', 'at', 'result'])),
      origin: m('Origin'),
    }, ['proposalId', 'ticket', 'kind', 'status', 'intents', 'intentsDigest', 'reason', 'precheck', 'mandateId', 'expiresAt', 'origin']),
    allOf: [
      when(propIs('kind', 'order'), { required: ['accountId', 'priceBounds'], properties: { intents: { type: 'array' } } }),
      when(propIs('kind', 'control'), { properties: { intents: { type: 'object' } } }),
      when(propIs('status', ['approved', 'executing', 'executed', 'failed', 'rejected']), { required: ['decision'], properties: { decision: { type: 'object' } } }),
      when(propIs('status', ['executed', 'failed']), { required: ['execution'], properties: { execution: { type: 'object' } } }),
    ],
  })

  add('agent', 'TakeoverRequest', obj({
    takeoverId: c('TkoId'), level: enm(K.TAKEOVER_LEVELS), scope: m('TradingScope'), reason: ne(), keepProtective: b(),
  }, ['level', 'scope', 'reason']))

  add('agent', 'ConfirmTokenClaims', obj({
    mandateId: c('MdtId'), accountId: c('AcctId'), normalizedIntentDigest: c('Sha256'), precheckId: c('PckId'), policyVersion: i({ minimum: 0 }),
    priceRef: obj({ markPrice: c('Decimal'), ts: c('Ms') }, ['markPrice', 'ts']), maxDriftBps: n({ minimum: 0 }), expiresAt: c('Ms'), nonce: ne(),
  }, ['mandateId', 'accountId', 'normalizedIntentDigest', 'precheckId', 'policyVersion', 'priceRef', 'maxDriftBps', 'expiresAt', 'nonce']))

  add('agent', 'OrderPreviewResult', obj({
    confirmToken: ne(), normalizedIntent: m('OrderIntent'), precheck: m('PrecheckResult'), expiresAt: c('Ms'),
  }, ['confirmToken', 'normalizedIntent', 'precheck', 'expiresAt']))

  // ---- 账本 gitrader-ledger/1 -----------------------------------------------------------
  const subject = obj({
    orgId: c('OrgId'), accountId: c('AcctId'), instrumentId: c('InstrumentId'), orderId: c('OrdId'), clientOrderId: c('ClientOrderId'),
    fillId: c('FillId'), proposalId: c('PropId'), ticket: c('Ticket'), mandateId: c('MdtId'), policyId: c('PolId'), takeoverId: c('TkoId'),
    engineId: s(), instanceId: c('InstanceId'), workflowId: s(), experimentId: c('ExpId'), pluginId: s(), precheckId: c('PckId'), ledgerRef: s(),
  }, [], { minProperties: 1 })
  add('ledger', 'LedgerEntry', {
    ...obj({
      schema: konst(K.LEDGER_SCHEMA), seq: i({ minimum: 0 }), id: c('LedId'), ts: c('Ms'), recordedAt: c('Ms'), type: enm(K.LEDGER_ENTRY_TYPE_LIST),
      origin: m('Origin'), subject,
      precheck: obj({
        precheckId: c('PckId'), verdict: enm(K.PRECHECK_VERDICTS), policyVersion: i({ minimum: 0 }),
        estimates: m('PrecheckEstimates'),
      }, ['precheckId', 'verdict', 'policyVersion', 'estimates']),
      ruleHits: arr(m('RuleHit')), payload: anyObj(), payloadHash: c('Sha256'), attestation: enm(K.LEDGER_ATTESTATIONS),
      venueRef: obj({ venue: c('VenueId'), nativeOrderId: s(), nativeFillId: s(), txHash: s(), receiptHash: c('Sha256') }, ['venue']),
      engineRef: obj({ engineId: ne(), sessionId: ne(), seq: i({ minimum: 0 }), eventId: ne() }, ['engineId', 'sessionId', 'seq', 'eventId']),
      prevHash: c('Sha256'), hash: c('Sha256'),
    }, ['schema', 'seq', 'id', 'ts', 'recordedAt', 'type', 'origin', 'subject', 'payloadHash', 'attestation', 'prevHash', 'hash']),
    allOf: [
      when(propIs('type', ['order.intent', 'risk.precheck', 'risk.denied', 'proposal.created']), { required: ['precheck'] }),
      when(propIs('type', ['risk.denied', 'protector.triggered', 'takeover.requested', 'takeover.applied', 'takeover.completed', 'takeover.failed']), { required: ['ruleHits'] }),
      when({ required: ['precheck'], properties: { precheck: propIs('verdict', ['deny', 'review']) } }, { required: ['ruleHits'] }),
      when(propIs('type', 'engine.event'), { required: ['engineRef'] }),
      when(propIs('seq', 0), { properties: { type: konst('checkpoint'), prevHash: konst(`sha256:${'0'.repeat(64)}`) } }),
    ],
  })
  return out
}
