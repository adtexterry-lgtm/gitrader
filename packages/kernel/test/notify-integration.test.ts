// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { enableLive, makeHarness, makeAgent } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { pinPluginDir } from '../src/plugins'
import { Metrics } from '../src/metrics'
import { fakeNotifyManifest } from './fixtures/plugin-notify-fake/manifest'
import { BTC } from './helpers/fake-connector'
import { newClientOrderId } from '../src/util/ids'

let h: Harness | undefined
const logs: string[] = []
const credential = () => ['synthetic', 'notify', 'credential'].join('-')
afterEach(async () => { vi.useRealTimers(); await h?.cleanup(); h = undefined; logs.length = 0 })

async function setup(params: Record<string, unknown> = {}, secrets: string[] = [], options: { secretValue?: string; start?: boolean } = {}): Promise<{ file: string; metrics: Metrics }> {
  h = await makeHarness({ configure: c => { c.plugins.developerMode = true }, kernel: {
    log: message => logs.push(message), resolveSecret: ref => ref === 'env:NOTIFY_TEST_TOKEN' ? options.secretValue ?? credential() : undefined,
  } })
  const dir = join(h.home, 'plugins', 'notify-fixture')
  mkdirSync(dir, { recursive: true })
  copyFileSync(resolve(__dirname, 'fixtures/plugin-notify-fake/gsp.mjs'), join(dir, 'gsp.mjs'))
  const manifest = { ...fakeNotifyManifest, secrets, runtime: { type: 'sidecar', native: false, diskMB: 1 }, entry: { transport: 'stdio' },
    'x-launch': { command: process.execPath, args: ['gsp.mjs'] } }
  writeFileSync(join(dir, 'gitrader-plugin.json'), JSON.stringify(manifest))
  pinPluginDir(dir)
  const result = await h.k.plugins.reload()
  expect(result.rejected).toEqual([])
  h.k.plugins.grant(manifest.id, [], h.sessionProof())
  h.k.config.plugins.secrets = { [manifest.id]: { DELIVERY_TOKEN: 'env:NOTIFY_TEST_TOKEN', UNUSED: 'env:IGNORED' } }
  const file = join(h.home, 'notices.jsonl')
  h.k.config.notify = { channels: [{ id: 'main', plugin: manifest.id, minLevel: 'warn', params: { output: file, ...params } }], rateLimit: { perChannelPerMinute: 20, dedupeWindowSec: 300 } }
  // Start before the fixture writes output, so the content pin is checked against the pristine artifact.
  if (options.start !== false) await h.k.plugins.start(manifest.id)
  return { file, metrics: new Metrics(h.k) }
}
const rows = (file: string): { notice: { key: string; level: string; topic: string; title: string; lines: string[] }; attempt: number; params: Record<string, unknown> }[] =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const denial = (id = 'check-1') => ({ accountId: 'acct_fixture', precheckId: id, ruleHits: [{ ruleId: 'size', actual: '12.50', limit: '10.00' }] })
const sent = async (metrics: Metrics, count: number, level = 'warn') => vi.waitFor(() => {
  expect(metrics.render()).toContain(`notify_sent_total{channel="main",level="${level}"} ${count}`)
}, { timeout: 5000 })

