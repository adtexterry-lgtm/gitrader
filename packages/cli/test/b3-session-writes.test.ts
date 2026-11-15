// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'

let home: string
let service: ServeHandle | undefined
let out: string[]
let errors: string[]
let secrets: string[]

const io = (): CliIo => ({
  out: value => out.push(value),
  err: value => errors.push(value),
  env: { GITRADER_HOME: home },
  interactive: true,
  deviceKey: fileProvider,
  readSecret: async () => {
    const secret = secrets.shift()
    if (secret === undefined) throw new Error('missing test secret input')
    return secret
  },
})
const run = (args: string[]): Promise<number> => main(args, io())
const text = (): string => out.join('')

function ledgerCount(): number {
  const db = new DatabaseSync(join(home, 'data', 'gitrader.sqlite'), { readOnly: true })
  try { return (db.prepare('SELECT COUNT(*) AS count FROM ledger').get() as { count: number }).count }
  finally { db.close() }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-session-writes-'))
  out = []; errors = []; secrets = []
  expect(await run(['init', '--no-pin'])).toBe(0)
  service = await runServe(home, { port: 0, io: io(), connectors: false })
})

afterEach(async () => {
  await service?.stop().catch(() => undefined)
  service = undefined
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

describe('CLI writes require a cached human session', () => {
  it('refuses a missing session without service fallback, then login enables reload and readback', async () => {
    const before = ledgerCount()
    expect(await run(['plugins', 'reload'])).toBe(1)
    expect(errors.join('')).toMatch(/session login/i)
    expect(ledgerCount()).toBe(before)

    secrets = [service!.kernel.auth.mintBootToken()]
    expect(await run(['session', 'login'])).toBe(0)
    expect(await run(['plugins', 'reload'])).toBe(0)
    expect(text()).toMatch(/Reloaded \(running service\)/)
    out = []
    expect(await run(['plugins', 'list'])).toBe(0)
    expect(text()).toContain('No plugins in ')
  })

  it('clears a remotely revoked cached session after one 401 and allows a fresh login', async () => {
    secrets = [service!.kernel.auth.mintBootToken()]
    expect(await run(['session', 'login'])).toBe(0)
    const cachePath = join(home, 'cli-session.json')
    const token = (JSON.parse(readFileSync(cachePath, 'utf8')) as { sessionToken: string }).sessionToken
    const principal = service!.kernel.auth.authenticateToken(token)
    expect(principal).not.toBeNull()
    service!.kernel.auth.revokeSession(principal!)

    const before = ledgerCount()
    out = []; errors = []
    expect(await run(['plugins', 'reload'])).toBe(1)
    expect(errors.join('')).toMatch(/session login/i)
    expect(existsSync(cachePath)).toBe(false)
    expect(ledgerCount()).toBe(before)

    secrets = [service!.kernel.auth.mintBootToken()]
    expect(await run(['session', 'login'])).toBe(0)
    out = []; errors = []
    expect(await run(['plugins', 'reload'])).toBe(0)
    expect(text()).toMatch(/Reloaded \(running service\)/)
  })
})
