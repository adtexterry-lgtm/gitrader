// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import {
  GEP_METHODS, HOST_METHOD_NAMES, LEDGER_ENTRY_TYPE_LIST, asDecimal, missingBacktestAssumptions,
  validateBacktestResult, validateBacktestSpec, validateBySchemaId, validateGepParams,
  validateGepResult, validateLedgerEntry, validateOrder, validateOrderIntent,
  type FundingRatePoint, type OrderAmendedPayload, type OrderStatusUnknownPayload, type PluginHealthChangedPayload,
} from '../src'
import { contract, sample } from './helpers'

const model = (name: string, value: unknown) => validateBySchemaId(`urn:gitrader:schema:model:0.1:${name}`, value).ok

describe('P3 optional protocol additions', () => {
  it('registers optional funding history with decimal points and integer millisecond bounds', () => {
    const method = 'host.market.fundingHistory'
    expect(HOST_METHOD_NAMES).toContain(method)
    expect(GEP_METHODS[method].requirement).toBe('optional')
    const point: FundingRatePoint = { instrumentId: 'hyperliquid:BTC', t: 1000, rate: asDecimal('-0.0001') }
    expect(model('FundingRatePoint', point)).toBe(true)
    expect(model('FundingRatePoint', { ...point, premium: '0.0002' })).toBe(true)
    expect(model('FundingRatePoint', { ...point, rate: 0.0001 })).toBe(false)
    expect(model('FundingRatePoint', { ...point, premium: 0.0002 })).toBe(false)
    expect(validateGepParams(method, { instrumentId: point.instrumentId, from: 0 }).ok).toBe(true)
    expect(validateGepParams(method, { instrumentId: point.instrumentId, from: 0, to: 2000 }).ok).toBe(true)
    expect(validateGepParams(method, { instrumentId: point.instrumentId }).ok).toBe(false)
    expect(validateGepParams(method, { instrumentId: point.instrumentId, from: 0.5 }).ok).toBe(false)
    expect(validateGepResult(method, { points: [point], complete: true }).ok).toBe(true)
    expect(validateGepResult(method, { points: [], complete: false }).ok).toBe(true)
    expect(validateGepResult(method, { points: [point] }).ok).toBe(false)
    expect(validateGepResult(method, { points: [{ ...point, t: 0.5 }], complete: true }).ok).toBe(false)
  })
  it('validates funding files, maintenance margin and optional execution assumptions', () => {
    const spec = sample('BacktestSpec')
    spec.data = { source: 'files', files: [{ path: 'funding.json', sha256: `sha256:${'a'.repeat(64)}`, format: 'json', kind: 'funding' }] }
    spec.account.maintenanceMarginRatio = 0.05
    spec.assumptions.maxVolumeShare = 0.5
    spec.assumptions.liquidationPenaltyRatio = 0.01
    expect(validateBacktestSpec(spec).ok).toBe(true)
    expect(missingBacktestAssumptions(spec.assumptions)).toEqual([])
    for (const kind of ['candles', undefined]) {
      const old = structuredClone(spec)
      if (kind === undefined) delete old.data.files[0].kind
      else old.data.files[0].kind = kind
      expect(validateBacktestSpec(old).ok).toBe(true)
    }
    for (const [key, value] of [['maxVolumeShare', -0.1], ['maxVolumeShare', 1.1], ['liquidationPenaltyRatio', -0.1]] as const) {
      const invalid = structuredClone(spec)
      invalid.assumptions[key] = value
      expect(validateBacktestSpec(invalid).ok).toBe(false)
    }
    expect(validateBacktestSpec({ ...spec, account: { ...spec.account, maintenanceMarginRatio: '0.05' } }).ok).toBe(false)
    spec.data.files[0].kind = 'unknown'
    expect(validateBacktestSpec(spec).ok).toBe(false)
  })
  it('accepts analytical funding results and validates the added statistics', () => {
    const result = sample('BacktestResult')
    Object.assign(result.stats, { fundingPaid: -0.01, feesPaid: 0.02, liquidations: 1, unfilledShare: 0.75 })
    result.funding = [{ t: 1000, rate: -0.0001, notional: 100, paid: -0.01 }]
    result.trades = [{ t: 1000, side: 'sell', price: 100, size: 1, pnl: -1, fee: 0.02, reason: 'liquidation' }]
    expect(validateBacktestResult(result).ok).toBe(true)
    for (const [key, value] of [['fundingPaid', '0.01'], ['feesPaid', '0.02'], ['liquidations', 0.5], ['unfilledShare', 1.1]] as const) {
      expect(validateBacktestResult({ ...result, stats: { ...result.stats, [key]: value } }).ok).toBe(false)
    }
    expect(validateBacktestResult({ ...result, funding: [{ ...result.funding[0], t: 0.5 }] }).ok).toBe(false)
    expect(validateBacktestResult({ ...result, funding: [{ ...result.funding[0], paid: '0.01' }] }).ok).toBe(false)
  })
  it('keeps the old BacktestSpec and BacktestResult fixtures unchanged and valid', () => {
    const spec = sample('BacktestSpec'), result = sample('BacktestResult')
    const original = JSON.stringify({ spec, result })
    expect(validateBacktestSpec(spec).ok).toBe(true)
    expect(validateBacktestResult(result).ok).toBe(true)
    expect(missingBacktestAssumptions(spec.assumptions)).toEqual([])
    expect(JSON.stringify({ spec, result })).toBe(original)
  })
  it('validates positive decimal trailing callbacks on intents and order mirrors', () => {
    const intent = { ...sample('OrderIntent'), type: 'trailing_stop' }
    const order = { ...contract('order-denied'), type: 'trailing_stop' }
    for (const [value, validate] of [[intent, validateOrderIntent], [order, validateOrder]] as const) {
      expect(validate(value).ok).toBe(true)
      expect(validate({ ...value, trailing: { callbackRatio: '0.02' } }).ok).toBe(true)
      expect(validate({ ...value, trailing: { callbackRatio: '0.02', activationPrice: '100', activationRatio: '0.01' } }).ok).toBe(true)
      for (const trailing of [{}, { callbackRatio: '0' }, { callbackRatio: '-0.02' }, { callbackRatio: 0.02 }, { callbackRatio: '0.02', activationPrice: 100 }, { callbackRatio: '0.02', activationRatio: 0.01 }]) {
        expect(validate({ ...value, trailing }).ok).toBe(false)
      }
    }
  })
  it('registers execution and plugin ledger events with independent payload schemas', () => {
    const amended: OrderAmendedPayload = { orderId: 'ord_001', before: { price: null, size: asDecimal('1') }, after: { price: asDecimal('100'), size: asDecimal('2'), triggerPrice: asDecimal('90') } }
    const unknown: OrderStatusUnknownPayload = { venue: 'hyperliquid', rawStatus: 'pending_review', orderId: 'ord_001' }
    const health: PluginHealthChangedPayload = { pluginId: 'skill.demo.echo', from: 'ok', to: 'degraded', reason: 'timeout' }
    const cases = [
      ['order.amended', 'OrderAmendedPayload', amended, { ...amended, after: { size: 2 } }],
      ['order.status_unknown', 'OrderStatusUnknownPayload', unknown, { venue: 'hyperliquid', orderId: 'ord_001' }],
      ['plugin.health_changed', 'PluginHealthChangedPayload', health, { ...health, to: 1 }],
    ] as const
    for (const [type, name, payload, invalid] of cases) {
      expect(LEDGER_ENTRY_TYPE_LIST).toContain(type)
      expect(validateLedgerEntry({ ...contract('ledger-risk-denied'), type, payload }).ok).toBe(true)
      expect(model(name, payload)).toBe(true)
      expect(model(name, invalid)).toBe(false)
    }
    expect(model('PluginHealthChangedPayload', { pluginId: health.pluginId, from: 'ok', to: 'down' })).toBe(true)
  })
  it('keeps Candle.vwap optional and numeric', () => {
    const candle = { t: 1000, o: 100, h: 102, l: 99, c: 101, v: 5 }
    expect(model('Candle', candle)).toBe(true)
    expect(model('Candle', { ...candle, vwap: 100.5 })).toBe(true)
    expect(model('Candle', { ...candle, vwap: '100.5' })).toBe(false)
  })
})
