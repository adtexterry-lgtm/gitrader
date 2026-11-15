// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { defaultConfig, validateConfig } from '../src/config'
import { ORG_SCOPE } from '../src/trading-state'
import { OpRateLimiter } from '../src/util/op-rate-limit'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'

type Rpc = { jsonrpc: '2.0'; id: number; method: string; params: Record<string, unknown> }
type RpcResult = { id?: number; result?: unknown; error?: { data?: { name?: string } } }

async function openSocket(endpoint: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const auth = await sendRpc(ws, { jsonrpc: '2.0', id: 1, method: 'auth', params: { token } })
  expect(auth.result).toEqual({ ok: true, user: 'usr_local' })
  return ws
}

function sendRpc(ws: WebSocket, request: Rpc): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('timed out waiting for JSON-RPC response')) }, 5_000)
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as RpcResult
      if (message.id !== request.id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify(request))
  })
}

function sendBatch(ws: WebSocket, requests: readonly Rpc[]): Promise<RpcResult[]> {
  const expected = new Set(requests.map((request) => request.id))
  return new Promise((resolve, reject) => {
    const results: RpcResult[] = []
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('timed out waiting for JSON-RPC batch')) }, 10_000)
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as RpcResult
      if (!expected.delete(message.id ?? -1)) return
      results.push(message)
      if (expected.size === 0) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(results)
      }
    }
    ws.on('message', onMessage)
    for (const request of requests) ws.send(JSON.stringify(request))
  })
}

