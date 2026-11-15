// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHarness, TEST_PIN } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness | undefined
let fixtureDir: string | undefined
let statePath = ''
let updatesPath = ''

const rpcFixture = `
import { appendFileSync, readFileSync } from 'node:fs'
import readline from 'node:readline'
const state = () => JSON.parse(readFileSync(process.env.B2_STATE_FILE, 'utf8'))
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n')
for await (const line of readline.createInterface({ input: process.stdin })) {
  let req
  try { req = JSON.parse(line) } catch { continue }
  if (req.id === undefined) continue
  switch (req.method) {
    case 'gep.hello': respond(req.id, { version: '0.1.0', sessionId: 'rpc_fixture_session' }); break
    case 'engine.describe': respond(req.id, { engine: { id: 'fixture', name: 'RPC fixture', version: '1', vendor: { id: 'test', name: 'test', kind: 'community', verified: false }, license: 'Apache-2.0', runtime: 'node' }, protocol: { version: '0.1.0', transports: ['stdio'] }, capabilities: { 'execution.modeA': true, strategy: true, 'strategy.hotUpdate': true }, venues: [] }); break
    case 'events.subscribe': respond(req.id, { subscriptions: [] }); break
    case 'engine.bind': respond(req.id, { bindingId: 'bind_fixture', warnings: [] }); break
    case 'risk.policy.push': respond(req.id, { ok: true }); break
    case 'strategy.status': {
      const s = state()
      if (s.mode === 'unsupported') { fail(req.id, -32601, 'status unavailable'); break }
      if (s.mode === 'malformed') { respond(req.id, { instances: 'invalid' }); break }
      if (s.mode === 'not-ok') { respond(req.id, { ok: false, instances: [{ instanceId: req.params?.instanceId ?? '', accountId: s.accountId }] }); break }
      if (s.mode === 'unknown-instance') { respond(req.id, { instances: [{ instanceId: 'inst_other', accountId: s.accountId }] }); break }
      if (s.mode === 'duplicate-instance') { respond(req.id, { instances: [{ instanceId: req.params?.instanceId ?? '', accountId: s.accountId }, { instanceId: req.params?.instanceId ?? '', accountId: s.accountId }] }); break }
      if (s.mode === 'missing-account') { respond(req.id, { instances: [{ instanceId: req.params?.instanceId ?? '', status: 'running' }] }); break }
      respond(req.id, { instances: [{ instanceId: req.params?.instanceId ?? '', strategyId: 'fixture-strategy', status: 'running', accountId: s.mode === 'unknown-account' ? 'acct_unknown_fixture' : s.accountId, instruments: ['hyperliquid:BTC'], params: {}, mandateId: 'mdt_fixture' }] })
      break
    }
    case 'strategy.update': appendFileSync(process.env.B2_UPDATE_FILE, JSON.stringify(req.params) + '\\n'); respond(req.id, { status: 'running', appliedAt: 1 }); break
    default: respond(req.id, {})
  }
}
`

