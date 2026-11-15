// SPDX-License-Identifier: CPAL-1.0
// doctor 凭据自查：env 句柄未设 / 占位值 -> warn（只报变量名）；正常值 -> ok。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome } from '@gitrader/kernel'
import { runChecks } from '../src/doctor'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gr-r7-cred-'))
  initHome(home)
  const f = join(home, 'gitrader.json')
  const cfg = JSON.parse(readFileSync(f, 'utf8'))
  cfg.accounts = [...(cfg.accounts ?? []), { alias: 'live-a', venue: 'binance', environment: 'mainnet', mode: 'live', credentials: { apiKey: 'env:GR_TEST_KEY', apiSecret: 'env:GR_TEST_SEC' } }]
  writeFileSync(f, JSON.stringify(cfg))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const cred = async (env: Record<string, string>) => (await runChecks(home, { env, liveService: async () => null })).find((c) => c.id === 'credentials')!

describe('credentials check', () => {
  it('变量没设 -> warn 且只带变量名', async () => {
    const c = await cred({ GR_TEST_KEY: 'k-123' })
    expect(c.level).toBe('warn')
    expect(c.zh).toContain('GR_TEST_SEC')
    expect(c.zh).not.toContain('k-123')
  })
  it('占位值 -> warn', async () => {
    const c = await cred({ GR_TEST_KEY: 'changeme', GR_TEST_SEC: 'real-secret-value' })
    expect(c.level).toBe('warn')
    expect(c.zh).toContain('GR_TEST_KEY')
  })
  it('正常 -> ok', async () => {
    expect((await cred({ GR_TEST_KEY: 'AbC123', GR_TEST_SEC: 'xYz789' })).level).toBe('ok')
  })
})
