// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, fileProvider } from '@gitrader/kernel'
import { initHome } from '@gitrader/kernel'
import { cmdKeysNewAgent } from '../src/keys-agent'
import type { KeysAgentDeps } from '../src/keys-agent'
import type { Args, CliIo, ServiceInfo } from '../src/index'

let home: string
let out: string[]
let err: string[]
let secrets: string[]
let secretCalls: number
let lineCalls: number

const svc: ServiceInfo = { port: 43123, pid: process.pid, token: 'test-token', startedAt: 1, version: 'test' }

const io = (over: Partial<CliIo> = {}): CliIo & { readLine?: (prompt: string) => Promise<string> } => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  deviceKey: fileProvider,
  readSecret: async () => {
    secretCalls++
    const s = secrets.shift()
    if (s === undefined) throw new Error('unexpected secret prompt')
    return s
  },
  readLine: async () => {
    lineCalls++
    const s = secrets.shift()
    if (s === undefined) throw new Error('unexpected line prompt')
    return s
  },
  ...over,
})

const args = (flags: Record<string, string | true> = {}): Args => ({ cmd: ['keys', 'new', 'agent', 'research-box'], flags })
const text = (): string => out.join('')
const errorText = (): string => err.join('')

function browserDeps(finalState: 'approved' | 'rejected'): Partial<KeysAgentDeps> {
  let polls = 0
  const tokenPath = join(home, 'agent-tokens', 'research-box.token')
  return {
    liveService: async () => svc,
    sleep: async () => undefined,
    callOp: async (_service, op) => {
      if (op === 'risk.state') return { limits: { maxOrderNotional: '5000', maxDailyNotional: '20000' } }
      if (op === 'market.instruments') return [{ instrumentId: 'hyperliquid:BTC', marketGroup: null }, { instrumentId: 'hyperliquid:ETH', marketGroup: null }]
      if (op === 'account.list') return [{ accountId: 'acct_paper', alias: 'paper', mode: 'paper' }]
      if (op === 'agentkey.request') return { requestId: 'akr_test', state: 'pending' }
      if (op === 'agentkey.request.status') {
        polls++
        if (polls === 1) return { requestId: 'akr_test', state: 'pending' }
        if (finalState === 'approved') return { requestId: 'akr_test', state: 'approved', keyId: 'ak_test', tokenFilePath: tokenPath }
        return { requestId: 'akr_test', state: 'rejected', note: '先不用' }
      }
      throw new Error(`unexpected op: ${op}`)
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-e0-4c-'))
  initHome(home)
  out = []
  err = []
  secrets = []
  secretCalls = 0
  lineCalls = 0
})

afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader keys new agent（E0-4c）', () => {
  it('missing tier in non-tty explains the two choices', async () => {
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code' }), io())
    expect(code).toBe(2)
    expect(errorText()).toContain('每笔开仓都等你批准')
    expect(errorText()).toContain('纸面单直接成交')
    expect(errorText()).toContain('--preset starter')
    expect(errorText()).toContain('gitrader keys new agent research-box')
  })

  it('preset starter fills confirm-tier fields', async () => {
    secrets = ['482916', '482916']
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', preset: 'starter' }), io({ interactive: true }))
    expect(code).toBe(0)
    expect(text()).toContain('令牌已写入')
    expect(text()).toContain('单笔上限：200 · 每日上限：1000')
    const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    try {
      const key = k.agents.listKeys()[0]!
      const mandate = k.agents.getMandate(key.mandateId)!
      expect(mandate.level).toBe('L2')
      expect(mandate.venueAllowlist).toEqual(['hyperliquid'])
      expect(mandate.instrumentAllowlist).toEqual(['hyperliquid:BTC', 'hyperliquid:ETH'])
      expect(mandate.limits.maxOrderNotional).toBe('200')
      expect(mandate.limits.maxDailyNotional).toBe('1000')
      expect(Math.abs(mandate.notAfter - mandate.notBefore - 30 * 86_400_000)).toBeLessThan(1_000) // CLI 与内核各取一次时钟，允许毫秒级差
    } finally { await k.stop() }
  }, 30_000)

  it('bare symbols are expanded and notes printed', async () => {
    secrets = ['482916', '482916']
    const deps: Partial<KeysAgentDeps> = {
      liveService: async () => svc,
      callOp: async (_service, op) => {
        if (op === 'market.instruments') return [{ instrumentId: 'hyperliquid:BTC', marketGroup: null }]
        if (op === 'account.list') return [{ accountId: 'acct_paper', alias: 'paper', mode: 'paper' }]
        throw new Error(`unexpected op: ${op}`)
      },
    }
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', tier: 'paper', instruments: 'BTC' }), io({ interactive: true }), deps)
    expect(code).toBe(0)
    expect(text()).toContain('已补全为 hyperliquid:BTC')
    const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    try {
      const key = k.agents.listKeys()[0]!
      expect(k.agents.getMandate(key.mandateId)?.instrumentAllowlist).toEqual(['hyperliquid:BTC'])
    } finally { await k.stop() }
  }, 30_000)

  it('validation happens before PIN prompt', async () => {
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', tier: 'confirm' }), io({ interactive: true }))
    expect(code).toBe(1) // 缺项沿用旧口径退出码 1（cli.test.ts 已有断言）
    expect(errorText()).toContain('需确认')
    expect(errorText()).toContain('--preset starter')
    expect(secretCalls).toBe(0)
    expect(lineCalls).toBe(0)
  })

  it('non-tty with running service uses browser approval and prints token file path', async () => {
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', preset: 'starter' }), io(), browserDeps('approved'))
    expect(code).toBe(0)
    expect(text()).toContain('已在工作台发起接入请求「research-box」')
    expect(text()).toContain(join(home, 'agent-tokens', 'research-box.token'))
    expect(text()).toContain('下一步：gitrader mcp snippet claude-code --token-file')
    expect(secretCalls).toBe(0)
  })

  it('rejected request exits 1 with chinese text', async () => {
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', preset: 'starter' }), io(), browserDeps('rejected'))
    expect(code).toBe(1)
    expect(errorText()).toContain('拒绝')
  })

  it('token never printed in token-file mode', async () => {
    secrets = ['482916', '482916']
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', preset: 'starter' }), io({ interactive: true }))
    expect(code).toBe(0)
    expect(text()).not.toMatch(/gtk_[A-Z2-7]{10,}/)
    const tokenPath = join(home, 'agent-tokens', 'research-box.token')
    expect(existsSync(tokenPath)).toBe(true)
    expect(readFileSync(tokenPath, 'utf8')).toMatch(/^gtk_[A-Z2-7]{52}\s*$/)
  }, 30_000)
})
