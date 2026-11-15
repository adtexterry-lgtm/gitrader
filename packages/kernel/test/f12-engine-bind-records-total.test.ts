// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'
import type { Order } from '../src/proto'

let h: Harness | undefined
let fixtureDir: string | undefined

const TS = 1_798_761_600_000

const rpcFixture = `
import readline from 'node:readline'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
let beat
for await (const line of readline.createInterface({ input: process.stdin })) {
  let req
  try { req = JSON.parse(line) } catch { continue }
  if (req.id === undefined) continue
  switch (req.method) {
    case 'gep.hello': send(req.id, { version: '0.1.0', sessionId: 'f12_session' }); break
    case 'engine.describe': send(req.id, { engine: { id: 'fixture', name: 'F12 fixture', version: '1', vendor: { id: 'test', name: 'test', kind: 'community', verified: false }, license: 'Apache-2.0', runtime: 'node' }, protocol: { version: '0.1.0', transports: ['stdio'] }, capabilities: { 'execution.modeA': true }, venues: [] }); break
    case 'events.subscribe':
      send(req.id, { subscriptions: [] })
      if (!beat) beat = setInterval(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'gep.heartbeat', params: { ts: Date.now() } }) + '\\n'), 10)
      break
    case 'engine.bind': send(req.id, { bindingId: 'bind_f12', warnings: [] }); break
    case 'risk.policy.push': send(req.id, { ok: true }); break
    default: send(req.id, {})
  }
}
`

const until = async (f: () => boolean, ms = 4000): Promise<void> => {
  for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20))
  expect(f()).toBe(true)
}

async function view(name: string, params: Record<string, unknown>): Promise<unknown> {
  if (!h) throw new Error('harness is not ready')
  return h.k.ops.call(h.k, name, { principal: h.session, params, transport: 'ws', kind: 'query' })
}

