// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome } from '@gitrader/kernel'
import { cmdDoctor, doctorDeps } from '../src/doctor'
import type { CliIo, ServiceInfo } from '../src/index'

const DAY = 86_400_000
const baseDeps = { ...doctorDeps }
let home: string
let stdout: string[]
let stderr: string[]
const outputs: string[] = []

const fakeService: ServiceInfo = { port: 43123, pid: process.pid, token: 'test-token', startedAt: 1, version: 'test' }

function makeIo(): CliIo {
  return {
    out: (s) => { stdout.push(s); outputs.push(s) },
    err: (s) => { stderr.push(s); outputs.push(s) },
    env: { GITRADER_HOME: home },
    interactive: false,
    readSecret: async () => { throw new Error('unexpected prompt') },
  }
}

async function runDoctor(extra: Record<string, string | true> = {}): Promise<number> {
  return cmdDoctor(home, { cmd: ['doctor'], flags: { ...extra } }, makeIo())
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gr-doctor-'))
  stdout = []
  stderr = []
  Object.assign(doctorDeps, baseDeps)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  Object.assign(doctorDeps, baseDeps)
})

describe('gitrader doctor', () => {
  it('fresh home says init first and exits 2', async () => {
    const fresh = join(home, 'not-created-yet')
    const code = await cmdDoctor(fresh, { cmd: ['doctor'], flags: {} }, makeIo())
    const text = stdout.join('')
    expect(code).toBe(2)
    expect(text).toContain('还没初始化')
    expect(text).toContain('gitrader init')
  })

  it('missing PIN suggests browser or init', async () => {
    initHome(home)
    const code = await runDoctor()
    const text = stdout.join('')
    expect(code).not.toBe(0)
    expect(text).toContain('还没设 PIN')
    expect(text).toContain('gitrader init')
  })

  it('stopped service suggests serve', async () => {
    initHome(home)
    writeFileSync(join(home, 'keys', 'pin.json'), '{}\n')
    const code = await runDoctor()
    const text = stdout.join('')
    expect(code).toBe(1)
    expect(text).toContain('服务没在跑')
    expect(text).toContain('gitrader serve')
  })

  it('corrupt pin.json points to pin reset', async () => {
    initHome(home)
    writeFileSync(join(home, 'keys', 'pin.json'), '{broken\n')
    const code = await runDoctor()
    const text = stdout.join('')
    expect(code).toBe(2)
    expect(text).toContain('PIN 文件损坏')
    expect(text).toContain('gitrader pin reset')
  })

  it('running service with stale quote warns', async () => {
    initHome(home)
    writeFileSync(join(home, 'keys', 'pin.json'), '{}\n')
    doctorDeps.liveService = async () => fakeService
    doctorDeps.callOp = async (_svc, op) => {
      if (op === 'market.quote') return { price: '100', ts: Date.now() - 20_000 }
      if (op === 'account.list') return [{ mode: 'paper' }]
      if (op === 'agentkey.list') return [{ name: 'A', tier: 'paper', expiresAt: Date.now() + 30 * DAY }]
      return null
    }
    const code = await runDoctor()
    const text = stdout.join('')
    expect(code).toBe(1)
    expect(text).toContain('行情暂时取不到')
    expect(text).toContain('检查网络')
  })

  it('no agent key suggests keys new agent with preset starter', async () => {
    initHome(home)
    writeFileSync(join(home, 'keys', 'pin.json'), '{}\n')
    doctorDeps.liveService = async () => fakeService
    doctorDeps.callOp = async (_svc, op) => {
      if (op === 'market.quote') return { price: '101', ts: Date.now() }
      if (op === 'account.list') return [{ mode: 'paper' }]
      if (op === 'agentkey.list') return []
      return null
    }
    const code = await runDoctor()
    const text = stdout.join('')
    expect(code).toBe(1)
    expect(text).toContain('还没有 Agent 钥匙')
    expect(text).toContain('gitrader keys new agent')
    expect(text).toContain('--preset starter')
  })

  it('--json shape', async () => {
    initHome(home)
    const code = await runDoctor({ json: true })
    const text = stdout.join('')
    expect(text.trim().split(/\r?\n/)).toHaveLength(1)
    const parsed = JSON.parse(text) as {
      checks: Array<{ id: string; ok: boolean; level: string; zh: string; next?: string }>
      summary: { block: number; warn: number }
    }
    expect(Array.isArray(parsed.checks)).toBe(true)
    expect(parsed.checks.length).toBeGreaterThan(0)
    for (const c of parsed.checks) {
      expect(typeof c.id).toBe('string')
      expect(typeof c.ok).toBe('boolean')
      expect(['block', 'warn', 'ok']).toContain(c.level)
      expect(typeof c.zh).toBe('string')
      if (c.next !== undefined) expect(typeof c.next).toBe('string')
    }
    expect(parsed.summary.block).toBe(parsed.checks.filter((c) => c.level === 'block').length)
    expect(parsed.summary.warn).toBe(parsed.checks.filter((c) => c.level === 'warn').length)
    expect(code).toBe(0) // --json：退出码恒为 0，状态看 summary（E0-12 第 3 次门禁发现：宿主把非 0 当工具失败）
  })

  it('pin.json gone beside the keystore is corrupt state and points to pin reset (B3)', async () => {
    initHome(home)
    writeFileSync(join(home, 'keys', 'keystore.json'), '{}\n')
    const code = await runDoctor()
    const text = stdout.join('')
    expect(code).toBe(2)
    expect(text).toContain('安全文件损坏')
    expect(text).toContain('gitrader pin reset')
  })

  it('running service: kernel security health drives the security check (E0-2)', async () => {
    initHome(home)
    writeFileSync(join(home, 'keys', 'pin.json'), '{}\n')
    doctorDeps.liveService = async () => fakeService
    doctorDeps.callOp = async (_svc, op) => {
      if (op === 'market.quote') return { price: '101', ts: Date.now() }
      if (op === 'account.list') return [{ mode: 'paper' }]
      if (op === 'agentkey.list') return [{ name: 'A', tier: 'paper', expiresAt: Date.now() + 30 * DAY }]
      return null
    }
    const health = (stateFiles: Array<{ kind: string; state: string }>) => async () => ({ status: stateFiles.some((f) => f.state === 'corrupt') ? 'degraded' : 'ok', stateFiles })
    doctorDeps.health = health([{ kind: 'pin', state: 'ok' }, { kind: 'keystore', state: 'ok' }])
    await runDoctor()
    expect(stdout.join('')).toContain('安全状态文件正常')

    stdout = []
    doctorDeps.health = health([{ kind: 'pin', state: 'ok' }, { kind: 'keystore', state: 'corrupt' }])
    expect(await runDoctor()).toBe(2)
    expect(stdout.join('')).toContain('钥匙库损坏')
    expect(stdout.join('')).toContain('gitrader pin reset')

    stdout = []
    doctorDeps.health = health([{ kind: 'install-key', state: 'corrupt' }])
    expect(await runDoctor()).toBe(2)
    expect(stdout.join('')).toContain('安装签名钥损坏')
    expect(stdout.join('')).not.toContain('pin reset')
  })

  it('output has no ascii error fragments', async () => {
    const fresh = join(home, 'empty')
    await cmdDoctor(fresh, { cmd: ['doctor'], flags: {} }, makeIo())

    initHome(home)
    await runDoctor()

    writeFileSync(join(home, 'keys', 'pin.json'), '{broken\n')
    await runDoctor()

    writeFileSync(join(home, 'keys', 'pin.json'), '{}\n')
    await runDoctor()

    doctorDeps.liveService = async () => fakeService
    doctorDeps.callOp = async (_svc, op) => {
      if (op === 'market.quote') return { price: '100', ts: Date.now() - 20_000 }
      if (op === 'account.list') return [{ mode: 'paper' }]
      if (op === 'agentkey.list') return []
      return null
    }
    await runDoctor()

    mkdirSync(join(home, 'agent-tokens'), { recursive: true })
    writeFileSync(join(home, 'agent-tokens', 'a.token'), 'one\ntwo\n')
    doctorDeps.callOp = async (_svc, op) => {
      if (op === 'market.quote') return { price: '100', ts: Date.now() }
      if (op === 'account.list') return [{ mode: 'paper' }]
      if (op === 'agentkey.list') return [{ name: 'A', tier: 'paper', expiresAt: Date.now() + 30 * DAY }]
      return null
    }
    await runDoctor()

    expect(outputs.join('\n')).not.toMatch(/\b(Error|error|failed|invalid|undefined|ENOENT|EACCES|stack)\b/)
  })
})
