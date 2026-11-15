// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { defaultConfig, validateConfig } from '../src/config'
import { noticeForEvent } from '../src/notify/templates'
import { containsPluginSecret } from '../src/plugin-secrets'

describe('notification configuration', () => {
  it('rejects credentials placed in channel params without echoing them', () => {
    const c = config()
    Object.assign(c.notify.channels[0]!.params, { password: ['synthetic', 'params', 'fixture'].join('-') })
    const problems = validateConfig(c)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).not.toContain('synthetic-params-fixture')
  })

  const config = () => ({ ...defaultConfig(), notify: {
    channels: [{ id: 'main', plugin: 'connector.test.notify', minLevel: 'warn', params: { target: 'room-01' } }],
    rules: [{ match: 'takeover.*', level: 'critical', channels: ['main'] }],
    rateLimit: { perChannelPerMinute: 20, dedupeWindowSec: 300 },
  } })

  it('accepts channel routing and env handles without requiring notifications on old configs', () => {
    expect(validateConfig(defaultConfig())).toEqual([])
    const c = config()
    Object.assign(c.plugins, { secrets: { 'connector.test.notify': { DELIVERY_TOKEN: 'env:NOTIFY_TEST_TOKEN' } } })
    expect(validateConfig(c)).toEqual([])
  })

  it.each([
    ['duplicate channel', (c: ReturnType<typeof config>) => c.notify.channels.push(c.notify.channels[0]!)],
    ['invalid level', (c: ReturnType<typeof config>) => { c.notify.channels[0]!.minLevel = 'urgent' }],
    ['unknown route', (c: ReturnType<typeof config>) => { c.notify.rules[0]!.channels = ['missing'] }],
    ['invalid wildcard', (c: ReturnType<typeof config>) => { c.notify.rules[0]!.match = 'take*over' }],
    ['zero budget', (c: ReturnType<typeof config>) => { c.notify.rateLimit.perChannelPerMinute = 0 }],
    ['fractional window', (c: ReturnType<typeof config>) => { c.notify.rateLimit.dedupeWindowSec = 0.5 }],
    ['array params', (c: ReturnType<typeof config>) => { Object.assign(c.notify.channels[0]!, { params: [] }) }],
  ])('rejects %s', (_name, change) => {
    const c = config()
    change(c)
    expect(validateConfig(c).length).toBeGreaterThan(0)
  })

  it('rejects literal secret configuration without echoing the value', () => {
    const c = config()
    const value = ['synthetic', 'credential', 'fixture'].join('-')
    Object.assign(c.plugins, { secrets: { 'connector.test.notify': { DELIVERY_TOKEN: value } } })
    const problems = validateConfig(c)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).not.toContain(value)
  })
})

