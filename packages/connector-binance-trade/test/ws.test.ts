// SPDX-License-Identifier: CPAL-1.0
// 用户数据流：listenKey 生命周期（时钟注入）+ 帧解析（假 socket，永不真连）。
import { describe, expect, it } from 'vitest'
import { createWeightBudget } from '../src/budget'
import { ProblemError } from '../src/errors'
import { BinanceHttp } from '../src/rest'
import { LISTEN_KEY_RENEW_AFTER_MS, LISTEN_KEY_TTL_MS, ListenKeyManager, USER_STREAM_BASE, openUserStream, userStreamUrl } from '../src/ws'
import type { SocketLike } from '../src/ws'
import type { BinanceUserEvent } from '../src/parse'
import { API_KEY, API_SECRET, BASE_URL, FakeBinanceTrade, NOW } from './helpers/fake-binance-trade'

function setup() {
  let now = NOW
  const f = new FakeBinanceTrade()
  const http = new BinanceHttp({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl: f.fetch, clock: () => now, budget: createWeightBudget({ clock: () => now }) })
  const mgr = new ListenKeyManager({ http, clock: () => now, secrets: [API_SECRET] })
  return { f, mgr, setNow: (t: number) => { now = t }, advance: (ms: number) => { now += ms } }
}

describe('listenKey lifecycle', () => {
  it('open() POSTs /fapi/v1/listenKey with the API key header and no signature', async () => {
    const { f, mgr } = setup()
    const key = await mgr.open()
    expect(key).toBe('listen-key-for-tests')
    const call = f.callsFor('POST', '/fapi/v1/listenKey')[0]!
    expect(call.apiKey).toBe(API_KEY)
    expect(call.signature).toBeNull()
    expect(call.params.has('timestamp')).toBe(false)
    expect(mgr.state()).toEqual({
      listenKey: 'listen-key-for-tests',
      createdAt: NOW,
      refreshedAt: NOW,
      renewals: 0,
      expiresAt: NOW + LISTEN_KEY_TTL_MS,
    })
  })

  it('tick() before the 25 minute mark does nothing', async () => {
    const { f, mgr, advance } = setup()
    await mgr.open()
    advance(10 * 60_000)
    expect(await mgr.tick()).toBe('skipped')
    expect(f.callsFor('PUT', '/fapi/v1/listenKey')).toHaveLength(0)
    advance(LISTEN_KEY_RENEW_AFTER_MS - 10 * 60_000)
    expect(await mgr.tick()).toBe('renewed')
    expect(f.callsFor('PUT', '/fapi/v1/listenKey')).toHaveLength(1)
    expect(f.callsFor('PUT', '/fapi/v1/listenKey')[0]!.signature).toBeNull()
    expect(mgr.state().renewals).toBe(1)
  })

  it('after a renewal the expiry moves to refreshedAt + 60 min', async () => {
    const { mgr, advance } = setup()
    await mgr.open()
    advance(26 * 60_000)
    await mgr.tick()
    expect(mgr.state().refreshedAt).toBe(NOW + 26 * 60_000)
    expect(mgr.state().expiresAt).toBe(NOW + 26 * 60_000 + LISTEN_KEY_TTL_MS)
    // 续期后 25 分钟内不再续
    advance(10 * 60_000)
    expect(await mgr.tick()).toBe('skipped')
  })

  it('close() DELETEs once (unsigned) and is idempotent', async () => {
    const { f, mgr } = setup()
    await mgr.open()
    await mgr.close()
    expect(f.callsFor('DELETE', '/fapi/v1/listenKey')).toHaveLength(1)
    expect(f.callsFor('DELETE', '/fapi/v1/listenKey')[0]!.signature).toBeNull()
    expect(f.callsFor('DELETE', '/fapi/v1/listenKey')[0]!.apiKey).toBe(API_KEY)
    expect(mgr.state().listenKey).toBeNull()
    expect(mgr.state().expiresAt).toBe(0)
    await mgr.close()
    expect(f.callsFor('DELETE', '/fapi/v1/listenKey')).toHaveLength(1)
  })

  it('opening twice closes the previous key first (no leaked keys)', async () => {
    const { f, mgr } = setup()
    await mgr.open()
    await mgr.open()
    expect(f.callsFor('DELETE', '/fapi/v1/listenKey')).toHaveLength(1)
    expect(f.callsFor('POST', '/fapi/v1/listenKey')).toHaveLength(2)
  })

  it('invalidate() (after listenKeyExpired) clears the key and keepAlive refuses', async () => {
    const { mgr } = setup()
    await mgr.open()
    mgr.invalidate()
    expect(mgr.state().listenKey).toBeNull()
    expect(await mgr.tick()).toBe('skipped')
    await expect(mgr.keepAlive()).rejects.toBeInstanceOf(ProblemError)
  })

  it('a failed open surfaces a redacted Problem', async () => {
    const { f, mgr } = setup()
    f.fail('POST', '/fapi/v1/listenKey', { code: -2015, msg: `Invalid API-key ${API_KEY}` }, 401)
    let caught: unknown
    try {
      await mgr.open()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProblemError)
    const problem = (caught as ProblemError).problem
    expect(problem.name).toBe('VENUE_AUTH')
    expect(problem.venue?.message).not.toContain(API_KEY)
  })
})

