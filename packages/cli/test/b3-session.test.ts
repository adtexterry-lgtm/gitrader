// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync as fsRenameSync, rmSync, statSync, unlinkSync as fsUnlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { fileProvider, tightenFile as secureTightenFile } from '@gitrader/kernel'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'
import { readCachedSession, SessionRequiredError } from '../src/session'

let home: string
let outsideHome: string
let service: ServeHandle
let out: string[]
let err: string[]
let secrets: string[]
let prompts: number

const io = (over: Partial<CliIo> = {}): CliIo => ({
  out: (value) => out.push(value), err: (value) => err.push(value), env: { GITRADER_HOME: home },
  interactive: true, deviceKey: fileProvider,
  readSecret: async () => { prompts++; const value = secrets.shift(); if (value === undefined) throw new Error('no secret input'); return value },
  ...over,
})
const run = (args: string[], over: Partial<CliIo> = {}): Promise<number> => main(args, io(over))

function endpoint(path: string): URL {
  const url = new URL(service.url)
  url.pathname = path
  url.search = ''
  return url
}

function waitForMessage(ws: WebSocket, predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('WebSocket response timed out')) }, timeoutMs)
    const onMessage = (raw: WebSocket.RawData): void => {
      let message: Record<string, unknown>
      try { message = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }
      if (!predicate(message)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}

async function connectSession(token: string): Promise<WebSocket> {
  const url = endpoint('/ui')
  url.protocol = 'ws:'
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', () => reject(new Error('WebSocket connection failed')))
  })
  const auth = waitForMessage(ws, (message) => message.id === 1)
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token, client: { name: 'session-test' } } }))
  expect(await auth).toMatchObject({ result: { ok: true } })
  return ws
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-session-'))
  outsideHome = mkdtempSync(join(tmpdir(), 'gitrader-session-outside-'))
  out = []; err = []; secrets = []; prompts = 0
  await run(['init', '--no-pin'])
  service = await runServe(home, { port: 0, io: io(), connectors: false })
})

afterEach(async () => {
  await service?.stop().catch(() => undefined)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  rmSync(outsideHome, { recursive: true, force: true, maxRetries: 5 })
})

