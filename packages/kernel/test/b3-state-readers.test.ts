// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceKey, fileProvider } from '../src/device-key'
import { InstallKey } from '../src/install-key'
import { Keystore } from '../src/keystore'
import { PinStore } from '../src/pin'
import { TEST_PIN, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { FAST_SCRYPT } from './helpers/harness'
import { validateProblem } from '@gitrader/protocol'
import { makeProblem } from '../src/proto'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const CORRUPT = { problem: { code: 5010, name: 'STATE_FILE_CORRUPT', category: 'PROTOCOL', retryable: false, message: 'security state file is corrupt; restore the original file and restart' } }
const typedData = { domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' }, types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, primaryType: 'Agent', message: { source: 'test', connectionId: `0x${'22'.repeat(32)}` } }

async function inTemp(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-state-reader-'))
  try { await run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function thrown(run: () => unknown): unknown {
  try { run(); return undefined } catch (error) { return error }
}

async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); return undefined } catch (error) { return error }
}

const malformed = [
  ['truncated JSON', '{'],
  ['valid JSON with the wrong shape', '{}'],
] as const

describe('corrupt state file shapes', () => {
  it.each(malformed)('PIN reader rejects %s with the fixed typed error', async (_label, contents) => inTemp((dir) => {
    const path = join(dir, 'pin.json')
    writeFileSync(path, contents)
    const error = thrown(() => new PinStore(path, h.clock, FAST_SCRYPT).version())
    expect(error).toMatchObject(CORRUPT)
  }))

  it.each(malformed)('keystore reader rejects %s with the fixed typed error', async (_label, contents) => inTemp((dir) => {
    const path = join(dir, 'keystore.json')
    writeFileSync(path, contents)
    const error = thrown(() => new Keystore(path, h.clock).list())
    expect(error).toMatchObject(CORRUPT)
  }))

  it.each(malformed)('device-key reader rejects %s with the fixed typed error', async (_label, contents) => inTemp(async (dir) => {
    const path = join(dir, 'device-key.json')
    writeFileSync(path, contents)
    const error = await rejected(() => new DeviceKey(path, fileProvider).get(false))
    expect(error).toMatchObject(CORRUPT)
  }))

  it.each(malformed)('install-key reader rejects %s without replacing the file', async (_label, contents) => inTemp((dir) => {
    const path = join(dir, 'install-key.json')
    writeFileSync(path, contents)
    const before = readFileSync(path)
    const error = thrown(() => InstallKey.loadOrCreate(path, h.clock.now()))
    expect(error).toMatchObject(CORRUPT)
    expect(readFileSync(path)).toEqual(before)
  }))
})

describe('corruption is latched after valid state was read', () => {
  it('keeps a damaged PIN set, makes it maximally locked, refuses overwrite, and latches until restart', async () => inTemp(async (dir) => {
    const path = join(dir, 'pin.json')
    const devicePath = join(dir, 'device-key.json')
    const device = new DeviceKey(devicePath, fileProvider)
    const pin = new PinStore(path, h.clock, FAST_SCRYPT, device)
    const originalKey = await pin.setup(TEST_PIN)
    const original = readFileSync(path)
    writeFileSync(path, '{')

    expect(await rejected(() => pin.verify(TEST_PIN))).toMatchObject(CORRUPT)
    expect(pin.isSet()).toBe(true)
    expect(pin.status()).toMatchObject({ set: true, lockedUntil: Number.MAX_SAFE_INTEGER })
    expect(pin.stateFileStatus()).toMatchObject({ kind: 'pin', state: 'corrupt' })
    expect(pin.deviceStateFileStatus()).toMatchObject({ kind: 'device-key', state: 'ok' })
    expect(await rejected(() => pin.setup('482917'))).toMatchObject(CORRUPT)
    expect(readFileSync(path, 'utf8')).toBe('{')

    writeFileSync(path, original)
    expect(await rejected(() => pin.verify(TEST_PIN))).toMatchObject(CORRUPT)
    const restarted = new PinStore(path, h.clock, FAST_SCRYPT, new DeviceKey(devicePath, fileProvider))
    expect((await restarted.verify(TEST_PIN)).equals(originalKey)).toBe(true)
  }))

  it('clears cached device key and latches deletion instead of recreating it', async () => inTemp(async (dir) => {
    const path = join(dir, 'device-key.json')
    const device = new DeviceKey(path, fileProvider)
    const originalKey = Buffer.from((await device.get(true))!)
    const original = readFileSync(path)
    unlinkSync(path)

    expect(await rejected(() => device.get(true))).toMatchObject(CORRUPT)
    expect(device.stateFileStatus()).toMatchObject({ kind: 'device-key', state: 'corrupt' })
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, original)
    expect(await rejected(() => device.get(false))).toMatchObject(CORRUPT)
    expect((await new DeviceKey(path, fileProvider).get(false))?.equals(originalKey!)).toBe(true)
  }))

  it('wipes a cached keystore master and makes an existing signer refuse after corruption', async () => {
    const proof = await h.pinProof()
    h.k.keystore.generate(proof, { name: 'cached-wallet' })
    const signer = h.k.keystore.getSigner('cached-wallet')
    const path = h.k.paths.keystore
    const original = readFileSync(path)
    writeFileSync(path, '{')

    expect(h.k.keystore.isUnlocked()).toBe(false)
    expect(h.k.keystore.stateFileStatus()).toMatchObject({ kind: 'keystore', state: 'corrupt' })
    expect(await rejected(() => signer.signTypedData(typedData as never))).toMatchObject(CORRUPT)
    expect(readFileSync(path, 'utf8')).toBe('{')
    writeFileSync(path, original)
    expect(thrown(() => h.k.keystore.list())).toMatchObject(CORRUPT)

    const restarted = new Keystore(path, h.clock)
    restarted.unlock(proof)
    expect(restarted.list().some((wallet) => wallet.name === 'cached-wallet')).toBe(true)
  })

  it('keeps cached install key signing disabled and refuses damaged-file replacement', () => inTemp((dir) => {
    const path = join(dir, 'install-key.json')
    const key = InstallKey.loadOrCreate(path, h.clock.now())
    const identity = { keyId: key.keyId, publicKey: key.publicKey, createdAt: key.createdAt }
    const original = readFileSync(path)
    writeFileSync(path, '{')

    expect(key.isAvailable()).toBe(false)
    expect(key.stateFileStatus()).toMatchObject({ kind: 'install-key', state: 'corrupt' })
    expect(thrown(() => key.sign('probe'))).toMatchObject(CORRUPT)
    expect(thrown(() => InstallKey.loadOrCreate(path, h.clock.now()))).toMatchObject(CORRUPT)
    expect(readFileSync(path, 'utf8')).toBe('{')

    writeFileSync(path, original)
    expect(thrown(() => key.sign('probe'))).toMatchObject(CORRUPT)
    const restarted = InstallKey.loadOrCreate(path, h.clock.now())
    expect(restarted.keyId).toBe(identity.keyId)
    expect(restarted.publicKey).toBe(identity.publicKey)
    expect(restarted.createdAt).toBe(identity.createdAt)
    expect(InstallKey.unavailable(path, identity).isAvailable()).toBe(false)
  }))
})