describe('user stream frames (injected socket factory)', () => {
  const makeSocket = (): { socket: SocketLike; closeCalls: () => number } => {
    let closes = 0
    const socket: SocketLike = {
      onmessage: null,
      onerror: null,
      onclose: null,
      close: () => { closes += 1 },
    }
    return { socket, closeCalls: () => closes }
  }

  it('parses ORDER_TRADE_UPDATE frames and forwards them', () => {
    const { socket } = makeSocket()
    const events: BinanceUserEvent[] = []
    const handle = openUserStream({
      factory: () => socket,
      url: userStreamUrl('testnet', 'k1'),
      onEvent: (e) => events.push(e),
    })
    expect(handle.url).toBe(`${USER_STREAM_BASE.testnet}/ws/k1`)
    socket.onmessage!({
      data: JSON.stringify({ e: 'ORDER_TRADE_UPDATE', E: NOW, o: { s: 'BTCUSDT', i: 7, X: 'FILLED', S: 'BUY', l: '0.01', z: '0.01', ap: '100', T: NOW } }),
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'order', venueOrderId: '7', status: 'filled' })
  })

  it('unparseable frames go to onError and do not throw', () => {
    const { socket } = makeSocket()
    const errors: string[] = []
    openUserStream({ factory: () => socket, url: 'ws://x', onEvent: () => {}, onError: (m) => errors.push(m) })
    socket.onmessage!({ data: 'not json' })
    expect(errors).toEqual(['unparseable user stream frame'])
  })

  it('listenKeyExpired closes the handle state', () => {
    const { socket, closeCalls } = makeSocket()
    const events: BinanceUserEvent[] = []
    const handle = openUserStream({ factory: () => socket, url: 'ws://x', onEvent: (e) => events.push(e) })
    socket.onmessage!({ data: JSON.stringify({ e: 'listenKeyExpired', E: NOW }) })
    expect(events[0]!.kind).toBe('listenKeyExpired')
    expect(handle.state()).toBe('closed')
    handle.close()
    expect(closeCalls()).toBe(0)
  })

  it('close() closes the socket exactly once', () => {
    const { socket, closeCalls } = makeSocket()
    const handle = openUserStream({ factory: () => socket, url: 'ws://x', onEvent: () => {} })
    handle.close()
    handle.close()
    expect(closeCalls()).toBe(1)
    expect(handle.state()).toBe('closed')
  })

  it('userStreamUrl uses the right host per environment', () => {
    expect(userStreamUrl('mainnet', 'abc')).toBe('wss://fstream.binance.com/ws/abc')
    expect(userStreamUrl('testnet', 'abc')).toBe('wss://stream.binancefuture.com/ws/abc')
  })
})
