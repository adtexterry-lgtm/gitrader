// SPDX-License-Identifier: CPAL-1.0
// 访问本机内核用的 fetch（R1-PERF-06）：Node 自带 fetch（undici）打本机内核每次约 15 ms 的固定地板（头与体分开写，撞上 Nagle + 延迟确认）；
// 换成 node:http 的 keep-alive 连接复用并关 Nagle 后约 2 ms。MCP 的 KernelClient 与 CLI 的 callOp / liveService 共用。
// 全局 fetch 被替换过（测试桩 / 宿主注入）或请求体不是字符串时，原样交给全局 fetch，注入点不变。
import { Agent, request } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

/** 空闲连接 4 s 就由我们先关（内核 Node 默认 keepAliveTimeout 是 5 s），不会拿到刚被对端关掉的旧连接去发请求。 */
const agent = new Agent({ keepAlive: true, timeout: 4_000, noDelay: true, maxSockets: 16, maxFreeSockets: 4 })
const nativeFetch = globalThis.fetch

function viaHttp(input: string | URL | Request, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let url: URL
    try { url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) } catch (e) { reject(e); return }
    const signal = init.signal ?? undefined
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError')); return }
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const body = typeof init.body === 'string' ? init.body : undefined
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    let incoming: IncomingMessage | undefined
    const req = request(url, { method: init.method ?? 'GET', headers, agent }, (res) => {
      incoming = res
      const status = res.statusCode ?? 0
      const h = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v)
      if (status === 204 || status === 205 || status === 304) { res.resume(); finish(); resolve(new Response(null, { status, headers: h })); return }
      res.once('end', finish)
      res.once('close', finish)
      resolve(new Response(Readable.toWeb(res) as ReadableStream, { status, statusText: res.statusMessage ?? '', headers: h }))
    })
    // 中止：请求阶段 → 请求以 reason 失败；响应读到一半 → 响应流以 reason 失败（超时仍报 TimeoutError，不变成连接断开）。
    // 请求结束后必须摘掉监听：连接已还给连接池，再 destroy 会误伤下一个借用它的请求。
    const onAbort = (): void => {
      const err = signal!.reason ?? new DOMException('This operation was aborted', 'AbortError')
      incoming?.destroy(err as Error)
      req.destroy(err as Error)
    }
    function finish(): void { signal?.removeEventListener('abort', onAbort) }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (e) => { finish(); reject(e) })
    req.once('socket', (s) => { s.setNoDelay(true) })
    req.end(body)
  })
}

export const kernelFetch: typeof fetch = ((input, init) =>
  globalThis.fetch !== nativeFetch || (init?.body !== undefined && typeof init.body !== 'string')
    ? globalThis.fetch(input, init)
    : viaHttp(input, init ?? {})) as typeof fetch
