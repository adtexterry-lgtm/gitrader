// SPDX-License-Identifier: Apache-2.0
// 假内核（仅测试 / 夹具用，Node 专用，不进浏览器包）：说 client.ts 里约定的 WS 线格式，外加一个会话换票端点与静态文件服务。
// 真内核（packages/kernel）落地后，壳的冒烟脚本改连真内核；这里只用来在没有内核时跑通客户端、桥与壳。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export interface FakeKernelOptions {
  port?: number
  /** 一次性引导令牌；缺省随机。 */
  bootstrapToken?: string
  /** 静态文件目录（壳的 dist）；`/` 返回 index.html 并注入引导令牌 meta。 */
  staticDir?: string
  /** WS 鉴权失败时的行为测试：设为 false 则永远拒绝。 */
  acceptAuth?: boolean
  /** true：每次请求 index.html 都注入一枚新的引导令牌（体检 / 手工看壳用）；缺省 false = 和真内核一样，只有带 ?launch=<有效令牌> 才注入。 */
  injectAlways?: boolean
  /** GET /api/session/relink 的行为：'bootstrap' 回 {bootstrap}；'session' 直接回 {sessionToken,user}；缺省 404（和还没实现该接口的内核一样）。 */
  relink?: 'bootstrap' | 'session'
  /** 额外路由：返回 true 表示已处理（例如服务插件目录）。 */
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean
  /** 静态响应的 CSP；缺省与真内核一致（script-src 'self'，不允许内联脚本），让壳在测试里就撞上同样的限制。 */
  csp?: string | false
}

type Rpc = { id?: number; method?: string; params?: Record<string, unknown> }
type Sub = { ws: WebSocket; id: string; topic: string; filter?: unknown; maxHz?: number; fromSeq?: number }

export interface FakeKernel {
  port: number
  url: string
  wsUrl: string
  bootstrapToken: string
  sessionToken: string | null
  /** 运行时可改的行为开关（测试里切换 injectAlways / relink）。 */
  readonly options: { injectAlways: boolean; relink: 'bootstrap' | 'session' | undefined }
  /** 铸一枚一次性启动令牌并返回带它的页面地址（对应 `gitrader serve` / `gitrader open --print` 打印的链接）。 */
  launchUrl(): string
  /** 已建立的 WS 连接数（含未鉴权）。 */
  connections(): number
  /** 当前订阅（topic → 数量）。 */
  subscriptions(): Array<{ topic: string; filter?: unknown; maxHz?: number; fromSeq?: number }>
  /** 记录：收到的命令与查询。 */
  readonly commands: Array<{ action: string; params: unknown; origin?: unknown; attestation?: unknown }>
  readonly queries: Array<{ method: string; params: unknown }>
  onQuery(method: string, fn: (params: unknown) => unknown | Promise<unknown>): void
  onCommand(action: string, fn: (params: unknown, ctx: { origin?: unknown; attestation?: unknown }) => unknown | Promise<unknown>): void
  /** 向订阅了 topic 的连接推一条事件。 */
  publish(topic: string, data: unknown, seq?: number): number
  /** 主动断开所有 WS（测试重连）。 */
  dropConnections(): void
  close(): Promise<void>
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.woff2': 'font/woff2' }

const rid = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)

