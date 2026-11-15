// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider } from '@gitrader/kernel'
import { cmdKeysNewAgent } from '../src/keys-agent'
import type { KeysAgentDeps } from '../src/keys-agent'
import type { Args, CliIo, ServiceInfo } from '../src/index'

let home: string
let out: string[]
let err: string[]

const svc: ServiceInfo = { port: 43123, pid: process.pid, token: 'test-token', startedAt: 1, version: 'test' }

const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  deviceKey: fileProvider,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
  ...over,
})

const args = (flags: Record<string, string | true> = {}): Args => ({ cmd: ['keys', 'new', 'agent', 'research-box'], flags })
const text = (): string => out.join('')
const errorText = (): string => err.join('')

/** 浏览器批准替身：状态里带上内核写好的默认令牌文件路径。 */
function browserDeps(tokenFilePath: string): Partial<KeysAgentDeps> {
  let polls = 0
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
        return { requestId: 'akr_test', state: 'approved', keyId: 'ak_test', tokenFilePath }
      }
      throw new Error(`unexpected op: ${op}`)
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-f6-'))
  out = []
  err = []
})

afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

const FAKE_TOKEN = 'gtk_FAKE_TOKEN_F6_0001'
const defaultTokenPath = (): string => join(home, 'agent-tokens', 'research-box.token')

function writeDefaultToken(): void {
  mkdirSync(join(home, 'agent-tokens'), { recursive: true })
  writeFileSync(defaultTokenPath(), `${FAKE_TOKEN}\n`, 'utf8')
}

describe('keys new agent：浏览器批准时尊重 --token-file', () => {
  it('browser approval writes the token to --token-file', async () => {
    writeDefaultToken()
    const target = join(home, 'target.token')
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', preset: 'starter', 'token-file': target }), io(), browserDeps(defaultTokenPath()))
    expect(code).toBe(0)
    // writeTokenAt → writeSecretFile 写一行令牌 + '\n'
    expect(readFileSync(target, 'utf8')).toBe(`${FAKE_TOKEN}\n`)
    expect(text()).toContain(target)
    expect(text()).toContain('另存了一份在')
    expect(text()).not.toContain(FAKE_TOKEN)
    expect(errorText()).not.toContain(FAKE_TOKEN)
  })

  it('without --token-file the output is unchanged', async () => {
    writeDefaultToken()
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', preset: 'starter' }), io(), browserDeps(defaultTokenPath()))
    expect(code).toBe(0)
    expect(text()).toContain(defaultTokenPath())
    expect(text()).not.toContain('另存了一份')
    expect(text()).not.toContain(FAKE_TOKEN)
  })

  it('unwritable target falls back to the default path', async () => {
    writeDefaultToken()
    const target = join(home, 'target-dir')
    mkdirSync(target)
    const code = await cmdKeysNewAgent(home, args({ host: 'claude-code', preset: 'starter', 'token-file': target }), io(), browserDeps(defaultTokenPath()))
    expect(code).toBe(0)
    expect(errorText()).toContain('没能写到')
    expect(errorText()).toContain(target)
    expect(text()).toContain(defaultTokenPath())
    expect(text()).not.toContain(FAKE_TOKEN)
    expect(errorText()).not.toContain(FAKE_TOKEN)
  })
})
