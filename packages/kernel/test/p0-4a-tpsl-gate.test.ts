// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import {
  asDecimal, type AccountId, type ClientOrderId, type Decimal, type GateInput, type InstrumentId, type Mandate,
  type PrecheckId, type RiskPolicy, type RuleHit, type Sha256Digest, type VenueId,
} from '@gitrader/protocol'
import { evaluateGateStages } from '../src/risk-gate/stages'
import { normalizeIntent } from '../src/normalize'
import * as d from '../src/util/dec'
import { FakeClock } from '../src/util/clock'
import { BTC, FakeConnector } from './helpers/fake-connector'

const decimal = (value: string): Decimal => asDecimal(value)
const accountId = 'acct_test' as AccountId
const instrumentId: InstrumentId = 'venue:asset'

type OrderIntentFixture = Extract<GateInput['target'], { kind: 'order' }>['intent']

const intentOf = (extra: Partial<OrderIntentFixture> = {}): OrderIntentFixture => ({
  accountId, instrumentId, side: 'buy', type: 'limit', size: decimal('0.01'), price: decimal('80000'),
  tif: 'gtc', clientOrderId: '0123456789abcdef0123456789abcdef' as ClientOrderId, ...extra,
})

const policy = (): RiskPolicy => ({
  policyId: 'pol_test', version: 1, scope: { type: 'account', id: accountId },
  limits: { maxSlippageBps: 50 }, failClosed: { stalePriceMs: 5000, staleAccountMs: 30000, onMissingPrice: 'deny' },
  dailyResetAt: '00:00Z', valuationCcy: 'USD',
  attestation: { method: 'system', by: 'kernel', at: 1, digest: `sha256:${'a'.repeat(64)}` as Sha256Digest, sig: 'signature' },
})

const mandate = (): Mandate => ({
  mandateId: 'mdt_test', version: 1, subject: { type: 'agentKey', id: 'ak_test' }, level: 'L3',
  accounts: [accountId], instrumentAllowlist: [instrumentId], venueAllowlist: ['venue' as VenueId],
  limits: { maxOrderNotional: decimal('100000'), maxDailyNotional: decimal('100000'), maxDailyLoss: decimal('100000'), autoMaxOrderNotional: decimal('100000') },
  notBefore: 0, notAfter: 100000, status: 'active', issuedBy: 'user:test',
  attestation: { method: 'system', by: 'kernel', at: 1, digest: `sha256:${'b'.repeat(64)}` as Sha256Digest, sig: 'signature' },
})

const base = (overrides: Partial<GateInput> = {}): GateInput => {
  const input: GateInput = {
    precheckId: 'pck_test' as PrecheckId, dryRun: true, action: 'open', actorClass: 'agent', originActorType: 'engine',
    account: { accountId, venue: 'venue' as VenueId, mode: 'paper', groupIds: [] },
    snapshot: { equity: decimal('100000'), available: decimal('100000'), availableDeductsOpenOrders: false, positions: [], openOrders: [], stopLossOrderIds: [], asOf: 0 as GateInput['now'], stale: false },
    mark: { price: decimal('80000'), ts: 1000 as GateInput['now'], source: 'venue_mark' }, mandate: mandate(), mandateIntegrity: { ok: true, problems: [] },
    policy: policy(), policyIntegrity: { ok: true, problems: [] }, path: 'direct', now: 1000,
    stats: { dailyNotional: decimal('0'), mandateDailyNotional: decimal('0'), ordersLastMinute: 0, mandateOrdersLastMinute: 0, ordersToday: 0, mandateOrdersToday: 0 },
    reserved: { account: { margin: decimal('0'), notional: decimal('0'), count: 0 }, byInstrument: {}, today: { notional: decimal('0'), count: 0 }, lastMinute: { count: 0 } },
    states: [], killSwitch: { tripped: false }, protectorResults: [], target: { kind: 'order', intent: intentOf() },
    instrument: {
      instrumentId, venue: 'venue' as VenueId, symbol: 'ASSET', displaySymbol: 'ASSET', kind: 'perp', base: 'ASSET', quote: 'USD',
      settle: 'USD', settlement: 'linear', contractSize: decimal('1'), venueSizeUnit: 'base', assetClass: 'crypto', status: 'trading',
      price: { sigFigs: 5, maxDecimals: 1 }, size: { step: decimal('0.01'), decimals: 2, min: decimal('0.01') },
      minNotional: decimal('10'), maxLeverage: 20, marginModes: ['cross'], orderTypes: ['limit'], tif: ['gtc'],
      triggerPriceTypes: ['mark'], fundingIntervalMs: 60000, fees: { maker: decimal('0.00015'), taker: decimal('0.00045'), source: 'venue' }, updatedAt: 0,
    },
  }
  return Object.assign(input, overrides)
}

