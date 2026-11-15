// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Kernel, fileProvider, initHome } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'

const WILDCARD_WARNING = '[gitrader] warning: listening on all network interfaces; only expose this service on a trusted network\n'
let home: string
let stdout: string[]
let stderr: string[]

function makeIo(env: Record<string, string | undefined> = {}): CliIo {
  return {
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    env: { GITRADER_HOME: home, ...env },
    interactive: false,
    deviceKey: fileProvider,
    readSecret: async () => { throw new Error('unexpected prompt') },
  }
}

function boundAddress(handle: ServeHandle): AddressInfo {
  const address = handle.kernel.http?.server.address()
  if (!address || typeof address === 'string') throw new Error('server has no internet socket address')
  return address
}

async function runMainServe(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; address?: AddressInfo }> {
  const originalStart = Kernel.prototype.start
  let address: AddressInfo | undefined
  const startSpy = vi.spyOn(Kernel.prototype, 'start').mockImplementation(async function (this: Kernel, options) {
    const result = await originalStart.call(this, options)
    const bound = this.http?.server.address()
    if (bound && typeof bound !== 'string') address = bound
    return result
  })
  const realOnce = process.once.bind(process)
  let onSigint: ((...args: never[]) => void) | undefined
  const onceSpy = vi.spyOn(process, 'once').mockImplementation(((event: string | symbol, listener: (...args: never[]) => void) => {
    if (event === 'SIGINT') { onSigint = listener; return process }
    if (event === 'SIGTERM') return process
    return realOnce(event as never, listener as never)
  }) as typeof process.once)
  let settled = false
  const pending = main(['serve', '--offline', '--port', '0', ...args], makeIo(env)).then((code) => { settled = true; return code })
  let stopCalled = false
  const stopOwnService = (): void => {
    if (!stopCalled && onSigint) { stopCalled = true; onSigint() }
  }
  try {
    for (let i = 0; i < 500 && !onSigint && !settled; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    stopOwnService()
    const code = await pending
    return { code, ...(address ? { address } : {}) }
  } finally {
    stopOwnService()
    await pending.catch(() => undefined)
    onceSpy.mockRestore()
    startSpy.mockRestore()
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-c2h-'))
  initHome(home)
  stdout = []
  stderr = []
})

afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe('bounded HTTP host binding', () => {
  it('keeps the default listener on the same loopback address shown by CLI', async () => {
    const handle = await runServe(home, { port: 0, io: makeIo(), connectors: false })
    try {
      expect(boundAddress(handle).address).toBe(new URL(handle.url).hostname)
      expect(boundAddress(handle).address).toBe('127.0.0.1')
      expect(boundAddress(handle).port).toBe(handle.port)
      expect(stderr).not.toContain(WILDCARD_WARNING)
    } finally { await handle.stop() }
  })

  it('binds IPv4 wildcard and emits exactly one fixed warning without the boot token', async () => {
    const handle = await runServe(home, { port: 0, host: '0.0.0.0', io: makeIo(), connectors: false })
    try {
      expect(boundAddress(handle)).toMatchObject({ address: '0.0.0.0', family: 'IPv4', port: handle.port })
      expect(stderr.filter((line) => line === WILDCARD_WARNING)).toHaveLength(1)
      expect(stderr.join('')).not.toContain(new URL(handle.url).searchParams.get('launch'))
      expect(new URL(handle.url).hostname).toBe('127.0.0.1')
    } finally { await handle.stop() }
  })

  it('binds IPv6 wildcard when the test environment supports it', async (context) => {
    let handle: ServeHandle | undefined
    try {
      handle = await runServe(home, { port: 0, host: '::', io: makeIo(), connectors: false })
      expect(boundAddress(handle)).toMatchObject({ address: '::', family: 'IPv6', port: handle.port })
      expect(stderr.filter((line) => line === WILDCARD_WARNING)).toHaveLength(1)
      expect(stderr.join('')).not.toContain(new URL(handle.url).searchParams.get('launch'))
      expect(new URL(handle.url).hostname).toBe('127.0.0.1')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL' || code === 'EADDRFAMILY') {
        context.skip(`NOT RUN: IPv6 wildcard unavailable (${code})`)
        return
      }
      throw error
    } finally {
      await handle?.stop()
    }
  })

  it('rejects invalid runServe hosts before creating a Kernel or connecting', async () => {
    const create = vi.spyOn(Kernel, 'create')
    const connect = vi.fn()
    let handle: ServeHandle | undefined
    let failure: unknown
    try {
      try { handle = await runServe(home, { port: 0, host: 'invalid-host', io: makeIo(), connect }) } catch (error) { failure = error }
    } finally {
      await handle?.stop()
      create.mockRestore()
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('host must be an allowed loopback or wildcard binding')
    expect(create).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(stderr).toEqual([])
  })

  it('rejects a bare host flag before starting a service', async () => {
    const create = vi.spyOn(Kernel, 'create')
    try {
      const result = await runMainServe(['--host'], { GITRADER_HOST: '0.0.0.0' })
      expect(result.code).toBe(1)
      expect(stderr.join('')).toContain('--host requires a value')
      expect(create).not.toHaveBeenCalled()
      expect(existsSync(join(home, 'service.json'))).toBe(false)
    } finally { create.mockRestore() }
  })

  it('rejects empty and invalid environment values before creating a Kernel', async () => {
    const create = vi.spyOn(Kernel, 'create')
    try {
      const result = await runMainServe([], { GITRADER_HOST: '' })
      expect(result.code).toBe(1)
      expect(stderr.join('')).toContain('host must be an allowed loopback or wildcard binding')
      expect(create).not.toHaveBeenCalled()
      expect(existsSync(join(home, 'service.json'))).toBe(false)
    } finally { create.mockRestore() }
  })

  it('gives --host priority over GITRADER_HOST and stops the local service through its own callback', async () => {
    const result = await runMainServe(['--host', '0.0.0.0'], { GITRADER_HOST: '::' })
    expect(result.code).toBe(0)
    expect(result.address?.address).toBe('0.0.0.0')
    expect(stderr.filter((line) => line === WILDCARD_WARNING)).toHaveLength(1)
  })

  it('uses GITRADER_HOST when --host is absent', async () => {
    const result = await runMainServe([], { GITRADER_HOST: '0.0.0.0' })
    expect(result.code).toBe(0)
    expect(result.address?.address).toBe('0.0.0.0')
    expect(stderr.filter((line) => line === WILDCARD_WARNING)).toHaveLength(1)
  })

  it('rejects an invalid --host instead of using the valid environment fallback', async () => {
    const create = vi.spyOn(Kernel, 'create')
    try {
      const result = await runMainServe(['--host', 'invalid-host'], { GITRADER_HOST: '0.0.0.0' })
      expect(result.code).toBe(1)
      expect(stderr.join('')).toContain('host must be an allowed loopback or wildcard binding')
      expect(create).not.toHaveBeenCalled()
    } finally { create.mockRestore() }
  })

  it('shows the host option and its environment fallback in help', async () => {
    expect(await main(['help'], makeIo())).toBe(0)
    expect(stdout.join('')).toContain('--host HOST')
    expect(stdout.join('')).toContain('GITRADER_HOST')
  })
})
