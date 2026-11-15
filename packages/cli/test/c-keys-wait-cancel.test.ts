// SPDX-License-Identifier: CPAL-1.0
// keys new agent 等浏览器批准：立刻提示去工作台；超时 / Ctrl+C 撤回请求，不留重复待批卡。依赖全注入。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome } from '@gitrader/kernel'
import { cmdKeysNewAgent } from '../src/keys-agent'
import type { KeysAgentDeps } from '../src/keys-agent'
import type { Args, CliIo, ServiceInfo } from '../src/index'

const svc: ServiceInfo = { port: 43123, pid: process.pid, token: 't', startedAt: 1, version: 'test' }
const args: Args = { cmd: ['keys', 'new', 'agent', 'research-box'], flags: { host: 'claude-code', preset: 'starter' } }
let home: string
let out: string[]
let err: string[]
let clock: number
let cancelled: string[]

const io: () => CliIo = () => ({ out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: {}, interactive: false, readSecret: async () => { throw new Error('no prompt') } })

function deps(sleep: KeysAgentDeps['sleep'], cancelResult = true): Partial<KeysAgentDeps> {
  return {
    liveService: async () => svc,
    now: () => clock,
    sleep,
    cancelRequest: async (_h, _s, id) => { cancelled.push(id); return cancelResult },
    callOp: async (_s, op) => {
      if (op === 'risk.state') return { limits: {} }
      if (op === 'market.instruments') return [{ instrumentId: 'hyperliquid:BTC' }, { instrumentId: 'hyperliquid:ETH' }]
      if (op === 'account.list') return [{ accountId: 'acct_paper', alias: 'paper', mode: 'paper' }]
      if (op === 'agentkey.request') return { requestId: 'akr_1', state: 'pending' }
      if (op === 'agentkey.request.status') return { requestId: 'akr_1', state: 'pending' }
      throw new Error(`unexpected op: ${op}`)
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-c-wait-'))
  initHome(home)
  out = []; err = []; cancelled = []; clock = 1_000_000
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('keys new agent 等待浏览器批准', () => {
  it('tells the user to go to the workbench right away, and withdraws the request on timeout', async () => {
    const d = deps(async (ms) => { clock += ms * 100 })
    await expect(cmdKeysNewAgent(home, args, io(), d)).rejects.toThrow('10 分钟内没有处理')
    expect(out.join('')).toContain('去工作台批准这个接入请求（等待中，Ctrl+C 取消）')
    expect(cancelled).toEqual(['akr_1'])
  })

  it('Ctrl+C withdraws the request and exits 130', async () => {
    const before = new Set(process.listeners('SIGINT'))
    const d = deps(async () => { for (const l of process.listeners('SIGINT')) if (!before.has(l)) (l as () => void)() })
    expect(await cmdKeysNewAgent(home, args, io(), d)).toBe(130)
    expect(cancelled).toEqual(['akr_1'])
    expect(err.join('')).toContain('已取消接入请求')
    expect(process.listeners('SIGINT').every((l) => before.has(l))).toBe(true) // 处理器已摘掉
  })

  it('says so when the request cannot be withdrawn (no logged-in session)', async () => {
    const before = new Set(process.listeners('SIGINT'))
    const d = deps(async () => { for (const l of process.listeners('SIGINT')) if (!before.has(l)) (l as () => void)() }, false)
    expect(await cmdKeysNewAgent(home, args, io(), d)).toBe(130)
    expect(err.join('')).toContain('没能撤回这条接入请求')
  })
})