describe('gitrader session login and logout', () => {
  it('exchanges one boot token and caches the current private session without printing its token', async () => {
    const peer = service.kernel.auth.exchangeBoot(service.kernel.auth.mintBootToken())
    const boot = service.kernel.auth.mintBootToken()
    secrets = [boot]
    const cacheWriteSteps: string[] = []

    const loginCode = await run(['session', 'login'], { sessionFileOps: {
      tightenFile: (path) => { cacheWriteSteps.push(`tighten:${statSync(path).size}`); return secureTightenFile(path) },
      renameSync: (from, to) => { cacheWriteSteps.push('rename'); fsRenameSync(from, to) },
      unlinkSync: fsUnlinkSync,
    } })
    expect(cacheWriteSteps).toEqual(['tighten:0', 'rename'])
    expect(loginCode, err.join('')).toBe(0)
    const cachePath = join(home, 'cli-session.json')
    expect(existsSync(cachePath)).toBe(true)
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    expect(cache).toMatchObject({ version: 1, sessionId: expect.any(String), serviceStartedAt: service.kernel.startedAt })
    expect(cache.sessionToken).toMatch(/^ses_/)
    expect(Number.isSafeInteger(cache.expiresAt)).toBe(true)
    expect(cache.expiresAt as number).toBeGreaterThan(Date.now())
    expect(`${out.join('')}${err.join('')}`).not.toContain(cache.sessionToken as string)
    expect(service.kernel.auth.authenticateToken(cache.sessionToken as string)).not.toBeNull()

    const replay = await fetch(endpoint('/api/session'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: boot }),
    })
    expect(replay.status).toBe(401)

    const beforeFailedLogin = readFileSync(cachePath)
    secrets = ['not-a-bootstrap-token']
    expect(await run(['session', 'login'])).toBe(1)
    expect(readFileSync(cachePath)).toEqual(beforeFailedLogin)
    expect(service.kernel.auth.authenticateToken(cache.sessionToken as string)).not.toBeNull()

    expect(await run(['session', 'logout'])).toBe(0)
    expect(existsSync(cachePath)).toBe(false)
    expect(service.kernel.auth.authenticateToken(cache.sessionToken as string)).toBeNull()
    expect(service.kernel.auth.authenticateToken(peer.sessionToken)).not.toBeNull()
    expect(await run(['status', '--json'])).toBe(0)
    expect(`${out.join('')}${err.join('')}`).not.toContain(cache.sessionToken as string)
  })

  it('rejects missing secret input without creating a cache', async () => {
    expect(await run(['session', 'login'])).toBe(1)
    expect(prompts).toBe(1)
    expect(existsSync(join(home, 'cli-session.json'))).toBe(false)
  })

  it('preserves a prior cache and revokes the new session when private staging cannot be secured', async () => {
    secrets = [service.kernel.auth.mintBootToken()]
    expect(await run(['session', 'login'])).toBe(0)
    const cachePath = join(home, 'cli-session.json')
    const priorBytes = readFileSync(cachePath)
    const prior = JSON.parse(priorBytes.toString('utf8')) as { sessionToken: string }
    secrets = [service.kernel.auth.mintBootToken()]
    const beforeCount = service.kernel.auth.sessionCount

    let tightenCalls = 0
    const stageId = '01234567-89ab-cdef-0123-456789abcdef'
    expect(await run(['session', 'login'], { sessionFileOps: {
      randomUUID: () => stageId,
      tightenFile: (path) => { tightenCalls++; expect(readFileSync(path)).toEqual(Buffer.alloc(0)); return false },
      renameSync: () => { throw new Error('unexpected rename') }, unlinkSync: fsUnlinkSync,
    } })).toBe(1)

    expect(readFileSync(cachePath)).toEqual(priorBytes)
    expect(service.kernel.auth.authenticateToken(prior.sessionToken)).not.toBeNull()
    expect(service.kernel.auth.sessionCount).toBe(beforeCount)
    expect(tightenCalls).toBe(1)
    expect(readdirSync(home).some((name) => name.includes(stageId))).toBe(false)
  })

  it('rejects a preexisting regular staging file without replacing it or the prior cache', async () => {
    secrets = [service.kernel.auth.mintBootToken()]
    expect(await run(['session', 'login'])).toBe(0)
    const cachePath = join(home, 'cli-session.json')
    const priorBytes = readFileSync(cachePath)
    const beforeCount = service.kernel.auth.sessionCount
    const stageId = '11234567-89ab-cdef-0123-456789abcdef'
    const stagePath = join(home, `.cli-session-${stageId}.tmp`)
    const collisionBytes = Buffer.from('preexisting staging data')
    writeFileSync(stagePath, collisionBytes)
    let uuidCalls = 0
    let tightenCalls = 0
    secrets = [service.kernel.auth.mintBootToken()]

    expect(await run(['session', 'login'], { sessionFileOps: {
      randomUUID: () => { uuidCalls++; return stageId },
      tightenFile: (path) => { tightenCalls++; return secureTightenFile(path) },
      renameSync: fsRenameSync,
      unlinkSync: fsUnlinkSync,
    } })).toBe(1)

    expect(uuidCalls).toBe(1)
    expect(tightenCalls).toBe(0)
    expect(readFileSync(stagePath)).toEqual(collisionBytes)
    expect(readFileSync(cachePath)).toEqual(priorBytes)
    expect(service.kernel.auth.sessionCount).toBe(beforeCount)
  })

  it('rejects a staging hard link without changing its outside sentinel or prior cache', async () => {
    secrets = [service.kernel.auth.mintBootToken()]
    expect(await run(['session', 'login'])).toBe(0)
    const cachePath = join(home, 'cli-session.json')
    const priorBytes = readFileSync(cachePath)
    const beforeCount = service.kernel.auth.sessionCount
    const stageId = '21234567-89ab-cdef-0123-456789abcdef'
    const stagePath = join(home, `.cli-session-${stageId}.tmp`)
    const sentinelPath = join(outsideHome, 'sentinel')
    const sentinelBytes = Buffer.from('outside sentinel remains unchanged')
    writeFileSync(sentinelPath, sentinelBytes)
    linkSync(sentinelPath, stagePath)
    const sentinelIdentity = statSync(sentinelPath)
    let uuidCalls = 0
    let tightenCalls = 0
    secrets = [service.kernel.auth.mintBootToken()]

    expect(await run(['session', 'login'], { sessionFileOps: {
      randomUUID: () => { uuidCalls++; return stageId },
      tightenFile: (path) => { tightenCalls++; return secureTightenFile(path) },
      renameSync: fsRenameSync,
      unlinkSync: fsUnlinkSync,
    } })).toBe(1)

    expect(uuidCalls).toBe(1)
    expect(tightenCalls).toBe(0)
    expect(readFileSync(sentinelPath)).toEqual(sentinelBytes)
    expect(statSync(stagePath).ino).toBe(sentinelIdentity.ino)
    expect(readFileSync(cachePath)).toEqual(priorBytes)
    expect(service.kernel.auth.sessionCount).toBe(beforeCount)
  })

  it('rejects expired, restarted, and corrupt local cache records with typed recovery errors', () => {
    const cachePath = join(home, 'cli-session.json')
    const serviceInfo = { baseUrl: new URL(service.url).origin, startedAt: service.kernel.startedAt }
    const valid = {
      version: 1, sessionToken: `ses_${'A'.repeat(52)}`, sessionId: `ses_${'a'.repeat(16)}`,
      expiresAt: Date.now() + 60_000, serviceStartedAt: service.kernel.startedAt,
    }
    writeFileSync(cachePath, JSON.stringify(valid))
    expect(readCachedSession(home, serviceInfo).sessionId).toBe(valid.sessionId)
    expect(() => readCachedSession(home, serviceInfo, valid.expiresAt)).toThrowError(SessionRequiredError)
    expect(() => readCachedSession(home, { ...serviceInfo, startedAt: service.kernel.startedAt + 1 })).toThrowError(SessionRequiredError)
    writeFileSync(cachePath, '{')
    expect(() => readCachedSession(home, serviceInfo)).toThrowError(SessionRequiredError)
  })

  it('revokes only one HTTP session and blocks its active WebSockets while preserving queued-event and peer access', async () => {
    const current = service.kernel.auth.exchangeBoot(service.kernel.auth.mintBootToken())
    const peer = service.kernel.auth.exchangeBoot(service.kernel.auth.mintBootToken())
    const eventSocket = await connectSession(current.sessionToken)
    const commandSocket = await connectSession(current.sessionToken)
    const peerSocket = await connectSession(peer.sessionToken)
    const subscriptionResponse = waitForMessage(eventSocket, (message) => message.id === 2)
    eventSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'subscribe', params: { topic: 'risk.state', maxHz: 1 } }))
    const subscription = await subscriptionResponse
    const subscriptionId = (subscription.result as { subscriptionId: string }).subscriptionId
    const firstEvent = waitForMessage(eventSocket, (message) => message.method === 'event')
    service.kernel.events.publish('risk.state', { marker: 'first' })
    await firstEvent
    service.kernel.events.publish('risk.state', { marker: 'queued' })

    const logout = await fetch(endpoint('/api/op/session.logout'), {
      method: 'POST', headers: { authorization: `Bearer ${current.sessionToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    })
    expect(logout.status).toBe(200)
    expect(service.kernel.auth.authenticateToken(current.sessionToken)).toBeNull()
    expect(service.kernel.auth.authenticateToken(peer.sessionToken)).not.toBeNull()

    const commandResult = waitForMessage(commandSocket, (message) => message.id === 3)
    commandSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'command', params: {
      action: 'settings.agent_layout.set', params: { enabled: true }, origin: { tool: 'session.logout.test', via: 'ui' },
    } }))
    expect(await commandResult).toMatchObject({ error: { data: { name: 'AUTH_FAILED' } } })
    expect(service.kernel.settings.agentLayout()).toBe(false)

    const peerQuery = waitForMessage(peerSocket, (message) => message.id === 2)
    peerSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'query', params: { method: 'settings.get' } }))
    expect(await peerQuery).toMatchObject({ result: { agentLayout: false } })
    expect(await run(['status', '--json'])).toBe(0)

    const delivered: unknown[] = []
    eventSocket.on('message', (raw) => delivered.push(JSON.parse(raw.toString())))
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(delivered.some((item) => JSON.stringify(item).includes('queued'))).toBe(false)
    expect(subscriptionId).toMatch(/^sub_/)
    eventSocket.close(); commandSocket.close(); peerSocket.close()
  })
})
