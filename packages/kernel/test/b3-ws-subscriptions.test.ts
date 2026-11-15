// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { makeHarness } from './helpers/harness'

type RpcResult = { id?: number; result?: { subscriptionId?: string }; error?: { data?: { name?: string; message?: string } } }

async function connect(endpoint: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const auth = await call(ws, 1, 'auth', { token })
  expect(auth.result).toEqual({ ok: true, user: 'usr_local' })
  return ws
}

function call(ws: WebSocket, id: number, method: string, params: Record<string, unknown>): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('timed out waiting for JSON-RPC response')) }, 5_000)
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as RpcResult
      if (message.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

async function waitForSubscriberCount(h: Awaited<ReturnType<typeof makeHarness>>, count: number): Promise<void> {
  const deadline = Date.now() + 1_000
  while (h.k.events.subscriberCount !== count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(h.k.events.subscriberCount).toBe(count)
}

describe('WebSocket subscription limits', () => {
  let cleanup: (() => Promise<void>) | undefined
  afterEach(async () => { await cleanup?.(); cleanup = undefined })

  it('rejects the sixty-fifth subscription on one authenticated connection', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const ws = await connect(`ws://${host}:${address.port}/ui`, token)
    let firstSubscriptionId: string | undefined
    for (let id = 2; id <= 65; id++) {
      const result = await call(ws, id, 'subscribe', { topic: 'ledger.entry' })
      expect(result.error?.data?.name, `subscription attempt ${id - 1}`).toBeUndefined()
      if (id === 2) firstSubscriptionId = result.result?.subscriptionId
    }
    const sixtyFifth = await call(ws, 66, 'subscribe', { topic: 'ledger.entry' })
    expect(sixtyFifth.error?.data?.name).toBe('RATE_BUDGET')
    if (!firstSubscriptionId) throw new Error('first subscription id missing')
    expect((await call(ws, 67, 'unsubscribe', { subscriptionId: firstSubscriptionId })).result).toEqual({ ok: true })
    const afterRelease = await call(ws, 68, 'subscribe', { topic: 'ledger.entry' })
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close()
    await closed

    expect(afterRelease.result?.subscriptionId).toMatch(/^sub_/)
  })

  it('allows only one wildcard subscription until the first is removed', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const ws = await connect(`ws://${host}:${address.port}/ui`, token)
    const first = await call(ws, 2, 'subscribe', { topic: '*' })
    const second = await call(ws, 3, 'subscribe', { topic: '*' })
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close()
    await closed

    expect(first.result?.subscriptionId).toMatch(/^sub_/)
    expect(second.error?.data?.name).toBe('RATE_BUDGET')
  })

  it('releases capacity on unsubscribe and clears active subscriptions when the socket closes', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const ws = await connect(`ws://${host}:${address.port}/ui`, token)
    const baseline = h.k.events.subscriberCount

    const first = await call(ws, 2, 'subscribe', { topic: '*' })
    expect(first.result?.subscriptionId).toMatch(/^sub_/)
    expect(h.k.events.subscriberCount).toBe(baseline + 1)
    const rejected = await call(ws, 3, 'subscribe', { topic: '*' })
    expect(rejected.error?.data?.name).toBe('RATE_BUDGET')
    expect(h.k.events.subscriberCount).toBe(baseline + 1)

    const unsubscribed = await call(ws, 4, 'unsubscribe', { subscriptionId: first.result?.subscriptionId })
    expect(unsubscribed.result).toEqual({ ok: true })
    expect(h.k.events.subscriberCount).toBe(baseline)
    const second = await call(ws, 5, 'subscribe', { topic: '*' })
    expect(second.result?.subscriptionId).toMatch(/^sub_/)
    expect(h.k.events.subscriberCount).toBe(baseline + 1)

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close()
    await closed
    await waitForSubscriberCount(h, baseline)
  })

  it('keeps separate subscriptions to the same ordinary topic', async () => {
    const h = await makeHarness()
    cleanup = h.cleanup
    const started = await h.k.start({ port: 0 })
    const token = h.k.auth.exchangeBoot(started.bootToken).sessionToken
    const address = h.k.http?.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const ws = await connect(`ws://${host}:${address.port}/ui`, token)
    const baseline = h.k.events.subscriberCount
    const first = await call(ws, 2, 'subscribe', { topic: 'ledger.entry' })
    const second = await call(ws, 3, 'subscribe', { topic: 'ledger.entry' })
    expect(first.result?.subscriptionId).toMatch(/^sub_/)
    expect(second.result?.subscriptionId).toMatch(/^sub_/)
    expect(second.result?.subscriptionId).not.toBe(first.result?.subscriptionId)
    expect(h.k.events.subscriberCount).toBe(baseline + 2)
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    ws.close()
    await closed
    await waitForSubscriberCount(h, baseline)
  })
})