describe('state status and fixed unwrap errors', () => {
  it('keeps STATE_FILE_CORRUPT valid under the public Problem schema', () => {
    expect(validateProblem(makeProblem('STATE_FILE_CORRUPT', 'security state file is corrupt; restore the original file and restart')).ok).toBe(true)
  })

  it('reports an absent PIN as missing without changing normal first-setup behavior', async () => inTemp(async (dir) => {
    const path = join(dir, 'pin.json')
    const pin = new PinStore(path, h.clock, FAST_SCRYPT)
    expect(pin.stateFileStatus()).toMatchObject({ kind: 'pin', state: 'missing' })
    expect(pin.isSet()).toBe(false)
    await pin.setup(TEST_PIN)
    expect(pin.stateFileStatus()).toMatchObject({ kind: 'pin', state: 'ok' })
  }))

  it('does not expose a device-key provider unwrap error', async () => inTemp(async (dir) => {
    const path = join(dir, 'device-key.json')
    writeFileSync(path, JSON.stringify({ version: 1, provider: fileProvider.name, blob: Buffer.from('synthetic').toString('base64') }))
    const provider = { ...fileProvider, unwrap: async () => { throw new Error('private provider detail') } }
    const error = await rejected(() => new DeviceKey(path, provider).get(false))
    expect(error).toMatchObject({ problem: { code: 5003, name: 'AUTH_FAILED', message: 'device key could not be opened' } })
    expect((error as Error).message).not.toContain('private provider detail')
  }))
})

describe('a file deleted immediately after its first successful write stays corrupt', () => {
  it('keeps a newly set PIN locked after its file is deleted before any read', async () => inTemp(async (dir) => {
    const path = join(dir, 'pin.json')
    const pin = new PinStore(path, h.clock, FAST_SCRYPT)
    const originalKey = await pin.setup(TEST_PIN)
    const original = readFileSync(path)
    unlinkSync(path)

    expect(await rejected(() => pin.setup('482917'))).toMatchObject(CORRUPT)
    expect(pin.isSet()).toBe(true)
    expect(pin.status()).toMatchObject({ set: true, lockedUntil: Number.MAX_SAFE_INTEGER })
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, original)
    expect(await rejected(() => pin.verify(TEST_PIN))).toMatchObject(CORRUPT)

    const restarted = new PinStore(path, h.clock, FAST_SCRYPT)
    expect((await restarted.verify(TEST_PIN)).equals(originalKey)).toBe(true)
  }))

  it('locks a newly generated keystore after its file is deleted before any read', async () => inTemp(async (dir) => {
    const path = join(dir, 'keystore.json')
    const proof = await h.pinProof()
    const keystore = new Keystore(path, h.clock)
    keystore.unlock(proof)
    keystore.generate(proof, { name: 'first-wallet' })
    const original = readFileSync(path)
    unlinkSync(path)

    expect(thrown(() => keystore.generate(proof, { name: 'second-wallet' }))).toMatchObject(CORRUPT)
    expect(keystore.isUnlocked()).toBe(false)
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, original)
    expect(thrown(() => keystore.list())).toMatchObject(CORRUPT)

    const restarted = new Keystore(path, h.clock)
    restarted.unlock(proof)
    expect(restarted.list().some((wallet) => wallet.name === 'first-wallet')).toBe(true)
  }))

  it('preserves the corrupt-file error when a locked keystore is used again', async () => inTemp(async (dir) => {
    const path = join(dir, 'keystore.json')
    const proof = await h.pinProof()
    const keystore = new Keystore(path, h.clock)
    keystore.unlock(proof)
    keystore.generate(proof, { name: 'first-wallet' })
    const original = readFileSync(path)
    unlinkSync(path)

    expect(keystore.isUnlocked()).toBe(false)
    expect(thrown(() => keystore.generate(proof, { name: 'second-wallet' }))).toMatchObject(CORRUPT)
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, original)
    expect(thrown(() => keystore.generate(proof, { name: 'second-wallet' }))).toMatchObject(CORRUPT)
  }))
})