describe('notification event templates', () => {
  it.each(['two words', '中文阶段', 'x'.repeat(65)])('omits non-token facts: %s', value => {
    const notice = noticeForEvent({ topic: 'engine.health', ts: 1, seq: 1, data: {
      state: value, status: value, reason: 'reason-token', detail: 'detail-token', desc: 'desc-token',
      notes: 'notes-token', error: { code: 5006, detail: 'nested-detail' },
      accountId: 'acct_fixture', price: '123456789.00000001', failed: false,
    } })!
    expect(notice.lines).toEqual(['ts: 1', 'accountId: acct_fixture', 'error.code: 5006', 'failed: false',
      'price: 123456789.00000001', 'state: [text omitted]', 'status: [text omitted]'])
  })
  it('never lets publisher keys change deduplication identity', () => {
    const notice = (data: unknown) => noticeForEvent({ topic: 'risk.denials', ts: 1, seq: 1, data })!
    const first = notice({ precheckId: 'one', key: 'publisher-key' })
    expect(first.key).toMatch(/^[a-f0-9]{64}$/)
    expect(notice({ precheckId: 'one', key: 'another-key' }).key).toBe(first.key)
    expect(notice({ precheckId: 'two', key: 'publisher-key' }).key).not.toBe(first.key)
  })
  it('uses one takeover key across stages and a separate key for all failure sources', () => {
    const ledger = (type: string, takeoverId = 'takeover-1', payload = {}) => noticeForEvent({
      topic: 'ledger.entry', ts: 1, seq: 1, data: { type, subject: { takeoverId }, payload },
    })!
    const requested = ledger('takeover.requested')
    expect(ledger('takeover.applied', 'takeover-1', { phase: 'applied' }).key).toBe(requested.key)
    expect(ledger('takeover.completed').key).toBe(requested.key)
    expect(ledger('trading_state.changed', 'takeover-1', { to: 'REDUCING' }).key).toBe(requested.key)
    expect(ledger('takeover.requested', 'takeover-2').key).not.toBe(requested.key)
    const failed = ledger('takeover.failed', 'takeover-1', { phase: 'cancel_all' })
    expect(failed.level).toBe('critical')
    expect(failed.key).not.toBe(requested.key)
    expect(noticeForEvent({ topic: 'takeover.alert', ts: 2, seq: 2,
      data: { takeoverId: 'takeover-1', phase: 'flatten' } })!.key).toBe(failed.key)
  })
  it.each([
    ['risk.denials', {}, 'warn'],
    ['risk.state', { to: 'HALTED' }, 'critical'],
    ['risk.state', { to: 'REDUCING' }, 'critical'],
    ['risk.state', { to: 'ACTIVE' }, 'info'],
    ['takeover.alert', { phase: 'failed' }, 'critical'],
    ['engine.health', { status: 'down' }, 'critical'],
    ['engine.health', { gep: 'failed' }, 'critical'],
    ['engine.health', { state: 'ready' }, 'info'],
    ['plugin.state', { state: 'failed' }, 'warn'],
    ['plugin.state', { state: 'degraded' }, 'info'],
    ['mandate.changed', { status: 'downgraded' }, 'warn'],
    ['mandate.changed', { status: 'revoked' }, 'warn'],
    ['mandate.changed', { status: 'expired' }, 'warn'],
    ['proposal.failed', {}, 'warn'],
    ['proposal.decided', {}, 'info'],
    ['proposal.executed', {}, 'info'],
    ['ledger.entry', { type: 'protector.triggered' }, 'critical'],
    ['ledger.entry', { type: 'risk.denied' }, 'warn'],
    ['ledger.entry', { type: 'trading_state.changed', payload: { to: 'HALTED' } }, 'critical'],
    ['ledger.entry', { type: 'trading_state.changed', payload: { to: 'REDUCING' } }, 'critical'],
    ['ledger.entry', { type: 'experiment.stage_changed' }, 'info'],
    ['ledger.entry', { type: 'takeover.completed' }, 'critical'],
  ] as const)('classifies %s %j as %s', (topic, data, expected) => {
    expect(noticeForEvent({ topic, data, ts: 1234, seq: 1 })).toMatchObject({ level: expected, ts: 1234 })
  })
  it('extracts ledger subjects and exact decimal facts, ignoring unrelated entries and unknown payload fields', () => {
    const notice = noticeForEvent({ topic: 'ledger.entry', ts: 1234, seq: 1, data: {
      type: 'risk.denied', subject: { accountId: 'acct_fixture', instrumentId: 'instrument-01' },
      ruleHits: [{ ruleId: 'budget', actual: '123456789.00000001', limit: '10.00' }], payload: { ignored: 'opaque-value' },
    } })!
    expect(notice.lines.join(' ')).toContain('123456789.00000001')
    expect(notice.lines.join(' ')).toContain('acct_fixture')
    expect(notice.lines.join(' ')).not.toContain('opaque-value')
    expect(noticeForEvent({ topic: 'ledger.entry', ts: 1, seq: 1, data: { type: 'order.amended' } })).toBeUndefined()
    expect(noticeForEvent({ topic: 'market.quote', ts: 1, seq: 1, data: {} })).toBeUndefined()
  })
  it('uses a stable content key across repeated timestamps and property order', () => {
    const first = noticeForEvent({ topic: 'risk.denials', ts: 1, seq: 1, data: { accountId: 'acct_fixture', precheckId: 'one' } })!
    const later = noticeForEvent({ topic: 'risk.denials', ts: 2, seq: 2, data: { precheckId: 'one', accountId: 'acct_fixture' } })!
    const other = noticeForEvent({ topic: 'risk.denials', ts: 2, seq: 3, data: { accountId: 'acct_fixture', precheckId: 'two' } })!
    expect(later.key).toBe(first.key)
    expect(other.key).not.toBe(first.key)
  })
})

describe('plugin secret frame guard', () => {
  it.each(['1', '0.1', 'ok', 'true', '1234567'])('does not reject frames containing a short value (%s)', value => {
    expect(containsPluginSecret({ ok: true, ref: value }, [value])).toBe(false)
  })
  it('still rejects raw, JSON-escaped, base64 and URI-encoded values at eight characters', () => {
    const value = 'ab\ncd/ef'
    for (const form of [value, Buffer.from(value).toString('base64'), encodeURIComponent(value)]) {
      expect(containsPluginSecret({ ref: form }, [value])).toBe(true)
    }
  })
})
