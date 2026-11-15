// SPDX-License-Identifier: CPAL-1.0
// 本地 HTTP + WS 服务。只绑 127.0.0.1；全部接口鉴权（没有令牌就是没有身份）；Origin / Sec-Fetch-Site / Host 只用来额外拒绝。
// 端口默认从 47900 起探测，避开 8765/8188/9872/9222/8080/5198/4184/14609/47831。
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { UI_BOOTSTRAP_META, makeProblem } from '../proto'
import type { Kernel } from '../kernel'
import { DEFAULT_PORT_START, RESERVED_PORTS } from '../config'
import { errorBody, statusOf } from '../api/router'
import { KernelError, toProblem } from '../util/errors'
import { newRequestId } from '../util/ids'
import { attachWs } from './ws'
import { Metrics } from '../metrics'
import { assertSafeRelativePath, resolveConfinedPath } from '../util/confined-path'

export interface HttpHandle { port: number; server: Server; close(): Promise<void> }

const MAX_BODY = 1024 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Gitrader</title><body style="font:14px system-ui;background:#0A0A0B;color:#ddd;padding:2rem"><h1>Gitrader</h1><p>工作台界面没装上，本机接口在运行（WebSocket 在 <code>/ui</code>）。</p><p>拿登录链接：在终端运行 <code>gitrader open</code>。</p></body>`

/** 刷新页面后一次性启动令牌已作废：在引导页明确提示怎么拿新链接（会话在本标签页的 sessionStorage，顶条只在真失效时出现）。 */
export const RELINK_HINT = '<div id="gitrader-relink-hint" role="alert" style="position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:10px 16px;background:#1b1b1f;color:#f0f0f0;font:14px system-ui;border-bottom:1px solid #555">登录已过期。在终端运行 <code>gitrader open</code>（输入 PIN）会打印新链接，用它重新打开；如果 <code>gitrader serve</code> 开在前台窗口，也可以在那个窗口按 Enter。</div>'

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > MAX_BODY) throw new KernelError(makeProblem('PAYLOAD_TOO_LARGE', 'request body exceeds 1 MiB'))
    chunks.push(c as Buffer)
  }
  if (n === 0) return undefined
  const ct = String(req.headers['content-type'] ?? '')
  if (!ct.toLowerCase().startsWith('application/json')) throw new KernelError(makeProblem('INVALID_REQUEST', 'content-type must be application/json'))
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new KernelError(makeProblem('PARSE_ERROR', 'invalid JSON body')) }
}

export async function startHttp(kernel: Kernel, o: { port?: number; host?: string; staticDir?: string }): Promise<HttpHandle> {
  const metrics = new Metrics({ events: kernel.events, status: () => kernel.status() })
  let boundPort = 0
  /** 允许嵌入的上层页面源；空 = 'none'。 */
  const embedOrigins = (): string[] => kernel.config.embed?.allowedOrigins ?? []
  const frameAncestors = (): string => (embedOrigins().length ? embedOrigins().join(' ') : "'none'")
  const csp = () => `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${boundPort} ws://localhost:${boundPort}; frame-ancestors ${frameAncestors()}; base-uri 'none'; form-action 'none'`

  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, errorBody(new KernelError(makeProblem('INVALID_REQUEST', 'method not allowed'))))
    const root = o.staticDir ? resolve(o.staticDir) : undefined
    let file = root ? normalize(join(root, pathname === '/' ? 'index.html' : pathname)) : undefined
    if (root && file && !(file === root || file.startsWith(root + sep))) return send(res, 403, errorBody(new KernelError(makeProblem('INVALID_REQUEST', 'path escapes the static root'))))
    if (root && file && !(existsSync(file) && statSync(file).isFile())) file = pathname.includes('.') ? undefined : join(root, 'index.html') // SPA 回退
    if (!root || !file || !existsSync(file)) {
      if (pathname === '/' || !root) return send(res, 200, PLACEHOLDER, { 'content-security-policy': csp() })
      return send(res, 404, errorBody(new KernelError(makeProblem('METHOD_NOT_FOUND', 'not found'))))
    }
    let body: Buffer | string = readFileSync(file)
    const ext = extname(file).toLowerCase()
    if (ext === '.html') {
      // 引导令牌：只在请求带着有效的一次性启动令牌（?launch=，由 `gitrader serve` 打印 / 嵌入方进程内铸造）时才注入 index.html。
      // 没有它的本机其他进程拿到的是不含令牌的页面——伪造任何头都换不到会话（契约 §5.1 T-B）。
      const launch = new URL(req.url ?? '/', 'http://x').searchParams.get('launch')
      if (launch && kernel.auth.peekBoot(launch)) body = body.toString('utf8').replace('</head>', `<meta name="${UI_BOOTSTRAP_META}" content="${launch.replace(/[^\w-]/g, '')}"></head>`)
      else {
        // 没有有效的启动令牌（刷新过 / 令牌用过 / 过期）：不注入令牌，页面顶部明确提示怎么拿新链接
        const html = body.toString('utf8')
        body = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => `${m}${RELINK_HINT}`) : html + RELINK_HINT
      }
    }
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': csp(), 'referrer-policy': 'no-referrer' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /**
   * 插件静态文件（iframe 加载的入口与资源）：GET /plugins/<id>/<path>。只服务校验通过且声明了块的插件目录内的文件，不出目录、不给点文件。
   * 响应头 Access-Control-Allow-Origin: * ——沙箱 iframe（无 allow-same-origin）的模块脚本是 null 源的 CORS 请求；**只在这条路由上**，API 不带。
   * 这些是静态代码，不带任何会话；对 API 与 WS 的鉴权不受影响。
   */
  const servePlugin = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    const cors = { 'access-control-allow-origin': '*' }
    const nf = (): void => send(res, 404, errorBody(new KernelError(makeProblem('METHOD_NOT_FOUND', 'not found'))), cors)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, errorBody(new KernelError(makeProblem('INVALID_REQUEST', 'method not allowed'))), cors)
    let rel: string
    try { rel = decodeURIComponent(pathname.slice('/plugins/'.length)) } catch { return nf() }
    const slash = rel.indexOf('/')
    const id = slash < 0 ? rel : rel.slice(0, slash)
    const sub = slash < 0 ? '' : rel.slice(slash + 1)
    const rec = kernel.plugins.get(id)
    if (!rec || !rec.ok || !rec.blocks.length || !sub || sub.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return nf()
    let file: string
    try {
      const safeSub = assertSafeRelativePath(sub)
      file = resolveConfinedPath(rec.dir, safeSub, { mustExist: true })
    } catch { return nf() }
    if (!existsSync(file) || !statSync(file).isFile()) return nf()
    const ext = extname(file).toLowerCase()
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'", 'referrer-policy': 'no-referrer', ...cors })
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = newRequestId()
    try {
      // 嵌入：只有配置了 embed.allowedOrigins，且是“页面的 GET 导航进 iframe”（不是 /api、不是 WS），才放过跨站的 Sec-Fetch-Site；
      // 谁能嵌由浏览器按 CSP frame-ancestors 强制。API 与 WS 请求从 iframe 内发出时是同源的，照旧要令牌。
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const embedNav = embedOrigins().length > 0 && (req.method === 'GET' || req.method === 'HEAD') && !rawPath.startsWith('/api/') && req.headers['sec-fetch-dest'] === 'iframe' && req.headers['sec-fetch-mode'] === 'navigate'
      // 插件文件路由：沙箱 iframe 的子资源请求带 Origin: null / 跨站，只对这条 GET 静态路由放过 Origin 与 Sec-Fetch-Site（Host 仍校验，防 DNS 重绑）
      // 集成修补（H，v2）：壳给第三方块 iframe 的启动脚本 /block-boot.js 也是沙箱里的跨站子资源请求（公开静态文件，不含任何令牌），原来被 403，插件块永远空白
      const pluginFile = (req.method === 'GET' || req.method === 'HEAD') && (rawPath.startsWith('/plugins/') || rawPath === '/block-boot.js')
      const hdrs = embedNav || pluginFile ? Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'sec-fetch-site' && !(pluginFile && k === 'origin'))) : req.headers
      const hc = kernel.auth.checkHeaders(hdrs, boundPort)
      if (!hc.ok) return send(res, 403, errorBody(new KernelError(makeProblem('AUTH_FAILED', hc.reason))))
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`)
      const path = url.pathname
      if (path.startsWith('/plugins/')) return servePlugin(req, res, path)
      if (!path.startsWith('/api/')) return serveStatic(req, res, path)

      // 存活探针：免令牌（`gitrader serve` 的 liveService 与监控用；auth.test 契约：唯一免令牌的数据接口，不泄露 pid / 令牌）。
      // 放在主体鉴权之前是既有契约，带不带令牌都返回同一份健康 JSON；`ok` / `startedAt` 保留给 CLI 探测进程是否还是同一个服务。
      if (path === '/api/health' && req.method === 'GET') {
        const health = kernel.healthSnapshot()
        return send(res, 200, {
          status: health.degraded ? 'degraded' : 'ok', uptimeSec: health.uptimeMs / 1000, version: health.version, launcher: health.launcher, ts: Date.now(),
          ok: true, name: 'gitrader', startedAt: kernel.startedAt,
          stateFiles: health.stateFiles, warnings: health.warnings, ledgerVerify: health.ledgerVerify, paperState: health.paperState,
        })
      }

      // 刷新后重新拿会话的口子不存在（要新链接走 `gitrader open`）：明确 404，让壳回退到提示而不是弹 401 错误层
      if (path === '/api/session/relink') return send(res, 404, errorBody(new KernelError(makeProblem('METHOD_NOT_FOUND', '没有这个接口；拿新链接请运行 gitrader open'))))

      if (path === '/api/session' && req.method === 'POST') {
        // protocol ui/wire.ts：POST /api/session {bootstrap} → 200 {sessionToken, user, ws?}；失败 401 {error:{name:"AUTH_FAILED", message}}
        const body = (await readBody(req)) as { bootstrap?: string } | undefined
        try {
          const s = kernel.auth.exchangeBoot(String(body?.bootstrap ?? ''))
          return send(res, 200, { sessionToken: s.sessionToken, sessionId: s.sessionId, expiresAt: s.expiresAt, user: s.user })
        } catch (e) {
          return send(res, 401, { error: { name: 'AUTH_FAILED', message: toProblem(e).message } })
        }
      }

      const principal = kernel.auth.authenticate(req.headers.authorization)
      if (!principal) {
        const bearer = /^Bearer\s+(gtk_\S+)$/.exec(req.headers.authorization ?? '')?.[1]
        const why = bearer ? kernel.agents.tokenStatus(bearer) : 'unknown'
        const msg = why === 'revoked' ? 'KEY_REVOKED: this agent key was revoked by the user; the token is no longer valid. Ask the user to create a new key (gitrader keys new agent ...)'
          : why === 'expired' ? 'KEY_EXPIRED: this agent key has expired. Ask the user to create or renew a key'
          : 'authentication required: Authorization: Bearer <token>'
        return send(res, 401, errorBody(new KernelError(makeProblem('AUTH_FAILED', msg))), { 'www-authenticate': 'Bearer' })
      }
      if (path === '/api/metrics' && req.method === 'GET') {
        kernel.consumeOperationRate(principal, 'http:metrics')
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(metrics.render())
        return
      }

      // 就绪探针：主体鉴权后，组件就绪才 200，否则 503；交易状态只上报，HALTED 本身不算不就绪。
      // Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/openapi/routes/health.py:50-123; adapted.
      if (path === '/api/ready' && req.method === 'GET') {
        kernel.consumeOperationRate(principal, 'http:ready')
        let status: Record<string, unknown> | null = null
        try { status = kernel.status() } catch { status = null }
        const kernelOk = status !== null && typeof status.version === 'string'
        const ledger = status?.ledger as { seq?: unknown; hash?: unknown; count?: unknown } | undefined
        const ledgerOk = !!ledger && typeof ledger.seq === 'number' && typeof ledger.hash === 'string' && typeof ledger.count === 'number'
        const tradingState = typeof status?.tradingState === 'string' ? status.tradingState : 'unknown'
        const ready = kernelOk && ledgerOk
        return send(res, ready ? 200 : 503, { ready, components: { kernel: kernelOk, ledger: ledgerOk, tradingState, halted: tradingState === 'HALTED' } })
      }
      const pin = typeof req.headers['x-gitrader-pin'] === 'string' ? (req.headers['x-gitrader-pin'] as string) : undefined

      const op = /^\/api\/op\/([A-Za-z0-9_.-]+)$/.exec(path)
      if (op) {
        if (req.method !== 'POST') return send(res, 405, errorBody(new KernelError(makeProblem('INVALID_REQUEST', 'operations are POST-only'))))
        const body = (await readBody(req)) as { params?: Record<string, unknown> } | undefined
        const result = await kernel.ops.call(kernel, op[1] as string, { principal, params: body?.params ?? {}, ...(pin ? { pin } : {}), transport: 'http', requestId })
        return send(res, 200, { ok: true, result })
      }

      const m = kernel.routes.match(req.method ?? 'GET', path)
      if (!m) return send(res, 404, errorBody(new KernelError(makeProblem('METHOD_NOT_FOUND', `no route ${req.method} ${path}`))))
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
      // 原始路由：同样走 ops 的鉴权与盖章，借一个临时操作名
      const ctx = await kernel.ops.prepare(kernel, `route:${req.method} ${path}`, m.route.spec, { principal, params: body, ...(pin ? { pin } : {}), transport: 'http', requestId })
      const rr = await m.route.handler({ method: req.method ?? 'GET', path, params: m.params, query: Object.fromEntries(url.searchParams), body, headers: req.headers }, ctx)
      return send(res, rr.status ?? 200, rr.body, rr.headers ?? {})
    } catch (e) {
      const p = toProblem(e)
      // ADR-27：过载保护抛的 BUSY 是“稍后再试”而不是上游场所故障 → 503 + Retry-After（秒，至少 1）
      send(res, p.name === 'BUSY' ? 503 : statusOf(p.code), { ok: false, error: p }, p.retryAfterMs ? { 'retry-after': String(Math.max(1, Math.ceil(p.retryAfterMs / 1000))) } : {})
    }
  }

  const server = createServer((req, res) => { void handle(req, res) })
  const wsHandle = attachWs(kernel, server, () => boundPort)

  const tryListen = (port: number): Promise<boolean> => new Promise((resolve_, reject) => {
    const onErr = (e: NodeJS.ErrnoException): void => { server.off('listening', onOk); if (e.code === 'EADDRINUSE' || e.code === 'EACCES') resolve_(false); else reject(e) }
    const onOk = (): void => { server.off('error', onErr); resolve_(true) }
    server.once('error', onErr)
    server.once('listening', onOk)
    server.listen(port, o.host ?? '127.0.0.1')
  })

  if (o.port !== undefined) {
    if (!(await tryListen(o.port))) throw new KernelError(makeProblem('VENUE_UNAVAILABLE', `port ${o.port} is not available（端口被占用：换一个 --port，或不写 --port 让它自动选端口）`))
  } else {
    let ok = false
    for (let p = DEFAULT_PORT_START; p < DEFAULT_PORT_START + 100 && !ok; p++) {
      if ((RESERVED_PORTS as readonly number[]).includes(p)) continue
      ok = await tryListen(p)
    }
    if (!ok) throw new KernelError(makeProblem('VENUE_UNAVAILABLE', `no free port in ${DEFAULT_PORT_START}-${DEFAULT_PORT_START + 99}`))
  }
  boundPort = (server.address() as { port: number }).port
  return {
    port: boundPort, server,
    close: () => new Promise<void>((r) => { wsHandle.close(); server.closeAllConnections?.(); server.close(() => r()) }),
  }
}
