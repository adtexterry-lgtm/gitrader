// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemOrigin } from '../src/util/origin'
import { TEST_PIN, enableLive, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let sessionToken = ''
let serviceToken = ''

beforeEach(async () => {
  h = await makeHarness()
  const started = await h.k.start({ port: 0 })
  sessionToken = h.k.auth.exchangeBoot(started.bootToken).sessionToken
  serviceToken = (JSON.parse(readFileSync(join(h.home, 'service.json'), 'utf8')) as { token: string }).token
  await h.pinProof()
})
afterEach(async () => { await h.cleanup() })
function serverUrl(protocol: 'http' | 'ws' = 'http'): string {
  const address = h.k.http?.server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server address unavailable')
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `${protocol}://${host}:${address.port}`
}

const op = async (name: string, params: unknown, token = serviceToken) => {
  const res = await fetch(`${serverUrl()}/api/op/${name}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  })
  return { status: res.status, json: await res.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('service transport is read-only', () => {
  it('rejects note.add without changing ledger while session note.add remains available', async () => {
    const before = h.k.ledger.count()

    const denied = await op('note.add', { text: 'service must not append' })
    expect(denied.status).toBe(401)
    expect(denied.json.error).toMatchObject({ name: 'AUTH_FAILED' })
    expect(h.k.ledger.count()).toBe(before)

    const allowed = await op('note.add', { text: 'session note' }, sessionToken)
    expect(allowed.status).toBe(200)
    expect(h.k.ledger.count()).toBe(before + 1)
  })

  it('rejects keystore.lock from service without locking the unlocked store', async () => {
    expect(h.k.keystore.isUnlocked()).toBe(true)

    const denied = await op('keystore.lock', {})

    expect(denied.status).toBe(401)
    expect(denied.json.error).toMatchObject({ name: 'AUTH_FAILED' })
    expect(h.k.keystore.isUnlocked()).toBe(true)
  })

  it('rejects config.get from service but preserves read-only status access', async () => {
    const config = await op('config.get', {})
    expect(config.status).toBe(401)
    expect(config.json.error).toMatchObject({ name: 'AUTH_FAILED' })

    const status = await op('status', {})
    expect(status.status).toBe(200)
  })

  it('ADR-5: service token mints an ordinary session.link only with the correct PIN', async () => {
    const mint = vi.spyOn(h.k.auth, 'mintBootToken')
    const withPin = async (pin?: string) => {
      const res = await fetch(`${serverUrl()}/api/op/session.link`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json', ...(pin ? { 'x-gitrader-pin': pin } : {}) },
        body: JSON.stringify({ params: {} }),
      })
      return { status: res.status, json: await res.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    const missing = await withPin()
    expect(missing.json.error).toMatchObject({ code: 1010 })
    const wrong = await withPin('000000')
    expect(wrong.json.error).toMatchObject({ name: 'AUTH_FAILED' })
    expect(mint).not.toHaveBeenCalled()

    const ok = await withPin(TEST_PIN)
    expect(ok.status).toBe(200)
    expect(new URL(ok.json.result.url).searchParams.get('launch')).toMatch(/^boot_/)
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('requires a human session to mint an unattended link and records the action', async () => {
    h.k.config.embed = { allowedOrigins: ['https://host.test'] }
    const mint = vi.spyOn(h.k.auth, 'mintBootToken')
    const before = h.k.ledger.count()

    const denied = await op('session.link.unattended', { origin: 'https://host.test' })
    expect(denied.status).toBe(401)
    expect(denied.json.error).toMatchObject({ name: 'AUTH_FAILED' })
    expect(mint).not.toHaveBeenCalled()
    expect(h.k.ledger.count()).toBe(before)

    const allowed = await op('session.link.unattended', { origin: 'https://host.test' }, sessionToken)
    expect(allowed.status).toBe(200)
    expect(mint).toHaveBeenCalledTimes(1)
    expect(h.k.ledger.count()).toBe(before + 1)
  })

  it('allows authenticated service kill while denying service flatten and resume', async () => {
    await enableLive(h)
    const before = h.k.ledger.count()
    const submitted = h.sim.submitted.length

    const killed = await op('kill', { reason: 'service emergency stop' })
    expect(killed.status).toBe(200)
    expect(['HALTED', 'REDUCING']).toContain(h.k.tstate.get({ type: 'org', id: 'org_local' }))
    expect(h.k.ledger.count()).toBeGreaterThan(before)
    expect(h.k.ledger.query({ types: ['takeover.requested'] }).length).toBeGreaterThan(0)
    expect(h.sim.submitted).toHaveLength(submitted)

    const flatten = await op('takeover.flatten_all', { reason: 'service flatten check', scope: { type: 'org', id: 'org_local' } })
    expect(flatten.status).toBe(401)
    expect(flatten.json.error).toMatchObject({ name: 'AUTH_FAILED' })

    const resume = await op('trading_state.resume', { reason: 'service resume check', scope: { type: 'org', id: 'org_local' } })
    expect(resume.status).toBe(401)
    expect(resume.json.error).toMatchObject({ name: 'AUTH_FAILED' })
    expect(h.k.tstate.get({ type: 'org', id: 'org_local' })).not.toBe('ACTIVE')
    expect(h.sim.submitted).toHaveLength(submitted)
  })

  it('keeps internal system kill available and human session kill on the HTTP path', async () => {
    await enableLive(h)
    const internal = await h.k.takeover.kill('internal emergency stop', { principal: { kind: 'service' }, origin: systemOrigin('internal emergency stop') })
    expect(internal.ok).toBe(true)
    expect(h.k.ledger.query({ types: ['takeover.requested'] }).at(-1)?.origin.actor).toBe('system:kernel')

    const human = await op('kill', { reason: 'human emergency stop' }, sessionToken)
    expect(['HALTED', 'REDUCING']).toContain(h.k.tstate.get({ type: 'org', id: 'org_local' }))
    expect(human.status).not.toBe(401)
  })
})

describe('fix-r2 T1: agentkey.request.list is session-only', () => {
  it('service token cannot list pending agent requests; session can; status stays readable for service', async () => {
    const denied = await op('agentkey.request.list', {})
    expect(denied.status).toBe(401)
    expect(denied.json.error).toMatchObject({ name: 'AUTH_FAILED' })
    const allowed = await op('agentkey.request.list', {}, sessionToken)
    expect(allowed.status).toBe(200)
    expect(allowed.json.result).toHaveProperty('requests')
    expect((await op('status', {})).status).toBe(200)
  })
})
