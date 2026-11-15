// SPDX-License-Identifier: Apache-2.0
// v0.1.3：合伙人引擎需要的可选字段（子仓位 / 实验阶段 / 模型版本 / 交易时段 / 亏损分解）。旧夹具不动，这里只测追加。
import { describe, expect, it } from 'vitest'
import {
  EXPERIMENT_STAGES, LEDGER_ENTRY_TYPE_LIST, PROTOCOL_PACKAGE_VERSION, checkLossAttribution, validateDecisionRecord, validateExperiment, validateFill,
  validateInstrument, validateLedgerEntry, validateLossAttribution, validateModelTrainedPayload, validateOrder, validateOrderIntent, validatePosition,
  type LossAttribution,
} from '../src'
import { clone, contract, sample } from './helpers'
import { buildChain } from './ledger-chain'

describe('v0.1.3 追加字段（可选，旧数据照样通过）', () => {
  it('版本号', () => expect(PROTOCOL_PACKAGE_VERSION).toMatch(/^0.1.[0-9]+$/))
  it('子仓位 / 出场计划 / OCO：OrderIntent、Order、Fill、Position、causation', () => {
    const intent = { ...sample('OrderIntent'), legId: 'leg-1', exitPlanId: 'plan-A', ocoGroupId: 'oco-1' }
    expect(validateOrderIntent(intent).ok).toBe(true)
    expect(validateOrderIntent({ ...intent, legId: 5 }).ok).toBe(false)
    const order = { ...contract('order-denied'), status: 'open', problem: undefined, legId: 'leg-1', exitPlanId: 'plan-A', ocoGroupId: 'oco-1' }
    delete (order as { problem?: unknown }).problem
    expect(validateOrder(order).ok).toBe(true)
    expect(validateFill({ ...sample('Fill'), legId: 'leg-1', exitPlanId: 'plan-A' }).ok).toBe(true)
    const pos = { ...sample('Position'), legs: [{ legId: 'leg-1', exitPlanId: 'plan-A', size: '0.002', entryPrice: '83000' }, { legId: 'leg-2', size: '0.001' }] }
    expect(validatePosition(pos).ok).toBe(true)
    expect(validatePosition({ ...pos, legs: [{ size: '0.002' }] }).ok).toBe(false)
    expect(validatePosition({ ...pos, legs: [{ legId: 'x', size: 0.002 }] }).ok).toBe(false)
    const o = clone(contract('order-denied'))
    o.origin.causation = { instanceId: 'inst_01JAB9', legId: 'leg-1', exitPlanId: 'plan-A' }
    expect(validateOrder(o).ok).toBe(true)
  })
  it('实验阶段：原六个值保留，追加 hypothesis / holdout / shadow / live / retired', () => {
    expect([...EXPERIMENT_STAGES].slice(0, 6)).toEqual(['draft', 'backtest', 'paper', 'live_small', 'review', 'closed'])
    for (const st of ['hypothesis', 'holdout', 'shadow', 'live', 'retired']) {
      expect(EXPERIMENT_STAGES).toContain(st)
      expect(validateExperiment({ ...sample('Experiment'), stage: st }).ok, st).toBe(true)
    }
    expect(validateExperiment({ ...sample('Experiment'), stage: 'launched' }).ok).toBe(false)
  })
  it('DecisionRecord.modelVersion 与 model.trained 账本类型', () => {
    expect(validateDecisionRecord({ ...contract('decision-fast'), modelVersion: '2026-10-10.rolling-3' }).ok).toBe(true)
    expect(validateDecisionRecord({ ...contract('decision-fast'), modelVersion: '' }).ok).toBe(false)
    expect(LEDGER_ENTRY_TYPE_LIST).toContain('model.trained')
    const payload = { modelId: 'cls-eth-15m', modelVersion: '2026-10-10.rolling-3', modelSha256: `sha256:${'a'.repeat(64)}`, trainWindow: { from: 1788220800000, to: 1790812800000 }, labelMaturityMs: 3_600_000, sampleCount: 4200, metrics: { auc: 0.58 } }
    expect(validateModelTrainedPayload(payload).ok).toBe(true)
    expect(validateModelTrainedPayload({ ...payload, labelMaturityMs: undefined }).ok).toBe(false)
    const entry = { ...clone(buildChain()[0]!), type: 'model.trained' as const, seq: 0 }
    expect(validateLedgerEntry({ ...entry, type: 'checkpoint' }).ok).toBe(true)
    expect(validateLedgerEntry({ ...entry, type: 'model.trained' }).ok).toBe(false) // seq 0 必须是创世 checkpoint
    expect(validateLedgerEntry({ ...entry, type: 'model.trained', seq: 5, prevHash: entry.prevHash }).ok).toBe(true)
  })
  it('Instrument 交易时段与点差', () => {
    const gold = {
      ...contract('instrument-xyz-tsla'), instrumentId: 'hyperliquid:xyz:GOLD', symbol: 'xyz:GOLD', displaySymbol: 'GOLD', assetClass: 'metals',
      typicalSpreadBps: 1.5,
      sessions: { tz: 'America/New_York', windows: [
        { days: [1, 2, 3, 4], from: '18:00', to: '17:00', quality: 'regular', typicalSpreadBps: 1.2 },
        { days: [5], from: '17:00', to: '18:00', quality: 'closed' },
        { days: [0, 6], from: '00:00', to: '23:59', quality: 'thin', typicalSpreadBps: 4 },
      ] },
    }
    expect(validateInstrument(gold).ok).toBe(true)
    expect(validateInstrument(contract('instrument-xyz-tsla')).ok).toBe(true)
    expect(validateInstrument({ ...gold, sessions: { tz: 'UTC', windows: [{ days: [7], from: '00:00', to: '01:00', quality: 'regular' }] } }).ok).toBe(false)
    expect(validateInstrument({ ...gold, sessions: { tz: 'UTC', windows: [{ days: [1], from: '9am', to: '01:00', quality: 'regular' }] } }).ok).toBe(false)
    expect(validateInstrument({ ...gold, sessions: { tz: 'UTC', windows: [{ days: [1], from: '00:00', to: '01:00', quality: 'sleepy' }] } }).ok).toBe(false)
  })
  const attribution = (): LossAttribution => ({
    totalLoss: '-120.5' as never, earlyExit: '-40.25' as never, lateExit: '-30' as never, violation: '-20.125' as never, overtrading: '-10.125' as never, residual: '-20' as never,
    method: 'ledger-replay-v1', basis: { fromSeq: 100, toSeq: 900 },
  })
  it('亏损分解：放在 Experiment.metrics 里，各项之和必须等于 totalLoss（精确十进制）', () => {
    const a = attribution()
    expect(checkLossAttribution(a)).toEqual([])
    expect(validateLossAttribution(a).ok).toBe(true)
    const e = { ...sample('Experiment'), metrics: { backtest: { totalReturnRatio: 0.04 }, live: { lossAttribution: a } } }
    expect(validateExperiment(e).ok).toBe(true)
    expect(validateExperiment({ ...e, metrics: { live: { lossAttribution: { ...a, residual: -20 } } } }).ok).toBe(false)
    const off = { ...a, residual: '-20.001' as never }
    expect(checkLossAttribution(off).join()).toContain('do not add up')
    expect(validateLossAttribution(off).ok).toBe(false)
    expect(checkLossAttribution({ ...a, totalLoss: '0' as never, earlyExit: '0.1' as never, lateExit: '0.2' as never, violation: '-0.3' as never, overtrading: '0' as never, residual: '0' as never })).toEqual([])
  })
})