describe('notification outlet with a real stdio channel', () => {
  it('settles queued diagnostics on shutdown and stops listening for new events', async () => {
    const { file, metrics } = await setup()
    const pending = h!.k.notify.test('main')
    h!.k.notify.stop()
    expect(await pending).toMatchObject({ results: [{ ok: false, reason: 'stopped' }] })
    h!.k.events.publish('risk.denials', denial())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(rows(file)).toEqual([])
    expect(metrics.render()).toContain('notify_dropped_total 1')
  })

  it('queues synchronous risk and takeover events, preserves facts and records no notification ledger entries', async () => {
    const { file, metrics } = await setup()
    const before = h!.k.ledger.count()
    h!.k.events.publish('risk.denials', denial())
    expect(rows(file)).toHaveLength(0)
    await sent(metrics, 1)
    expect(rows(file)[0]!.notice).toMatchObject({ level: 'warn', topic: 'risk.denials' })
    expect(rows(file)[0]!.notice.lines.join(' ')).toContain('12.50')
    h!.k.events.publish('takeover.alert', { takeoverId: 'takeover-1', phase: 'failed', accountId: 'acct_fixture' })
    await sent(metrics, 1, 'critical')
    expect(rows(file)[1]!.notice.level).toBe('critical')
    expect(h!.k.ledger.count()).toBe(before)
  })

  it('delivers one critical notice for kill with the same single requested takeover id', async () => {
    const { file, metrics } = await setup()
    await enableLive(h!)
    let finishTrip!: (armed: number) => void
    const tripWait = new Promise<number>(resolve => { finishTrip = resolve })
    vi.spyOn(h!.k.deadman, 'trip').mockReturnValue(tripWait)
    const ctx = h!.human('ui:kill')
    const pending = h!.k.takeover.kill('manual stop', ctx)
    try {
      await sent(metrics, 1, 'critical')
      const critical = rows(file).filter(row => row.notice.level === 'critical')
      expect(critical).toHaveLength(1)
      expect(critical[0]!.notice.topic).toBe('takeover.requested')
      const requested = h!.k.ledger.query({ types: ['takeover.requested'] })
      expect(requested).toHaveLength(1)
      expect(requested[0]!.origin.requestId).toBe(ctx.origin.requestId)
      expect(h!.k.tstate.get({ type: 'org', id: 'org_local' })).toBe('HALTED')
      finishTrip(0)
      const result = await pending
      expect(requested[0]!.subject.takeoverId).toBe(result.takeoverId)
    } finally {
      finishTrip(0)
      await pending.catch(() => undefined)
    }
  })

  it('deduplicates for five minutes and delivers again at expiry', async () => {
    const { file, metrics } = await setup()
    h!.k.events.publish('risk.denials', denial())
    h!.k.events.publish('risk.denials', denial())
    await sent(metrics, 1)
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_deduplicated_total 1'))
    expect(rows(file)).toHaveLength(1)
    h!.clock.advance(300_000)
    h!.k.events.publish('risk.denials', denial())
    await sent(metrics, 2)
    expect(rows(file)).toHaveLength(2)
  })

  it('applies first matching route and level then sends in channel order', async () => {
    const { file, metrics } = await setup()
    const channel = h!.k.config.notify!.channels[0]!
    h!.k.config.notify!.channels.push({ ...channel, id: 'second', params: { ...channel.params, marker: 'second' } })
    h!.k.config.notify!.rules = [{ match: 'proposal.*', level: 'critical', channels: ['main', 'second'] }]
    h!.k.events.publish('proposal.decided', { proposalId: 'proposal-1', status: 'approved' })
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_sent_total{channel="second",level="critical"} 1'))
    expect(rows(file).map(row => row.params.marker ?? 'main')).toEqual(['main', 'second'])
  })

  it('redacts promise wording and counts each redacted line', async () => {
    const { file, metrics } = await setup()
    h!.k.events.publish('risk.denials', { ...denial(), phase: 'risk-free', reason: '保证收益' })
    await sent(metrics, 1)
    expect(rows(file)[0]!.notice.lines).toContain('[redacted wording]')
    expect(readFileSync(file, 'utf8')).not.toContain('保证收益')
    expect(metrics.render()).toContain('notify_redacted_total 1')
  })

  it('merges excess notices at the end of the minute without needing another event', async () => {
    const { file, metrics } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h!.k.config.notify!.rateLimit!.perChannelPerMinute = 1
    for (let i = 0; i < 4; i++) h!.k.events.publish('risk.denials', denial(String(i)))
    await sent(metrics, 1)
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_merged_total 3'))
    h!.clock.advance(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await sent(metrics, 2)
    expect(rows(file)[1]!.notice.title).toBe('3 条通知被合并')
  })

  it.each([[false, 1], [true, 2]] as const)('honours retryable=%s with a bounded retry', async (retryable, count) => {
    const { file, metrics } = await setup({ mode: 'fail', retryable })
    h!.k.events.publish('risk.denials', denial())
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_failed_total{channel="main",reason="channel_rejected"} 1'))
    expect(rows(file)).toHaveLength(count)
    expect(logs.join(' ')).not.toContain(file)
  })

  it('recovers on the one retry and rejects malformed output', async () => {
    const { file, metrics } = await setup({ mode: 'recover' })
    h!.k.events.publish('risk.denials', denial())
    await sent(metrics, 1)
    expect(rows(file)).toHaveLength(2)
    h!.k.config.notify!.channels[0]!.params = { output: file, mode: 'invalid' }
    h!.k.events.publish('risk.denials', denial('invalid'))
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_failed_total{channel="main",reason="invalid_result"} 1'))
    expect(rows(file)).toHaveLength(3)
  })

  it('times out once (no kernel re-call: the first call may still be running), counts one failed delivery and never blocks event dispatch', async () => {
    const { file, metrics } = await setup({ mode: 'timeout' })
    let dispatched = 0
    h!.k.events.subscribe('risk.denials', () => { dispatched++ })
    h!.k.events.publish('risk.denials', denial())
    h!.k.events.publish('risk.denials', denial())
    expect(dispatched).toBe(2)
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_failed_total{channel="main",reason="timeout"} 1'), { timeout: 30_000 })
    // R2-REL-03: a timed-out call is not repeated by the kernel (one HTTP-attempt budget per notice across the whole chain)
    expect(rows(file)).toHaveLength(1)
  }, 40_000)

  it('drops the oldest queued event at the 1000 item bound', async () => {
    const { file, metrics } = await setup()
    h!.k.config.notify!.rateLimit!.perChannelPerMinute = 2000
    for (let i = 0; i < 1001; i++) h!.k.events.publish('risk.denials', denial(String(i)))
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_dropped_total 1'))
    // 1000 条逐条走真 stdio 通道，重负载下 5 秒不够：窗口放宽到 20 秒（队列按通道拆开，行为不变）
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_sent_total{channel="main",level="warn"} 1000'), { timeout: 20_000 })
    expect(rows(file)[0]!.notice.lines.join(' ')).toContain('precheckId: 1')
  }, 30_000)

  it('supports human test notices below minLevel and denies agents and generic notification tool calls', async () => {
    const { file } = await setup()
    const result = await h!.k.ops.call(h!.k, 'notify.test', { principal: h!.session, params: { channelId: 'main' }, transport: 'http', kind: 'command' })
    expect(result).toMatchObject({ results: [{ channelId: 'main', ok: true }] })
    expect(rows(file)[0]!.notice.level).toBe('info')
    const agent = await makeAgent(h!, 'read_only')
    await expect(h!.k.ops.call(h!.k, 'notify.test', { principal: agent.principal, params: { channelId: 'main' }, transport: 'http', kind: 'command' })).rejects.toThrow()
    await expect(h!.k.plugins.callTool('connector.test.notify', 'notify_send', {})).rejects.toThrow(/notification outlet/)
    await expect(h!.k.ops.call(h!.k, 'notify.test', { principal: h!.session, params: { channelId: 'missing' }, transport: 'http', kind: 'command' })).rejects.toThrow(/unknown channel/)
  })

  it('injects only declared names and keeps their values out of RPC, errors, logs and ledger', async () => {
    const { metrics } = await setup({ mode: 'leak' }, ['DELIVERY_TOKEN'])
    const result = await h!.k.plugins.callTool('connector.test.notify', 'environment_keys', {}) as { keys: string[]; helloKeys: string[] }
    const systemDrive = process.platform === 'win32'
      ? (process.env.SystemDrive ?? process.env.SystemRoot?.match(/^([A-Za-z]:)(?:\\|\/|$)/)?.[1])
      : undefined
    const baselineEnv = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(systemDrive ? { SystemDrive: systemDrive } : {}),
    }
    const baseline = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { env: baselineEnv, encoding: 'utf8', windowsHide: true })) as string[]
    expect(result.keys).toEqual([...baseline, 'DELIVERY_TOKEN', 'GITRADER_GSP_TOKEN'].sort())
    expect(result.helloKeys).toEqual([])
    expect(logs.join(' ')).toContain('UNUSED')
    h!.k.events.publish('risk.denials', denial())
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_failed_total{channel="main",reason="secret_rejected"} 1'))
    h!.k.config.notify!.channels[0]!.params = { mode: 'error' }
    const outcome = await h!.k.notify.test('main')
    expect(JSON.stringify([outcome, logs, h!.k.ledger.query({})])).not.toContain(credential())
    await h!.k.plugins.stop('connector.test.notify')
    h!.k.config.plugins.secrets = {}
    await expect(h!.k.plugins.start('connector.test.notify')).rejects.toThrow(/DELIVERY_TOKEN/)
    expect(h!.k.plugins.get('connector.test.notify')!.state).toBe('failed')
    expect(logs.join(' ')).not.toContain(credential())
  })

  it('keeps Agent proposal and takeover reasons out of every delivered notice and sends one takeover notice', async () => {
    const { file } = await setup()
    h!.k.config.notify!.channels[0]!.minLevel = 'info'
    const agent = await makeAgent(h!, 'confirm')
    const proposalText = 'AGENT-PROPOSAL 私有提案理由'
    const takeoverText = 'AGENT-TAKEOVER 私有接管理由'
    const proposal = await h!.k.trading.propose({ accountId: h!.paper.accountId, reason: proposalText, intents: [{
      accountId: h!.paper.accountId as never, instrumentId: BTC, side: 'buy', type: 'limit', size: '0.001' as never,
      price: '80000' as never, tif: 'gtc', clientOrderId: newClientOrderId(),
    }] }, agent.ctx('propose'))
    expect(proposal.status).toBe('pending')
    h!.k.trading.reject(proposal.ticket, h!.sessionProof(), h!.human('proposal.reject'))
    const takeover = await h!.k.takeover.execute({ level: 'cancel_all', scope: { type: 'account', id: h!.paper.accountId }, reason: takeoverText }, agent.ctx('takeover'))
    expect(takeover.ok).toBe(true)
    await h!.k.notify.test('main')
    const notices = rows(file).map(row => row.notice)
    expect(notices.some(notice => notice.topic === 'proposal.decided')).toBe(true)
    const related = notices.filter(notice => notice.topic.startsWith('takeover.') || ['risk.state', 'trading_state.changed'].includes(notice.topic))
    expect(related).toHaveLength(1)
    expect(related[0]!.lines).toContain(`takeoverId: ${takeover.takeoverId}`)
    expect(JSON.stringify(notices)).not.toMatch(/AGENT-PROPOSAL|AGENT-TAKEOVER|私有|reason:|detail:/)
  })

  it('deduplicates takeover updates and failure sources per channel, keeping other takeovers and expiry independent', async () => {
    const { file, metrics } = await setup()
    const channel = h!.k.config.notify!.channels[0]!
    h!.k.config.notify!.channels.push({ ...channel, id: 'second', params: { ...channel.params, marker: 'second' } })
    const publish = (type: string, id: string, payload = {}) => h!.k.events.publish('ledger.entry', {
      type, subject: { takeoverId: id }, payload,
    })
    publish('takeover.requested', 'one')
    await sent(metrics, 1, 'critical')
    publish('takeover.applied', 'one')
    publish('takeover.completed', 'one')
    h!.k.config.notify!.rules = [{ match: 'takeover.failed', level: 'info', channels: ['main', 'second'] }]
    publish('takeover.failed', 'one', { phase: 'cancel_all' })
    h!.k.events.publish('takeover.alert', { takeoverId: 'one', phase: 'cancel_all' })
    publish('takeover.failed', 'one', { phase: 'flatten' })
    publish('takeover.requested', 'two')
    await h!.k.notify.test('main')
    const deliveries = () => rows(file).filter(row => row.notice.topic !== 'notify.test')
    expect(deliveries()).toHaveLength(6)
    expect(deliveries().every(row => row.notice.level === 'critical')).toBe(true)
    expect(new Set(deliveries().map(row => row.notice.key)).size).toBe(3)
    h!.clock.advance(300_000)
    publish('takeover.completed', 'one')
    await h!.k.notify.test('main')
    expect(deliveries()).toHaveLength(8)
    expect(deliveries().at(-1)!.notice.key).toBe(deliveries()[0]!.notice.key)
  })

  it('associates takeover state changes by request and scope without hiding unrelated state changes', async () => {
    const { file } = await setup()
    const scope = { type: 'account', id: 'acct_fixture' }
    const origin = { actor: 'user:fixture', requestId: 'request-1' }
    const ledger = (type: string, payload: Record<string, unknown>, otherOrigin = origin, takeoverId?: string) => h!.k.events.publish('ledger.entry', {
      type, origin: otherOrigin, subject: takeoverId ? { takeoverId } : {}, payload,
    })
    ledger('takeover.requested', { scope }, origin, 'one')
    const state = { scope, from: 'ACTIVE', to: 'REDUCING' }
    ledger('trading_state.changed', state)
    h!.k.events.publish('risk.state', state)
    ledger('takeover.completed', { scope }, origin, 'one')
    ledger('trading_state.changed', { ...state, to: 'HALTED' }, { ...origin, requestId: 'request-other' })
    h!.k.events.publish('risk.state', { ...state, to: 'HALTED' })
    await h!.k.notify.test('main')
    const notices = rows(file).filter(row => row.notice.topic !== 'notify.test')
    expect(notices.map(row => row.notice.topic)).toEqual(['takeover.requested', 'trading_state.changed', 'risk.state'])
  })

  it('reports a missing secret name on diagnostics and outlet logs, including repeated calls', async () => {
    const { metrics } = await setup({}, ['DELIVERY_TOKEN'], { start: false })
    // Keep the diagnostic count independent of the warn-level plugin.state side effect.
    h!.k.config.notify!.channels[0]!.minLevel = 'critical'
    h!.k.config.plugins.secrets = {}
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await h!.k.notify.test('main')).toMatchObject({ results: [{ ok: false, reason: 'invalid_params',
        detail: 'missing secret handle: DELIVERY_TOKEN', retryable: false }] })
    }
    expect(logs.filter(line => line.startsWith('notification failed:')).every(line => line.includes('missing secret handle: DELIVERY_TOKEN'))).toBe(true)
    expect(logs.filter(line => line.startsWith('notification failed:'))).toHaveLength(2)
    expect(JSON.stringify(logs)).not.toContain(credential())
    expect(metrics.render()).toContain('notify_failed_total{channel="main",reason="invalid_params"} 2')
    expect(metrics.render()).not.toContain('DELIVERY_TOKEN')
    expect(metrics.render()).toContain('notify_retried_total 0')
    h!.k.events.publish('takeover.alert', { takeoverId: 'missing-handle', phase: 'failed' })
    await vi.waitFor(() => expect(metrics.render()).toContain('notify_failed_total{channel="main",reason="invalid_params"} 3'))
    expect(logs.filter(line => line.startsWith('notification failed:'))).toHaveLength(3)
    expect(logs.at(-1)).toContain('missing secret handle: DELIVERY_TOKEN')
    h!.k.config.plugins.secrets = { 'connector.test.notify': { DELIVERY_TOKEN: 'env:NOTIFY_TEST_TOKEN' } }
    await h!.k.plugins.start('connector.test.notify')
    expect(await h!.k.notify.test('main')).toMatchObject({ results: [{ ok: true }] })
    expect(JSON.stringify(logs)).not.toContain(credential())
  })

  it.each(['1', '0.1', 'ok', 'true'])('starts and sends with a short secret (%s), warning only by name', async secretValue => {
    const { file } = await setup({}, ['DELIVERY_TOKEN'], { secretValue })
    expect(h!.k.plugins.get('connector.test.notify')!.state).toBe('ready')
    expect(await h!.k.notify.test('main')).toMatchObject({ results: [{ ok: true }] })
    expect(rows(file)).toHaveLength(1)
    const warnings = logs.filter(line => line.includes('short secret'))
    expect(warnings).toEqual(['warning: short secret excluded from frame scan: DELIVERY_TOKEN'])
  })
})
