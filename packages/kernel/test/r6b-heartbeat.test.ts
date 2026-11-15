// SPDX-License-Identifier: CPAL-1.0
// R6 B 包 R2-REL-06：引擎挂死（进程在、心跳停）——状态不再报 ready；连续 2 个超时周期没有心跳，内核按自己持有的句柄杀进程树并按崩溃退避重启。
// 闸门只收不放：心跳丢失先 halt_new，重启后账户仍是 REDUCING（恢复交易只有人）。真子进程引擎，心跳由夹具按「flag 文件里写着自己的 pid」停掉。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
let dir: string | undefined
afterEach(async () => {
  await h?.cleanup(); h = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const TIMEOUT_MS = 400
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const fixture = (flag: string): string => `
import readline from 'node:readline'
import { readFileSync } from 'node:fs'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const silenced = () => { try { return readFileSync(${JSON.stringify(flag)}, 'utf8').trim() === String(process.pid) } catch { return false } }
let beat
for await (const line of readline.createInterface({ input: process.stdin })) {
  let req
  try { req = JSON.parse(line) } catch { continue }
  if (req.id === undefined) continue
  switch (req.method) {
    case 'gep.hello': send(req.id, { version: '0.1.0', sessionId: 'hb_' + process.pid }); break
    case 'engine.describe': send(req.id, { engine: { id: 'hbfix', name: 'R6B heartbeat fixture', version: '1', vendor: { id: 'test', name: 'test', kind: 'community', verified: false }, license: 'Apache-2.0', runtime: 'node' }, protocol: { version: '0.1.0', transports: ['stdio'] }, capabilities: { 'execution.modeA': true }, venues: [] }); break
    case 'events.subscribe':
      send(req.id, { subscriptions: [] })
      if (!beat) beat = setInterval(() => { if (!silenced()) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'gep.heartbeat', params: { ts: Date.now() } }) + '\\n') }, 20)
      break
    case 'engine.bind': send(req.id, { bindingId: 'bind_hb', warnings: [] }); break
    case 'strategy.status': send(req.id, { instances: [] }); break
    default: send(req.id, {})
  }
}
`

async function boot(): Promise<{ flag: string; pidOf: () => number | null; stateOf: () => { state: string; detail?: string; restarts: number; pid: number | null } }> {
  dir = mkdtempSync(join(tmpdir(), 'gitrader-r6b-hb-'))
  const script = join(dir, 'engine.mjs')
  const flag = join(dir, 'silence.pid')
  writeFileSync(script, fixture(flag), 'utf8')
  h = await makeHarness({
    configure: (cfg) => cfg.engines.push({ id: 'hbfix', enabled: true, launch: { command: process.execPath, args: [script] } }),
    kernel: { gep: { heartbeatTimeoutMs: TIMEOUT_MS }, engines: { backoffMinMs: 50, backoffMaxMs: 200 } },
  })
  const stateOf = () => h!.k.engines.status().find((e) => e.id === 'hbfix')!
  h.k.engines.start('hbfix')
  for (let i = 0; i < 300 && !(h.k.gep.isReady('hbfix') && stateOf().state === 'ready'); i++) await wait(20)
  expect(stateOf().state).toBe('ready')
  return { flag, pidOf: () => stateOf().pid, stateOf }
}

describe('R2-REL-06 引擎挂死', () => {
  it('[R6B-HB1] 心跳停了：本地引擎状态离开 ready，改报 degraded 且 detail 含 heartbeat lost；心跳回来改回 ready，不杀', async () => {
    const e = await boot()
    const pid = e.pidOf()!
    writeFileSync(e.flag, String(pid))
    await wait(TIMEOUT_MS + 150) // 过了一个超时周期、还没到两个
    await h!.k.gep.tick()
    expect(e.stateOf().state).toBe('degraded')
    expect(e.stateOf().detail).toMatch(/heartbeat lost/)
    expect(e.stateOf().pid).toBe(pid) // 进程还在，也还没被杀
    expect(h!.k.engines.status().find((x) => x.id === 'hbfix')!.restarts).toBe(0)

    unlinkSync(e.flag) // 心跳回来
    await wait(120)
    await h!.k.gep.tick()
    expect(e.stateOf()).toMatchObject({ state: 'ready', pid, restarts: 0 })
    expect(e.stateOf().detail).toBeUndefined()
  })

  it('[R6B-HB2] 连续 2 个超时周期没有心跳：杀掉本地引擎并按崩溃退避重启（restarts+1、新 pid、回到 ready）；绑定账户仍是 REDUCING', async () => {
    const e = await boot()
    const pin = await h!.pinProof()
    const mandate = h!.k.agents.issueMandate({ subject: { type: 'engine', id: 'hbfix' }, level: 'L1', accounts: [h!.paper.accountId] } as never, pin, h!.human('mandate.issue').origin).mandateId
    await h!.k.gep.bind('hbfix', { accounts: [{ accountId: h!.paper.accountId as never, mandateId: mandate }], instruments: [BTC] }, pin)

    const pid = e.pidOf()!
    writeFileSync(e.flag, String(pid))
    let relaunched = false
    for (let i = 0; i < 400 && !relaunched; i++) {
      await wait(50)
      await h!.k.gep.tick()
      const s = e.stateOf()
      relaunched = s.pid !== null && s.pid !== pid && s.state === 'ready' && h!.k.gep.isReady('hbfix')
    }
    expect(relaunched).toBe(true)
    expect(e.stateOf()).toMatchObject({ state: 'ready', restarts: 1 })
    expect(e.stateOf().pid).not.toBe(pid)
    // 闸门只收不放：halt_new 在杀之前就做了，重启不会自动解除
    expect(h!.k.tstate.effective([{ type: 'account', id: h!.paper.accountId }]).state).toBe('REDUCING')
    expect(h!.k.ledger.query({ types: ['engine.health_changed'] }).some((x) => (x.payload as { to?: string }).to === 'lost')).toBe(true)
  })
})
