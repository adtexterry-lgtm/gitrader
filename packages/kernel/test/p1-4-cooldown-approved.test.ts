// SPDX-License-Identifier: CPAL-1.0
// P1-4 / ADR-8：开仓冷却不约束人已批准的提案（i.path === 'approved' 整段跳过）。
import { describe, expect, it } from 'vitest'
import {
  asDecimal, type AccountId, type ClientOrderId, type Decimal, type GateInput, type InstrumentId, type Mandate,
  type PrecheckId, type RiskPolicy, type RuleHit, type Sha256Digest, type VenueId,
} from '@gitrader/protocol'
import { evaluateGateStages } from '../src/risk-gate/stages'

const decimal = (value: string): Decimal => asDecimal(value)
const accountId = 'acct_test' as AccountId
const instrumentId: InstrumentId = 'venue:asset'

type OrderIntentFixture = Extract<GateInput['target'], { kind: 'order' }>['intent']

const intentOf = (extra: Partial<OrderIntentFixture> = {}): OrderIntentFixture => ({
  accountId, instrumentId, side: 'buy', type: 'limit', size: decimal('0.01'), price: decimal('80000'),
  tif: 'gtc', clientOrderId: '0123456789abcdef0123456789abcdef' as ClientOrderId, ...extra,
})

const policy = (extra: Partial<RiskPolicy> = {}): RiskPolicy => ({
  policyId: 'pol_test', version: 1, scope: { type: 'account', id: accountId },
  limits: { maxSlippageBps: 50 }, failClosed: { stalePriceMs: 5000, staleAccountMs: 30000, onMissingPrice: 'deny' },
  dailyResetAt: '00:00Z', valuationCcy: 'USD',
  attestation: { method: 'system', by: 'kernel', at: 1, digest: `sha256:${'a'.repeat(64)}` as Sha256Digest, sig: 'signature' },
  ...extra,
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

// 冷却：10 秒前刚开过仓，冷却 60 秒；enforce 与 monitor 各一个。
const COOLDOWN_PROTECTORS: RiskPolicy['protectors'] = [
  { kind: 'cooldown', afterOpenSec: 60 },
  { kind: 'cooldown', afterOpenSec: 60, mode: 'monitor' },
]

const withCooldown = (overrides: Partial<GateInput> = {}): GateInput => base({
  ...overrides,
  policy: policy({ protectors: COOLDOWN_PROTECTORS }),
  stats: {
    dailyNotional: decimal('0'), mandateDailyNotional: decimal('0'), ordersLastMinute: 0, mandateOrdersLastMinute: 0,
    ordersToday: 0, mandateOrdersToday: 0, lastOpenTs: 0 as GateInput['now'],
  },
})

const hitsOf = (i: GateInput): RuleHit[] => Object.values(evaluateGateStages(i).byStage).flat()
const cooldownHits = (i: GateInput): RuleHit[] => hitsOf(i).filter((hit) => hit.ruleId === 'pol_test#cooldown')
const cooldownMonitors = (i: GateInput): RuleHit[] => evaluateGateStages(i).monitorHits.filter((hit) => hit.ruleId === 'pol_test#cooldown')

describe('P1-4 cooldown vs approved path', () => {
  it('approved path skips cooldown', () => {
    const input = withCooldown({ path: 'approved' })
    const out = evaluateGateStages(input)
    expect(hitsOf(input).filter((hit) => hit.code === 'COOLDOWN')).toEqual([])
    expect(cooldownMonitors(input)).toEqual([])
    expect(out.byStage.PROTECTOR?.some((hit) => hit.ruleId === 'pol_test#cooldown')).not.toBe(true)
  })

  it('agent path keeps cooldown', () => {
    for (const path of ['direct', 'proposal'] as const) {
      const input = withCooldown({ path })
      const enforce = cooldownHits(input)
      expect(enforce).toHaveLength(1)
      expect(enforce[0]).toMatchObject({ code: 'COOLDOWN', action: 'deny', scope: 'account', unit: 's', limit: '60', actual: '1' })
      const monitor = cooldownMonitors(input)
      expect(monitor).toHaveLength(1)
      expect(monitor[0]).toMatchObject({ code: 'COOLDOWN', action: 'warn' })
    }
  })

  it('approved path still enforces order notional limit', () => {
    const input = base({
      path: 'approved',
      policy: policy({ limits: { maxSlippageBps: 50, maxOrderNotional: decimal('10') } }),
    })
    const hits = hitsOf(input).filter((hit) => hit.code === 'ORDER_NOTIONAL' && hit.ruleId === 'pol_test#maxOrderNotional')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ action: 'deny', scope: 'account', limit: '10', actual: '800' })
  })
})