describe('authenticated operation rate limits', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('rejects an explicitly empty security configuration but accepts either partial rate limit setting', () => {
    const empty = defaultConfig()
    Object.assign(empty.server, { operationRateLimit: {} })
    expect(validateConfig(empty).some((problem) => problem.includes('operationRateLimit'))).toBe(true)

    const capacityOnly = defaultConfig()
    Object.assign(capacityOnly.server, { operationRateLimit: { capacity: 12 } })
    expect(validateConfig(capacityOnly)).toEqual([])

    const refillOnly = defaultConfig()
    Object.assign(refillOnly.server, { operationRateLimit: { refillPerSecond: 3 } })
    expect(validateConfig(refillOnly)).toEqual([])
  })

  it('rejects invalid numeric rate and subscription limits', () => {
    const badCapacity = defaultConfig()
    Object.assign(badCapacity.server, { operationRateLimit: { capacity: 0 } })
    expect(validateConfig(badCapacity).some((problem) => problem.includes('capacity'))).toBe(true)

    const badRefill = defaultConfig()
    Object.assign(badRefill.server, { operationRateLimit: { refillPerSecond: 0 } })
    expect(validateConfig(badRefill).some((problem) => problem.includes('refillPerSecond'))).toBe(true)

    const badSubscriptions = defaultConfig()
    Object.assign(badSubscriptions.server, { maxWsSubscriptions: 0 })
    expect(validateConfig(badSubscriptions).some((problem) => problem.includes('maxWsSubscriptions'))).toBe(true)
  })

  it('rejects out-of-range upper values and null configuration', () => {
    const tooLargeCapacity = defaultConfig()
    Object.assign(tooLargeCapacity.server, { operationRateLimit: { capacity: 10_001 } })
    expect(validateConfig(tooLargeCapacity).some((problem) => problem.includes('capacity'))).toBe(true)

    const tooLargeRefill = defaultConfig()
    Object.assign(tooLargeRefill.server, { operationRateLimit: { refillPerSecond: 10_001 } })
    expect(validateConfig(tooLargeRefill).some((problem) => problem.includes('refillPerSecond'))).toBe(true)

    const nullLimit = defaultConfig()
    Object.assign(nullLimit.server, { operationRateLimit: null })
    expect(validateConfig(nullLimit).some((problem) => problem.includes('operationRateLimit'))).toBe(true)
  })

  it('uses stable non-token principal identities and changes the service bucket on rotation', async () => {
    const h = await makeHarness()
    try {
      const firstSessionKey = h.k.auth.operationRateKey(h.session)
      expect(h.k.auth.operationRateKey(h.session)).toBe(firstSessionKey)
      const secondSession = h.k.auth.authenticateToken(h.k.auth.exchangeBoot(h.k.auth.mintBootToken()).sessionToken)!
      expect(h.k.auth.operationRateKey(secondSession)).not.toBe(firstSessionKey)

      const agent = await makeAgent(h, 'read_only')
      expect(h.k.auth.operationRateKey(agent.principal)).toBe(`agent:${agent.keyId}`)

      const firstService = h.k.auth.rotateServiceToken()
      const firstServicePrincipal = h.k.auth.authenticateToken(firstService)!
      const firstServiceKey = h.k.auth.operationRateKey(firstServicePrincipal)
      const secondService = h.k.auth.rotateServiceToken()
      const secondServicePrincipal = h.k.auth.authenticateToken(secondService)!
      expect(h.k.auth.operationRateKey(secondServicePrincipal)).not.toBe(firstServiceKey)
      expect(h.k.auth.operationRateKey({ kind: 'engine', engineId: 'engine-a', mandateId: 'mandate-a' })).toBe('engine:engine-a')
    } finally { await h.cleanup() }
  })

  it('refills fractional tokens and reports a retry duration from its missing fraction', () => {
    let now = 0
    const limiter = new OpRateLimiter({ capacity: 2, refillPerSecond: 2 }, () => now)
    limiter.consume('principal')
    limiter.consume('principal')
    let problem: unknown
    try { limiter.consume('principal') } catch (error) { problem = error }
    expect(problem).toMatchObject({ problem: { name: 'RATE_BUDGET', retryable: true, retryAfterMs: 500 } })

    now = 250
    expect(() => limiter.consume('principal')).toThrow()
    now = 500
    expect(() => limiter.consume('principal')).not.toThrow()
  })

  it('does not mint tokens when monotonic time moves backwards', () => {
    let now = 1_000
    const limiter = new OpRateLimiter({ capacity: 1, refillPerSecond: 1 }, () => now)
    limiter.consume('principal')
    now = 0
    let problem: unknown
    try { limiter.consume('principal') } catch (error) { problem = error }
    expect(problem).toMatchObject({ problem: { retryAfterMs: 1000 } })
    now = 1_000
    expect(() => limiter.consume('principal')).toThrow()
    now = 2_000
    expect(() => limiter.consume('principal')).not.toThrow()
  })

  it('bounds bucket identities and recycles a bucket after the minimum idle window', () => {
    let now = 0
    const limiter = new OpRateLimiter({ capacity: 1, refillPerSecond: 0.1 }, () => now)
    for (let i = 0; i < 10_000; i++) limiter.consume(`principal-${i}`)
    expect(() => limiter.consume('principal-overflow')).toThrow()
    now = 60_000
    expect(() => limiter.consume('principal-after-idle')).not.toThrow()
  })

  it('rejects an authenticated HTTP query burst above the configured bucket capacity', async () => {
    const h = await makeHarness({ configure: (config) => { config.server.operationRateLimit = { capacity: 4, refillPerSecond: 0.1 } } })
    cleanup = h.cleanup
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const endpoint = `http://${host}:${address.port}/api/op/status`
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    })))
    const results = await Promise.all(responses.map(async (response) => ({
      response,
      body: await response.json() as { error?: { name?: string; retryAfterMs?: number } },
    })))
    const limited = results.find(({ body }) => body.error?.name === 'RATE_BUDGET')
    expect(limited).toBeDefined()
    if (!limited) throw new Error('the request burst must reach the operation limiter')
    expect(limited.response.status).toBe(429)
    expect(Number(limited.response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(limited.body.error?.retryAfterMs).toBeGreaterThan(0)
  })

  it('keeps separate authenticated sessions in separate buckets', async () => {
    const h = await makeHarness({ configure: (config) => { config.server.operationRateLimit = { capacity: 1, refillPerSecond: 0.1 } } })
    cleanup = h.cleanup
    const started = await h.k.start({ port: 0 })
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const endpoint = `http://${host}:${address.port}/api/op/status`
    const firstToken = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const secondToken = h.k.auth.exchangeBoot(h.k.auth.mintBootToken()).sessionToken
    const request = async (token: string): Promise<Response> => fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    })
    const first = await request(firstToken)
    const otherSession = await request(secondToken)
    const firstAgain = await request(firstToken)

    expect(first.status).toBe(200)
    expect(otherSession.status).toBe(200)
    expect(firstAgain.status).toBe(429)
  })

  it('keeps HTTP kill reachable for humans and service principals while denying other service writes', async () => {
    const h = await makeHarness({ configure: (config) => { config.server.operationRateLimit = { capacity: 1, refillPerSecond: 0.1 } } })
    try {
      await enableLive(h)
      const started = await h.k.start({ port: 0 })
      const address = h.k.http?.server.address()
      if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
      const host = address.address.includes(':') ? `[${address.address}]` : address.address
      const base = `http://${host}:${address.port}/api/op`
      const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
      const request = (operation: string, bearer: string, params: Record<string, unknown> = {}): Promise<Response> => fetch(`${base}/${operation}`, {
        method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ params }),
      })
      expect((await request('status', token)).status).toBe(200)
      expect((await request('status', token)).status).toBe(429)

      const snapshot = () => ({
        fills: h.k.orders.fills({ limit: 1000 }),
        fillEntries: h.k.ledger.query({ types: ['fill'], limit: 1000 }),
        submitted: h.sim.submitted.length + h.live.submitted.length,
        ledgerCount: (h.k.db.prepare('SELECT COUNT(*) AS c FROM ledger').get() as { c: number }).c,
        takeoverRequests: h.k.ledger.query({ types: ['takeover.requested'], limit: 1000 }).length,
      })

      const kill = await request('kill', token, { reason: 'B3 rate-limit test' })
      expect(kill.status).toBe(200)
      expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')

      const serviceToken = h.k.auth.rotateServiceToken()
      expect((await request('status', serviceToken)).status).toBe(200)
      expect((await request('status', serviceToken)).status).toBe(429)
      const beforeServiceKill = snapshot()
      const serviceKill = await request('kill', serviceToken, { reason: 'B3 service-auth test' })
      const serviceBody = await serviceKill.json() as { ok?: boolean; result?: { ok?: boolean }; error?: { name?: string } }
      expect(serviceKill.status).toBe(200)
      expect(serviceBody.error).toBeUndefined()
      expect(serviceBody.result?.ok ?? serviceBody.ok).toBe(true)
      expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
      const afterServiceKill = snapshot()
      expect(afterServiceKill.fills).toEqual(beforeServiceKill.fills)
      expect(afterServiceKill.fillEntries).toEqual(beforeServiceKill.fillEntries)
      expect(afterServiceKill.submitted).toBe(beforeServiceKill.submitted)
      expect(afterServiceKill.ledgerCount).toBeGreaterThan(beforeServiceKill.ledgerCount)
      expect(afterServiceKill.takeoverRequests).toBe(beforeServiceKill.takeoverRequests + 1)

      const beforeFlatten = snapshot()
      const flattenToken = h.k.auth.rotateServiceToken()
      const flatten = await request('takeover.flatten_all', flattenToken, { scope: ORG_SCOPE, reason: 'B3 service flatten denial' })
      const flattenBody = await flatten.json() as { error?: { name?: string } }
      expect(flatten.status).toBe(401)
      expect(flattenBody.error?.name).toBe('AUTH_FAILED')
      expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
      expect(snapshot()).toEqual(beforeFlatten)

      const beforeResume = snapshot()
      const resumeToken = h.k.auth.rotateServiceToken()
      const resume = await request('trading_state.resume', resumeToken, { scope: ORG_SCOPE, reason: 'B3 service resume denial' })
      const resumeBody = await resume.json() as { error?: { name?: string } }
      expect(resume.status).toBe(401)
      expect(resumeBody.error?.name).toBe('AUTH_FAILED')
      expect(h.k.tstate.get(ORG_SCOPE)).toBe('HALTED')
      expect(snapshot()).toEqual(beforeResume)
    } finally { await h.cleanup() }
  })

  it('does not charge an Agent trading action twice before the registry handler', async () => {
    const h = await makeHarness({ configure: (config) => { config.server.operationRateLimit = { capacity: 1, refillPerSecond: 0.1 } } })
    try {
      const agent = await makeAgent(h, 'paper')
      await h.k.start({ port: 0 })
      const address = h.k.http?.server.address()
      if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
      const host = address.address.includes(':') ? `[${address.address}]` : address.address
      const endpoint = `http://${host}:${address.port}/api/op`
      const request = (operation: string, params: Record<string, unknown>): Promise<Response> => fetch(`${endpoint}/${operation}`, {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ params }),
      })

      const tradeAction = await request('agent.order', { action: 'place', accountId: h.paper.accountId })
      const tradeBody = await tradeAction.json() as { error?: { name?: string } }
      expect(tradeBody.error?.name).toBe('INVALID_PARAMS')
      expect((await request('agent.session', {})).status).toBe(200)
      expect((await request('agent.session', {})).status).toBe(429)
    } finally { await h.cleanup() }
  })

  it('shares one token bucket across two authenticated WS connections', async () => {
    const h = await makeHarness({ configure: (config) => { config.server.operationRateLimit = { capacity: 4, refillPerSecond: 0.1 } } })
    cleanup = h.cleanup
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const endpoint = `http://${host}:${address.port}/api/op/status`
    const wsEndpoint = `ws://${host}:${address.port}/ui`
    const httpResponses = await Promise.all(Array.from({ length: 3 }, () => fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    })))
    expect(httpResponses.map((response) => response.status)).toEqual([200, 200, 200])
    const first = await openSocket(wsEndpoint, token)
    const firstBatch = Array.from({ length: 1 }, (_, index) => ({
      jsonrpc: '2.0' as const, id: index + 2, method: 'query', params: { method: 'status' },
    }))
    const firstResults = await sendBatch(first, firstBatch)
    const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()))
    first.close()
    await firstClosed

    const second = await openSocket(wsEndpoint, token)
    const next = await sendRpc(second, { jsonrpc: '2.0', id: 2, method: 'query', params: { method: 'status' } })
    second.close()

    expect(firstResults[0]?.result).toBeDefined()
    expect(next.error?.data?.name).toBe('RATE_BUDGET')
  })
})
