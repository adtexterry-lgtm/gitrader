// SPDX-License-Identifier: CPAL-1.0
// P1-20 / ADR-3：策略开启 requireStopOnAgentOpen 时，Agent 开仓必须带 tpsl.stopLoss（纸面与实盘同一规则）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  asDecimal, type AccountId, type ClientOrderId, type Decimal, type GateInput, type InstrumentId, type Mandate,
  type PrecheckId, type RiskPolicy, type RuleHit, type Sha256Digest, type VenueId,
} from '@gitrader/protocol'
import { evaluateGateStages } from '../src/risk-gate/stages'
import { defaultConfig } from '../src/config'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

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

const stopHits = (i: GateInput): RuleHit[] => Object.values(evaluateGateStages(i).byStage).flat().filter((hit) => hit.code === 'STOP_REQUIRED')
const withStop = (): OrderIntentFixture => intentOf({ tpsl: { grouping: 'order', stopLoss: { triggerPrice: decimal('79000') } } })

let h: Harness | undefined
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('P1-20 requireStopOnAgentOpen', () => {
  it('agent open without stop is denied when on', () => {
    const hits = stopHits(base({ policy: policy({ requireStopOnAgentOpen: true }) }))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ruleId: 'pol_test#requireStop', action: 'deny', scope: 'org', unit: 'violations' })
    expect(hits[0]!.message).toContain('Agent 开仓必须带止损（tpsl.stopLoss）')
    expect(hits[0]!.message).toContain('expected=tpsl.stopLoss; actual=missing')
  })

  it('agent open with stop is allowed when on', () => {
    const input = base({ policy: policy({ requireStopOnAgentOpen: true }), target: { kind: 'order', intent: withStop() } })
    expect(stopHits(input)).toEqual([])
    expect(Object.values(evaluateGateStages(input).byStage).flat().filter((hit) => hit.code === 'TPSL_INVALID')).toEqual([])
  })

  it('human open without stop is allowed', () => {
    const input = base({ actorClass: 'human', policy: policy({ requireStopOnAgentOpen: true }) })
    const out = evaluateGateStages(input)
    expect(stopHits(input)).toEqual([])
    expect(Object.values(out.byStage).flat().filter((hit) => hit.code === 'STOP_REQUIRED')).toEqual([])
  })

  it('policy without the field keeps old behaviour', () => {
    expect(stopHits(base())).toEqual([])
  })

  it('config turning it off is ignored as loosening', () => {
    const risk = h!.k.risk
    // 先由配置把它打开（收紧照常生效），再用配置关掉（放宽被忽略）
    expect(risk.seedFromConfig({ ...defaultConfig().risk, requireStopOnAgentOpen: true }).action).toBe('tightened')
    expect(risk.current()?.requireStopOnAgentOpen).toBe(true)
    const seeded = risk.seedFromConfig({ ...defaultConfig().risk, requireStopOnAgentOpen: false })
    expect(seeded.action).toBe('ignored-looser')
    expect(seeded.warnings.some((w) => w.includes('requireStopOnAgentOpen'))).toBe(true)
    expect(risk.current()?.requireStopOnAgentOpen).toBe(true)
  })

  // 新 home 默认开由 CLI 在新建 gitrader.json 时写入（packages/cli/test/p1-20-new-home.test.ts）；内核默认值保持字段缺省 = 关。
  it('kernel default config leaves the field unset', () => {
    expect(defaultConfig().risk.requireStopOnAgentOpen).toBeUndefined()
    expect(h!.k.risk.current()?.requireStopOnAgentOpen).not.toBe(true)
  })
})