export async function startFakeKernel(opts: FakeKernelOptions = {}): Promise<FakeKernel> {
  const cfg: FakeKernel['options'] = { injectAlways: opts.injectAlways ?? false, relink: opts.relink }
  const bootstrapToken = opts.bootstrapToken ?? rid()
  // 每次加载页面都发一枚新的一次性引导令牌；换票即作废。会话令牌可以有多个（弹出窗不另换，但测试可能重载页面）。
  const validBootstrap = new Set<string>([bootstrapToken])
  const sessions = new Set<string>()
  const kernel = { sessionToken: null as string | null }
  const queryFns = new Map<string, (p: unknown) => unknown | Promise<unknown>>()
  const commandFns = new Map<string, (p: unknown, c: { origin?: unknown; attestation?: unknown }) => unknown | Promise<unknown>>()
  const commands: FakeKernel['commands'] = []
  const queries: FakeKernel['queries'] = []
  const subs = new Set<Sub>()
  const sockets = new Set<WebSocket>()
  let subSeq = 0

  const startedAt = Date.now()
  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      // 免令牌存活探针（与真内核 /api/health 同形状的最小子集）：壳按 startedAt 判断内核是否重启过
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, name: 'gitrader', startedAt }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        let body = ''
        for await (const c of req) body += c
        let parsed: { bootstrap?: string } = {}
        try { parsed = JSON.parse(body) } catch { /* 空 */ }
        if (!parsed.bootstrap || !validBootstrap.has(parsed.bootstrap)) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 5003, name: 'AUTH_FAILED', message: '引导令牌无效或已使用' } }))
          return
        }
        validBootstrap.delete(parsed.bootstrap)
        kernel.sessionToken = rid()
        sessions.add(kernel.sessionToken)
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ sessionToken: kernel.sessionToken, user: 'usr_local', ws: '/ui' }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/session/relink') {
        if (!cfg.relink) { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { name: 'METHOD_NOT_FOUND', message: 'not found' } })); return }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        if (cfg.relink === 'session') { const t = rid(); sessions.add(t); kernel.sessionToken = t; res.end(JSON.stringify({ sessionToken: t, user: 'usr_local' })) } else { const f = rid(); validBootstrap.add(f); res.end(JSON.stringify({ bootstrap: f })) }
        return
      }
      if (opts.extraRoutes && (await opts.extraRoutes(req, res, url))) return
      if (!opts.staticDir) { res.writeHead(404).end(); return }
      let rel = decodeURIComponent(url.pathname)
      if (rel === '/') rel = '/index.html'
      const file = normalize(join(resolve(opts.staticDir), rel))
      if (!file.startsWith(resolve(opts.staticDir))) { res.writeHead(403).end(); return }
      try {
        await stat(file)
        let buf: Buffer | string = await readFile(file)
        if (rel === '/index.html') {
          // 服务端注入一次性引导令牌（页面加载时换会话令牌）。
          const launch = url.searchParams.get('launch')
          let tok: string | null = null
          if (cfg.injectAlways) { tok = rid(); validBootstrap.add(tok) } else if (launch && validBootstrap.has(launch)) tok = launch
          buf = buf.toString('utf8').replace('<!--BOOTSTRAP-->', tok ? `<meta name="gitrader-bootstrap" content="${tok}">` : '')
        }
        const csp = opts.csp === false ? undefined : (opts.csp ?? `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${(http.address() as AddressInfo).port}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...(csp ? { 'content-security-policy': csp } : {}) })
        res.end(buf)
      } catch { res.writeHead(404).end() }
    })()
  })

  const wss = new WebSocketServer({ server: http, path: '/ui' })
  wss.on('connection', (ws) => {
    sockets.add(ws)
    let authed = false
    const send = (o: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)) }
    ws.on('close', () => { sockets.delete(ws); for (const s of [...subs]) if (s.ws === ws) subs.delete(s) })
    ws.on('message', (raw) => {
      void (async () => {
        let m: Rpc
        try { m = JSON.parse(String(raw)) as Rpc } catch { return }
        const reply = (result: unknown) => send({ jsonrpc: '2.0', id: m.id, result })
        const fail = (code: number, message: string, data?: unknown) => send({ jsonrpc: '2.0', id: m.id, error: { code, message, data } })
        if (m.method === 'auth') {
          const tok = (m.params as { token?: string } | undefined)?.token
          if (opts.acceptAuth === false || !tok || !sessions.has(tok)) { fail(5003, '会话令牌无效', { code: 5003, name: 'AUTH_FAILED', category: 'PROTOCOL', message: '会话令牌无效', retryable: false }); return }
          authed = true
          reply({ ok: true, user: 'usr_local' })
          return
        }
        if (!authed) { fail(5003, '未鉴权', { name: 'AUTH_FAILED' }); return }
        const p = m.params ?? {}
        switch (m.method) {
          case 'subscribe': {
            const id = `sub_${++subSeq}`
            subs.add({ ws, id, topic: String(p.topic), filter: p.filter, maxHz: p.maxHz as number | undefined, fromSeq: p.fromSeq as number | undefined })
            reply({ subscriptionId: id })
            return
          }
          case 'unsubscribe':
            for (const s of [...subs]) if (s.id === p.subscriptionId) subs.delete(s)
            reply({ ok: true })
            return
          case 'query': {
            const name = String(p.method)
            queries.push({ method: name, params: p.params })
            const fn = queryFns.get(name)
            if (!fn) { fail(-32601, `未知查询 ${name}`, { name: 'METHOD_NOT_FOUND' }); return }
            try { reply(await fn(p.params)) } catch (e) { const er = e as { code?: number; message?: string; data?: unknown }; fail(er.code ?? -32603, er.message ?? String(e), er.data) }
            return
          }
          case 'command': {
            const name = String(p.action)
            commands.push({ action: name, params: p.params, origin: p.origin, attestation: p.attestation })
            const fn = commandFns.get(name)
            if (!fn) { fail(-32601, `未知命令 ${name}`, { name: 'METHOD_NOT_FOUND' }); return }
            try { reply(await fn(p.params, { origin: p.origin, attestation: p.attestation })) } catch (e) { const er = e as { code?: number; message?: string; data?: unknown }; fail(er.code ?? -32603, er.message ?? String(e), er.data) }
            return
          }
          default: fail(-32601, `未知方法 ${String(m.method)}`, { name: 'METHOD_NOT_FOUND' })
        }
      })()
    })
  })

  await new Promise<void>((r) => http.listen(opts.port ?? 0, '127.0.0.1', r))
  const port = (http.address() as AddressInfo).port
  let seq = 0
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ui`,
    bootstrapToken,
    options: cfg,
    launchUrl() { const t = rid(); validBootstrap.add(t); return `http://127.0.0.1:${port}/?launch=${t}` },
    get sessionToken() { return kernel.sessionToken },
    connections: () => sockets.size,
    subscriptions: () => [...subs].map((s) => ({ topic: s.topic, filter: s.filter, maxHz: s.maxHz, fromSeq: s.fromSeq })),
    commands,
    queries,
    onQuery: (m, fn) => { queryFns.set(m, fn) },
    onCommand: (a, fn) => { commandFns.set(a, fn) },
    publish(topic, data, s) {
      let n = 0
      const sq = s ?? ++seq
      for (const sub of subs) {
        const match = sub.topic === topic || (sub.topic.endsWith('.*') && topic.startsWith(sub.topic.slice(0, -1)))
        if (!match || sub.ws.readyState !== sub.ws.OPEN) continue
        sub.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { subscriptionId: sub.id, topic, events: [{ seq: sq, ts: Date.now(), data }] } }))
        n += 1
      }
      return n
    },
    dropConnections() { for (const ws of sockets) ws.terminate() },
    close: () => new Promise<void>((r) => { for (const ws of sockets) ws.terminate(); wss.close(() => http.close(() => r())) }),
  }
}

export { installViewFixtures } from './view-fixtures'
