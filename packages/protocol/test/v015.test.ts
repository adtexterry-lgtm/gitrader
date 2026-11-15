// SPDX-License-Identifier: Apache-2.0
// v0.1.5：engine-core 交付后定稿的七项约定。
import { describe, expect, it } from 'vitest'
import {
  EVENTS_ACK_METHOD, GEP_DEPRECATED_METHOD_ALIASES, GEP_METHODS, HOST_METHOD_NAMES, MARKET_EVENT_TYPES, PROTOCOL_PACKAGE_VERSION, WORKFLOW_ACTION_HOST_METHOD,
  X_GITRADER_CAPABILITIES, X_GITRADER_METHODS, extensionCapabilityOf, findSecretFields, isExtensionMethod, isKnownCapability, validateBacktestSpec,
  validateEngineDescribe, validateGepParams, validateGepResult, validateMarketCandleData, validateMarketCandlesData,
} from '../src'
import { clone, contract, sample } from './helpers'

const intent = () => sample('OrderIntent')
const candle = { t: 1790000000000, o: 2400, h: 2410, l: 2395, c: 2405, v: 12.5 }

describe('v0.1.5', () => {
  it('版本', () => expect(PROTOCOL_PACKAGE_VERSION).toMatch(/^0.1.[0-9]+$/))

  it('① market 事件：标的在信封上，data = {interval, candle, closed?}', () => {
    expect([...MARKET_EVENT_TYPES]).toEqual(['market.candle', 'market.candles'])
    expect(validateMarketCandleData({ interval: '1m', candle }).ok).toBe(true)
    expect(validateMarketCandleData({ interval: '1m', candle, closed: true }).ok).toBe(true)
    expect(validateMarketCandleData({ candle }).ok).toBe(false)
    expect(validateMarketCandleData({ interval: '1m', candle: { t: 1 } }).ok).toBe(false)
    expect(validateMarketCandlesData({ interval: '1m', candles: [candle, candle], closed: true }).ok).toBe(true)
    expect(validateMarketCandlesData({ interval: '1m', candles: 'x' }).ok).toBe(false)
  })

  it('② strategy.start 的可选 sizing', () => {
    const base = { strategyId: 'ema-trend', accountId: 'acct_01JABAPAPER000000000000001', instruments: ['hyperliquid:BTC'], params: {}, mandateId: 'mdt_01JABAENG01' }
    expect(validateGepParams('strategy.start', base).ok).toBe(true)
    expect(validateGepParams('strategy.start', { ...base, sizing: { allocRatio: 0.2, leverage: 3 } }).ok).toBe(true)
    expect(validateGepParams('strategy.start', { ...base, sizing: { allocRatio: 0.2, allocCapNotional: 500, leverage: 3, maxSlippageBps: 50, minStepNotional: 10 } }).ok).toBe(true)
    for (const bad of [{ allocRatio: 0 }, { allocRatio: 1.5 }, { leverage: 0.5 }, { leverage: 51 }, { allocCapNotional: 0 }, { allocRatio: '0.2' }]) {
      expect(validateGepParams('strategy.start', { ...base, sizing: bad }).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('③ host.order.place 的可选 origin 提示：只要求 tool；多发的 Origin 字段不报错', () => {
    const p = { accountId: 'acct_01JABAPAPER000000000000001', intent: intent(), clientOrderId: '9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60' }
    expect(validateGepParams('host.order.place', p).ok).toBe(true)
    expect(validateGepParams('host.order.place', { ...p, origin: { tool: 'strategy:ema-trend', causation: { instanceId: 'inst_01JAB9' } } }).ok).toBe(true)
    expect(validateGepParams('host.order.place', { ...p, origin: { actor: 'engine:x', actorType: 'engine', tool: 'strategy:ema-trend', requestId: 'r', via: 'gep' } }).ok).toBe(true)
    expect(validateGepParams('host.order.place', { ...p, origin: { causation: {} } }).ok).toBe(false)
  })

  it('④ 扩展方法约定：x-gitrader.* 登记、能力位门；未登记的 x- 方法没有能力位', () => {
    expect(Object.keys(X_GITRADER_METHODS)).toEqual([
      'x-gitrader.workflow.nodes', 'x-gitrader.workflow.blank', 'x-gitrader.workflow.validate', 'x-gitrader.workflow.run', 'x-gitrader.workflow.values', 'x-gitrader.strategy.files',
    ])
    for (const m of Object.keys(X_GITRADER_METHODS)) expect(isExtensionMethod(m)).toBe(true)
    for (const cap of X_GITRADER_CAPABILITIES) expect(isKnownCapability(cap)).toBe(true)
    expect(extensionCapabilityOf('x-gitrader.workflow.run')).toBe('x-gitrader.workflow')
    expect(extensionCapabilityOf('x-gitrader.strategy.files')).toBe('x-gitrader.strategy-folder')
    expect(extensionCapabilityOf('x-other.thing')).toBeUndefined()
    const d = clone(contract('engine-describe'))
    d.capabilities['x-gitrader.workflow'] = true
    d.capabilities['x-gitrader.strategy-folder'] = true
    expect(validateEngineDescribe(d).ok).toBe(true)
  })

  it('④ host.proposal.create：新增的宿主方法，act.propose 走它，act.order / act.close 走 host.order.place', () => {
    expect(HOST_METHOD_NAMES).toContain('host.proposal.create')
    expect(GEP_METHODS['host.proposal.create']).toMatchObject({ side: 'host', requirement: 'optional' })
    expect(WORKFLOW_ACTION_HOST_METHOD['act.propose']).toBe('host.proposal.create')
    expect(WORKFLOW_ACTION_HOST_METHOD['act.order']).toBe('host.order.place')
    const params = { accountId: 'acct_01JAB0QZ8W3K5M7N9P1R3T5V7X', intents: [intent()], reason: 'Funding flipped negative.', strategyId: 'wf-mine', instanceId: 'inst_01JAB9', origin: { tool: 'node:act.propose' } }
    expect(validateGepParams('host.proposal.create', params).ok).toBe(true)
    expect(validateGepParams('host.proposal.create', { ...params, intents: [] }).ok).toBe(false)
    expect(validateGepParams('host.proposal.create', { ...params, intents: Array.from({ length: 11 }, intent) }).ok).toBe(false)
    expect(validateGepParams('host.proposal.create', { ...params, reason: '' }).ok).toBe(false)
    const { reason: _r, ...noReason } = params
    expect(validateGepParams('host.proposal.create', noReason).ok).toBe(false)
    const result = { proposalId: 'prop_01JABC8F1', ticket: 'T-20261010-0001', status: 'pending', precheck: contract('precheck-allow'), expiresAt: 1791549900000 }
    expect(validateGepResult('host.proposal.create', result).ok).toBe(true)
    expect(validateGepResult('host.proposal.create', { ...result, status: 'approved' }).ok).toBe(false)
    expect(validateGepResult('host.proposal.create', { ...result, ticket: 'T-1' }).ok).toBe(false)
  })

  it('⑤ files[].format 支持 json', () => {
    const spec = clone(sample('BacktestSpec'))
    spec.data = { source: 'files', files: [{ path: 'D:/data/eth-1m.json', sha256: `sha256:${'a'.repeat(64)}`, format: 'json' }] }
    expect(validateBacktestSpec(spec).ok).toBe(true)
    spec.data.files[0].format = 'csv'
    expect(validateBacktestSpec(spec).ok).toBe(true)
    spec.data.files[0].format = 'xlsx'
    expect(validateBacktestSpec(spec).ok).toBe(false)
  })

  it('⑥ seed 例外只放过 spec.seed（number）', () => {
    expect(findSecretFields({ spec: { seed: 42 } })).toEqual([])
    expect(findSecretFields({ params: { spec: { seed: 42 } } })).toEqual([])
    expect(findSecretFields({ seed: 42 })).toEqual(['$.seed'])
    expect(findSecretFields({ params: { seed: 42 } })).toEqual(['$.params.seed'])
    expect(findSecretFields({ spec: { account: { seed: 42 } } })).toEqual(['$.spec.account.seed'])
    expect(findSecretFields({ spec: { seed: 'abandon abandon' } })).toEqual(['$.spec.seed'])
    expect(findSecretFields({ spec: { seed: [1, 2] } })).toEqual(['$.spec.seed'])
  })

  it('⑦ 事件确认统一 host.events.ack，events.ack 为弃用别名', () => {
    expect(EVENTS_ACK_METHOD).toBe('host.events.ack')
    expect(GEP_DEPRECATED_METHOD_ALIASES).toEqual({ 'events.ack': 'host.events.ack' })
    expect(validateGepParams('host.events.ack', { upToSeq: 10 }).ok).toBe(true)
    expect(validateGepParams('events.ack', { upToSeq: 10 }).ok).toBe(true)
    expect(validateGepParams('host.events.ack', {}).ok).toBe(false)
  })
})
