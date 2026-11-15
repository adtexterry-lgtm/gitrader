// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProvider, initHome, Kernel, loadConfig, saveConfig } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo } from '../src/index'

let home: string
let stdout: string[]
let stderr: string[]

function makeIo(env: Record<string, string | undefined> = {}): CliIo {
  return {
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    env: { GITRADER_HOME: home, ...env },
    interactive: false,
    deviceKey: fileProvider,
    readSecret: async () => { throw new Error('unexpected prompt') },
  }
}

function useUnknownVenueConfig(): void {
  const config = loadConfig(home)
  saveConfig(home, { ...config, venues: [{ id: 'unregistered-fixture', environment: 'testnet', enabled: true }] })
}

async function runMainServe(io: CliIo, args: string[]): Promise<number> {
  const realOnce = process.once.bind(process)
  let onSigint: ((...args: never[]) => void) | undefined
  let settled = false
  const onceSpy = vi.spyOn(process, 'once').mockImplementation(((event: string | symbol, listener: (...args: never[]) => void) => {
    if (event === 'SIGINT') { onSigint = listener; return process }
    if (event === 'SIGTERM') return process
    return realOnce(event as never, listener as never)
  }) as typeof process.once)
  const pending = main(['serve', '--port', '0', ...args], io).then((code) => { settled = true; return code })
  let stopped = false
  const stopOwnService = (): void => {
    if (!stopped && onSigint) { stopped = true; onSigint() }
  }
  try {
    for (let i = 0; i < 500 && !onSigint && !settled; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    stopOwnService()
    return await pending
  } finally {
    stopOwnService()
    await pending.catch(() => undefined)
    onceSpy.mockRestore()
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-c2l-'))
  initHome(home)
  stdout = []
  stderr = []
})

afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe('serve JSON logs', () => {
  it('wraps main-to-runServe assembly output once and keeps stdout human-readable', async () => {
    useUnknownVenueConfig()
    const code = await runMainServe(makeIo({ GITRADER_LOG_FORMAT: 'json' }), [])
    expect(code).toBe(0)
    const lines = stderr.join('').trim().split('\n')
    const records = lines.map((line) => JSON.parse(line) as { level: string; msg: string })
    const assembly = records.filter((record) => record.msg.includes('unknown venue in config'))
    expect(assembly).toHaveLength(1)
    expect(assembly[0]).toMatchObject({ level: 'info', msg: '[gitrader] unknown venue in config: unregistered-fixture (skipped)' })
    expect(stdout.join('')).toContain('Gitrader ')
    expect(stdout.join('')).not.toContain('{"ts":')
  })

  it('uses --log-format over the environment for common-catch host errors', async () => {
    const code = await main(['serve', '--host', 'invalid-host', '--log-format', 'json'], makeIo({ GITRADER_LOG_FORMAT: 'text' }))
    expect(code).toBe(1)
    expect(stderr).toHaveLength(1)
    const row = JSON.parse(stderr[0]!) as { level: string; msg: string }
    expect(row).toMatchObject({ level: 'error', msg: 'error: host must be an allowed loopback or wildcard binding' })
  })

  it('keeps explicit text format and rejects unknown formats without opening a service', async () => {
    const textCode = await main(['serve', '--host', 'invalid-host', '--log-format', 'text'], makeIo({ GITRADER_LOG_FORMAT: 'json' }))
    expect(textCode).toBe(1)
    expect(stderr).toEqual(['error: host must be an allowed loopback or wildcard binding\n'])
    stderr = []
    const badCode = await runMainServe(makeIo(), ['--offline', '--log-format', 'yaml'])
    expect(badCode).toBe(1)
    expect(stderr).toEqual(['error: --log-format must be text or json\n'])
  })

  it('keeps default text output and main serve stdout unchanged', async () => {
    useUnknownVenueConfig()
    const code = await runMainServe(makeIo(), [])
    expect(code).toBe(0)
    expect(stderr.join('')).toContain('[gitrader] unknown venue in config: unregistered-fixture (skipped)\n')
    expect(stderr.join('')).not.toContain('{"ts":')
    expect(stdout.join('')).toContain('Gitrader ')
  })

  it('keeps explicit text through main-to-runServe when the environment requests JSON', async () => {
    useUnknownVenueConfig()
    const code = await runMainServe(makeIo({ GITRADER_LOG_FORMAT: 'json' }), ['--log-format', 'text'])
    expect(code).toBe(0)
    expect(stderr.join('')).toContain('[gitrader] unknown venue in config: unregistered-fixture (skipped)\n')
    expect(stderr.join('')).not.toContain('{"ts":')
    expect(stdout.join('')).toContain('Gitrader ')
  })

  it.each([
    { name: 'default text', env: {} },
    { name: 'JSON environment', env: { GITRADER_LOG_FORMAT: 'json' } },
  ])('rejects a bare --log-format before Kernel creation with $name', async ({ env }) => {
    const createSpy = vi.spyOn(Kernel, 'create')
    try {
      const code = await runMainServe(makeIo(env), ['--offline', '--log-format'])
      expect(code).toBe(1)
      expect(stderr).toEqual(['error: --log-format requires a value\n'])
      expect(createSpy).not.toHaveBeenCalled()
    } finally {
      createSpy.mockRestore()
    }
  })

  it('serializes direct runServe unknown-status logs as one warning row', async () => {
    const io = makeIo({ GITRADER_LOG_FORMAT: 'json' })
    let lookup: Promise<unknown> | undefined
    const handle = await runServe(home, {
      port: 0,
      connectors: false,
      io,
      connect: (kernel: Kernel) => {
        const fixture = {
          venue: 'fixture-venue',
          describe: () => ({}),
          status: () => ({}),
          orderStatus: async () => ({ found: true, status: 'future-status' }),
          close: async () => undefined,
        }
        kernel.bus.register(fixture as never)
        lookup = kernel.bus.lookup({ accountId: 'fixture-account', venue: 'fixture-venue', mode: 'live', owner: {} } as never, 'fixture-client-order')
      },
    })
    try {
      await lookup
      const rows = stderr.join('').trim().split('\n').map((line) => JSON.parse(line) as { level: string; msg: string })
      const unknown = rows.filter((row) => row.msg.includes('order.status_unknown'))
      expect(unknown).toHaveLength(1)
      expect(unknown[0]!.level).toBe('warn')
      expect(unknown[0]!.msg).toContain('future-status')
    } finally {
      await handle.stop()
    }
  })
})
