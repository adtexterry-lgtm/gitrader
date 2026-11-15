// SPDX-License-Identifier: CPAL-1.0
// gitrader stop（契约 C4）：全部依赖注入，不起真服务、不杀真进程。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cmdStop } from '../src/stop'
import type { StopDeps } from '../src/stop'
import type { LiveServiceInfo, ServiceInfo } from '../src/index'

const svc: ServiceInfo = { port: 4567, pid: 4321, token: 'tok', startedAt: 1000, version: 'test' }
const live: LiveServiceInfo = { ...svc, baseUrl: 'http://127.0.0.1:4567' }
const args = { cmd: ['stop'], flags: {} }

let out: string[]
let err: string[]
let clock: number
const io = { out: (s: string) => { out.push(s) }, err: (s: string) => { err.push(s) }, env: {}, interactive: false, readSecret: async () => { throw new Error('unexpected prompt') } }

/** pid 在 aliveFor 毫秒（假时钟）后消失；Infinity = 一直活着。 */
function deps(o: { aliveFor?: number; after?: ServiceInfo | null; live?: LiveServiceInfo | null; forceKillDies?: boolean } = {}): StopDeps & { calls: string[] } {
  const calls: string[] = []
  let killed = false
  const start = clock
  let reads = 0
  return {
    calls,
    readService: () => (reads++ === 0 ? svc : o.after === undefined ? svc : o.after),
    liveService: async () => (o.live === undefined ? live : o.live),
    callOp: async (_h, _l, name) => { calls.push(`op:${name}`); return { ok: true } },
    pidAlive: () => !killed && clock - start < (o.aliveFor ?? 0),
    forceKill: async (pid) => { calls.push(`kill:${pid}`); if (o.forceKillDies !== false) killed = true },
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  }
}

beforeEach(() => { out = []; err = []; clock = 1_000_000 })

describe('gitrader stop', () => {
  it('no service: says so and exits 0', async () => {
    const d = deps()
    d.readService = () => null
    expect(await cmdStop('h', args, io, d)).toBe(0)
    expect(out.join('')).toContain('服务没在运行')
    expect(d.calls).toEqual([])
  })

  it('stale service.json (pid dead): not running, nothing called', async () => {
    const d = deps({ aliveFor: 0 })
    expect(await cmdStop('h', args, io, d)).toBe(0)
    expect(out.join('')).toContain('服务没在运行')
    expect(d.calls).toEqual([])
  })

  it('graceful exit: shutdown op called, never force-killed', async () => {
    const d = deps({ aliveFor: 1000 })
    expect(await cmdStop('h', args, io, d)).toBe(0)
    expect(d.calls).toEqual(['op:service.shutdown'])
    expect(out.join('')).toContain('服务已停止')
  })

  it('timeout: force-kills exactly once after 15 s', async () => {
    const d = deps({ aliveFor: Infinity })
    expect(await cmdStop('h', args, io, d)).toBe(0)
    expect(d.calls).toEqual(['op:service.shutdown', 'kill:4321'])
    expect(clock - 1_000_000).toBeGreaterThanOrEqual(15_000)
    expect(out.join('')).toContain('已强制结束')
  })

  it('startedAt changed at timeout: kills nothing and exits 1', async () => {
    const d = deps({ aliveFor: Infinity, after: { ...svc, startedAt: 2000 } })
    expect(await cmdStop('h', args, io, d)).toBe(1)
    expect(d.calls).toEqual(['op:service.shutdown'])
    expect(err.join('')).toContain('没有强制结束任何进程')
  })

  // fix-r4: 审稿 M1——健康检查不通的 pid 无法确认是 gitrader，原先“超时后强杀”改为“不杀、退出码 1”
  it('health check fails but pid alive: never kills, exits 1 with a manual hint', async () => {
    const d = deps({ aliveFor: Infinity, live: null })
    expect(await cmdStop('h', args, io, d)).toBe(1)
    expect(d.calls).toEqual([])
    expect(err.join('')).toContain('无法确认是 gitrader')
    expect(err.join('')).toContain('没有结束它')
  })

  it('force kill that does not work reports failure', async () => {
    const d = deps({ aliveFor: Infinity, forceKillDies: false })
    expect(await cmdStop('h', args, io, d)).toBe(1)
    expect(err.join('')).toContain('强制结束失败')
  })

  it('shutdown op error does not stop it from waiting', async () => {
    const d = deps({ aliveFor: 400 })
    d.callOp = vi.fn(async () => { throw new Error('boom') })
    expect(await cmdStop('h', args, io, d)).toBe(0)
    expect(out.join('')).toContain('服务已停止')
  })
})
