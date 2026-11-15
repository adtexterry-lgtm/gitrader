// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { enableLive, FAST_SCRYPT, TEST_PIN } from './helpers/harness'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => {
  let stopFailure: unknown
  try { await h.k.stop() } catch (error) { stopFailure = error }
  await h.cleanup()
  if (stopFailure !== undefined) throw new Error(`kernel stop failed: ${stopFailure instanceof Error ? stopFailure.message : 'unknown error'}`)
})

type JsonResponse = { status: number; body: Record<string, unknown> }

function baseUrl(): string {
  const address = h.k.http?.server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `http://${host}:${address.port}`
}

async function request(path: string, options: { token?: string; pin?: string; body?: unknown } = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {}
  if (options.pin !== undefined) headers['x-gitrader-pin'] = options.pin
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${baseUrl()}${path}`, {
    headers,
    ...(options.body === undefined ? {} : { method: 'POST', body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function get(path: string, token?: string): Promise<JsonResponse> {
  return request(path, token ? { token } : {})
}

async function op(name: string, params: unknown, token: string, pin?: string): Promise<JsonResponse> {
  return request(`/api/op/${name}`, { token, ...(pin === undefined ? {} : { pin }), body: { params } })
}

function identityFingerprint(): string {
  return createHash('sha256').update(h.k.installKey.keyId).update(h.k.installKey.publicKey).digest('hex')
}

async function restartKernel(): Promise<void> {
  await h.k.stop()
  h.k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
}

function liveIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    accountId: h.liveAcct.accountId as OrderIntent['accountId'], instrumentId: BTC, side: 'buy', type: 'market',
    size: '0.001' as OrderIntent['size'], reason: 'state health probe', ...overrides,
  }
}

async function initializeSecurityFiles(): Promise<void> {
  const proof = await h.pinProof()
  h.k.keystore.generate(proof, { name: 'health-probe-wallet' })
}

const stateFilePath = (kind: string): string => {
  if (kind === 'pin') return h.k.paths.pin
  if (kind === 'keystore') return h.k.paths.keystore
  if (kind === 'device-key') return h.k.paths.deviceKey
  return h.k.paths.installKey
}

const corruptions = [
  ['truncated JSON', '{'],
  ['valid wrong shape', '{"version":999,"marker":"synthetic"}'],
] as const
const stateKinds = ['pin', 'keystore', 'device-key', 'install-key'] as const

describe('real HTTP health with corrupted security state', () => {
  it.each(stateKinds.flatMap((kind) => corruptions.map(([label, contents]) => [kind, label, contents] as const)))(
    'keeps health and authenticated diagnostics readable for %s with %s', async (kind, _label, contents) => {
      await initializeSecurityFiles()
      const started = await h.k.start({ port: 0 })
      const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
      const path = stateFilePath(kind)
      const original = readFileSync(path)
      writeFileSync(path, contents)

      const health = await get('/api/health')
      const diagnostics = await get('/api/ready', token)
      expect(health.status).toBe(200)
      expect(health.body.ok).toBe(true)
      expect(diagnostics.status).not.toBe(500)
      expect(typeof diagnostics.body.ready).toBe('boolean')
      expect(health.body.status).toBe('degraded')
      expect(health.body.stateFiles).toContainEqual({ kind, state: 'corrupt' })
      expect(JSON.stringify(health.body)).not.toContain(h.home)
      expect(JSON.stringify(health.body)).not.toMatch(/publicKey|privateKey|SyntaxError|ENOENT/)
      expect(readFileSync(path, 'utf8')).toBe(contents)

      writeFileSync(path, original)
      const restored = await get('/api/health')
      expect(restored.body.status).toBe('degraded')
      expect(restored.body.stateFiles).toContainEqual({ kind, state: 'corrupt' })
    },
  )

  it('serves degraded health after cold restart from an initialized home with a corrupt PIN file', async () => {
    await initializeSecurityFiles()
    const path = h.k.paths.pin
    writeFileSync(path, '{')
    await h.k.stop()

    h.k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    await h.k.start({ port: 0 })
    const health = await get('/api/health')

    expect(health.status).toBe(200)
    expect(health.body.status).toBe('degraded')
    expect(health.body.stateFiles).toContainEqual({ kind: 'pin', state: 'corrupt' })
    expect(readFileSync(path, 'utf8')).toBe('{')
  })

  it.each(stateKinds)('cold start reports damaged %s while preserving install identity and source bytes', async (kind) => {
    await initializeSecurityFiles()
    const identity = identityFingerprint()
    const path = stateFilePath(kind)
    const original = readFileSync(path)
    await h.k.stop()
    writeFileSync(path, '{')

    h.k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    const started = await h.k.start({ port: 0 })
    const health = await get('/api/health')

    expect(health.status).toBe(200)
    expect(health.body.status).toBe('degraded')
    expect(health.body.stateFiles).toContainEqual({ kind, state: 'corrupt' })
    expect(readFileSync(path, 'utf8')).toBe('{')
    expect(identityFingerprint() === identity).toBe(true)
    expect(started.port).toBeGreaterThan(0)
    writeFileSync(path, original)
    await h.k.stop()
  })

  it('blocks fake-live place and cancel after cached security-state corruption without side effects', async () => {
    await initializeSecurityFiles()
    await enableLive(h)
    const order = await h.k.trading.place({ intent: liveIntent({ type: 'limit', price: '79000' as OrderIntent['price'] }) }, h.human())
    expect(order.order?.status).toBe('open')
    const orderId = order.order!.orderId
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const path = h.k.paths.keystore
    const original = readFileSync(path)
    writeFileSync(path, '{')
    const submitted = h.live.submitted.length
    const cancelled = h.live.cancelCalls.length

    const place = await op('order.place', { intent: liveIntent() }, token, TEST_PIN)
    const cancel = await op('order.cancel', { accountId: h.liveAcct.accountId, orderId }, token, TEST_PIN)

    expect(place.status).not.toBe(500)
    expect(cancel.status).not.toBe(500)
    expect(JSON.stringify(place.body)).toContain('STATE_FILE_CORRUPT')
    expect(JSON.stringify(cancel.body)).toContain('STATE_FILE_CORRUPT')
    expect(h.live.submitted).toHaveLength(submitted)
    expect(h.live.cancelCalls).toHaveLength(cancelled)
    writeFileSync(path, original)
  })

  it('refuses first PIN setup when PIN is missing beside existing keystore and device identity', async () => {
    await initializeSecurityFiles()
    const pinPath = h.k.paths.pin
    const keystorePath = h.k.paths.keystore
    const devicePath = h.k.paths.deviceKey
    const keystore = readFileSync(keystorePath)
    const deviceKey = readFileSync(devicePath)
    await h.k.stop()
    unlinkSync(pinPath)
    h.k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken

    const result = await op('pin.set', { pin: TEST_PIN }, token)

    expect(result.status).not.toBe(200)
    expect(JSON.stringify(result.body)).toContain('STATE_FILE_CORRUPT')
    expect(readFileSync(keystorePath).equals(keystore)).toBe(true)
    expect(readFileSync(devicePath).equals(deviceKey)).toBe(true)
    expect(() => readFileSync(pinPath)).toThrow()
    await h.k.stop()
  })

  it.each(['keystore', 'device-key', 'install-key'] as const)('does not change an existing PIN when %s is corrupt', async (kind) => {
    await initializeSecurityFiles()
    const pinPath = h.k.paths.pin
    const path = stateFilePath(kind)
    const pinBytes = readFileSync(pinPath)
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    writeFileSync(path, '{')

    const result = await op('pin.set', { pin: '482917' }, token, TEST_PIN)

    expect(result.status).not.toBe(200)
    expect(JSON.stringify(result.body)).toContain('STATE_FILE_CORRUPT')
    expect(readFileSync(pinPath).equals(pinBytes)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('{')
  })

  it('treats a missing device key beside a version-2 PIN as corrupt and blocks PIN reset', async () => {
    await initializeSecurityFiles()
    expect(h.k.pin.version()).toBe(2)
    const devicePath = h.k.paths.deviceKey
    const pinPath = h.k.paths.pin
    const pinBytes = readFileSync(pinPath)
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    unlinkSync(devicePath)

    const health = await get('/api/health')
    const result = await op('pin.set', { pin: '482917' }, token, TEST_PIN)

    expect(health.body.status).toBe('degraded')
    expect(health.body.stateFiles).toContainEqual({ kind: 'device-key', state: 'corrupt' })
    expect(result.status).not.toBe(200)
    expect(JSON.stringify(result.body)).toContain('STATE_FILE_CORRUPT')
    expect(readFileSync(pinPath).equals(pinBytes)).toBe(true)
    expect(() => readFileSync(devicePath)).toThrow()
  })

  it.each(stateKinds)('restoring %s bytes stays latched in this instance and recovers only after restart', async (kind) => {
    await initializeSecurityFiles()
    const identity = identityFingerprint()
    const path = stateFilePath(kind)
    const original = readFileSync(path)
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    writeFileSync(path, '{')

    const damaged = await get('/api/health')
    expect(damaged.body.status).toBe('degraded')
    writeFileSync(path, original)
    const sameInstance = await get('/api/health')
    expect(sameInstance.body.status).toBe('degraded')

    await restartKernel()
    const recoveredStart = await h.k.start({ port: 0 })
    const recovered = await get('/api/health')

    expect(recoveredStart.port).toBeGreaterThan(0)
    expect(recovered.status).toBe(200)
    expect(recovered.body.status).toBe('ok')
    expect(identityFingerprint() === identity).toBe(true)
    expect((await h.k.pin.verify(TEST_PIN)).length).toBeGreaterThan(0)
    expect(token).toBeTruthy()
  })
})
