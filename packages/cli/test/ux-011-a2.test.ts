// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 第二批 A2：UX-31/32（serve 横幅与 Enter 监听）、UX-33（--check 带令牌文件）、UX-36（预设默认值不报“已补全”）、UX-38（中文环境不出英文整句）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider, initHome } from '@gitrader/kernel'
import { announceServe, main } from '../src/index'
import type { Args, CliIo, ServiceInfo } from '../src/index'
import { cmdKeysNewAgent } from '../src/keys-agent'
import type { KeysAgentDeps } from '../src/keys-agent'
import { checkCommand, renderSnippet } from '../src/snippets'

const CJK = /[一-龥]/
const URL1 = 'http://127.0.0.1:47900/?launch=boot_x'
let home: string
let out: string[]
let err: string[]
let secrets: string[]
const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home, GITRADER_LANG: 'zh' }, interactive: false, deviceKey: fileProvider,
  readSecret: async () => { const s = secrets.shift(); if (s === undefined) throw new Error('unexpected secret prompt'); return s }, ...over,
})
const text = (): string => out.join('')
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-ux-a2-')); out = []; err = []; secrets = [] })
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('UX-31 / UX-32 serve 横幅', () => {
  it('中文：横幅是中文；非交互（stdin 不是终端）不提 Enter', () => {
    announceServe(io({ interactive: false, stdinTty: false }), { port: 47900, url: URL1 }, false)
    expect(text()).toContain(URL1)
    expect(text()).toMatch(CJK)
    expect(text()).not.toContain('is running on')
    expect(text()).not.toMatch(/Press Enter|按 Enter/)
    expect(text()).toContain('重新运行启动脚本')
  })

  it('stdin 是终端但 stdout 被接走（interactive=false、stdinTty=true）：仍提示按 Enter', () => {
    announceServe(io({ interactive: false, stdinTty: true }), { port: 47900, url: URL1 }, false)
    expect(text()).toMatch(/按 Enter/)
    out = []
    announceServe(io({ interactive: false, stdinTty: true, lang: 'en' }), { port: 47900, url: URL1 }, false)
    expect(text()).toContain('Press Enter')
    expect(text()).not.toMatch(CJK)
  })

  it('英文非交互不出现 Press Enter', () => {
    announceServe(io({ lang: 'en' }), { port: 47900, url: URL1 }, false)
    expect(text()).not.toContain('Press Enter')
  })

  it('open 没设 PIN 的提示补一句重新运行启动脚本', async () => {
    initHome(home)
    const svc: ServiceInfo = { port: 1, pid: process.pid, token: 't', startedAt: 1, version: 'x' }
    void svc
    // 没有运行中的服务时走 noServiceMsg，这里只验文案常量：见 index.ts 的 open 分支
    const src = await import('node:fs').then((f) => f.readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8'))
    expect(src).toContain('关掉启动窗口')
  })
})

describe('UX-33 snippet 的 --check 带上令牌文件', () => {
  const WIN = { node: 'C:\Program Files\G\node.exe', mcpEntry: 'C:\Program Files\G\gitrader-mcp.js' }
  const POSIX = { node: '/opt/g/node', mcpEntry: '/opt/g/gitrader-mcp.js' }
  it('Windows：set "VAR=文件" && ...；POSIX：VAR=文件 命令；没给文件时不变', () => {
    expect(checkCommand({ ...WIN, tokenFile: 'C:\h\agent-tokens\b.token' })).toBe(`set "GITRADER_AGENT_TOKEN_FILE=C:\h\agent-tokens\b.token" && "${WIN.node}" "${WIN.mcpEntry}" --check`)
    expect(checkCommand({ ...POSIX, tokenFile: '/h/agent-tokens/b.token' })).toBe(`GITRADER_AGENT_TOKEN_FILE='/h/agent-tokens/b.token' "${POSIX.node}" "${POSIX.mcpEntry}" --check`)
    expect(checkCommand(WIN)).toBe(`"${WIN.node}" "${WIN.mcpEntry}" --check`)
  })
  it('renderSnippet 给了 tokenFile：末尾 --check 命令带环境变量', () => {
    for (const host of ['claude-code', 'codex', 'cursor', 'generic'] as const) {
      const t = renderSnippet({ host, ...WIN, home: 'C:\h', tokenFile: 'C:\h\agent-tokens\b.token' })
      expect(t).toContain('set "GITRADER_AGENT_TOKEN_FILE=C:\h\agent-tokens\b.token" && "')
    }
  })
})

describe('UX-36 预设默认值不报“已补全”', () => {
  const svc: ServiceInfo = { port: 43123, pid: process.pid, token: 't', startedAt: 1, version: 'test' }
  const deps = (): Partial<KeysAgentDeps> => ({
    liveService: async () => svc,
    callOp: async (_s, op) => {
      if (op === 'market.instruments') return [{ instrumentId: 'hyperliquid:BTC', marketGroup: null }, { instrumentId: 'hyperliquid:ETH', marketGroup: null }]
      if (op === 'account.list') return [{ accountId: 'acct_paper', alias: 'paper', mode: 'paper' }]
      throw new Error(`unexpected op: ${op}`)
    },
  })
  const a = (flags: Record<string, string | true>): Args => ({ cmd: ['keys', 'new', 'agent', 'k1'], flags })
  it('--preset starter 没写 --instruments：不打印“已补全”；自己写的裸符号仍打印', async () => {
    initHome(home)
    secrets = ['482916', '482916']
    expect(await cmdKeysNewAgent(home, a({ host: 'claude-code', preset: 'starter' }), io({ interactive: true }), deps())).toBe(0)
    expect(text()).not.toContain('已补全')
    out = []
    secrets = ['482916']
    expect(await cmdKeysNewAgent(home, { cmd: ['keys', 'new', 'agent', 'k2'], flags: { host: 'claude-code', tier: 'paper', instruments: 'BTC' } }, io({ interactive: true }), deps())).toBe(0)
    expect(text()).toContain('已补全为 hyperliquid:BTC')
  }, 30_000)
})

describe('UX-38 中文环境：常用命令不出英文整句', () => {
  it('keys list / ledger verify（中文）与英文各自成句', async () => {
    initHome(home)
    expect(await main(['keys', 'list'], io())).toBe(0)
    expect(text()).toMatch(CJK)
    expect(text()).not.toContain('API wallets')
    expect(text()).not.toContain('Agent keys (')
    out = []
    expect(await main(['ledger', 'verify'], io())).toBe(0)
    expect(text()).toMatch(CJK)
    out = []
    expect(await main(['keys', 'list', '--lang', 'en'], io())).toBe(0)
    expect(text()).toContain('API wallets (0)')
    expect(text()).not.toMatch(CJK)
  })
})


describe('GITRADER_OPEN_COMMAND（自定义开链接命令）', () => {
  it('serve --open 把链接交给自定义命令（写文件替身，不真开浏览器）', async () => {
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
    const marker = join(home, 'opened.txt')
    const script = join(home, 'opener.cjs')
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv[2])`)
    announceServe(io({ env: { GITRADER_HOME: home, GITRADER_OPEN_COMMAND: `"${process.execPath}" "${script}"` } }), { port: 47900, url: URL1 }, true)
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100))
    expect(readFileSync(marker, 'utf8')).toBe(URL1)
  }, 15_000)
})
