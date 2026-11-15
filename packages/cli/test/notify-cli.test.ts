// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Kernel, fileProvider, initHome, saveConfig, pinPluginDir } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'
import { fakeNotifyManifest } from '../../kernel/test/fixtures/plugin-notify-fake/manifest'

let home: string
let service: ServeHandle | undefined
let output: string[]
let errors: string[]
const io = (): CliIo => ({
  out: text => output.push(text), err: text => errors.push(text), interactive: false, readSecret: async () => { throw new Error('unexpected credential prompt') },
  deviceKey: fileProvider, env: { GITRADER_HOME: home, NOTIFY_TEST_TOKEN: ['synthetic', 'cli', 'fixture'].join('-') },
})
async function loginOnline(): Promise<void> {
  if (!service) throw new Error('service fixture is required')
  const boot = service.kernel.auth.mintBootToken()
  expect(await main(['session', 'login'], { ...io(), readSecret: async () => boot })).toBe(0)
  output = []; errors = []
}
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gitrader-notify-cli-')); output = []; errors = [] })
afterEach(async () => { await service?.stop(); service = undefined; rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

async function install(mode = 'ok', withSecret = true): Promise<string> {
  const { config } = initHome(home)
  config.engines = []
  config.venues = []
  config.accounts = []
  config.plugins.developerMode = true
  config.plugins.secrets = withSecret ? { 'connector.test.notify': { DELIVERY_TOKEN: 'env:NOTIFY_TEST_TOKEN' } } : {}
  const file = join(home, 'notices.jsonl')
  config.notify = { channels: [{ id: 'main', plugin: 'connector.test.notify', minLevel: 'critical', params: { output: file, mode, retryable: false } }] }
  saveConfig(home, config)
  const dir = join(home, 'plugins', 'notify-fixture')
  mkdirSync(dir, { recursive: true })
  copyFileSync(resolve(__dirname, '../../kernel/test/fixtures/plugin-notify-fake/gsp.mjs'), join(dir, 'gsp.mjs'))
  writeFileSync(join(dir, 'gitrader-plugin.json'), JSON.stringify({ ...fakeNotifyManifest,
    secrets: ['DELIVERY_TOKEN'], runtime: { type: 'sidecar', native: false, diskMB: 1 }, entry: { transport: 'stdio' },
    'x-launch': { command: process.execPath, args: ['gsp.mjs'] },
  }))
  pinPluginDir(dir)
  const k = await Kernel.create({ home, deviceKeyProvider: fileProvider, timers: false })
  try {
    await k.plugins.reload()
    const session = k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!
    k.plugins.grant('connector.test.notify', [], k.auth.sessionProof(session))
  } finally { await k.stop() }
  return file
}

describe('gitrader notify test', () => {
  it.each([false, true])('reports the missing handle name without any value (running service: %s)', async online => {
    await install('ok', false)
    if (online) { service = await runServe(home, { port: 0, io: io(), connectors: false }); await loginOnline() }
    expect(await main(['notify', 'test', 'main'], io())).toBe(1)
    expect(JSON.parse(output.join(''))).toMatchObject({ results: [{ ok: false, reason: 'invalid_params',
      detail: 'missing secret handle: DELIVERY_TOKEN', retryable: false }] })
    expect(errors.join('')).toContain('missing secret handle: DELIVERY_TOKEN')
    expect([...output, ...errors].join('')).not.toContain(io().env.NOTIFY_TEST_TOKEN)
    expect([...output, ...errors].join('')).not.toContain('internal_error')
  })
  it('delivers an offline info diagnostic using configured environment handles', async () => {
    const file = await install()
    expect(await main(['notify', 'test', 'main'], io())).toBe(0)
    expect(JSON.parse(output.join(''))).toMatchObject({ results: [{ channelId: 'main', ok: true }] })
    expect(JSON.parse(readFileSync(file, 'utf8').trim()).notice).toMatchObject({ level: 'info', topic: 'notify.test' })
    expect(errors.join('')).not.toContain(io().env.NOTIFY_TEST_TOKEN)
  })
  it('uses the running service and returns failure as exit code 1', async () => {
    const file = await install('fail')
    service = await runServe(home, { port: 0, io: io(), connectors: false })
    await loginOnline()
    expect(await main(['notify', 'test', 'main'], io())).toBe(1)
    expect(JSON.parse(output.join(''))).toMatchObject({ results: [{ channelId: 'main', ok: false, reason: 'fixture_failure' }] })
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  })
  it('reports usage and rejects unknown channels without a credential prompt', async () => {
    await install()
    expect(await main(['notify', 'test'], io())).toBe(1)
    expect(errors.join('')).toContain('usage: gitrader notify test <channelId>')
    errors = []
    expect(await main(['notify', 'test', 'missing'], io())).toBe(1)
    expect(errors.join('')).toContain('unknown channel')
  })
})