async function bootFixture(mode: string, accountId: string, bindAccounts: string[] = [accountId]): Promise<void> {
  fixtureDir = mkdtempSync(join(tmpdir(), 'gitrader-b2-02-'))
  statePath = join(fixtureDir, 'state.json')
  updatesPath = join(fixtureDir, 'updates.log')
  writeFileSync(statePath, JSON.stringify({ mode, accountId }), 'utf8')
  writeFileSync(updatesPath, '', 'utf8')
  const scriptPath = join(fixtureDir, 'rpc-engine.mjs')
  writeFileSync(scriptPath, rpcFixture, 'utf8')
  h = await makeHarness({ configure: (cfg) => cfg.engines.push({ id: 'fixture', enabled: true, launch: { command: process.execPath, args: [scriptPath], env: { B2_STATE_FILE: statePath, B2_UPDATE_FILE: updatesPath } } }) })
  const resolvedStatusAccountId = h.k.accounts.get(accountId).accountId
  writeFileSync(statePath, JSON.stringify({ mode, accountId: resolvedStatusAccountId }), 'utf8')
  h.k.engines.start('fixture')
  for (let i = 0; i < 200 && !h.k.gep.isReady('fixture'); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(h.k.gep.isReady('fixture')).toBe(true)
  const pin = await h.pinProof()
  const accounts = []
  for (const accountAliasOrId of bindAccounts) {
    const accountIdToBind = h.k.accounts.get(accountAliasOrId).accountId
    const isLive = h.k.accounts.get(accountIdToBind).mode === 'live'
    const mandate = await h.k.agents.issueMandate({
      subject: { type: 'engine', id: 'fixture' }, level: isLive ? 'L3' : 'L1', accounts: [accountIdToBind],
      ...(isLive ? { venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1000', maxDailyNotional: '5000', maxDailyLoss: '100', autoMaxOrderNotional: '300' } } : {}),
    } as never, pin, h.human('mandate.issue').origin)
    accounts.push({ accountId: accountIdToBind, mandateId: mandate.mandateId })
  }
  await h.k.gep.bind('fixture', { accounts: accounts as never, instruments: [BTC] }, pin)
}

function setStatus(mode: string, accountAliasOrId: string): void {
  const accountId = h ? h.k.accounts.get(accountAliasOrId).accountId : accountAliasOrId
  writeFileSync(statePath, JSON.stringify({ mode, accountId }), 'utf8')
}
function updateCount(): number { return readFileSync(updatesPath, 'utf8').split(/\r?\n/).filter(Boolean).length }
function updateParamsReceived(): Array<Record<string, unknown>> { return readFileSync(updatesPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) }
function opCall(params: Record<string, unknown>, pin?: string): Promise<unknown> {
  if (!h) throw new Error('fixture harness is not ready')
  return h.k.ops.call(h.k, 'engine.call', { principal: h.session, params: { id: 'fixture', method: 'strategy.update', params }, transport: 'ws', kind: 'command', ...(pin === undefined ? {} : { pin }) })
}
function updateParams(accountId?: string): Record<string, unknown> {
  return { instanceId: 'inst_fixture', params: { fast: 8 }, ...(accountId ? { accountId } : {}) }
}

afterEach(async () => {
  await h?.cleanup()
  h = undefined
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
  fixtureDir = undefined
})

describe('B2 live strategy.update presence gate', () => {
  it('uses the RPC-reported live account, rejects missing/wrong PIN and only updates after PIN via engine.call', async () => {
    await bootFixture('valid', 'live', ['live', 'paper'])
    const forgedPaper = updateParams(h!.paper.accountId)
    await expect(opCall(forgedPaper)).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    await expect(opCall(forgedPaper, 'wrong-pin')).rejects.toMatchObject({ problem: { name: 'AUTH_FAILED' } })
    expect(updateCount()).toBe(0)
    await expect(h!.k.gep.callEngine('fixture', 'strategy.update', updateParams() as never)).rejects.toMatchObject({ problem: { name: 'ATTESTATION_REQUIRED' } })
    expect(updateCount()).toBe(0)
    await expect(opCall(forgedPaper, TEST_PIN)).resolves.toMatchObject({ status: 'running' })
    expect(updateCount()).toBe(1)
    expect(updateParamsReceived()[0]).toEqual(forgedPaper)
    expect(updateParamsReceived()[0]).not.toHaveProperty('pin')
    expect(updateParamsReceived()[0]).not.toHaveProperty('proof')
    expect(JSON.stringify(updateParamsReceived()[0])).not.toContain(TEST_PIN)

    setStatus('valid', h!.paper.accountId)
    await expect(opCall(updateParams())).resolves.toMatchObject({ status: 'running' })
    expect(updateCount()).toBe(2)
  })

  it('fails closed for unknown instances/accounts, unbound accounts, malformed or unsupported status, and empty instanceId', async () => {
    await bootFixture('valid', 'live', ['live'])
    const invalidCases: Array<[string, string, Record<string, unknown>]> = [
      ['unknown-instance', 'live', updateParams()],
      ['unknown-account', 'live', updateParams()],
      ['duplicate-instance', 'live', updateParams()],
      ['missing-account', 'live', updateParams()],
      ['valid', 'paper', updateParams()],
      ['malformed', 'live', updateParams()],
      ['not-ok', 'live', updateParams()],
      ['unsupported', 'live', updateParams()],
      ['valid', 'live', { params: { fast: 8 } }],
      ['valid', 'live', { instanceId: ' inst_fixture ', params: { fast: 8 } }],
    ]
    for (const [mode, accountId, params] of invalidCases) {
      setStatus(mode, accountId)
      await expect(opCall(params, TEST_PIN)).rejects.toThrow()
      expect(updateCount()).toBe(0)
    }
  })

  it('rejects an engine that is not ready before querying status', async () => {
    await bootFixture('valid', 'live', ['live'])
    await h!.k.engines.stop('fixture')
    for (let i = 0; i < 200 && h!.k.gep.isReady('fixture'); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(opCall(updateParams(), TEST_PIN)).rejects.toMatchObject({ problem: { name: 'VENUE_UNAVAILABLE' } })
    expect(updateCount()).toBe(0)
  })
})
