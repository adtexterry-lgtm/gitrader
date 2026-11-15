// SPDX-License-Identifier: Apache-2.0
// 壳 ↔ 内核的 UI 通道（v0.1.3）的 JSON Schema 定义：换票、auth / subscribe / query / command、事件、在场证明、设置与钥匙元数据。
import { anyObj, arr, b, c, enm, i, konst, n, ne, obj, ref, s } from './lib.mjs'

const u = (name) => ref('ui', name)

export function uiSchemas(K) {
  const out = {}
  const add = (name, schema) => { out[`ui:${name}`] = { domain: 'ui', name, title: name, schema } }
  const network = enm('mainnet', 'testnet')

  add('SessionExchangeRequest', obj({ bootstrap: ne() }, ['bootstrap']))
  add('SessionExchangeResult', obj({ sessionToken: ne(), user: ne(), sessionId: ne(), expiresAt: c('Ms'), ws: s({ pattern: '^/' }) }, ['sessionToken', 'user']))
  add('SessionExchangeError', obj({ error: obj({ name: ne(), message: s() }, ['name', 'message']) }, ['error']))

  add('UiAuthParams', obj({ token: ne(), client: obj({ name: ne(), instanceId: s() }, ['name']) }, ['token', 'client']))
  add('UiAuthResult', obj({ ok: konst(true), user: ne() }, ['ok', 'user']))
  add('UiSubscribeParams', obj({ topic: ne(), filter: anyObj(), maxHz: n({ exclusiveMinimum: 0 }), fromSeq: i({ minimum: 0 }) }, ['topic']))
  add('UiSubscribeResult', obj({ subscriptionId: ne() }, ['subscriptionId']))
  add('UiUnsubscribeParams', obj({ subscriptionId: ne() }, ['subscriptionId']))

  add('PresenceProof', {
    ...obj({
      method: enm('pin', 'passkey', 'wallet'), pin: s({ pattern: K.PIN_PATTERN }), assertion: anyObj(),
    }, ['method']),
    allOf: [{ if: { properties: { method: konst('pin') }, required: ['method'] }, then: { required: ['pin'] } }],
  })
  add('UiQueryParams', obj({ method: ne(), params: anyObj() }, ['method']))
  add('UiCommandParams', obj({
    action: ne(), params: anyObj(),
    origin: obj({ tool: ne(), via: konst('ui') }, ['tool', 'via']),
    attestation: u('PresenceProof'),
  }, ['action', 'origin']))
  add('UiEventParams', obj({
    subscriptionId: ne(), topic: ne(),
    events: arr(obj({ seq: i({ minimum: 0 }), ts: c('Ms'), data: {} }, ['data'])),
    seq: i({ minimum: 0 }), ts: c('Ms'), data: {},
  }, ['subscriptionId', 'topic']))

  const key = obj({ id: ne(), label: s(), address: ne(), venue: ne(), network, createdAt: c('Ms'), expiresAt: c('Ms') }, ['id', 'label', 'address', 'venue', 'network', 'createdAt'])
  add('KeyInfo', key)
  // 块 / 壳订阅的主题载荷（v0.1.6）
  add('RiskUsageItem', obj({
    key: s({ pattern: `^(${K.RISK_USAGE_KEYS.join('|')}|x-.+)$` }), used: c('Decimal'), limit: c('Decimal'), unit: ne(), ratio: c('Decimal'),
    scope: s(), window: enm('day', 'minute', 'now'),
  }, ['key', 'used', 'limit', 'unit']))
  add('RiskStateSnapshot', obj({
    tradingState: enm(K.TRADING_STATES), reasons: arr({}), policyVersion: i({ minimum: 0 }), denyLlmLiveEntries: b(), usage: arr(u('RiskUsageItem')), ts: c('Ms'),
  }, ['tradingState']))
  add('AccountSummary', obj({
    accountId: c('AcctId'), ts: c('Ms'), equity: c('Decimal'), available: c('Decimal'), positions: i({ minimum: 0 }), openOrders: i({ minimum: 0 }),
    dayStartEquity: c('Decimal'),
  }, ['accountId', 'ts', 'equity', 'available']))
  add('SettingsSnapshot', obj({ network, pinSet: b(), agentLayout: b(), keys: arr(u('KeyInfo')) }, ['network', 'pinSet', 'agentLayout', 'keys']))
  add('WorkspaceMeta', obj({ id: ne(), name: ne(), savedBy: obj({ actor: ne(), at: c('Ms') }, ['actor', 'at']) }, ['id', 'name']))

  return out
}
