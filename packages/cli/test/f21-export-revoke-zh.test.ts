// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, fileProvider } from '@gitrader/kernel'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let out: string[]
let err: string[]
let secrets: string[]

const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  deviceKey: fileProvider,
  readSecret: async () => { const s = secrets.shift(); if (s === undefined) throw new Error('unexpected secret prompt'); return s },
  ...over,
})
const run = (argv: string[], over: Partial<CliIo> = {}): Promise<number> => main(argv, io(over))
const text = (): string => out.join('')
const errText = (): string => err.join('')
const norm = (p: string): string => p.split('\\').join('/')

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-f21-'))
  out = []
  err = []
  secrets = []
  expect(await run(['init', '--no-pin'])).toBe(0)
  const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
  try {
    for (let i = 0; i < 3; i++) k.ledger.append({ type: 'note', origin: { actor: 'user:usr_local', actorType: 'human', tool: 'test', requestId: 'r', via: 'cli' }, subject: { orgId: 'org_local' }, payload: { text: `n${i}` } })
  } finally { await k.stop() }
  out = []
  err = []
})

afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe('gitrader ledger export 受限路径', () => {
  it('export with an absolute --out explains in Chinese', async () => {
    const exportsRoot = join(home, 'exports')
    for (const bad of ['C:/x', '../x', './x']) {
      out = []
      err = []
      expect(await run(['ledger', 'export', '--out', bad])).toBe(2)
      expect(errText()).toContain('只接受 exports 目录下的相对名字')
      expect(norm(errText())).toContain(norm(exportsRoot))
    }
  })

  it('export prints the full path', async () => {
    expect(await run(['ledger', 'export', '--out', '2026-10'])).toBe(0)
    expect(norm(text())).toContain(norm(join(home, 'exports', '2026-10')))
    expect(text()).toMatch(/已导出 \d+ 条（seq \d+\.\.\d+）/)
  })

  it('export to an existing target says so', async () => {
    expect(await run(['ledger', 'export', '--out', '2026-10'])).toBe(0)
    out = []
    err = []
    expect(await run(['ledger', 'export', '--out', '2026-10'])).toBe(2)
    expect(errText()).toContain('导出目标已经存在')
  })
})

describe('gitrader keys revoke 中文输出', () => {
  it('revoke agent prints Chinese', async () => {
    secrets = ['482916', '482916']
    expect(await run(['keys', 'new', 'agent', 'research-box', '--host', 'claude-code', '--tier', 'paper'], { interactive: true })).toBe(0)
    out = []
    err = []
    secrets = ['482916']
    expect(await run(['keys', 'revoke', 'agent', 'research-box'], { interactive: true })).toBe(0)
    expect(text()).toContain('已吊销 Agent 钥匙')
  })
})
