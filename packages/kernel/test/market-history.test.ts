// SPDX-License-Identifier: CPAL-1.0
// host.market.history 的参数校验、本地库兜底 / 录制、以及总线收盘录制的内核级测试。
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Candle } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const c = (t: number): Candle => ({ t, o: t, h: t + 1, l: t - 1, c: t, v: 1 })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 8000, what = 'condition'): Promise<void> => {
  for (let i = 0; i < ms / 25 && !f(); i++) await sleep(25)
  if (!f()) throw new Error(`timeout waiting for ${what}`)
}
const readResults = (out: string): { method: string; result?: any; error?: any }[] => // eslint-disable-line @typescript-eslint/no-explicit-any
  existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

let h: Harness | undefined
const dirs: string[] = []

afterEach(async () => {
  await h?.cleanup()
  h = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 起内核 + 一个最小脚本引擎（握手后按 actions 逐条调宿主方法，结果写 out.jsonl）。 */
async function boot(actions: unknown[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-mh-'))
  dirs.push(dir)
  const out = join(dir, 'out.jsonl')
  writeFileSync(join(dir, 'engine.mjs'), SCRIPT_ENGINE)
  writeFileSync(join(dir, 'actions.json'), JSON.stringify(actions))
  h = await makeHarness({
    kernel: { gep: { heartbeatMs: 500, callTimeoutMs: 5000 } },
    configure: (cfg) => {
      cfg.engines.push({ id: 'core', enabled: true, launch: { command: process.execPath, args: [join(dir, 'engine.mjs')], env: { SCRIPT_OUT: out, SCRIPT_IN: join(dir, 'actions.json') } } })
    },
  })
  return out
}

const start = (out: string, count: number): Promise<void> => {
  h!.k.engines.start('core')
  return until(() => readResults(out).length >= count, 15_000, `${count} host call result(s)`)
}

const history = (instrumentId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ method: 'host.market.history', params: { instrumentId, interval: '1h', ...extra } })

const SCRIPT_ENGINE = `
import { appendFileSync, readFileSync } from 'node:fs'
const out = process.env.SCRIPT_OUT, actions = JSON.parse(readFileSync(process.env.SCRIPT_IN, 'utf8'))
let buf = '', nid = 1000
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const pending = new Map()
const call = (method, params) => new Promise((res) => { const id = nid++; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }) })
const answer = (m) => {
  switch (m.method) {
    case 'gep.hello': return { version: '0.1', sessionId: 'ses_script', resumed: false, engine: { id: 'scripted', version: '0.0.1' } }
    case 'engine.describe': setTimeout(run, 50); return { engine: { id: 'scripted', name: 'scripted', version: '0.0.1', vendor: { id: 'test', name: 'test', kind: 'self', verified: false }, license: 'Apache-2.0', runtime: 'node' }, protocol: { version: '0.1', transports: ['stdio'] }, capabilities: { 'execution.modeA': true, 'market.useHost': true, 'halt.levels': ['halt_new', 'cancel_all', 'flatten_all'] }, venues: [] }
    case 'events.subscribe': return { subscriptionId: 'sub_s', fromSeq: 0 }
    case 'risk.policy.push': return { acceptedVersions: (m.params.policies || []).map((p) => p.version) }
    case 'engine.halt': return { ack: true, appliedAt: Date.now() }
    case 'engine.resume': return { resumedAt: Date.now() }
    default: return {}
  }
}
async function run() {
  await call('host.describe', {})
  for (const a of actions) {
    const r = await call(a.method, a.params)
    appendFileSync(out, JSON.stringify({ method: a.method, ...r }) + '\\n')
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method) { if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: answer(m) }) }
    else if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
setInterval(() => {}, 1000)
`

describe('host.market.history 参数校验与本地库兜底', { timeout: 30_000 }, () => {
  it('interval / limit 校验；limit 缺省等价 500', async () => {
    const out = await boot([
      history(BTC, { interval: 'bogus', limit: 10 }),
      history(BTC, { limit: 0 }),
      history(BTC, { limit: 1.5 }),
      history(BTC, { limit: 5001 }),
      history(BTC),
    ])
    h!.live.candleData.set(BTC, Array.from({ length: 600 }, (_, i) => c(i + 1)))
    await start(out, 5)
    const rs = readResults(out)
    for (const r of rs.slice(0, 4)) expect(r.error?.data?.name).toBe('INVALID_PARAMS')
    const ok = rs[4]!.result as { candles: Candle[]; complete: boolean }
    expect(ok.candles).toHaveLength(500)
    expect(ok.complete).toBe(false)
  })

  it('场所够量：返回场所数据并录进本地库', async () => {
    const out = await boot([history(BTC, { limit: 20 })])
    h!.live.candleData.set(BTC, Array.from({ length: 10 }, (_, i) => c(i + 1)))
    await start(out, 1)
    const r = readResults(out)[0]!.result as { candles: Candle[]; source: string; complete: boolean }
    expect(r.candles.map((x) => x.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(r.source).toBe('hyperliquid')
    expect(r.complete).toBe(true)
    await sleep(20)
    // 没给 to：末根视为仍在形成，不录
    expect((await h!.k.marketStore.read(BTC, '1h')).map((x) => x.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('轮询去重：同一窗口再拉一次不重复落盘；给了 to 的回补整批照录', async () => {
    const out = await boot([history(BTC, { limit: 20 }), history(BTC, { limit: 20 }), history(BTC, { limit: 20, to: 11 })])
    h!.live.candleData.set(BTC, Array.from({ length: 10 }, (_, i) => c(i + 1)))
    await start(out, 3)
    await sleep(50)
    const lines = readFileSync(h!.k.marketStore.pathFor(BTC, '1h'), 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(19) // 9（首轮，去末根）+ 0（重复轮询）+ 10（带 to 的回补整批）
    expect(lines.length).toBeGreaterThanOrEqual(10)
    expect((await h!.k.marketStore.read(BTC, '1h')).map((x) => x.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(h!.k.marketStore.pathFor(BTC, '1h')).toContain(join('candles', 'testnet'))
  })

  it('场所不够量：与本地库合并（场所优先）并升序', async () => {
    const out = await boot([history(BTC, { limit: 20 })])
    await h!.k.marketStore.record(BTC, '1h', [c(1), c(2), c(3), c(4), c(5)])
    h!.live.candleData.set(BTC, [c(6), c(7)])
    await start(out, 1)
    const r = readResults(out)[0]!.result as { candles: Candle[]; source: string; complete: boolean }
    expect(r.candles.map((x) => x.t)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(r.source).toBe('hyperliquid+store')
    expect(r.complete).toBe(true)
  })

  it('场所抛错：本地库有数据就用库', async () => {
    const out = await boot([history(BTC, { limit: 20 })])
    await h!.k.marketStore.record(BTC, '1h', [c(1), c(2), c(3)])
    h!.live.candles = async () => { throw new Error('down') }
    await start(out, 1)
    const r = readResults(out)[0]!.result as { candles: Candle[]; source: string }
    expect(r.candles.map((x) => x.t)).toEqual([1, 2, 3])
    expect(r.source).toBe('store')
  })

  it('场所抛错且库为空：抛出原错误', async () => {
    const out = await boot([history(BTC, { limit: 20 })])
    h!.live.candles = async () => { throw new Error('down') }
    await start(out, 1)
    const r = readResults(out)[0]!
    expect(r.result).toBeUndefined()
    expect(String(r.error?.data?.message ?? r.error?.message)).toContain('down')
  })
})

describe('总线收盘录制', { timeout: 15_000 }, () => {
  it('只录已收盘的 K 线', async () => {
    h = await makeHarness()
    h.k.events.publish('market.candles', { instrumentId: BTC, interval: '1m', candles: [c(1)] })
    h.k.events.publish('market.candles', { instrumentId: BTC, interval: '1m', candles: [c(2)] })
    await sleep(20)
    expect((await h.k.marketStore.read(BTC, '1m')).map((x) => x.t)).toEqual([1])
  })
})