const tpslHits = (i: GateInput): RuleHit[] => Object.values(evaluateGateStages(i).byStage).flat().filter((hit) => hit.code === 'TPSL_INVALID')

describe('P0-4a tpsl gate', () => {
  it('SL on loss side allow, maxLoss computed', () => {
    const input = base({ target: { kind: 'order', intent: intentOf({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: decimal('79000') } } }) } })
    expect(tpslHits(input)).toEqual([])
    const expected = d.str(d.add(
      d.mul(d.mul(d.D('0.01'), d.D('1')), d.abs(d.sub(d.D('80000'), d.D('79000')))),
      d.mul(d.mul(d.D('0.01'), d.mul(d.D('80000'), d.D('1'))), d.D('0.00015')),
    ))
    expect(expected).toBe('10.12')
    expect(evaluateGateStages(input).estimates.maxLoss).toBe(expected)
  })

  it('SL on profit side deny TPSL_INVALID', () => {
    const input = base({ target: { kind: 'order', intent: intentOf({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: decimal('81000') } } }) } })
    const hits = tpslHits(input)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ruleId: 'pol_test#tpsl:stopLoss', action: 'deny', scope: 'org' })
    expect(hits[0]!.message).toContain('止损价 81000 在参考价 80000 的盈利一侧')
  })

  it('TP on wrong side deny', () => {
    const input = base({ target: { kind: 'order', intent: intentOf({ tpsl: { grouping: 'order', takeProfit: { triggerPrice: decimal('79000') } } }) } })
    const hits = tpslHits(input)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ruleId: 'pol_test#tpsl:takeProfit', action: 'deny' })
    expect(hits[0]!.message).toContain('止盈价 79000 在参考价 80000 的亏损一侧')
  })

  it('trigger price rounded to tick under passive rounding', () => {
    const inst = new FakeConnector({ id: 'kernel-sim', clock: new FakeClock() }).getInstrument(BTC)!
    const intent = {
      accountId: 'acct_X' as never, instrumentId: BTC, side: 'buy' as const, type: 'limit' as const,
      size: '0.01' as never, price: '80000' as never, rounding: 'passive' as const,
      tpsl: { grouping: 'order' as const, stopLoss: { triggerPrice: '79999.5' as never }, takeProfit: { triggerPrice: '81000.5' as never } },
    }
    const normalized = normalizeIntent(intent, inst, { defaultMaxSlippageBps: 50 })
    expect(normalized.tpsl?.stopLoss?.triggerPrice).toBe('79999')
    expect(normalized.tpsl?.takeProfit?.triggerPrice).toBe('81001')
    expect(intent.tpsl.stopLoss.triggerPrice).toBe('79999.5')
    expect(intent.tpsl.takeProfit.triggerPrice).toBe('81000.5')
  })

  it('no tpsl → no maxLoss', () => {
    const estimates = evaluateGateStages(base()).estimates
    expect('maxLoss' in estimates).toBe(false)
    expect(tpslHits(base())).toEqual([])
  })

  it('position grouping from agent denied', () => {
    const input = base({ target: { kind: 'order', intent: intentOf({ tpsl: { grouping: 'position', stopLoss: { triggerPrice: decimal('79000') } } }) } })
    const hits = tpslHits(input)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ruleId).toBe('pol_test#tpsl:grouping')
    expect(hits[0]!.message).toContain('grouping: position')
  })
})
