// SPDX-License-Identifier: CPAL-1.0
// A2 追加第 1 层：gitrader agent 被拒时，把内核 Problem 里的 next 原样打印出来。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Args, CliIo } from '../src/index'
import { cmdAgent } from '../src/agent-call'

let home: string
let out: string[]
let err: string[]
const io = (): CliIo => ({ out: (s) => { out.push(s) }, err: (s) => { err.push(s) }, env: { GITRADER_HOME: home }, interactive: false, readSecret: async () => { throw new Error('no prompt') } })
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-a2-next-')); out = []; err = []
  mkdirSync(join(home, 'agent-tokens'), { recursive: true })
  writeFileSync(join(home, 'agent-tokens', 'agent.token'), `gtk_${'A'.repeat(52)}\n`)
  writeFileSync(join(home, 'service.json'), JSON.stringify({ port: 1, pid: 1, token: 'svc_unused', startedAt: 1, version: '0' }))
})
afterEach(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

describe('agent 被拒时打印 next', () => {
  it('stderr 带 next 原文；JSON 里也有', async () => {
    const next = `gitrader agent order preview --args '{"intent":{}}'`
    const fetchFn = (async () => new Response(JSON.stringify({ ok: false, error: { code: 1001, name: 'INVALID_PARAMS', category: 'REJECTED', retryable: false, message: 'intent is required', next } }), { status: 400 })) as unknown as typeof fetch
    const a: Args = { cmd: ['agent', 'order', 'preview'], flags: { args: '{}' } }
    expect(await cmdAgent(home, a, io(), { fetch: fetchFn })).toBe(1)
    expect(err.join('')).toContain(next)
    expect(JSON.parse(out.join('')).error.next).toBe(next)
  })
})
