// SPDX-License-Identifier: CPAL-1.0
// 真传输：打包后的引擎作为子进程跑起来，分别走 stdio（NDJSON）与本地 WebSocket（loopback、/gep、子协议 gep.v0）。
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateEngineDescribe } from '../../protocol/src/validate'
import { GepSession } from '../../protocol/conformance/session'
import { HostSim, PAPER_ACCOUNT, MANDATE_ID, BTC } from '../../protocol/conformance/host-sim'
import { stdioTransport, wsTransport } from '../../protocol/conformance/transport'
import { buildEngine } from '../build.mjs'
import { strategyDir } from './harness'

const TOKEN = 'transport-test-token'
let bundle = ''

beforeAll(async () => {
  bundle = await buildEngine(join(mkdtempSync(join(tmpdir(), 'engine-core-')), 'engine-core.mjs'))
}, 60_000)

const baseEnv = (): Record<string, string> => {
  const e: Record<string, string> = {}
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) { const v = process.env[k]; if (v !== undefined) e[k] = v }
  return e
}

describe('stdio', () => {
  it('NDJSON：握手 → describe → bind → 策略 → shutdown；退出码 0；5 秒内退出', async () => {
    const t = stdioTransport({ command: process.execPath, args: [bundle, '--stdio', '--strategies', strategyDir()] }, TOKEN)
    const s = new GepSession(t, new HostSim())
    const h = await s.hello({ token: TOKEN })
    expect(h.ok).toBe(true)
    s.startHeartbeats(500)
    const d = await s.call('engine.describe', {})
    expect(validateEngineDescribe(d).ok).toBe(true)
    await s.call('engine.bind', { bindingId: 'bind_01JABA', accounts: [{ accountId: PAPER_ACCOUNT, mode: 'A', mandateId: MANDATE_ID }], data: { source: 'host', instruments: [BTC] }, policies: [], heartbeatMs: 1000 })
    const st = await s.call('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: {}, mandateId: MANDATE_ID })
    expect(st.status).toBe('running')
    // 100 个混合请求：响应 id 一一对应（帧格式）
    const outs = await Promise.all(Array.from({ length: 100 }, (_, i) => s.request(i % 2 ? 'engine.health' : 'strategy.list', {})))
    expect(outs.every((o) => o.ok)).toBe(true)
    expect(s.raw.every((line) => !line.startsWith('﻿') && !line.includes('\n'))).toBe(true)
    const t0 = Date.now()
    await s.call('engine.shutdown', { graceMs: 1000 })
    expect(await s.waitClosed(5000)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
    await new Promise((res) => setTimeout(res, 100))
    expect(t.exitCode?.()).toBe(0)
    expect(t.info?.() ?? '').not.toMatch(/stack|TypeError|ReferenceError/)
  }, 30_000)

  it('没有令牌环境变量就拒绝启动', async () => {
    const child = spawn(process.execPath, [bundle, '--stdio'], { env: baseEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    const code = await new Promise<number | null>((res) => child.on('exit', res))
    expect(code).toBe(2)
  }, 15_000)
})

describe('WebSocket', () => {
  let child: ChildProcess | null = null
  afterAll(() => { child?.kill() })

  it('loopback 监听、子协议 gep.v0、令牌放在 hello 里；错误令牌被拒；单帧上限 4 MiB', async () => {
    child = spawn(process.execPath, [bundle, '--ws', '0'], { env: { ...baseEnv(), GITRADER_GEP_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] })
    const url = await new Promise<string>((resolve, reject) => {
      let buf = ''
      child!.stdout!.on('data', (c: Buffer) => { buf += c.toString(); const i = buf.indexOf('\n'); if (i >= 0) resolve((JSON.parse(buf.slice(0, i)) as { listening: string }).listening) })
      child!.on('exit', () => reject(new Error('engine exited')))
      setTimeout(() => reject(new Error('listen timeout')), 10_000)
    })
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/gep$/)

    const bad = new GepSession(await wsTransport(url), new HostSim())
    const o = await bad.hello({ token: 'wrong' })
    expect(o.ok).toBe(false)
    if (!o.ok) expect(o.error.code).toBe(5003)
    expect(await bad.waitClosed(1000)).toBe(true)

    const s = new GepSession(await wsTransport(url), new HostSim())
    expect((await s.hello({ token: TOKEN })).ok).toBe(true)
    s.startHeartbeats(500)
    const h = await s.call('engine.health', {})
    expect(h.status).toBe('ok')
    // 往返延迟冒烟（只记录，不作准入）：1000 次 engine.health
    const lat: number[] = []
    for (let i = 0; i < 300; i++) { const t0 = performance.now(); await s.call('engine.health', {}); lat.push(performance.now() - t0) }
    lat.sort((a, b) => a - b)
    expect(lat[Math.floor(lat.length * 0.95)]!).toBeLessThan(25)
    // 超过 4 MiB 的帧：连接被关闭（ws 的 maxPayload），引擎本身不崩
    s.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'engine.health', params: { pad: 'x'.repeat(4 * 1024 * 1024 + 10) } }))
    expect(await s.waitClosed(3000)).toBe(true)
    const s2 = new GepSession(await wsTransport(url), new HostSim())
    expect((await s2.hello({ token: TOKEN })).ok).toBe(true)
    await s2.call('engine.shutdown', { graceMs: 100 })
    expect(await s2.waitClosed(5000)).toBe(true)
  }, 40_000)
})
