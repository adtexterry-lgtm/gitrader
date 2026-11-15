// SPDX-License-Identifier: CPAL-1.0
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/events'
import { InstallKey } from '../src/install-key'
import { Kernel } from '../src/kernel'
import { Ledger } from '../src/ledger'
import { metaGet, openDb } from '../src/db'
import { makeHarness, FAST_SCRYPT, enableLive, TEST_PIN, makeAgent } from './helpers/harness'
import type { Harness } from './helpers/harness'
import type { OrderIntent } from '../src/proto'
import { BTC } from './helpers/fake-connector'
import { fileProvider } from '../src/device-key'
import { mkOrigin } from '../src/util/origin'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => {
  await h.k.stop().catch(() => undefined)
  await h.cleanup()
})

const makeAlternateFile = (): Buffer => {
  const alternatePath = join(h.home, 'alternate-install-key.json')
  InstallKey.loadOrCreate(alternatePath, h.clock.now())
  return readFileSync(alternatePath)
}

const recreate = async (): Promise<void> => {
  h.k = await Kernel.create({ home: h.home, clock: h.clock, scrypt: FAST_SCRYPT, deviceKeyProvider: fileProvider, timers: false, sleep: async () => undefined })
}

const startAndRead = async (path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

describe('preserve the established install identity', () => {
  it('keeps a cold replacement degraded and restores signing only after restart with original bytes', async () => {
    const path = h.k.paths.installKey
    const originalBytes = readFileSync(path)
    const originalId = h.k.installKey.keyId
    const originalPub = h.k.installKey.publicKey
    const originalHead = h.k.ledger.head()
    const alternateBytes = makeAlternateFile()
    await h.k.stop()
    writeFileSync(path, alternateBytes)

    await recreate()
    expect(readFileSync(path)).toEqual(alternateBytes)
    expect(h.k.installKey.keyId).toBe(originalId)
    expect(h.k.installKey.publicKey).toBe(originalPub)
    expect(metaGet(h.k.db, 'install_key_id')).toBe(originalId)
    expect(metaGet(h.k.db, 'install_key_pub')).toBe(originalPub)
    expect(h.k.securityStateHealth().files).toContainEqual({ kind: 'install-key', state: 'corrupt' })
    expect(() => h.k.installKey.sign('identity probe')).toThrow()

    const started = await h.k.start({ port: 0 })
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const base = `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const health = await startAndRead(`${base}/api/health`)
    const diagnostics = await startAndRead(`${base}/api/ready`, token)
    expect(health.status).toBe(200)
    expect(health.body.status).toBe('degraded')
    expect(diagnostics.status).not.toBe(500)
    expect(typeof diagnostics.body.ready).toBe('boolean')

    writeFileSync(path, originalBytes)
    expect(h.k.securityStateHealth().files).toContainEqual({ kind: 'install-key', state: 'corrupt' })
    expect(() => h.k.installKey.sign('identity probe')).toThrow()
    await h.k.stop()
    const stoppedDb = openDb(h.k.paths.db)
    expect(stoppedDb.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1').get()).toEqual(originalHead)
    stoppedDb.close()

    await recreate()
    expect(h.k.installKey.keyId).toBe(originalId)
    expect(h.k.installKey.publicKey).toBe(originalPub)
    expect(h.k.securityStateHealth().ok).toBe(true)
    expect(InstallKey.verify(originalPub, 'identity probe', h.k.installKey.sign('identity probe'))).toBe(true)
  })

  it('latches a hot valid replacement before signing or live venue submission', async () => {
    await enableLive(h)
    const alternateBytes = makeAlternateFile()
    writeFileSync(h.k.paths.installKey, alternateBytes)
    const liveBefore = h.live.submitted.length
    expect(h.k.installKey.stateFileStatus().state).toBe('corrupt')
    expect(h.k.installKey.isAvailable()).toBe(false)
    expect(() => h.k.installKey.sign('identity probe')).toThrow()
    expect(h.k.securityStateHealth().ok).toBe(false)

    const intent: OrderIntent = {
      accountId: h.liveAcct.accountId as OrderIntent['accountId'], instrumentId: BTC, side: 'buy', type: 'market',
      size: '0.001' as OrderIntent['size'], reason: 'identity health probe',
    }
    await expect(h.k.trading.place({ intent }, h.human())).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
    expect(h.live.submitted).toHaveLength(liveBefore)
  })

  it('rejects live approval before changing a pending proposal when the keystore is corrupt', async () => {
    await enableLive(h)
    const proof = await h.pinProof()
    const agent = await makeAgent(h, 'confirm')
    const intent: OrderIntent = {
      accountId: h.liveAcct.accountId as OrderIntent['accountId'], instrumentId: BTC, side: 'buy', type: 'market',
      size: '0.001' as OrderIntent['size'], reason: 'approval health probe',
    }
    const pending = await h.k.trading.propose({ accountId: h.liveAcct.accountId, forcePending: true, reason: 'approval health probe', intents: [intent] }, agent.ctx('propose'))
    expect(pending.status).toBe('pending')
    const keyPath = h.k.paths.keystore
    const originalBytes = readFileSync(keyPath)
    const ledgerHead = h.k.ledger.head()
    const submitted = h.live.submitted.length
    const events: unknown[] = []
    const unsubscribe = h.k.events.subscribe('proposal.decided', (event) => events.push(event))
    writeFileSync(keyPath, '{')

    await expect(h.k.trading.approve(pending.ticket, proof, h.human('proposal.approve')))
      .rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
    expect(h.k.trading.getProposal(pending.ticket)).toMatchObject({ status: 'pending' })
    expect(h.k.ledger.head()).toEqual(ledgerHead)
    expect(h.live.submitted).toHaveLength(submitted)
    expect(events).toHaveLength(0)
    expect(readFileSync(keyPath)).toEqual(Buffer.from('{'))
    unsubscribe()

    await h.k.stop()
    writeFileSync(keyPath, originalBytes)
    await recreate()
    h.k.registerConnector(h.sim)
    h.k.registerConnector(h.live)
    const principal = h.k.auth.authenticateToken(h.k.auth.exchangeBoot(h.k.auth.mintBootToken()).sessionToken)
    if (!principal) throw new Error('fresh session unavailable')
    const freshProof = await h.k.auth.pinProof(principal, TEST_PIN, 'ui')
    h.k.keystore.unlock(freshProof)
    const approved = await h.k.trading.approve(pending.ticket, freshProof, {
      principal, origin: mkOrigin('user:usr_local', 'proposal.approve', 'ui'),
    })
    expect(approved.status).toBe('executed')
  })

  it('refuses a conflicting identity when Ledger is constructed directly', () => {
    const originalId = metaGet(h.k.db, 'install_key_id')
    const originalPub = metaGet(h.k.db, 'install_key_pub')
    const originalHead = h.k.ledger.head()
    const alternatePath = join(h.home, 'alternate-install-key.json')
    const alternate = InstallKey.loadOrCreate(alternatePath, h.clock.now())

    expect(() => new Ledger(h.k.db, h.clock, new EventBus(() => h.clock.now()), alternate)).toThrow()
    expect(metaGet(h.k.db, 'install_key_id')).toBe(originalId)
    expect(metaGet(h.k.db, 'install_key_pub')).toBe(originalPub)
    expect(h.k.ledger.head()).toEqual(originalHead)
  })

  it('fails closed when a nonempty ledger has no saved install identity', async () => {
    const path = h.k.paths.installKey
    const originalBytes = readFileSync(path)
    const originalHead = h.k.ledger.head()
    const originalCount = h.k.db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }
    await h.k.stop()
    const db = openDb(h.k.paths.db)
    db.prepare("DELETE FROM meta WHERE key IN ('install_key_id','install_key_pub')").run()
    db.close()

    await expect(recreate()).rejects.toMatchObject({ problem: { name: 'STATE_FILE_CORRUPT' } })
    expect(readFileSync(path)).toEqual(originalBytes)
    const reopened = openDb(h.k.paths.db)
    expect(reopened.prepare('SELECT COUNT(*) c FROM ledger').get()).toEqual(originalCount)
    expect(reopened.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1').get()).toEqual(originalHead)
    expect(metaGet(reopened, 'install_key_id')).toBeUndefined()
    reopened.close()
  })

  it('keeps fresh initialization and ordinary restart usable', async () => {
    const originalId = h.k.installKey.keyId
    const originalPub = h.k.installKey.publicKey
    expect(h.k.securityStateHealth().ok).toBe(true)
    await h.k.stop()
    await recreate()
    expect(h.k.installKey.keyId).toBe(originalId)
    expect(h.k.installKey.publicKey).toBe(originalPub)
    expect(h.k.securityStateHealth().ok).toBe(true)
    expect(InstallKey.verify(originalPub, 'restart probe', h.k.installKey.sign('restart probe'))).toBe(true)
  })
})
