// SPDX-License-Identifier: CPAL-1.0
// R1-PERF-06：本机内核连接复用（keep-alive）+ 关 Nagle，失败语义（notSent / outcomeUnknown / timedOut）不变，fetch 注入点仍然有效。
import { createServer } from 'node:http'
import type { Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelClient } from '../src/client'
import { kernelFetch } from '../src/local-fetch'

const TOKEN = `gtk_${'A'.repeat(52)}`
const servers: HttpServer[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

interface Kernel { url: string; srv: HttpServer; connections: () => number }
async function startKernel(handler: (res: ServerResponse, op: string) => void): Promise<Kernel> {
  let connections = 0
  const srv = createServer((req, res) => {
    req.resume()
    req.on('end', () => handler(res, (req.url ?? '').replace('/api/op/', '')))
  })
  srv.on('connection', () => { connections++ })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, srv, connections: () => connections }
}
const ok = (res: ServerResponse, result: unknown = { n: 1 }): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })) }
const client = (baseUrl: string): KernelClient => new KernelClient({ baseUrl, token: TOKEN })

describe('R1-PERF-06 本机内核连接复用', () => {
  it('串行多次调用只建一条连接（keep-alive），结果照常解析', async () => {
    const k = await startKernel((res) => ok(res))
    const c = client(k.url)
    for (let i = 0; i < 6; i++) expect(await c.call('risk.state', {})).toEqual({ ok: true, result: { n: 1 } })
    expect(k.connections()).toBe(1)
  })

  it('请求头与请求体同一次写出（content-length 齐全，内核读到完整 JSON）', async () => {
    let seen = ''
    const k = await startKernel((res) => ok(res))
    k.srv.removeAllListeners('request')
    k.srv.on('request', (req, res) => {
      let raw = ''
      req.on('data', (d) => { raw += String(d) })
      req.on('end', () => { seen = `${req.headers.authorization}|${req.headers['content-length']}|${raw}`; ok(res) })
    })
    await client(k.url).call('x', { a: 1 })
    expect(seen).toBe(`Bearer ${TOKEN}|${Buffer.byteLength('{"params":{"a":1}}')}|{"params":{"a":1}}`)
  })

  it('对端把空闲连接关掉之后，下一次调用换新连接照样成功', async () => {
    const k = await startKernel((res) => ok(res))
    const c = client(k.url)
    expect((await c.call('a', {})).ok).toBe(true)
    k.srv.closeAllConnections()
    await new Promise((r) => setTimeout(r, 100))
    expect((await c.call('b', {})).ok).toBe(true)
    expect(k.connections()).toBe(2)
  })

  it('拒连 → notSent（可原样重试）', async () => {
    const k = await startKernel((res) => ok(res))
    const url = k.url
    k.srv.close()
    const r = await client(url).call('a', {})
    expect(r).toMatchObject({ ok: false, notSent: true })
    expect(r.ok === false && r.outcomeUnknown).toBeUndefined()
  })

  it('收到请求后不回应 → 超时：timedOut + outcomeUnknown', async () => {
    const k = await startKernel(() => { /* 不回应 */ })
    const r = await client(k.url).call('a', {}, { timeoutMs: 150 })
    expect(r).toMatchObject({ ok: false, timedOut: true, outcomeUnknown: true })
  })

  it('响应体读到一半断开 → outcomeUnknown，状态码保留，不当成未发出', async () => {
    const k = await startKernel((res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' })
      res.write('{"ok":true,"result":')
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const r = await client(k.url).call('a', {})
    expect(r).toMatchObject({ ok: false, status: 200, outcomeUnknown: true })
    expect(r.ok === false && r.error.message).toContain('reading the reply')
    expect(r.ok === false && r.notSent).toBeUndefined()
  })

  it('读响应体时超时仍报 timedOut（不变成连接断开）', async () => {
    const k = await startKernel((res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' })
      res.write('{"ok":true,')
    })
    const r = await client(k.url).call('a', {}, { timeoutMs: 200 })
    expect(r).toMatchObject({ ok: false, status: 200, timedOut: true, outcomeUnknown: true })
  })

  it('注入的 fetch 优先；全局 fetch 被替换时 kernelFetch 也尊重替换', async () => {
    const injected = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: 'inj' })))
    const c = new KernelClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, fetch: injected as never })
    expect(await c.call('a', {})).toEqual({ ok: true, result: 'inj' })
    expect(injected).toHaveBeenCalledTimes(1)
    const stub = vi.fn(async () => new Response('stubbed'))
    vi.stubGlobal('fetch', stub)
    expect(await (await kernelFetch('http://127.0.0.1:1/x', { method: 'POST', body: '{}' })).text()).toBe('stubbed')
    expect(stub).toHaveBeenCalledTimes(1)
  })
})