async function issue(level: 'L1' | 'L3', accounts: string[]): Promise<string> {
  if (!h) throw new Error('harness is not ready')
  const input: Record<string, unknown> = { subject: { type: 'engine', id: 'fixture' }, level, accounts }
  if (level !== 'L1') Object.assign(input, { venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1000', maxDailyNotional: '5000', maxDailyLoss: '100', autoMaxOrderNotional: '300' } })
  const proof = await h.pinProof()
  return h.k.agents.issueMandate(input as never, proof, h.human('mandate.issue').origin).mandateId
}

async function bootFixture(): Promise<void> {
  fixtureDir = mkdtempSync(join(tmpdir(), 'gitrader-f12-'))
  const scriptPath = join(fixtureDir, 'rpc-engine.mjs')
  writeFileSync(scriptPath, rpcFixture, 'utf8')
  h = await makeHarness({ configure: (cfg) => cfg.engines.push({ id: 'fixture', enabled: true, launch: { command: process.execPath, args: [scriptPath] } }) })
  h.k.engines.start('fixture')
  await until(() => h!.k.gep.isReady('fixture'))
}

function order(id: string): Order {
  if (!h) throw new Error('harness is not ready')
  return {
    orderId: id as never, clientOrderId: `client-${id}`, accountId: h.paper.accountId, instrumentId: 'hyperliquid:BTC' as never,
    side: 'buy', type: 'limit', tif: 'gtc', size: '5' as never, filledSize: '0' as never,
    price: '10' as never, status: 'open', fee: '0' as never,
    origin: h.human('order.test').origin, createdAt: TS, updatedAt: TS,
  }
}

afterEach(async () => {
  await h?.cleanup()
  h = undefined
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
  fixtureDir = undefined
})

describe('F12 engine bindings, heartbeat and records total', () => {
  it('engine.list exposes bindings and lastHeartbeatAt', async () => {
    await bootFixture()
    const paperMandate = await issue('L1', [h!.paper.accountId])
    const liveMandate = await issue('L3', [h!.liveAcct.accountId])
    await h!.k.gep.bind('fixture', {
      accounts: [
        { accountId: h!.paper.accountId as never, mandateId: paperMandate },
        { accountId: h!.liveAcct.accountId as never, mandateId: liveMandate },
      ],
      instruments: [BTC],
    }, await h!.pinProof())
    await until(() => h!.k.gep.bindingOf('fixture') !== undefined)
    await until(() => h!.k.gep.status().find((s) => s.engineId === 'fixture')?.lastHeartbeatAt !== undefined)

    const rows = await view('engine.list', {}) as Array<Record<string, unknown>>
    const row = rows.find((r) => r.id === 'fixture')!
    const expected = [
      { accountId: h!.paper.accountId, mode: 'paper', mandateId: paperMandate },
      { accountId: h!.liveAcct.accountId, mode: 'live', mandateId: liveMandate },
    ]
    expect(row.bindings).toEqual(expected)
    expect(row.lastHeartbeatAt).toBe(h!.clock.now())
    const gep = row.gep as Record<string, unknown>
    expect(gep.bindings).toEqual(expected)
    expect(gep.lastHeartbeatAt).toBe(row.lastHeartbeatAt)
  })

  it('binding that drops a live account is refused without replaceLive', async () => {
    h = await makeHarness({ configure: (cfg) => cfg.engines.push({ id: 'fixture', enabled: true, launch: { command: process.execPath, args: [] } }) })
    const liveMandate = await issue('L3', [h.liveAcct.accountId])
    const paperMandate = await issue('L1', [h.paper.accountId])
    const pin = await h.pinProof()
    await h.k.gep.bind('fixture', { accounts: [{ accountId: h.liveAcct.accountId as never, mandateId: liveMandate }], instruments: [BTC] }, pin)
    const before = h.k.ledger.query({ types: ['engine.bound'] }).length

    await expect(h.k.gep.bind('fixture', { accounts: [{ accountId: h.paper.accountId as never, mandateId: paperMandate }], instruments: [BTC] }, pin))
      .rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: `this binding would remove the live account live from engine fixture; include it again or pass replaceLive:true` } })
    expect(h.k.ledger.query({ types: ['engine.bound'] }).length).toBe(before)

    await expect(h.k.gep.bind('fixture', { accounts: [{ accountId: h.paper.accountId as never, mandateId: paperMandate }], instruments: [BTC], replaceLive: true }, pin)).resolves.toMatchObject({})
    expect(h.k.ledger.query({ types: ['engine.bound'] }).length).toBe(before + 1)
  })

  it('adding a paper account while keeping the live one succeeds', async () => {
    h = await makeHarness({ configure: (cfg) => cfg.engines.push({ id: 'fixture', enabled: true, launch: { command: process.execPath, args: [] } }) })
    const liveMandate = await issue('L3', [h.liveAcct.accountId])
    const paperMandate = await issue('L1', [h.paper.accountId])
    const pin = await h.pinProof()
    await h.k.gep.bind('fixture', { accounts: [{ accountId: h.liveAcct.accountId as never, mandateId: liveMandate }], instruments: [BTC] }, pin)
    await expect(h.k.gep.bind('fixture', {
      accounts: [
        { accountId: h.liveAcct.accountId as never, mandateId: liveMandate },
        { accountId: h.paper.accountId as never, mandateId: paperMandate },
      ],
      instruments: [BTC],
    }, pin)).resolves.toMatchObject({})
    expect(h.k.gep.bindingOf('fixture')).toBeUndefined()
    const saved = h.k.docs.get<{ accounts: { accountId: string }[] }>('enginebind', 'fixture')!
    expect(saved.accounts.map((a) => a.accountId)).toEqual([h.liveAcct.accountId, h.paper.accountId])
  })

  it('records.query returns total on the first page', async () => {
    h = await makeHarness()
    for (let i = 0; i < 25; i++) h.k.orders.upsert(order(`ord_f12_${String(i).padStart(3, '0')}`), '20', true)
    const first = await view('records.query', { kind: 'order', accountId: h.paper.accountId, limit: 10 }) as { items: unknown[]; next?: string; total?: number }
    expect(first.total).toBe(25)
    expect(first.items).toHaveLength(10)
    expect(first.next).toEqual(expect.any(String))
    const second = await view('records.query', { kind: 'order', accountId: h.paper.accountId, limit: 10, cursor: first.next }) as { items: unknown[]; next?: string; total?: number }
    expect(second.items).toHaveLength(10)
    expect(second.total).toBeUndefined()
  })
})
