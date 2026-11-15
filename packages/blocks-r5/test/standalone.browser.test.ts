// SPDX-License-Identifier: CPAL-1.0
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { build } from 'esbuild'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const stageLibSpecifier = new URL('../../../scripts/verify/stage-lib.mjs', import.meta.url).href
const importedStageLib: unknown = await import(stageLibSpecifier)
type StageLibExports = {
  root: string
  RESERVED: number[]
  bundleHost(directory: string): Promise<unknown>
}
function isStageLibExports(value: unknown): value is StageLibExports {
  if (!value || typeof value !== 'object') return false
  const exports = value as Record<string, unknown>
  return typeof exports.root === 'string'
    && Array.isArray(exports.RESERVED)
    && exports.RESERVED.every((port: unknown) => typeof port === 'number')
    && typeof exports.bundleHost === 'function'
}
if (!isStageLibExports(importedStageLib)) throw new Error('stage library exports unavailable')
const root = importedStageLib.root
const RESERVED = importedStageLib.RESERVED
const bundleHost = async (directory: string): Promise<string> => {
  const result: unknown = await importedStageLib.bundleHost(directory)
  if (typeof result !== 'string') throw new Error('stage bundle path unavailable')
  return result
}

type SafeEvidence = {
  phase: string
  status: 'PASS' | 'FAIL' | 'NOT RUN'
  errorType: string | null
  route: string | null
  blockCfg: Record<string, unknown> | null
  dom: Record<string, boolean | number | string | null>
  counts: Record<string, number>
  elapsedMs: number | null
  secretChecks: Record<string, boolean>
}

type AuditEvent = { event: string; pid?: number | null; profileTag?: string; homeTag?: string; ready?: boolean; exited?: boolean; handleState?: 'alive' | 'exited' | 'unknown'; pidState?: 'alive' | 'exited' | 'unknown'; profileRemoved?: boolean; details?: Record<string, string | number | boolean | null> }
type OwnedProcess = {
  resource: 'browser' | 'stage' | 'mcp'
  child: ReturnType<typeof spawn>
  profile?: string
  profileRemoved?: boolean
  stop: () => Promise<void>
  stopCalled: boolean
  handleState: 'NOT CHECKED' | 'alive' | 'exited'
  pidState: 'NOT CHECKED' | 'alive' | 'exited' | 'unknown'
  cleanupVerified: boolean
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

// 缺省自建系统临时 home（afterAll 清掉）；显式给了 GITRADER_HOME 才校验它是现成目录。
let ownedTempHome: string | null = null
export function approvedTestHome() {
  const raw = process.env.GITRADER_HOME ?? ''
  if (!raw) {
    ownedTempHome = mkdtempSync(join(tmpdir(), 'gitrader-s1-'))
    console.log('S1_HOME_VALID=true (temp)')
    return resolve(ownedTempHome)
  }
  let valid = false
  try { valid = existsSync(raw) && statSync(raw).isDirectory() } catch { /* invalid home */ }
  console.log(`S1_HOME_VALID=${valid}`)
  if (!valid) throw new Error('S1 test home invalid')
  return resolve(raw)
}

export function requiredTestAlias() {
  const alias = process.env.GITRADER_S1_CROSS_SITE_ALIAS || 's1-host.test'
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.test$/i.test(alias)) throw new Error('cross-site test alias invalid')
  return alias
}

export function sameSecret(actual: unknown, expected: unknown) {
  return typeof actual === 'string' && typeof expected === 'string' && actual === expected
}

export function safeEvidence(input: Partial<SafeEvidence>): SafeEvidence {
  return {
    phase: typeof input.phase === 'string' ? input.phase : 'preflight',
    status: input.status === 'PASS' || input.status === 'FAIL' ? input.status : 'NOT RUN',
    errorType: typeof input.errorType === 'string' ? input.errorType : null,
    route: typeof input.route === 'string' ? input.route : null,
    blockCfg: input.blockCfg && typeof input.blockCfg === 'object' ? input.blockCfg : null,
    dom: input.dom && typeof input.dom === 'object' ? input.dom : {},
    counts: input.counts && typeof input.counts === 'object' ? input.counts : {},
    elapsedMs: typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) ? input.elapsedMs : null,
    secretChecks: input.secretChecks && typeof input.secretChecks === 'object' ? input.secretChecks : {},
  }
}

export function ownedWorkArea(home: string) {
  const resolvedHome = resolve(home)
  const rootDir = mkdtempSync(join(resolvedHome, 's1-standalone-'))
  if (!isStrictChild(resolvedHome, rootDir)) throw new Error('test work area escaped home')
  const artifactDir = join(rootDir, 'artifacts')
  mkdirSync(artifactDir)
  return { rootDir, artifactDir }
}

function isStrictChild(parent: string, candidate: string) {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function until<T>(fn: () => T | Promise<T>, ms = 15000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  lastWaitLabel = /^[A-Za-z0-9 -]{1,100}$/.test(label) ? label : 'condition'
  while (Date.now() < end) {
    try { const found = await fn(); if (found) { lastWaitLabel = null; return found } } catch (error) { last = error }
    await pause(50)
  }
  const errorType = last instanceof Error ? last.name : ''
  throw new Error(`${label} timed out${errorType ? ` (${errorType})` : ''}`)
}

export class BrowserCdp {
  child: ReturnType<typeof spawn>
  profile: string
  rootDir: string
  socket: WebSocket
  audit: (event: AuditEvent) => void
  seq = 0
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  targets = new Map<string, any>()
  contexts = new Map<string, Map<number, any>>()
  authFrames: Array<{ sessionId: string; requestId: string; contextId: number | null; token: string }> = []
  wsFramesSent: Array<{ sessionId: string; payload: string; at: number }> = []
  wsFramesReceived: Array<{ sessionId: string; payload: string }> = []
  errorTypes: Array<{ sessionId: string; type: string }> = []
  localResourceStatus: Array<{ path: string; status: number }> = []
  wsOpened: Array<{ sessionId: string; requestId: string; contextId: number | null; url: string }> = []
  wsClosed: Array<{ sessionId: string; requestId: string }> = []
  destroyedContexts: Array<{ sessionId: string; contextId: number; source: 'destroyed' | 'cleared' | 'target-detached' }> = []
  listeners = new Map<string, Array<(params: any, sessionId?: string) => void>>()

  constructor(child: ReturnType<typeof spawn>, profile: string, rootDir: string, socket: WebSocket, audit: (event: AuditEvent) => void) {
    this.child = child; this.profile = profile; this.rootDir = rootDir; this.socket = socket; this.audit = audit
    socket.on('message', (raw) => this.onMessage(raw))
    socket.on('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP closed')) }
      this.pending.clear()
    })
  }

  static async launch(rootDir: string, loopback: string, hostAlias: string, audit: (event: AuditEvent) => void = () => {}) {
    const resolvedRoot = resolve(rootDir)
    const systemRoot = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles
    const edge = process.env.GITRADER_EDGE ?? (systemRoot ? join(systemRoot, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '')
    if (!edge || !existsSync(edge)) throw new Error('browser executable unavailable')
    const profile = mkdtempSync(join(resolvedRoot, 'cdp-profile-'))
    if (!resolve(profile).startsWith(resolvedRoot + sep)) throw new Error('browser profile escaped test root')
    const child = spawn(edge, [
      '--headless=new', '--lang=zh-CN', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-popup-blocking', '--window-size=1440,900', '--no-proxy-server', `--host-resolver-rules=MAP ${hostAlias} ${loopback}`,
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' })
    // Do not disable site isolation or storage partitioning; the host alias stays on the default browser path.
    let socket: WebSocket | undefined
    let ownedBrowser: BrowserCdp | undefined
    const owned = registerOwnedProcess('browser', child, async () => {
      if (ownedBrowser) { await ownedBrowser.close(); return }
      if (socket?.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} })) } catch { /* owned browser fallback */ }
        await pause(200)
      }
      await stopChildHandle(child)
      const exited = child.exitCode !== null || child.signalCode !== null
      const pidState = probePid(child.pid)
      if (exited && pidState === 'exited' && resolve(profile).startsWith(resolvedRoot + sep)) rmSync(profile, { recursive: true, force: true })
    }, profile)
    let spawnError = false
    child.on('error', () => { spawnError = true })
    try {
      audit({ event: 'browser-spawned', pid: child.pid ?? null, profileTag: basename(profile) })
      const portFile = join(profile, 'DevToolsActivePort')
      await until(() => {
        if (spawnError) throw new Error('browser spawn failed')
        if (child.exitCode !== null) throw new Error('browser exited during startup')
        return existsSync(portFile)
      }, 20000, 'browser port file')
      const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
      if (!Number.isInteger(port) || port < 1 || port > 65535 || RESERVED.includes(port)) throw new Error('browser debug port unavailable')
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('browser target unavailable')
      const info = await response.json() as { webSocketDebuggerUrl: string }
      socket = new WebSocket(info.webSocketDebuggerUrl)
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('browser websocket timeout')), 10000)
        socket!.once('open', () => { clearTimeout(timer); done() })
        socket!.once('error', () => { clearTimeout(timer); fail(new Error('browser websocket failed')) })
      })
      const cdp = new BrowserCdp(child, profile, resolvedRoot, socket, audit)
      ownedBrowser = cdp
      await cdp.send('Target.setDiscoverTargets', { discover: true })
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      return cdp
    } catch (error) {
      try { socket?.terminate() } catch { /* own socket */ }
      await owned.stop()
      const exited = child.exitCode !== null || child.signalCode !== null
      const pidState = probePid(child.pid)
      const verified = exited && pidState === 'exited'
      if (verified && resolve(profile).startsWith(resolvedRoot + sep)) rmSync(profile, { recursive: true, force: true })
      audit({ event: 'browser-launch-failed', pid: child.pid ?? null, profileTag: basename(profile), exited: verified,
        handleState: exited ? 'exited' : 'alive', pidState, profileRemoved: !existsSync(profile) })
      throw error instanceof Error ? new Error(`browser startup failed (${error.name})`) : new Error('browser startup failed')
    }
  }

  on(method: string, fn: (params: any, sessionId?: string) => void) {
    const list = this.listeners.get(method) ?? []
    list.push(fn); this.listeners.set(method, list)
  }

  onMessage(raw: WebSocket.RawData) {
    let message: any
    try { message = JSON.parse(String(raw)) } catch { return }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error('CDP command failed'))
      else pending.resolve(message.result ?? {})
      return
    }
    const { method, params = {}, sessionId } = message
    if (method === 'Target.attachedToTarget') {
      const target = { ...params.targetInfo, sessionId: params.sessionId, ready: false }
      this.targets.set(target.targetId, target)
      void this.initTarget(target, params.waitingForDebugger).catch(() => { target.failed = true })
    } else if (method === 'Target.targetInfoChanged') {
      const target = this.targets.get(params.targetInfo.targetId)
      if (target) Object.assign(target, params.targetInfo)
    } else if (method === 'Target.detachedFromTarget') {
      for (const [id, target] of this.targets) if (target.sessionId === params.sessionId) {
        for (const contextId of this.contexts.get(params.sessionId)?.keys() ?? []) this.destroyedContexts.push({ sessionId: params.sessionId, contextId, source: 'target-detached' })
        this.targets.delete(id)
      }
      this.contexts.delete(params.sessionId)
    } else if (method === 'Runtime.executionContextCreated') {
      const contexts = this.contexts.get(sessionId) ?? new Map()
      contexts.set(params.context.id, params.context); this.contexts.set(sessionId, contexts)
    } else if (method === 'Runtime.executionContextDestroyed') {
      this.destroyedContexts.push({ sessionId, contextId: params.executionContextId, source: 'destroyed' })
      this.contexts.get(sessionId)?.delete(params.executionContextId)
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const contextId of this.contexts.get(sessionId)?.keys() ?? []) this.destroyedContexts.push({ sessionId, contextId, source: 'cleared' })
      this.contexts.delete(sessionId)
    } else if (method === 'Network.webSocketCreated') {
      const contextId = [...(this.contexts.get(sessionId)?.values() ?? [])].find((context: any) => context.auxData?.isDefault === true)?.id ?? null
      this.wsOpened.push({ sessionId, requestId: params.requestId, contextId, url: params.url })
    } else if (method === 'Network.webSocketClosed') {
      this.wsClosed.push({ sessionId, requestId: params.requestId })
    } else if (method === 'Network.webSocketFrameSent') {
      const payload = params.response?.payloadData
      if (typeof payload === 'string') this.wsFramesSent.push({ sessionId, payload, at: Date.now() })
      try {
        const frame = JSON.parse(payload ?? '')
        if (frame.method === 'auth' && typeof frame.params?.token === 'string') {
          const contextId = [...(this.contexts.get(sessionId)?.values() ?? [])].find((context: any) => context.auxData?.isDefault === true)?.id ?? null
          this.authFrames.push({ sessionId, requestId: params.requestId, contextId, token: frame.params.token })
        }
      } catch { /* unrelated network frame */ }
    } else if (method === 'Network.webSocketFrameReceived') {
      const payload = params.response?.payloadData
      if (typeof payload === 'string') this.wsFramesReceived.push({ sessionId, payload })
    } else if (method === 'Runtime.exceptionThrown') {
      this.errorTypes.push({ sessionId, type: params.exceptionDetails?.exception?.className ?? 'Runtime.exceptionThrown' })
    } else if (method === 'Network.responseReceived') {
      try {
        const path = new URL(params.response?.url ?? '').pathname
        if (path === '/iframe' || path === '/sol-source.js') this.localResourceStatus.push({ path, status: params.response.status })
      } catch { /* unrelated resource */ }
    }
    for (const fn of this.listeners.get(method) ?? []) fn(params, sessionId)
  }

  async initTarget(target: any, waiting: boolean) {
    if (target.type === 'page' || target.type === 'iframe') {
      await this.send('Page.enable', {}, target.sessionId)
      await this.send('Runtime.enable', {}, target.sessionId)
      await this.send('Network.enable', {}, target.sessionId)
      if (target.type === 'page') {
        try { await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, target.sessionId) } catch { /* browser-level targets remain usable */ }
      }
    }
    if (waiting) await this.send('Runtime.runIfWaitingForDebugger', {}, target.sessionId)
    target.ready = true
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    return new Promise<any>((resolveReply, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) return reject(new Error('CDP websocket unavailable'))
      const id = ++this.seq
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP command timeout')) }, 20000)
      this.pending.set(id, { resolve: resolveReply, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error('CDP command send failed')) }
      })
    })
  }

  async createPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    const target = await until(() => { const found = this.targets.get(targetId); return found?.ready && found }, 15000, 'page target')
    await this.send('Page.navigate', { url }, target.sessionId)
    return target
  }

  contextFor(origin: string, excludedTargetIds = new Set<string>(), targetId?: string) {
    for (const target of this.targets.values()) {
      if (!target.ready || excludedTargetIds.has(target.targetId) || (targetId && target.targetId !== targetId)) continue
      const contexts = this.contexts.get(target.sessionId)
      for (const context of contexts?.values() ?? []) {
        if (context.origin === origin && context.auxData?.isDefault !== false) return { target, contextId: context.id }
      }
    }
    return null
  }

  async evaluate(where: { target: { sessionId: string }; contextId: number }, expression: string) {
    const reply = await this.send('Runtime.evaluate', { expression, contextId: where.contextId, awaitPromise: true, returnByValue: true, userGesture: true }, where.target.sessionId)
    if (reply.exceptionDetails) throw new Error('page evaluation failed')
    return reply.result?.value
  }

  async close() {
    try { await this.send('Browser.close') } catch { /* owned browser fallback */ }
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill()
      await Promise.race([new Promise((done) => this.child.once('exit', done)), pause(2000)])
    }
    const handleExited = this.child.exitCode !== null || this.child.signalCode !== null
    const pidResult = probePid(this.child.pid)
    const exited = handleExited && pidResult === 'exited'
    if (exited && resolve(this.profile).startsWith(this.rootDir + sep)) rmSync(this.profile, { recursive: true, force: true })
    const profileRemoved = !existsSync(this.profile)
    this.audit({ event: 'browser-closed', pid: this.child.pid ?? null, profileTag: basename(this.profile), exited,
      details: { handleState: handleExited ? 'exited' : 'alive', pidState: pidResult } })
    return { exited, profileRemoved, handleState: handleExited ? 'exited' : 'alive', pidState: pidResult }
  }
}

export function entryUrl(url: string, route: string) {
  const next = new URL(url)
  next.searchParams.set('ui', 'r5')
  next.hash = route
  return String(next)
}

export async function listenTestHost(loopback: string, alias: string, html: { value: string }) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html.value)
    })
    const port = await new Promise<number>((done, fail) => {
      server.once('error', (error) => fail(new Error(`host listener failed (${error.name})`)))
      server.listen(0, loopback, () => done((server.address() as import('node:net').AddressInfo).port))
    })
    if (!RESERVED.includes(port)) return { server, origin: `http://${alias}:${port}` }
    await new Promise<void>((done) => server.close(() => done()))
  }
  throw new Error('no permitted local host listener')
}

export function embeddedHostHtml(src: string, sandbox = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Standalone test host</title></head><body style="margin:0"><iframe id="s1-embed" ${sandbox ? 'sandbox="allow-scripts allow-same-origin"' : ''} src="${src}" style="border:0;width:100vw;height:100vh"></iframe></body></html>`
}

export async function prepareRealBundles(artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const stageFile = await bundleHost(artifactDir)
  const mcpFile = join(artifactDir, 'stage-mcp.mjs')
  const banner = "import { createRequire as __gtCreateRequire } from 'node:module'; const require = __gtCreateRequire(import.meta.url);"
  await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'packages', 'mcp', 'src', 'bin.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: mcpFile,
    banner: { js: banner }, external: ['node:*'], logLevel: 'error',
  })
  return { stageFile, mcpFile }
}

export async function startRealStage({ home, stageFile, audit }: {
  home: string; stageFile: string; audit: (event: AuditEvent) => void
}) {
  const child = spawn(process.execPath, [stageFile, home, join(root, 'fixtures', 'hl'), join(root, 'packages', 'workbench', 'dist'), '', '250'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GITRADER_HOME: home, GITRADER_STAGE_NO_ENGINE: '1', GITRADER_STAGE_FIXED_MARKET: '1' },
  })
  audit({ event: 'stage-spawned', pid: child.pid ?? null, homeTag: 'approved-s1-home' })
  let normalStop = async () => { await stopChildHandle(child) }
  const owned = registerOwnedProcess('stage', child, () => normalStop())
  let spawnError = false
  child.on('error', () => { spawnError = true })
  let stderrBytes = 0
  child.stderr.on('data', (data) => { stderrBytes += data.length })
  const lines: any[] = []
  const waiters = new Set<{ predicate: (value: any) => boolean; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let value: any
    try { value = JSON.parse(line) } catch { return }
    lines.push(value)
    for (const waiter of [...waiters]) if (waiter.predicate(value)) {
      waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(value)
    }
  })
  const next = (predicate: (value: any) => boolean, timeout = 20000) => new Promise<any>((resolveReply, reject) => {
    const found = lines.find(predicate)
    if (found) { resolveReply(found); return }
    const waiter = { predicate, resolve: resolveReply, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('stage response timeout')) }, timeout) }
    waiters.add(waiter)
  })
  let id = 0
  const call = async (cmd: string, code?: string, timeout?: number) => {
    lastStageFailure = null
    if (spawnError || child.exitCode !== null) throw new Error('stage process unavailable')
    const requestId = ++id
    const reply = next((value) => value.id === requestId, timeout)
    child.stdin.write(JSON.stringify({ id: requestId, cmd, ...(code ? { code } : {}) }) + '\n')
    const value = await reply
    if (value.error) {
      const safeError = typeof value.error === 'string' ? value.error : ''
      lastStageFailure = { errorType: safeErrorType(safeError), frame: safeFrameFromText(safeError) }
      throw new Error('stage request failed')
    }
    return value
  }
  normalStop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { await call('stop', undefined, 5000) } catch { /* owned child fallback */ }
      await waitChildExit(child, 2000)
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await waitChildExit(child, 2000)
    }
  }
  try {
    const ready = await next((value) => value.ready === true)
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('stage exited during startup')
    audit({ event: 'stage-ready', pid: child.pid ?? null, homeTag: 'approved-s1-home', ready: true })
    return {
      child, url: ready.url, stderrBytes: () => stderrBytes,
      boot: async () => (await call('boot')).url,
      run: async (code: string, timeout?: number) => (await call('run', code, timeout)).result,
      async close() {
        await owned.stop()
        const exited = child.exitCode !== null || child.signalCode !== null
        audit({ event: 'stage-closed', pid: child.pid ?? null, homeTag: 'approved-s1-home', exited })
        return exited
      },
    }
  } catch (error) {
    await owned.stop()
    audit({ event: 'stage-start-failed', pid: child.pid ?? null, homeTag: 'approved-s1-home', exited: child.exitCode !== null || child.signalCode !== null })
    throw error instanceof Error ? new Error(`stage startup failed (${error.name})`) : new Error('stage startup failed')
  }
}

export async function connectSameStageMcp({ home, mcpFile, agentToken, audit }: {
  home: string; mcpFile: string; agentToken: string; audit: (event: AuditEvent) => void
}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [mcpFile],
    env: { GITRADER_HOME: home, GITRADER_AGENT_TOKEN: agentToken }, stderr: 'pipe',
  })
  const start = transport.start.bind(transport)
  const client = new Client({ name: 's1-standalone-test', version: '1' }, { capabilities: {} })
  let stopMcp = async () => { try { await transport.close() } catch { /* owned MCP fallback */ } }
  const owned: { process: OwnedProcess | null } = { process: null }
  transport.start = async () => {
    const starting = start()
    const proc = (transport as any)._process as ReturnType<typeof spawn> | null
    if (proc?.pid && !owned.process) owned.process = registerOwnedProcess('mcp', proc, () => stopMcp())
    await starting
    audit({ event: 'mcp-spawned', pid: transport.pid ?? null })
  }
  stopMcp = async () => { try { await client.close() } catch { try { await transport.close() } catch { /* owned MCP fallback */ } } }
  try { await client.connect(transport) }
  catch (error) {
    const pid = transport.pid
    const proc = (transport as any)._process as ReturnType<typeof spawn> | null
    if (owned.process) await owned.process.stop()
    else { try { await transport.close() } catch { /* cleanup evidence below */ } }
    audit({ event: 'mcp-connect-failed', pid, exited: !proc || proc.exitCode !== null || proc.signalCode !== null })
    throw error instanceof Error ? new Error(`MCP connection failed (${error.name})`) : new Error('MCP connection failed')
  }
  return {
    client,
    async close() {
      const pid = transport.pid
      const proc = (transport as any)._process as ReturnType<typeof spawn> | null
      if (owned.process) await owned.process.stop()
      else await stopMcp()
      const exited = !proc || proc.exitCode !== null || proc.signalCode !== null
      audit({ event: 'mcp-closed', pid, exited })
      return exited
    },
  }
}

type GateStatus = 'PASS' | 'FAIL' | 'NOT RUN' | 'NOT VERIFIED'
type GateResult = {
  status: GateStatus
  phase: string
  errorType: string | null
  errorFrame: string | null
  checks: Record<string, boolean>
  counts: Record<string, number>
  observations: Record<string, boolean | number | string | string[] | null>
}

const STATE_PATHS = ['gitrader.json', 'service.json', 'keys', 'data', 'workspaces', 'lab', 'plugins', 'engines']
const GATES = ['①', '②', '③', '④', '⑤', '⑥'] as const
type Gate = typeof GATES[number]
const gateResults: Record<Gate, GateResult> = {
  '①': { status: 'NOT RUN', phase: 'preflight', errorType: null, errorFrame: null, checks: {}, counts: {}, observations: {} },
  '②': { status: 'NOT RUN', phase: 'preflight', errorType: null, errorFrame: null, checks: {}, counts: {}, observations: {} },
  '③': { status: 'NOT RUN', phase: 'preflight', errorType: null, errorFrame: null, checks: {}, counts: {}, observations: {} },
  '④': { status: 'NOT RUN', phase: 'preflight', errorType: null, errorFrame: null, checks: {}, counts: {}, observations: {} },
  '⑤': { status: 'NOT RUN', phase: 'preflight', errorType: null, errorFrame: null, checks: {}, counts: {}, observations: {} },
  '⑥': { status: 'NOT RUN', phase: 'preflight', errorType: null, errorFrame: null, checks: {}, counts: {}, observations: {} },
}
const suiteResult: Record<string, unknown> = {
  runId: null,
  phase: 'preflight',
  setupStatus: 'NOT RUN',
  setupErrorType: null,
  gates: gateResults,
  stateAudit: {},
  cleanup: { status: 'NOT RUN' },
}

let phase = 'preflight'
let lastWaitLabel: string | null = null
let lastStageFailure: { errorType: string; frame: string | null } | null = null
let home: string | null = null
let alias: string | null = null
let workArea: ReturnType<typeof ownedWorkArea> | null = null
let lifecycleFile: string | null = null
let resultFile: string | null = null
let manifestFile: string | null = null
let manifest: { rootLabel: string; runId: string; createdPaths: string[] } | null = null
let stage: Awaited<ReturnType<typeof startRealStage>> | null = null
let host: Awaited<ReturnType<typeof listenTestHost>> | null = null
let hostHtml: { value: string } | null = null
let cdp: BrowserCdp | null = null
let mcp: Awaited<ReturnType<typeof connectSameStageMcp>> | null = null
let hostTarget: any = null
let hostTop: { target: any; contextId: number } | null = null
let parent: { target: any; contextId: number } | null = null
let gateThreeChild: CdpContext | null = null
let parentToken: string | null = null
let bootToken: string | null = null
let initialSessionCount: number | null = null
let stageOrigin: string | null = null
let initialChartRoute = '#/overview'
let startupEvidence: Record<string, any> = {}
let refreshedEvidence: Record<string, any> = {}
let dockedEvidence: Record<string, any> = {}
let lifecycleEvents: Array<Record<string, unknown>> = []
let ownedProcesses: OwnedProcess[] = []
let paperAccountId: string | null = null
let paperAgentToken: string | null = null
let testPin: string | null = null
let chartRoute = '#/chart/hyperliquid%3ABTC'
let childDockScreenshotFile: string | null = null

type CdpContext = NonNullable<ReturnType<BrowserCdp['contextFor']>>

async function contextUntil(fn: () => CdpContext | null | Promise<CdpContext | null>, label: string): Promise<CdpContext> {
  const found = await until(async () => (await fn()) ?? false, 20000, label)
  if (found === false) throw new Error(`${label} unavailable`)
  return found
}

function currentPhase(next: string) {
  phase = next
  lastWaitLabel = null
  suiteResult.phase = next
  console.info(`[S1-D2] PHASE=${next}`)
}

function audit(event: AuditEvent) {
  const row = { at: new Date().toISOString(), ...event }
  lifecycleEvents.push(row)
  if (lifecycleFile) writeFileSync(lifecycleFile, JSON.stringify({ events: lifecycleEvents }, null, 2))
}

function probePid(pid: number | undefined) {
  if (!pid) return 'unknown' as const
  try { process.kill(pid, 0); return 'alive' as const }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' as const : 'unknown' as const }
}

async function waitChildExit(child: ReturnType<typeof spawn>, ms: number) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), pause(ms)])
}

async function stopChildHandle(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) child.kill()
  await waitChildExit(child, 2000)
}

function registerOwnedProcess(resource: OwnedProcess['resource'], child: ReturnType<typeof spawn>, stop: () => Promise<void>, profile?: string) {
  const row: OwnedProcess = { resource, child, profile, stopCalled: false, handleState: 'NOT CHECKED', pidState: 'NOT CHECKED', cleanupVerified: false,
    stop: async () => { if (row.stopCalled) return; row.stopCalled = true; await stop() } }
  if (child.pid) {
    ownedProcesses.push(row)
    audit({ event: 'owned-process-registered', pid: child.pid, details: { resource } })
  }
  return row
}

async function verifyOwnedProcess(row: OwnedProcess) {
  try { await row.stop() } catch (error) { audit({ event: 'owned-process-stop-failed', pid: row.child.pid ?? null, details: { resource: row.resource, errorType: errorType(error) } }) }
  if (row.child.exitCode === null && row.child.signalCode === null) {
    try { row.child.kill() } catch { /* only the saved child handle is eligible for fallback */ }
    await waitChildExit(row.child, 2000)
  }
  row.handleState = row.child.exitCode !== null || row.child.signalCode !== null ? 'exited' : 'alive'
  row.pidState = probePid(row.child.pid)
  if (row.handleState === 'exited' && row.pidState === 'alive') row.pidState = 'unknown'
  row.profileRemoved = !row.profile || !existsSync(row.profile)
  row.cleanupVerified = row.handleState === 'exited' && row.pidState === 'exited' && row.profileRemoved
  audit({ event: 'owned-process-verified', pid: row.child.pid ?? null, exited: row.cleanupVerified,
    handleState: row.handleState, pidState: row.pidState, profileRemoved: row.profileRemoved, details: { resource: row.resource } })
  return row.cleanupVerified
}

function errorType(error: unknown) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'Error'
}

function safeFrameFromText(stack: string) {
  for (const line of stack.split(/\r?\n/)) {
    const match = line.match(/(?:^|[\s(])(?:[^()\r\n]*[\\/])?(standalone\.browser\.test\.ts|stage-lib\.mjs|standalone\.js|boot\.js):(\d+):(\d+)\)?$/)
    if (match) return `${match[1]}:${match[2]}:${match[3]}`
  }
  return null
}

function safeErrorFrame(error: unknown) {
  return safeFrameFromText(error instanceof Error ? error.stack ?? '' : '')
}

function safeErrorType(text: string) {
  const match = text.match(/\b([A-Za-z][A-Za-z0-9]*(?:Error|Exception))\b/)
  return match?.[1] ?? 'Error'
}

function safeAssert(gate: Gate, name: string, actual: unknown, expected: unknown = true) {
  const pass = Object.is(actual, expected)
  gateResults[gate].checks[name] = pass
  expect(pass, `${gate}:${name}`).toBe(true)
}

function gatePhase(gate: Gate, next: string) {
  currentPhase(next)
  gateResults[gate].phase = next
}

async function runGate(gate: Gate, next: string, body: () => Promise<void>) {
  gatePhase(gate, next)
  // 依赖：内核按会话限流器（K-r5-13，工作树未提交）缺省 200 枚、每秒回填 60。④ 紧跟 ③ 的突发，开门前先冷却 4 s 让桶回满；不改额度、不放宽断言。
  // 只冷却 ④：实测 ③ 前空等 4 s 会让夹具行情超过 5 s 过期线（STALE_PRICE），纸面单被拒。
  if (gate === '④') {
    currentPhase('gate-④-rate-bucket-cooldown')
    await pause(4000)
  }
  const gateStartedAt = gate === '④' ? Date.now() : null
  console.info(`[S1-D2] GATE=${gate} START`)
  try {
    await body()
    gateResults[gate].status = 'PASS'
    console.info(`[S1-D2] GATE=${gate} PASS`)
  } catch (error) {
    gateResults[gate].status = 'FAIL'
    gateResults[gate].errorType = errorType(error)
    gateResults[gate].errorFrame = safeErrorFrame(error)
    if (lastWaitLabel) gateResults[gate].observations.waitLabel = lastWaitLabel
    if (lastStageFailure) {
      gateResults[gate].observations.stageErrorType = lastStageFailure.errorType
      gateResults[gate].observations.stageErrorFrame = lastStageFailure.frame
    }
    lastWaitLabel = null
    console.info(`[S1-D2] GATE=${gate} FAIL errorType=${errorType(error)} frame=${gateResults[gate].errorFrame ?? 'unavailable'} stageType=${lastStageFailure?.errorType ?? 'none'} stageFrame=${lastStageFailure?.frame ?? 'unavailable'}`)
    lastStageFailure = null
    throw new Error(`S1 gate ${gate} failed at ${phase} (${errorType(error)})`)
  } finally {
    if (gate === '④' && gateStartedAt !== null) {
      gateResults['④'].observations.rpcBudget = JSON.stringify(rpcBudgetObservation(gateStartedAt, Date.now()))
    }
  }
}

function rpcBudgetObservation(gateStartedAt: number, gateEndedAt: number) {
  const allowedMethods = new Set(['auth', 'query', 'command'])
  const requests = (cdp?.wsFramesSent ?? []).flatMap((row) => {
    try {
      const frame = JSON.parse(row.payload) as { id?: unknown; method?: unknown }
      if ((typeof frame.id !== 'string' && typeof frame.id !== 'number') || typeof frame.method !== 'string') return []
      return [{ at: row.at, method: allowedMethods.has(frame.method) ? frame.method : 'other' }]
    } catch { return [] }
  })
  const summarize = (rows: typeof requests) => {
    const methods: Record<string, number> = {}
    const perSecond = new Map<number, number>()
    for (const row of rows) {
      methods[row.method] = (methods[row.method] ?? 0) + 1
      const second = Math.floor((row.at - gateStartedAt) / 1000)
      perSecond.set(second, (perSecond.get(second) ?? 0) + 1)
    }
    return {
      count: rows.length,
      methods,
      firstOffsetMs: rows.length ? rows.reduce((value, row) => Math.min(value, row.at - gateStartedAt), Number.POSITIVE_INFINITY) : null,
      lastOffsetMs: rows.length ? rows.reduce((value, row) => Math.max(value, row.at - gateStartedAt), Number.NEGATIVE_INFINITY) : null,
      perSecond: [...perSecond.entries()].sort(([left], [right]) => left - right).map(([second, count]) => ({ second, count })),
    }
  }
  const before = requests.filter((row) => row.at < gateStartedAt)
  const during = requests.filter((row) => row.at >= gateStartedAt && row.at <= gateEndedAt)
  return { total: before.length + during.length, gateStartedAt: true, elapsedMs: gateEndedAt - gateStartedAt, before: summarize(before), during: summarize(during) }
}

function statePresenceAudit(rootDir: string) {
  return Object.fromEntries(STATE_PATHS.map((name) => [name, existsSync(join(rootDir, name))]))
}

function verifyManifestPath(rootDir: string, relativePath: string) {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) return null
  const target = resolve(rootDir, relativePath)
  return isStrictChild(rootDir, target) ? target : null
}

function samePath(left: string, right: string) {
  return resolve(left).replace(/[\\/]+$/, '').toLowerCase() === resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

function assertNoReparsePath(parentDir: string, target: string) {
  if (!isStrictChild(parentDir, target)) throw new Error('retained path escaped approved parent')
  let current = resolve(parentDir)
  for (const part of relative(resolve(parentDir), resolve(target)).split(/[\\/]/)) {
    if (!part || part === '.' || part === '..') throw new Error('retained path component invalid')
    current = join(current, part)
    if (!existsSync(current)) break
    if (lstatSync(current).isSymbolicLink() || !samePath(realpathSync(current), current)) throw new Error('reparse path rejected')
  }
}

function retainManifestPaths() {
  if (!home || !manifest || !manifestFile || !workArea) return { status: 'NOT RUN', action: 'retained', moved: [], remaining: [] }
  if (manifest.rootLabel !== 'approved-s1-home' || !manifest.runId || manifest.createdPaths.length !== STATE_PATHS.length ||
      STATE_PATHS.some((name, index) => manifest!.createdPaths[index] !== name)) throw new Error('ownership manifest mismatch')
  const persisted = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (persisted.rootLabel !== manifest.rootLabel || persisted.runId !== manifest.runId ||
      JSON.stringify(persisted.createdPaths) !== JSON.stringify(manifest.createdPaths)) throw new Error('persisted ownership manifest mismatch')
  const realHome = realpathSync(home)
  if (!samePath(realHome, home)) throw new Error('approved home reparse path rejected')
  const artifactDir = resolve(workArea.artifactDir)
  if (!isStrictChild(home, artifactDir) || !samePath(realpathSync(artifactDir), artifactDir)) throw new Error('artifact root boundary failed')
  const retainedDir = join(artifactDir, 'retained-state')
  if (!isStrictChild(artifactDir, retainedDir) || existsSync(retainedDir)) throw new Error('retained target already exists')

  const entries = manifest.createdPaths.map((relativePath) => {
    const source = verifyManifestPath(home!, relativePath)
    if (!source) throw new Error('manifest source boundary failed')
    assertNoReparsePath(home!, source)
    const present = existsSync(source)
    if (present && !isStrictChild(realHome, realpathSync(source))) throw new Error('manifest source realpath escaped home')
    if (present && lstatSync(source).isSymbolicLink()) throw new Error('manifest source reparse rejected')
    const destination = join(retainedDir, relativePath)
    if (!isStrictChild(artifactDir, destination)) throw new Error('retained destination boundary failed')
    return { source: relative(home!, source), destination: relative(artifactDir, destination), present, state: present ? 'planned' : 'absent' }
  })

  mkdirSync(retainedDir)
  if (!samePath(realpathSync(retainedDir), retainedDir)) throw new Error('retained directory reparse rejected')
  for (const entry of entries) {
    const destination = resolve(artifactDir, entry.destination)
    assertNoReparsePath(artifactDir, destination)
    if (existsSync(destination)) throw new Error('retained destination already exists')
  }
  const restoreFile = join(retainedDir, 'restore-manifest.json')
  const recovery = { rootLabel: manifest.rootLabel, runId: manifest.runId, moved: [] as string[], remaining: entries.filter((entry) => entry.present).map((entry) => entry.source), entries }
  writeFileSync(restoreFile, JSON.stringify(recovery, null, 2))
  try {
    for (const entry of entries) {
      if (!entry.present) continue
      const source = resolve(home, entry.source)
      const destination = resolve(artifactDir, entry.destination)
      if (!isStrictChild(home, source) || !isStrictChild(artifactDir, destination)) throw new Error('retained move boundary failed')
      if (!existsSync(source) || existsSync(destination)) throw new Error('retained move precondition failed')
      assertNoReparsePath(home, source)
      assertNoReparsePath(artifactDir, destination)
      renameSync(source, destination)
      entry.state = 'moved'
      recovery.moved.push(entry.source)
      recovery.remaining = entries.filter((candidate) => candidate.present && candidate.state !== 'moved').map((candidate) => candidate.source)
      writeFileSync(restoreFile, JSON.stringify(recovery, null, 2))
    }
  } catch (error) {
    return { status: 'FAIL', action: 'retained', moved: recovery.moved, remaining: recovery.remaining, errorType: errorType(error) }
  }
  const sourcesAbsent = entries.every((entry) => !existsSync(resolve(home!, entry.source)))
  const destinationsPresent = entries.filter((entry) => entry.present).every((entry) => existsSync(resolve(artifactDir, entry.destination)))
  const reversible = existsSync(restoreFile) && entries.every((entry) => entry.present ? entry.state === 'moved' : entry.state === 'absent')
  return { status: sourcesAbsent && destinationsPresent && reversible ? 'PASS' : 'FAIL', action: 'retained', moved: recovery.moved, remaining: recovery.remaining, sourcesAbsent, destinationsPresent, reversible }
}

async function pageEval(where: { target: { sessionId: string }; contextId: number }, expression: string) {
  if (!cdp) throw new Error('browser unavailable')
  return cdp.evaluate(where, expression)
}

async function pageTrue(where: { target: { sessionId: string }; contextId: number }, expression: string, label: string) {
  return until(() => pageEval(where, `Boolean(${expression})`), 20000, label)
}

async function captureMode(where: { target: { sessionId: string }; contextId: number }) {
  return pageEval(where, `(() => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).display !== 'none';
    };
    const button = [...document.querySelectorAll('button[data-act="standalone"]')].find(isVisible) ?? null;
    const peerButton = document.querySelector('[data-standalone-peer="on"] button[data-act="standalone"]');
    return {
      mode: document.documentElement.dataset.mode ?? null,
      kernel: document.documentElement.dataset.kernel ?? null,
      pressed: button?.getAttribute('aria-pressed') ?? null,
      label: button?.getAttribute('aria-label') ?? null,
      button: Boolean(button),
      disabled: Boolean(button?.disabled),
      peer: Boolean(document.querySelector('[data-standalone-peer="on"]')),
      peerButton: isVisible(peerButton),
      peerButtonPressed: peerButton?.getAttribute('aria-pressed') ?? null,
      peerButtonLabel: peerButton?.getAttribute('aria-label') ?? null,
      approve: Boolean(document.querySelector('[data-act="approve"]')),
      pinDialog: Boolean(document.querySelector('[role="dialog"]')),
      palette: Boolean(document.querySelector('.gr-palette')),
      chart: Boolean(document.querySelector('[data-g5-page="chart"]')),
      overview: Boolean(document.querySelector('[data-g5-page="workbench"], [data-g5-page="overview"]')),
      hostUnavailable: document.querySelector('[data-host-unavailable]')?.textContent?.trim() ?? null,
      route: location.hash
    };
  })()`)
}

async function authToken(where: { target: { sessionId: string } }, label: string): Promise<string> {
  if (!cdp) throw new Error('browser unavailable')
  const token = await until(() => [...cdp!.authFrames].reverse().find((frame) => frame.sessionId === where.target.sessionId)?.token ?? false, 20000, label)
  if (typeof token !== 'string') throw new Error(`${label} unavailable`)
  return token
}

async function refreshedAuthToken(where: { target: { sessionId: string } }, previousCount: number, label: string): Promise<string> {
  if (!cdp) throw new Error('browser unavailable')
  const token = await until(() => {
    const frames = cdp!.authFrames.filter((frame) => frame.sessionId === where.target.sessionId)
    const latest = frames.at(-1)
    return cdp!.authFrames.length > previousCount && latest ? latest.token : false
  }, 20000, label)
  if (typeof token !== 'string') throw new Error(`${label} unavailable`)
  return token
}

type WebSocketCounts = {
  opened: number
  closed: number
  active: number
  authenticatedActive: number
  retiredDocumentUnclosed: number
  unknownUnclosed: number
  previousDocumentDestroyed: boolean | null
}

function activeWebSocketCounts(where: CdpContext, origin: string, previousContextId: number | null): WebSocketCounts {
  if (!cdp) throw new Error('browser unavailable')
  const expectedUrl = new URL('/ui', origin)
  expectedUrl.protocol = expectedUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const sessionId = where.target.sessionId
  const openedRows = cdp.wsOpened.filter((row) => row.sessionId === sessionId && row.url === expectedUrl.href && typeof row.requestId === 'string')
  const openedIds = new Set(openedRows.map((row) => row.requestId))
  const closedIds = new Set(cdp.wsClosed.filter((row) => row.sessionId === sessionId && openedIds.has(row.requestId)).map((row) => row.requestId))
  const destroyedIds = new Set(cdp.destroyedContexts.filter((row) => row.sessionId === sessionId).map((row) => row.contextId))
  const unclosedRows = openedRows.filter((row) => !closedIds.has(row.requestId))
  const currentRows = unclosedRows.filter((row) => row.contextId === where.contextId)
  const activeIds = new Set(currentRows.map((row) => row.requestId))
  const authenticatedIds = new Set(cdp.authFrames.filter((row) => row.sessionId === sessionId && row.contextId === where.contextId && activeIds.has(row.requestId)).map((row) => row.requestId))
  const retiredDocumentUnclosed = new Set(unclosedRows.filter((row) => row.contextId !== null && row.contextId !== where.contextId && destroyedIds.has(row.contextId)).map((row) => row.requestId)).size
  const unknownUnclosed = new Set(unclosedRows.filter((row) => row.contextId === null || (row.contextId !== where.contextId && !destroyedIds.has(row.contextId))).map((row) => row.requestId)).size
  return { opened: openedIds.size, closed: closedIds.size, active: activeIds.size, authenticatedActive: authenticatedIds.size,
    retiredDocumentUnclosed, unknownUnclosed, previousDocumentDestroyed: previousContextId === null ? null : destroyedIds.has(previousContextId) }
}

function recordStableWebSocketCounts(label: string, parentContext: CdpContext, childContext: CdpContext, origin: string, previous: { parent: number | null; child: number | null } = { parent: null, child: null }) {
  const counts = {
    parent: activeWebSocketCounts(parentContext, origin, previous.parent),
    child: activeWebSocketCounts(childContext, origin, previous.child),
  }
  const existing = gateResults['②'].observations.webSocketCounts
  const checkpoints = existing ? JSON.parse(existing as string) as Record<string, typeof counts> : {}
  checkpoints[label] = counts
  gateResults['②'].observations.webSocketCounts = JSON.stringify(checkpoints)
  for (const windowName of ['parent', 'child'] as const) {
    safeAssert('②', `${label}_${windowName}_active_websocket`, counts[windowName].active, 1)
    safeAssert('②', `${label}_${windowName}_authenticated_active_websocket`, counts[windowName].authenticatedActive, 1)
    safeAssert('②', `${label}_${windowName}_unknown_unclosed_websocket`, counts[windowName].unknownUnclosed, 0)
    if (counts[windowName].previousDocumentDestroyed !== null) safeAssert('②', `${label}_${windowName}_previous_document_destroyed`, counts[windowName].previousDocumentDestroyed)
  }
}

function targetIdsForOrigin(browser: BrowserCdp, origin: string) {
  const ids = new Set<string>()
  for (const [targetId, target] of browser.targets) {
    const contexts = browser.contexts.get(target.sessionId)
    if ([...(contexts?.values() ?? [])].some((context: any) => context.origin === origin && context.auxData?.isDefault !== false)) ids.add(targetId)
  }
  return ids
}

async function tokenEvidence(where: { target: { sessionId: string }; contextId: number }, sessionToken: string, launchToken: string) {
  const page = await pageEval(where, `(() => {
    const ses = ${JSON.stringify(sessionToken)}; const launch = ${JSON.stringify(launchToken)};
    const href = String(location.href); const state = JSON.stringify(history.state ?? null);
    const dom = document.documentElement.outerHTML;
    let readable = true; let storage = '';
    try { for (const store of [localStorage, sessionStorage]) for (const key of Object.keys(store)) storage += key + store.getItem(key); }
    catch { readable = false; }
    return {
      storageReadable: readable,
      urlNoSession: !href.includes(ses), storageNoSession: !storage.includes(ses), domNoSession: !dom.includes(ses),
      stateNoSession: !state.includes(ses), urlNoLaunch: !href.includes('launch=') && !href.includes(launch),
      storageNoLaunch: !storage.includes(launch), domNoLaunch: !dom.includes(launch), stateNoLaunch: !state.includes(launch),
      bootstrapMetaGone: !document.querySelector('meta[name="gitrader-bootstrap"]')
    };
  })()`)
  return { ...page, navigation: await navigationEvidence(where, sessionToken, launchToken) }
}

async function navigationEvidence(where: { target: { sessionId: string }; contextId: number }, sessionToken: string, launchToken: string) {
  if (!cdp) return { available: false, noSession: null, noLaunch: null }
  try {
    const history = await cdp.send('Page.getNavigationHistory', {}, where.target.sessionId)
    const entries = Array.isArray(history.entries) ? history.entries : []
    if (!entries.length) return { available: false, noSession: null, noLaunch: null }
    const current = entries[history.currentIndex]
    const pageOrigin = await pageEval(where, 'location.origin')
    if (!current?.url || new URL(String(current.url)).origin !== pageOrigin) return { available: false, noSession: null, noLaunch: null }
      const urls: string[] = entries.map((entry: { url?: string }) => String(entry.url ?? ''))
    return {
      available: true,
      noSession: urls.every((url) => !url.includes(sessionToken)),
      noLaunch: urls.every((url) => !url.includes('launch=') && !url.includes(launchToken)),
    }
  } catch {
    return { available: false, noSession: null, noLaunch: null }
  }
}

function allTokenChecksForPage(evidence: any, hostDocument = false) {
  const fields = ['storageReadable', 'urlNoSession', 'storageNoSession', 'domNoSession', 'stateNoSession',
    'urlNoLaunch', 'storageNoLaunch', 'stateNoLaunch', 'bootstrapMetaGone']
  if (!hostDocument) fields.push('domNoLaunch')
  return fields.every((field) => evidence?.[field] === true)
}

function recordTokenEvidence(evidence: any) {
  const safe: Record<string, boolean | null> = {}
  for (const key of ['storageReadable', 'urlNoSession', 'storageNoSession', 'domNoSession', 'stateNoSession',
    'urlNoLaunch', 'storageNoLaunch', 'domNoLaunch', 'stateNoLaunch', 'bootstrapMetaGone']) safe[key] = evidence?.[key] === true
  safe.navigationAvailable = evidence?.navigation?.available === true
  safe.navigationNoSession = evidence?.navigation?.noSession ?? null
  safe.navigationNoLaunch = evidence?.navigation?.noLaunch ?? null
  return safe
}

async function tradeEventCount() {
  if (!stage) throw new Error('stage unavailable')
  return stage.run(`return k.ledger.query({ limit: 1000 }).filter((event) =>
    ['order.intent', 'order.accepted', 'proposal.created', 'proposal.decided'].includes(event.type)).length`)
}

const actorKinds = ['human', 'engine', 'agent', 'system']

async function chartIntervalUi(where: CdpContext) {
  return pageEval(where, "document.querySelector('[data-g5-page=chart] [data-iv][aria-selected=true]')?.getAttribute('data-iv') ?? null")
}

type ChartUiSnapshot = {
  routeExpected: boolean
  kernel: string
  chartPresent: boolean
  state: string
  ariaBusy: boolean
  wireErrorVisible: boolean
  wireError: string | null
  visibleError: string | null
  intervals: Array<{ period: string; exists: boolean; disabled: boolean | null; selected: boolean | null }>
}

async function chartUiSnapshot(where: CdpContext, expectedRoute: string): Promise<ChartUiSnapshot> {
  const snapshot = await pageEval(where, `(() => {
    const card=document.querySelector('[data-g5-page="chart"]');
    const stateNode=card?.querySelector('[data-state]') ?? null;
    const visible=(node) => { if(!node) return false; const r=node.getBoundingClientRect(),s=getComputedStyle(node); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
    const periods=['1m','5m','15m','1h','4h','1d'];
    const intervals=periods.map((period)=>{ const node=card?.querySelector('[data-iv="'+period+'"]') ?? null; return { period, exists:Boolean(node), disabled:node ? Boolean(node.disabled) : null, selected:node ? node.getAttribute('aria-selected')==='true' : null }; });
    const wire=card?.querySelector('[data-wire="off"] .g5-msg') ?? null;
    const error=card?.querySelector('.g5-pstate .g5-msg,[role="alert"]') ?? null;
    const rawState=stateNode?.getAttribute('data-state') ?? 'none';
    const kernelRaw=document.documentElement.dataset.kernel ?? '';
    return {
      routeExpected:location.hash===${JSON.stringify(expectedRoute)},
      kernel:['open','connecting','closed'].includes(kernelRaw) ? kernelRaw : 'other',
      chartPresent:Boolean(card),
      state:['loading','nosource','noperiod','error','offline'].includes(rawState) ? rawState : rawState==='none' ? 'none' : 'other',
      ariaBusy:Boolean(card?.querySelector('[aria-busy="true"]')),
      wireErrorVisible:visible(wire), wireError:visible(wire) ? wire.textContent?.trim() ?? null : null,
      visibleError:visible(error) ? error.textContent?.trim() ?? null : null,
      intervals
    };
  })()`)
  return snapshot as ChartUiSnapshot
}

function safeEnumMarker(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null
}

function safeErrorMarker(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) return 'UNKNOWN'
  return value.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
}

function marketCandleFrameEvidence(where: CdpContext, routeInstrument: string) {
  if (!cdp) return { requestCount: 0, matchingRequestCount: 0, responseCount: 0, requestRouteMatches: false, responses: [] as Array<Record<string, string | number | null>> }
  type ParsedFrame = { id?: unknown; method?: unknown; params?: { method?: unknown; params?: { instrumentId?: unknown } }; result?: unknown; error?: { code?: unknown; data?: { name?: unknown }; message?: unknown } }
  const parse = (payload: string): ParsedFrame | null => { try { return JSON.parse(payload) as ParsedFrame } catch { return null } }
  const requests = cdp.wsFramesSent.flatMap((row) => {
    if (row.sessionId !== where.target.sessionId) return []
    const message = parse(row.payload)
    if (message?.method !== 'query' || message.params?.method !== 'market.candles') return []
    return [{ id: typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined, instrumentId: message.params?.params?.instrumentId }]
  })
  const matching = requests.filter((request) => request.instrumentId === routeInstrument && (typeof request.id === 'string' || typeof request.id === 'number'))
  const summaries: Array<Record<string, string | number | null>> = []
  for (const request of matching) {
    const responseRow = cdp.wsFramesReceived.find((row) => {
      if (row.sessionId !== where.target.sessionId) return false
      const message = parse(row.payload)
      return message?.id === request.id
    })
    if (!responseRow) continue
    const response = parse(responseRow.payload)
    const error = response?.error
    const result = response?.result
    const candleValue = result && typeof result === 'object' && 'candles' in result ? result.candles : null
    const candles = Array.isArray(result) ? result : Array.isArray(candleValue) ? candleValue : null
    summaries.push(error ? {
      resultType: 'error', candleCount: null,
      errorCode: typeof error.code === 'number' ? error.code : safeEnumMarker(error.code),
        errorName: error.data?.name === undefined ? null : safeErrorMarker(error.data.name), errorMessage: safeDiagnosticText(error.message),
    } : {
      resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result === 'object' ? 'object' : typeof result,
      candleCount: candles?.length ?? null, errorCode: null, errorName: null, errorMessage: null,
    })
  }
  return {
    requestCount: requests.length,
    matchingRequestCount: matching.length,
    responseCount: summaries.length,
    requestRouteMatches: requests.length > 0 && matching.length === requests.length,
    responses: summaries.slice(-4),
  }
}

async function markerEvidence(where: CdpContext) {
  return pageEval(where, `(() => {
    const ui = Object.fromEntries([...document.querySelectorAll('[data-g5-page=chart] [data-legend]')]
      .map((node) => [node.getAttribute('data-legend'), Boolean(node.querySelector('i')?.classList.contains('g5-off'))]));
    let persisted = null;
    try { const value = JSON.parse(localStorage.getItem('gitrader.prefs') || '{}').blockCfg?.bi_chart_1?.markers; if (Array.isArray(value)) persisted = value; } catch {}
    let intervalStored = null;
    try { intervalStored = JSON.parse(localStorage.getItem('gitrader.prefs') || '{}').blockCfg?.bi_chart_1?.interval ?? null; } catch {}
    return { ui, persisted, intervalStored };
  })()`)
}

function markersMatch(evidence: any, off: string[]) {
  const expectedOn = actorKinds.filter((kind) => !off.includes(kind))
  return actorKinds.every((kind) => evidence?.ui?.[kind] === off.includes(kind))
    && JSON.stringify(evidence?.persisted) === JSON.stringify(expectedOn)
}

async function chartConfigEvidence(where: CdpContext) {
  return { intervalUi: await chartIntervalUi(where), ...(await markerEvidence(where)) }
}

function chartConfigMatches(evidence: any, interval: string, off: string[]) {
  return evidence?.intervalUi === interval && evidence?.intervalStored === interval && markersMatch(evidence, off)
}

async function toggleRealMarker(where: CdpContext, kind: string) {
  // 菜单只认真实鼠标事件（与 chart.browser 的 mclick 同法），合成 click 打不开。
  const opened = await clickRealElement(where, '[data-g5-page=chart] [data-menu=markers]')
  if (!opened) throw new Error('real chart marker control unavailable')
  const selector = `[role=menuitem][data-v=${kind}]`
  try {
    await pageTrue(where, `document.querySelector(${JSON.stringify(selector)})`, 'real chart marker menu item')
  } catch (error) {
    const diag = await pageEval(where, `(() => { const t=document.querySelector('[data-g5-page=chart] [data-menu=markers]'); const r=t?.getBoundingClientRect();
      return { expanded: t?.getAttribute('aria-expanded') ?? null, state: t?.getAttribute('data-state') ?? null, rect: r ? [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] : null,
        menus: document.querySelectorAll('[role=menu]').length, items: [...document.querySelectorAll('[role=menuitem]')].map((n) => n.getAttribute('data-v')),
        hit: (() => { if(!r) return null; const e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return e ? e.tagName + '.' + String(e.className).slice(0,40) : null })(), vw: innerWidth, vh: innerHeight } })()`).catch(() => null)
    gateResults['④'].observations.markerMenuDiag = JSON.stringify(diag)
    throw error
  }
  const selected = await clickRealElement(where, selector)
  if (!selected) throw new Error('real chart marker item unavailable')
}

function textResult(reply: any) {
  if (reply?.isError) return null
  try { return JSON.parse(reply.content?.find((item: any) => item.type === 'text')?.text ?? 'null') } catch { return null }
}

async function directApprove(where: CdpContext, proposalId: string, token: string, pin: string | null, requiresPin: boolean, due = Date.now()) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  if (requiresPin && pin) headers['x-gitrader-pin'] = pin
  return pageEval(where, `new Promise(resolve => setTimeout(async () => {
    try { const response=await fetch('/api/op/proposal.approve', { method:'POST', headers:${JSON.stringify(headers)}, body:JSON.stringify({params:{id:${JSON.stringify(proposalId)}}}) });
      const body=await response.json(); const message=body.error?.message ?? ''; const code=typeof body.error?.code==='number' ? body.error.code : null; const name=typeof body.error?.name==='string' ? body.error.name : null; resolve({
        ok:response.ok && body.ok===true, statusClass:Math.floor(response.status/100),
        code, name,
        kernelStateError:code===-32602 && name==='INVALID_PARAMS' && typeof message==='string' && message.includes('not pending'),
        attestRequired:name==='ATTESTATION_REQUIRED', message
      })
    } catch { resolve({ok:false,statusClass:0,code:null,name:null,kernelStateError:false,attestRequired:false,message:''}) }
  }, Math.max(0, ${due}-Date.now())))`)
}

async function createPendingPaperProposal(label: string, size = '0.002') {
  if (!stage || !paperAgentToken || !paperAccountId) throw new Error('paper setup unavailable')
  // 夹具：纸面账户的保护器在最近一次开仓后有冷却（COOLDOWN）；上一组刚成交时第二组会被风控直接 deny。
  // 只在「全部命中都是 COOLDOWN」时等一等再建，其余任何拒绝原样返回，不改风控、不放宽断言。
  for (let attempt = 0; ; attempt += 1) {
    const created = await createPendingPaperProposalOnce(label, size)
    const hits = Array.isArray(created?.ruleHits) ? created.ruleHits : []
    const cooling = created?.status === 'denied' && hits.length > 0 && hits.every((hit: { code?: unknown }) => hit?.code === 'COOLDOWN')
    if (!cooling || attempt >= 8) return created
    await pause(1500)
  }
}

async function createPendingPaperProposalOnce(label: string, size: string) {
  if (!stage || !paperAgentToken || !paperAccountId) throw new Error('paper setup unavailable')
  const result = await stage.run(`
    try {
      const token = ${JSON.stringify(paperAgentToken)}
      const principal = k.auth.authenticateToken(token)
      if (principal?.kind !== 'agent') throw new Error('paper agent unavailable')
      const proposal = await k.trading.propose({ accountId:${JSON.stringify(paperAccountId)},
        intents:[{ accountId:${JSON.stringify(paperAccountId)}, instrumentId:'hyperliquid:BTC', side:'buy', type:'market', size:${JSON.stringify(size)}, leverage:2 }],
        reason:${JSON.stringify(label)}, forcePending:true },
        { principal, origin:{ actor:'agent:'+principal.keyId, actorType:'llm-agent', tool:'s1:proposal', via:'mcp', requestId:${JSON.stringify(randomUUID())} } })
      const hits = Array.isArray(proposal.precheck?.ruleHits) ? proposal.precheck.ruleHits : []
      return { id:proposal.proposalId, ticket:proposal.ticket, status:proposal.status, verdict:proposal.precheck?.verdict ?? null,
        ruleHits:hits.map((hit) => ({ code:hit?.code ?? null, action:hit?.action ?? null, scope:hit?.scope ?? null })) }
    } catch (error) {
      const value = error && typeof error === 'object' ? error : {}
      const problem = value.problem && typeof value.problem === 'object' ? value.problem : {}
      return { problem: {
        name: typeof problem.name === 'string' ? problem.name : null,
        message: typeof problem.message === 'string' ? problem.message : typeof value.message === 'string' ? value.message : null,
        code: typeof problem.code === 'string' || typeof problem.code === 'number' ? problem.code : null,
      }, errorName: typeof value.name === 'string' ? value.name : null }
    }
  `)
  if (result?.problem) {
    const detail = {
      problemName: safeErrorMarker(result.problem.name),
      problemCode: typeof result.problem.code === 'number' ? result.problem.code : safeEnumMarker(result.problem.code),
      errorName: safeErrorMarker(result.errorName),
      message: safeDiagnosticText(result.problem.message),
    }
    gateResults['⑤'].observations.proposalCreateProblem = JSON.stringify(detail)
    throw new Error('paper proposal creation failed')
  }
  return result
}

async function waitForPendingCount(where: CdpContext, count: number) {
  try {
    return await until(() => pageEval(where, "Number(document.querySelector('#g5-pendpop .g5-ct')?.textContent ?? -1)").then((actual) => actual === count), 10000, `real P1 pending count ${count}`)
  } catch (error) {
    const diag = await pageEval(where, `(() => ({ ct: (document.querySelector('#g5-pendpop .g5-ct')?.textContent ?? '').trim(), pend: document.documentElement.dataset.pend ?? null,
      items: [...document.querySelectorAll('#g5-pendpop .g5-pitem')].map((n) => ({ held: n.hasAttribute('data-held'), cls: String(n.className).slice(0, 40), text: (n.textContent ?? '').trim().slice(0, 40) })).length,
      resultTexts: [...document.querySelectorAll('#g5-pendpop [data-result], #g5-pendpop .g5-result')].map((n) => (n.textContent ?? '').trim().slice(0, 40)), holdRaw: !!window.__S1_DELAYED_APPROVAL__?.raw }))()`).catch(() => null)
    gateResults['⑤'].observations.pendCountDiag = JSON.stringify({ wanted: count, diag })
    throw error
  }
}

type PositionSnapshot = {
  routeExpected: boolean
  kernel: string
  rowCount: number
  quantity: string | null
  totalRows: number
  paperRows: number
  rowState: string
  selectedTab: string
  tabCount: number
  loadingVisible: boolean
  errorVisible: boolean
  wireOffVisible: boolean
  filterVisible: boolean
  visibleError: string | null
}

async function positionSnapshot(where: CdpContext, rowSelector: string): Promise<PositionSnapshot> {
  const snapshot = await pageEval(where, `(() => {
    const card = document.querySelector('[data-g5-page="overview"][data-view="positions"]');
    const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
    const row = rows[0] ?? null;
    const visible = (node) => { if (!node) return false; const r=node.getBoundingClientRect(), s=getComputedStyle(node); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden' };
    const tabs = [...(card?.querySelectorAll('[role="tab"][data-tab]') ?? [])].filter(visible);
    const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.getAttribute('data-tab') ?? 'none';
    const errorNode = [...(card?.querySelectorAll('.g5-msg,[role="alert"]') ?? [])].find(visible) ?? null;
    const rowStateRaw = row?.getAttribute('data-state') ?? 'none';
    return {
      routeExpected: location.hash === '#/overview',
      kernel: ['open','connecting','closed'].includes(document.documentElement.dataset.kernel ?? '') ? document.documentElement.dataset.kernel : 'other',
      rowCount: rows.length,
      quantity: row?.querySelector('[data-n="qty"]')?.textContent?.replaceAll(',','').trim() ?? null,
      totalRows: card?.querySelectorAll('tbody tr').length ?? 0,
      paperRows: card?.querySelectorAll('tbody tr.g5-paper').length ?? 0,
      rowState: ['armed','closing','monitor','stopped','error'].includes(rowStateRaw) ? rowStateRaw : 'other',
      selectedTab: ['pos','ord','none'].includes(selected) ? selected : 'other',
      tabCount: tabs.length,
      loadingVisible: Boolean(card?.querySelector('[aria-busy="true"]')),
      errorVisible: Boolean(errorNode),
      wireOffVisible: Boolean(card?.querySelector('[data-wire="off"]')),
      filterVisible: [...(card?.querySelectorAll('input,select,[role="combobox"]') ?? [])].some(visible),
      visibleError: errorNode?.textContent?.trim() ?? null
    };
})()`)
  return snapshot as PositionSnapshot
}

function safeDiagnosticText(value: unknown, extraSecrets: string[] = []): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let text = value.slice(0, 500)
  for (const secret of [parentToken, bootToken, paperAgentToken, testPin, paperAccountId, ...extraSecrets]) {
    if (secret) text = text.split(secret).join('[redacted]')
  }
  text = text
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[endpoint]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[address]')
    .replace(/\b(?:usr|acc|ord|prp|agt|key|req|exp|run|tkt)_[A-Za-z0-9_-]+\b/gi, '[id]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[id]')
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\b/g, '[host]')
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 160) || null
}

type ClickTrace = { selectorIndex: number | null; sendPoint: { x: number; y: number } | null }

async function clickRealElement(where: CdpContext, selector: string, trace?: ClickTrace) {
  if (!cdp) throw new Error('browser unavailable')
  const point = await pageEval(where, `(() => {
    const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];
    const node=nodes.find((candidate) => { const r=candidate.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(candidate).display!=='none' }) ?? null;
    if(!node || node.disabled) return null;
    const r=node.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,selectorIndex:nodes.indexOf(node)};
  })()`)
  if (trace) {
    trace.selectorIndex = typeof point?.selectorIndex === 'number' ? point.selectorIndex : null
    trace.sendPoint = point ? { x: point.x, y: point.y } : null
  }
  if (!point || point.width <= 0 || point.height <= 0) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, where.target.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, where.target.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, where.target.sessionId)
  return true
}

async function restoreParentFromLiveChild(gate: Gate, label: string) {
  if (!cdp || !parent || !stageOrigin) throw new Error('parent recovery dependencies unavailable')
  const current = await captureMode(parent)
  if (current.mode === 'docked' && !current.peer) return
  const child = cdp.contextFor(stageOrigin, new Set([parent.target.targetId]))
  if (!child) {
    gateResults[gate].observations.missingEvidence = 'live-child-context'
    throw new Error('live child recovery dependency missing')
  }
  const clicked = await clickRealElement(child, 'button[data-act="standalone"]')
  safeAssert(gate, 'existing_child_real_redock_clicked', clicked)
  parent = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([child.target.targetId]), parent!.target.targetId), label)
  await pageTrue(parent, "document.documentElement.dataset.mode==='docked' && !document.querySelector('[data-standalone-peer=on]') && !!document.querySelector('[data-g5-page]')", 'parent rendered after child redock')
}

async function websocketError(where: CdpContext, requestId: number) {
  if (!cdp) throw new Error('browser unavailable')
  return until(() => {
    for (const frame of cdp!.wsFramesReceived) {
      if (frame.sessionId !== where.target.sessionId) continue
      try {
        const message = JSON.parse(frame.payload)
        if (message.id === requestId && message.error) return { code: message.error.code, name: message.error.data?.name ?? null, message: message.error.message ?? '' }
      } catch { /* unrelated WebSocket payload */ }
    }
    return null
  }, 15000, 'real approval WebSocket response')
}

function normalizeDecimal(value: unknown) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const normalizedFraction = fraction.replace(/0+$/, '')
  return `${whole}${normalizedFraction ? `.${normalizedFraction}` : ''}`
}

describe('S1 D2 permanent real gates', () => {
  beforeAll(async () => {
    try {
      currentPhase('preflight-home')
      home = approvedTestHome()
      alias = requiredTestAlias()
      workArea = ownedWorkArea(home)
      lifecycleFile = join(workArea.artifactDir, 'lifecycle.safe.json')
      resultFile = join(workArea.artifactDir, 'result.safe.json')
      const runId = randomUUID()
      suiteResult.runId = runId

      currentPhase('preflight-state-existence')
      const presence = statePresenceAudit(home)
      suiteResult.stateAudit = presence
      if (Object.values(presence).some(Boolean)) throw new Error('unknown pre-existing state')
      const distPresent = existsSync(join(root, 'packages', 'workbench', 'dist', 'index.html'))
      suiteResult.workbenchDistPresent = distPresent
      if (!distPresent) throw new Error('workbench dist unavailable')

      manifest = { rootLabel: 'approved-s1-home', runId, createdPaths: [...STATE_PATHS] }
      manifestFile = join(workArea.artifactDir, 'ownership-manifest.json')
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
      audit({ event: 'ownership-manifest-created', homeTag: manifest.rootLabel, details: { runId, pathCount: manifest.createdPaths.length } })

      currentPhase('artifact-bundles')
      const bundles = await prepareRealBundles(workArea.artifactDir)
      currentPhase('real-stage-start')
      stage = await startRealStage({ home, stageFile: bundles.stageFile, audit })
      const stageUrl = new URL(stage.url)
      stageOrigin = stageUrl.origin
      const preflightChecks: Record<string, boolean> = {}
      preflightChecks.stageReady = Boolean(stage.child.pid && stageUrl.protocol === 'http:')
      expect(preflightChecks.stageReady, 'preflight:stage_ready').toBe(true)
      preflightChecks.crossSiteAliasDiffers = !stageUrl.hostname.endsWith('.test') && stageUrl.hostname !== alias
      expect(preflightChecks.crossSiteAliasDiffers, 'preflight:cross_site_alias_differs').toBe(true)
      suiteResult.preflightChecks = preflightChecks

      currentPhase('cross-site-host-and-paper-venue')
      hostHtml = { value: '<!doctype html><title>S1 waiting</title>' }
      host = await listenTestHost(stageUrl.hostname, alias, hostHtml)
      const allowed = await stage.run(`k.config.embed.allowedOrigins = [${JSON.stringify(host.origin)}]; return k.config.embed.allowedOrigins.length === 1`)
      preflightChecks.hostOriginAllowed = allowed === true
      expect(preflightChecks.hostOriginAllowed, 'preflight:host_origin_allowed').toBe(true)
      const pin = ephemeralPin()
      const setup = await stage.run(`
        if (k.pin.isSet()) throw new Error('test home PIN is already set')
        const proof = await k.auth.setupPinLocalTerminal(${JSON.stringify(pin)})
        k.keystore.unlock(proof)
        const paperAccount = k.accounts.list().find((account) => account.mode === 'paper')?.accountId
        if (!paperAccount) throw new Error('paper account unavailable')
        const key = k.agents.createKey({ name: 's1-real-gate', host: 'other', tier: 'paper',
          mandate: { accounts: [paperAccount] } }, proof,
          { actor: 'user:usr_local', actorType: 'human', tool: 's1:setup', via: 'cli', requestId: ${JSON.stringify(randomUUID())} })
        return { paperAccount, agentToken: key.token }
      `)
      if (!setup?.paperAccount || !setup?.agentToken) throw new Error('paper venue setup unavailable')
      paperAccountId = setup.paperAccount
      paperAgentToken = setup.agentToken
      testPin = pin
      currentPhase('same-stage-mcp-start')
      mcp = await connectSameStageMcp({ home, mcpFile: bundles.mcpFile, agentToken: setup.agentToken, audit })

      currentPhase('cross-site-browser-start')
      const bootUrl = await stage.boot()
      bootToken = new URL(bootUrl).searchParams.get('launch')
      if (!bootToken) throw new Error('initial boot launch missing')
      initialChartRoute = '#/overview'
      const frameUrl = entryUrl(bootUrl, initialChartRoute)
      if (!hostHtml) throw new Error('cross-site host document unavailable')
      hostHtml.value = embeddedHostHtml(frameUrl)
      cdp = await BrowserCdp.launch(workArea.artifactDir, stageUrl.hostname, alias, audit)
      hostTarget = await cdp.createPage(`${host.origin}/`)
      hostTop = await contextUntil(() => cdp!.contextFor(host!.origin, new Set(), hostTarget.targetId), 'cross-site host document')
      parent = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set()), 'embedded workbench document')
      await pageTrue(parent, "document.documentElement.dataset.kernel === 'open' && !!document.querySelector('[data-g5-page]')", 'embedded workbench online')
      parentToken = await authToken(parent, 'initial embedded auth')
      initialSessionCount = await stage.run('return k.auth.sessionCount')
      startupEvidence.parentMode = await captureMode(parent)
      startupEvidence.parentTokens = await tokenEvidence(parent, parentToken, bootToken)
      startupEvidence.hostTokens = await tokenEvidence(hostTop, parentToken, bootToken)
      suiteResult.setupStatus = 'PASS'
      currentPhase('ready')
      console.info('[S1-D2] SETUP PASS')
      for (const gate of GATES) gateResults[gate].phase = 'ready'
    } catch (error) {
      suiteResult.setupStatus = 'FAIL'
      suiteResult.setupErrorType = errorType(error)
      suiteResult.phase = phase
      console.info(`[S1-D2] SETUP FAIL phase=${phase} errorType=${errorType(error)}`)
      audit({ event: 'setup-failed', details: { phase, errorType: errorType(error) } })
      throw new Error(`S1 D2 setup failed at ${phase} (${errorType(error)})`)
    }
  }, 180000)

  it('② preserves the single original session across detach, refresh, and dock', async () => {
    await runGate('②', 'session-and-recovery', async () => {
      if (!cdp || !stage || !parent || !hostTop || !parentToken || !bootToken || initialSessionCount === null || !stageOrigin) throw new Error('setup state unavailable')
      safeAssert('②', 'initial_boot_created_one_session', initialSessionCount, 1)
      const initialMode = await captureMode(parent)
      safeAssert('②', 'parent_started_docked', initialMode.mode, 'docked')
      safeAssert('②', 'parent_button_unpressed', initialMode.pressed, 'false')
      safeAssert('②', 'parent_semantic_label', initialMode.label, '独立模式')

      const partitionCanary = randomUUID()
      await pageEval(parent, `localStorage.setItem('s1.partition.canary', ${JSON.stringify(partitionCanary)}); true`)
      const clicked = await clickRealElement(parent, 'button[data-act="standalone"]')
      safeAssert('②', 'detach_real_button_clicked', clicked)
      const parentBeforeDetach = parent
      let child = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([parentBeforeDetach.target.targetId])), 'detached child document')
      await pageTrue(child, "document.documentElement.dataset.mode === 'standalone' && document.documentElement.dataset.kernel === 'open'", 'detached child online')
      const childToken = await authToken(child, 'detached child auth')
      safeAssert('②', 'detach_reused_auth_token', sameSecret(childToken, parentToken))
      let currentCount = await stage.run('return k.auth.sessionCount')
      safeAssert('②', 'detach_did_not_create_session', currentCount, initialSessionCount)
      const sessionCounts = { initial: initialSessionCount, afterDetach: currentCount, afterChildRefresh: -1, afterParentIframeRefresh: -1, afterDock: -1 }
      const partitioned = await pageEval(child, `localStorage.getItem('s1.partition.canary') !== ${JSON.stringify(partitionCanary)}`)
      safeAssert('②', 'cross_site_storage_partitioned', partitioned)
      const peerMode = await captureMode(parent)
      safeAssert('②', 'parent_peer_marker_present', peerMode.peer)
      safeAssert('②', 'parent_peer_button_pressed', peerMode.pressed, 'true')
      safeAssert('②', 'parent_peer_card_button_present', peerMode.peerButton)
      safeAssert('②', 'parent_peer_card_button_pressed', peerMode.peerButtonPressed, 'true')
      safeAssert('②', 'child_button_pressed', (await captureMode(child)).pressed, 'true')
      startupEvidence.childTokens = await tokenEvidence(child, childToken, bootToken)
      startupEvidence.childTopHistory = await navigationEvidence(child, childToken, bootToken)
      recordStableWebSocketCounts('initial-detach-online', parent, child, stageOrigin)

      const oldChildContext = child.contextId
      const oldChildAuthCount = cdp.authFrames.length
      await pageEval(child, 'location.reload(); true')
      child = await contextUntil(() => {
        const next = cdp!.contextFor(stageOrigin!, new Set([parent!.target.targetId]))
        return next && next.contextId !== oldChildContext ? next : null
      }, 'child refresh document')
      await pageTrue(child, "document.documentElement.dataset.mode === 'standalone' && document.documentElement.dataset.kernel === 'open'", 'child refresh online')
      safeAssert('②', 'child_refresh_removed_relink_hint', await pageEval(child, "!document.getElementById('gitrader-relink-hint')"))
      const childRefreshToken = await refreshedAuthToken(child, oldChildAuthCount, 'child refresh auth')
      safeAssert('②', 'child_refresh_reused_auth_token', sameSecret(childRefreshToken, parentToken))
      currentCount = await stage.run('return k.auth.sessionCount')
      safeAssert('②', 'child_refresh_did_not_create_session', currentCount, initialSessionCount)
      sessionCounts.afterChildRefresh = currentCount
      refreshedEvidence.childTokens = await tokenEvidence(child, childRefreshToken, bootToken)
      refreshedEvidence.childTopHistory = await navigationEvidence(child, childRefreshToken, bootToken)
      recordStableWebSocketCounts('child-refresh-online', parent, child, stageOrigin, { parent: null, child: oldChildContext })

      const oldParentContext = parent.contextId
      const oldParentAuthCount = cdp.authFrames.length
      await pageEval(parent, 'location.reload(); true')
      parent = await contextUntil(() => {
        const next = cdp!.contextFor(stageOrigin!, new Set([child!.target.targetId]), parent!.target.targetId)
        return next && next.contextId !== oldParentContext ? next : null
      }, 'parent iframe refresh document')
      await pageTrue(parent, "document.documentElement.dataset.mode === 'docked' && !!document.querySelector('[data-standalone-peer=on]')", 'parent refresh yields to child')
      await pageTrue(parent, "document.documentElement.dataset.kernel === 'open'", 'parent refresh kernel connected')
      safeAssert('②', 'parent_refresh_removed_relink_hint', await pageEval(parent, "!document.getElementById('gitrader-relink-hint')"))
      const parentRefreshToken = await refreshedAuthToken(parent, oldParentAuthCount, 'parent iframe refresh auth')
      safeAssert('②', 'parent_refresh_reused_auth_token', sameSecret(parentRefreshToken, parentToken))
      currentCount = await stage.run('return k.auth.sessionCount')
      safeAssert('②', 'parent_refresh_did_not_create_session', currentCount, initialSessionCount)
      sessionCounts.afterParentIframeRefresh = currentCount
      refreshedEvidence.parentTokens = await tokenEvidence(parent, parentRefreshToken, bootToken)
      refreshedEvidence.hostTokens = await tokenEvidence(hostTop, parentRefreshToken, bootToken)
      refreshedEvidence.parentFrameHistory = await navigationEvidence(parent, parentRefreshToken, bootToken)
      refreshedEvidence.hostTopHistory = await navigationEvidence(hostTop, parentRefreshToken, bootToken)
      recordStableWebSocketCounts('parent-iframe-refresh-online', parent, child, stageOrigin, { parent: oldParentContext, child: null })

      const dockDiagnostic: Record<string, unknown> = {}
      const parentMessageHook = await pageEval(parent, `(() => {
        const state = { startedAt: performance.now(), records: [], lastPingSource: null, lastPingPair: null };
        window.__s1DockDiagnostic = state;
        window.addEventListener('message', (event) => {
          const data = event.data;
          if (!data || !['ready', 'ping', 'dock'].includes(data.gr) || state.records.length >= 32) return;
          const sourceClosed = (() => { try { return event.source ? Boolean(event.source.closed) : null } catch { return true } })();
          state.records.push({
            gr: data.gr,
            from: ['standalone', 'docked'].includes(data.from) ? data.from : 'other',
            sameOrigin: event.origin === location.origin,
            sourceNull: event.source === null,
            sourceClosed,
            relativeMs: Math.round(performance.now() - state.startedAt),
            sameAsLastPingSource: state.lastPingSource === null ? null : event.source === state.lastPingSource,
            sameAsLastPingPair: state.lastPingPair === null ? null : data.pairId === state.lastPingPair
          });
          if (data.gr === 'ping') { state.lastPingSource = event.source; state.lastPingPair = data.pairId ?? null }
        });
        return true;
      })()`)
      dockDiagnostic.parentMessageHookInstalled = parentMessageHook === true
      const childBeforeClick = await pageEval(child, `(() => {
        const button = [...document.querySelectorAll('button[data-act="standalone"]')].find((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        }) ?? null;
        const rect = button?.getBoundingClientRect();
        const x = rect ? rect.left + rect.width / 2 : -1;
        const y = rect ? rect.top + rect.height / 2 : -1;
        return {
          mode: document.documentElement.dataset.mode ?? null,
          kernel: document.documentElement.dataset.kernel ?? null,
          buttonPresent: Boolean(button),
          buttonVisible: Boolean(button && rect && rect.width > 0 && rect.height > 0),
          disabled: button ? Boolean(button.disabled) : null,
          ariaDisabled: button?.getAttribute('aria-disabled') ?? null,
          pressed: button?.getAttribute('aria-pressed') ?? null,
          centerInViewport: Boolean(rect && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight),
          elementFromPointMatches: Boolean(button && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y) === button),
          modeButtons: [...document.querySelectorAll('button[data-act="standalone"]')].map((candidate, index) => {
            const candidateRect = candidate.getBoundingClientRect();
            const style = getComputedStyle(candidate);
            const centerX = candidateRect.left + candidateRect.width / 2;
            const centerY = candidateRect.top + candidateRect.height / 2;
            const hit = centerX >= 0 && centerY >= 0 && centerX < innerWidth && centerY < innerHeight ? document.elementFromPoint(centerX, centerY) : null;
            const hitElement = hit instanceof Element ? hit : null;
            const allowedClasses = ['g5-ri', 'g5-tbi'];
            const allowedActions = ['standalone', 'settings'];
            const safeElement = (element) => element ? {
              tag: element.tagName.toLowerCase(),
              classes: [...element.classList].filter((name) => allowedClasses.includes(name)),
              dataAct: allowedActions.includes(element.getAttribute('data-act') ?? '') ? element.getAttribute('data-act') : null
            } : null;
            return {
              index,
              rect: { x: candidateRect.x, y: candidateRect.y, width: candidateRect.width, height: candidateRect.height },
              computed: { display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents },
              disabled: Boolean(candidate.disabled),
              classes: [...candidate.classList].filter((name) => allowedClasses.includes(name)),
              dataAct: allowedActions.includes(candidate.getAttribute('data-act') ?? '') ? candidate.getAttribute('data-act') : null,
              centerHit: {
                ...safeElement(hitElement),
                closestModeButton: Boolean(hitElement?.closest('button[data-act="standalone"]')),
                selectedButtonContains: Boolean(hitElement && candidate.contains(hitElement))
              }
            };
          })
        };
      })()`)
      dockDiagnostic.childBeforeClick = childBeforeClick
      const childClickHook = await pageEval(child, `(() => {
        const state = { count: 0, isTrusted: null, insideModeButton: null, clientX: null, clientY: null, target: null };
        window.__s1DockChildClick = state;
        document.addEventListener('click', (event) => {
          state.count += 1;
          state.target = event.target instanceof Element ? event.target : null;
          state.clientX = event.clientX;
          state.clientY = event.clientY;
          const button = [...document.querySelectorAll('button[data-act="standalone"]')].find((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          }) ?? null;
          state.isTrusted = event.isTrusted;
          state.insideModeButton = Boolean(button && event.target instanceof Node && button.contains(event.target));
        }, true);
        return true;
      })()`)
      dockDiagnostic.childClickHookInstalled = childClickHook === true
      const dockClickTrace: ClickTrace = { selectorIndex: null, sendPoint: null }
      try {
        gatePhase('②', 'dock-before-input')
        try {
          const screenshot = await cdp!.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, child.target.sessionId)
          if (typeof screenshot.data === 'string' && workArea) {
            childDockScreenshotFile = join(workArea.artifactDir, 'd2-d2-child-dock.png')
            writeFileSync(childDockScreenshotFile, Buffer.from(screenshot.data, 'base64'))
            dockDiagnostic.screenshotCaptured = true
          } else dockDiagnostic.screenshotCaptured = false
        } catch (error) {
          dockDiagnostic.screenshotCaptured = false
          dockDiagnostic.screenshotErrorType = errorType(error)
        }
        const dockClicked = await clickRealElement(child, 'button[data-act="standalone"]', dockClickTrace)
        dockDiagnostic.helperClickTrace = dockClickTrace
        safeAssert('②', 'child_dock_real_button_clicked', dockClicked)
        gatePhase('②', 'dock-wait-parent')
        parent = await contextUntil(async () => {
          const next = cdp!.contextFor(stageOrigin!, new Set([child!.target.targetId]), parent!.target.targetId)
          if (!next) return null
          const mode = await captureMode(next)
          return mode.mode === 'docked' && !mode.peer ? next : null
        }, 'parent restored after dock')
      } finally {
        try {
          const messages = await pageEval(parent, `JSON.stringify(window.__s1DockDiagnostic?.records ?? [])`)
          dockDiagnostic.parentMessages = typeof messages === 'string' ? messages : 'unavailable'
        } catch { dockDiagnostic.parentMessages = 'unavailable' }
        try {
          const mode = await captureMode(parent)
          dockDiagnostic.parentAfterClick = { mode: mode.mode, peer: mode.peer, button: mode.button, disabled: mode.disabled }
        } catch { dockDiagnostic.parentAfterClick = 'unavailable' }
        try {
          const liveChild = cdp?.contextFor(stageOrigin!, new Set(), child.target.targetId)
          if (!liveChild) {
            dockDiagnostic.childClosed = true
            dockDiagnostic.childAfterClick = 'unreadable'
          } else {
            dockDiagnostic.childClosed = false
            try {
              const childMode = await captureMode(liveChild)
              const childClick = await pageEval(liveChild, `(() => {
                const state = window.__s1DockChildClick;
                const buttons = [...document.querySelectorAll('button[data-act="standalone"]')];
                const selected = Number.isInteger(${JSON.stringify(dockClickTrace.selectorIndex)}) ? buttons[${JSON.stringify(dockClickTrace.selectorIndex)}] : null;
                const target = state?.target instanceof Element ? state.target : null;
                const allowedClasses = ['g5-ri', 'g5-tbi'];
                const allowedActions = ['standalone', 'settings'];
                return JSON.stringify({
                  count: state?.count ?? null,
                  isTrusted: state?.isTrusted ?? null,
                  insideModeButton: state?.insideModeButton ?? null,
                  clientX: state?.clientX ?? null,
                  clientY: state?.clientY ?? null,
                  target: target ? {
                    tag: target.tagName.toLowerCase(),
                    classes: [...target.classList].filter((name) => allowedClasses.includes(name)),
                    dataAct: allowedActions.includes(target.getAttribute('data-act') ?? '') ? target.getAttribute('data-act') : null
                  } : null,
                  closestModeButton: Boolean(target?.closest('button[data-act="standalone"]')),
                  selectedButtonContainsTarget: Boolean(selected && target && selected.contains(target))
                });
              })()`)
              dockDiagnostic.childAfterClick = {
                click: typeof childClick === 'string' ? childClick : 'unavailable',
                mode: childMode.mode,
                disabled: childMode.disabled,
                button: childMode.button
              }
            } catch { dockDiagnostic.childAfterClick = 'unreadable' }
          }
        } catch {
          dockDiagnostic.childClosed = true
          dockDiagnostic.childAfterClick = 'unreadable'
        }
        gateResults['②'].observations.dockDiagnostic = JSON.stringify(dockDiagnostic)
      }
      currentCount = await stage.run('return k.auth.sessionCount')
      safeAssert('②', 'dock_did_not_create_session', currentCount, initialSessionCount)
      sessionCounts.afterDock = currentCount
      dockedEvidence.parentTokens = await tokenEvidence(parent, parentToken, bootToken)
      dockedEvidence.hostTokens = await tokenEvidence(hostTop, parentToken, bootToken)
      dockedEvidence.parentFrameHistory = await navigationEvidence(parent, parentToken, bootToken)
      dockedEvidence.hostTopHistory = await navigationEvidence(hostTop, parentToken, bootToken)
      dockedEvidence.sessionCount = currentCount
      gateResults['②'].counts = sessionCounts
    })
  }, 180000)

  it('③ verifies a same-kernel MCP paper fill in the real P1 positions DOM', async () => {
    await runGate('③', 'mcp-paper-order-to-p1-dom', async () => {
      if (!cdp || !parent || !stage || !mcp || !paperAccountId || !stageOrigin || !parentToken) throw new Error('paper DOM gate setup unavailable')
      currentPhase('gate3-parent-recovery')
      await restoreParentFromLiveChild('③', 'parent recovered before P1 child gate')
      currentPhase('gate3-parent-overview')
      await pageEval(parent, "location.hash='#/overview'; true")
      await pageTrue(parent, "document.querySelector('[data-g5-page=overview][data-view=positions]')", 'parent real P1 positions page')
      const sessionBeforeDetach = await stage.run('return k.auth.sessionCount')
      currentPhase('gate3-parent-separation-click')
      safeAssert('③', 'parent_separation_real_button_clicked', await clickRealElement(parent, 'button[data-act="standalone"]'))
      const parentTargetId = parent.target.targetId
      currentPhase('gate3-child-context-online')
      const child = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([parentTargetId])), 'P1 standalone child context')
      await pageTrue(child, "document.documentElement.dataset.mode==='standalone' && document.documentElement.dataset.kernel==='open'", 'P1 standalone child online')
      gateThreeChild = child
      safeAssert('③', 'child_actual_standalone_mode', (await captureMode(child)).mode, 'standalone')
      const yieldedParentMode = await captureMode(parent)
      safeAssert('③', 'parent_peer_yielded', yieldedParentMode.peer)
      safeAssert('③', 'parent_peer_card_button_present', yieldedParentMode.peerButton)
      safeAssert('③', 'parent_peer_card_button_pressed', yieldedParentMode.peerButtonPressed, 'true')
      const childToken = await authToken(child, 'P1 standalone child auth')
      safeAssert('③', 'child_reused_original_session_token', sameSecret(childToken, parentToken))
      const sessionAfterDetach = await stage.run('return k.auth.sessionCount')
      safeAssert('③', 'detach_did_not_create_session', sessionAfterDetach, sessionBeforeDetach)
      currentPhase('gate3-child-positions-page')
      await pageEval(child, "location.hash='#/overview'; true")
      await pageTrue(child, "document.querySelector('[data-g5-page=overview][data-view=positions]')", 'real P1 positions page in child')
      const rowKey = `${paperAccountId}|hyperliquid:BTC|long`
      const rowSelector = `[data-tab=positions] tr.g5-paper[data-row=${JSON.stringify(rowKey)}]`
      let before: PositionSnapshot | null = null
      let orderId: string | null = null
      let filledSize: string | null = null
      let mcpRoundTripMs: number | null = null
      let domObservedMs: number | null = null
      let domLatencyMs: number | null = null
      let after: PositionSnapshot | null = null
      let lastSnapshot: PositionSnapshot | null = null
      try {
        before = await positionSnapshot(child, rowSelector)
        // 夹具：回放行情只在有人订阅时才推，纸面标记价偶尔超过 5 s 过期线（STALE_PRICE）而被风控拒；只在「拒绝原因就是 STALE_PRICE」时等行情再下，
        // 其余任何拒绝原样判红；计时只取最后一次调用。
        let startedAt = Date.now()
        let reply: Awaited<ReturnType<typeof mcp.client.callTool>> | null = null
        for (let attempt = 0; attempt < 6; attempt += 1) {
          startedAt = Date.now()
          reply = await mcp.client.callTool({ name: 'order', arguments: {
              action: 'place', intent: { accountId: paperAccountId, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', leverage: 2, reason: 'S1 real paper DOM verification' },
            } }).finally(() => { mcpRoundTripMs = Date.now() - startedAt })
          const attemptOrder = textResult(reply)?.order
          if (!(attemptOrder?.status === 'denied' && attemptOrder?.problem?.name === 'STALE_PRICE')) break
          gateResults['③'].observations.stalePriceRetries = attempt + 1
          await pause(1000)
        }
        if (!reply) throw new Error('mcp order reply unavailable')
        const returnedAt = Date.now()
        const placed = textResult(reply)
        orderId = typeof placed?.order?.orderId === 'string' ? placed.order.orderId : null
        filledSize = typeof placed?.order?.filledSize === 'string' ? placed.order.filledSize : null
        // 没成交时留下安全枚举（状态 / 问题名 / 风控命中码），好判定是限流、风控还是夹具；不含 id、金额。
        const enumOf = (value: unknown) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null)
        const problem = (placed as any)?.problem ?? (placed as any)?.error ?? null
        gateResults['③'].observations.orderReply = JSON.stringify({
          isError: (reply as any)?.isError === true, orderStatus: enumOf(placed?.order?.status), topKeys: Object.keys(placed ?? {}).slice(0, 8).map(enumOf),
          orderKeys: Object.keys(placed?.order ?? {}).slice(0, 40).map(enumOf),
          orderProblem: (() => { const p = (placed as any)?.order?.problem; return p ? { name: enumOf(p.name), code: typeof p.code === 'number' ? p.code : enumOf(p.code), hits: Array.isArray(p.ruleHits) ? p.ruleHits.slice(0, 8).map((hit: any) => ({ code: enumOf(hit?.code), action: enumOf(hit?.action), scope: enumOf(hit?.scope) })) : [] } : null })(),
          orderHits: Array.isArray((placed as any)?.order?.ruleHits) ? (placed as any).order.ruleHits.slice(0, 8).map((hit: any) => ({ code: enumOf(hit?.code), action: enumOf(hit?.action), scope: enumOf(hit?.scope) })) : null,
          problemName: enumOf(problem?.name), problemCode: typeof problem?.code === 'number' ? problem.code : enumOf(problem?.code),
          ruleCodes: Array.isArray(problem?.ruleHits) ? problem.ruleHits.slice(0, 8).map((hit: any) => enumOf(hit?.code)) : [],
        })
        safeAssert('③', 'mcp_returned_real_filled_order', placed?.order?.status === 'filled' && orderId !== null)
        safeAssert('③', 'filled_size_is_decimal_string', typeof filledSize === 'string' && normalizeDecimal(filledSize) !== null)
        currentPhase('gate3-child-p1-dom-update')
        const observeStartedAt = Date.now()
        try {
          after = await until(async () => {
            const snapshot = await positionSnapshot(child, rowSelector)
            lastSnapshot = snapshot
            if (snapshot.rowCount === 1 && typeof snapshot.quantity === 'string' && normalizeDecimal(snapshot.quantity) === normalizeDecimal(filledSize)) {
              domLatencyMs = Date.now() - returnedAt
              return snapshot
            }
            return null
          }, 1000, 'real P1 filled position row')
        } catch { /* direct assertions below retain the actual last snapshot */ }
        finally { domObservedMs = Date.now() - observeStartedAt }
        safeAssert('③', 'p1_real_position_row_count', after?.rowCount ?? null, 1)
        safeAssert('③', 'p1_position_quantity_matches_fill', normalizeDecimal(after?.quantity ?? ''), normalizeDecimal(filledSize))
        safeAssert('③', 'mcp_return_to_dom_latency_under_1s', domLatencyMs !== null && domLatencyMs <= 1000)
        currentPhase('gate3-same-kernel-ledger')
        const accepted = await stage.run(`return k.ledger.query({ limit:500 }).some((event) => event.type==='order.accepted' && event.subject?.orderId===${JSON.stringify(orderId)})`)
        safeAssert('③', 'same_kernel_order_accepted_ledger', accepted === true)
      } finally {
        const safeSnapshot = (snapshot: PositionSnapshot | null) => snapshot ? { ...snapshot, visibleError: safeDiagnosticText(snapshot.visibleError, orderId ? [orderId] : []) } : null
        const snapshots = { before: safeSnapshot(before), after: safeSnapshot(after), last: safeSnapshot(lastSnapshot) }
        const counts: Record<string, number> = {}
        if (before) { counts.rowCountBefore = before.rowCount; counts.totalRowsBefore = before.totalRows; counts.paperRowsBefore = before.paperRows }
        if (after) { counts.rowCountAfter = after.rowCount; counts.totalRowsAfter = after.totalRows; counts.paperRowsAfter = after.paperRows }
        gateResults['③'].counts = counts
        gateResults['③'].observations.positionDiagnostic = JSON.stringify({ snapshots, filledSize, mcpRoundTripMs, domObservedMs, domLatencyMs, childStandalone: true, parentPeer: yieldedParentMode.peer, sameSession: sessionAfterDetach === sessionBeforeDetach })
      }
    })
  }, 30000)

  it('④ preserves real Chart controls and blockCfg through detach, refresh, and dock', async () => {
    await runGate('④', 'real-chart-config-and-refreshes', async () => {
      if (!cdp || !stage || !parent || !stageOrigin) throw new Error('Chart recovery setup unavailable')
      const parentBeforeGate4Restore = parent
      currentPhase('gate4-parent-restore-from-gate3-child')
      if (!gateThreeChild) {
        gateResults['④'].observations.missingEvidence = 'gate3-real-child-context'
        throw new Error('gate 3 child context dependency missing')
      }
      const gate3Mode = await captureMode(gateThreeChild)
      if (gate3Mode.mode !== 'standalone') {
        gateResults['④'].observations.missingEvidence = 'gate3-child-not-standalone'
        throw new Error('gate 3 child is not in standalone mode')
      }
      safeAssert('④', 'gate3_child_real_redock_clicked', await clickRealElement(gateThreeChild, 'button[data-act="standalone"]'))
      const gate3ChildTargetId = gateThreeChild.target.targetId
      parent = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([gate3ChildTargetId]), parentBeforeGate4Restore.target.targetId), 'parent restored from gate 3 child')
      await pageTrue(parent, "document.documentElement.dataset.mode==='docked' && !document.querySelector('[data-standalone-peer=on]') && !!document.querySelector('[data-g5-page]')", 'parent restored from real gate 3 child')
      safeAssert('④', 'gate3_child_really_docked', (await captureMode(parent)).mode, 'docked')
      gateThreeChild = null
      currentPhase('gate4-chart-page')
      await pageEval(parent, `location.hash=${JSON.stringify(chartRoute)}; true`)
      await pageTrue(parent, "document.querySelector('[data-g5-page=chart]')", 'parent real Chart before detach')
      currentPhase('gate4-parent-interval-control-select-readback')
      const chartDeadline = Date.now() + 10000
      let parentChartSnapshot: ChartUiSnapshot | null = null
      let parentCandleEvidence: ReturnType<typeof marketCandleFrameEvidence> | null = null
      try {
        const readySnapshot = await until(async () => {
          const snapshot = await chartUiSnapshot(parent!, chartRoute)
          parentChartSnapshot = snapshot
          const oneHour = snapshot.intervals.find((control) => control.period === '1h')
          return oneHour?.exists && oneHour.disabled === false ? snapshot : null
        }, Math.max(0, chartDeadline - Date.now()), 'parent 1h Chart control ready')
        if (!readySnapshot) throw new Error('parent 1h Chart control ready unavailable')
        safeAssert('④', 'parent_chart_route_matches_expected', readySnapshot.routeExpected)
        safeAssert('④', 'parent_1h_chart_control_enabled', readySnapshot.intervals.find((control) => control.period === '1h')?.disabled === false)
        await pageEval(parent, "document.querySelector('[data-g5-page=chart] [data-iv=\\\"1h\\\"]')?.click(); true")
        await until(() => chartIntervalUi(parent!).then((value) => value === '1h'), Math.max(0, chartDeadline - Date.now()), 'parent 1h Chart interval')
        safeAssert('④', 'parent_1h_chart_control_selected', await chartIntervalUi(parent) === '1h')
      } finally {
        try { parentChartSnapshot = await chartUiSnapshot(parent, chartRoute) } catch { /* preserve the original Chart gate error */ }
        const expectedInstrument = decodeURIComponent(chartRoute.slice('#/chart/'.length))
        parentCandleEvidence = marketCandleFrameEvidence(parent, expectedInstrument)
        const snapshot = parentChartSnapshot ? {
          ...parentChartSnapshot,
          wireError: safeDiagnosticText(parentChartSnapshot.wireError),
          visibleError: safeDiagnosticText(parentChartSnapshot.visibleError),
        } : null
        gateResults['④'].observations.parentChartLoad = JSON.stringify({ snapshot, candleFrames: parentCandleEvidence })
      }
      currentPhase('gate4-parent-marker-menu-select-readback')
      await toggleRealMarker(parent, 'human')
      await until(() => markerEvidence(parent!).then((value) => markersMatch(value, ['human'])), 10000, 'parent human marker filter')
      const beforeDetach = await chartConfigEvidence(parent)
      safeAssert('④', 'parent_before_detach_chart_config', chartConfigMatches(beforeDetach, '1h', ['human']))
      currentPhase('gate4-session-count-before-detach')
      const sessionBefore = await stage.run('return k.auth.sessionCount')
      currentPhase('gate4-parent-detach-click')
      const detach = await clickRealElement(parent, 'button[data-act="standalone"]')
      safeAssert('④', 'detach_real_button_clicked', detach)
      const parentTargetId = parent.target.targetId
      currentPhase('gate4-child-context-and-chart')
      let child = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([parentTargetId])), 'child Chart context')
      await pageTrue(child, "document.documentElement.dataset.mode==='standalone' && !!document.querySelector('[data-g5-page=chart]')", 'child Chart mounted')
      currentPhase('gate4-child-interval-control-readback')
      await until(() => chartIntervalUi(child).then((value) => value === '1h'), 10000, 'child initial Chart interval')
      const childInitial = await chartConfigEvidence(child)
      safeAssert('④', 'child_initial_real_chart_config', chartConfigMatches(childInitial, '1h', ['human']))
      safeAssert('④', 'parent_peer_yields_workspace', await pageEval(parent, "document.documentElement.dataset.mode==='docked' && !!document.querySelector('[data-standalone-peer=on]') && !document.querySelector('[data-g5-page]')"))
       const countAfterDetach = await stage.run('return k.auth.sessionCount')
       safeAssert('④', 'detach_kept_original_session', countAfterDetach, sessionBefore)

      currentPhase('gate4-child-interval-select-readback')
      await pageEval(child, "document.querySelector('[data-g5-page=chart] [data-iv=\\\"4h\\\"]')?.click(); true")
      await until(() => chartIntervalUi(child).then((value) => value === '4h'), 10000, 'child 4h Chart interval')
      currentPhase('gate4-child-marker-menu-select-readback')
      await toggleRealMarker(child, 'agent')
      await until(() => markerEvidence(child).then((value) => markersMatch(value, ['human', 'agent'])), 10000, 'child agent marker filter')
      const childModified = await chartConfigEvidence(child)
      safeAssert('④', 'child_modified_real_chart_config', chartConfigMatches(childModified, '4h', ['human', 'agent']))
      currentPhase('gate4-child-overview-before-refresh')
      await pageEval(child, "location.hash='#/overview'; true")
      await pageTrue(child, "document.querySelector('[data-g5-page=overview][data-view=positions]')", 'real P1 positions before child refresh')
      const childOldContext = child.contextId
      currentPhase('gate4-child-refresh')
      await pageEval(child, 'location.reload(); true')
      child = await contextUntil(() => {
        const next = cdp!.contextFor(stageOrigin!, new Set([parentTargetId]), child.target.targetId)
        return next && next.contextId !== childOldContext ? next : null
      }, 'child refreshed context')
      currentPhase('gate4-child-refresh-auth-and-chart-readback')
      await pageTrue(child, "document.documentElement.dataset.mode==='standalone' && location.hash==='#/overview'", 'child refresh route and mode')
      const childToken = await authToken(child, 'child refresh auth')
      safeAssert('④', 'child_refresh_reused_session_token', sameSecret(childToken, parentToken))
      await pageEval(child, `location.hash=${JSON.stringify(chartRoute)}; true`)
      await until(() => chartIntervalUi(child).then((value) => value === '4h'), 10000, 'child refreshed 4h Chart interval').catch(async (error) => {
        gateResults['④'].observations.childRefreshDiag = JSON.stringify(await pageEval(child, `(() => { let prefs = null; try { const p = JSON.parse(localStorage.getItem('gitrader.prefs') ?? 'null'); prefs = p ? { blockCfg: p.blockCfg ?? null } : null } catch { prefs = 'unreadable' }
          return { hash: location.hash, mode: document.documentElement.dataset.mode ?? null, kernel: document.documentElement.dataset.kernel ?? null, ivSelected: document.querySelector('[data-g5-page=chart] [data-iv][aria-selected=true]')?.getAttribute('data-iv') ?? null,
            ivCount: document.querySelectorAll('[data-g5-page=chart] [data-iv]').length, visibleError: (document.querySelector('[data-g5-page=chart] .g5-msg, [data-g5-page=chart] [role=alert]')?.textContent ?? '').trim().slice(0, 120), pages: [...document.querySelectorAll('[data-g5-page]')].map((n) => n.getAttribute('data-g5-page')), prefs } })()`).catch(() => null))
        throw error
      })
      const childRefresh = await chartConfigEvidence(child)
      safeAssert('④', 'child_refresh_real_chart_config', chartConfigMatches(childRefresh, '4h', ['human', 'agent']))
      refreshedEvidence.d2bChildTokens = await tokenEvidence(child, childToken, bootToken!)
      refreshedEvidence.d2bChildTopHistory = await navigationEvidence(child, childToken, bootToken!)
      await pageEval(child, "location.hash='#/overview'; true")
      await pageTrue(child, "document.querySelector('[data-g5-page=overview][data-view=positions]')", 'child overview restored')
       const countAfterChildRefresh = await stage.run('return k.auth.sessionCount')
       safeAssert('④', 'child_refresh_kept_original_session', countAfterChildRefresh, sessionBefore)

      const parentOldContext = parent.contextId
      currentPhase('gate4-parent-iframe-refresh')
      await pageEval(parent, 'location.reload(); true')
      parent = await contextUntil(() => {
        const next = cdp!.contextFor(stageOrigin!, new Set([child.target.targetId]), parent!.target.targetId)
        return next && next.contextId !== parentOldContext ? next : null
      }, 'parent iframe refreshed context')
      currentPhase('gate4-parent-refresh-token-and-deferred-config')
      await pageTrue(parent, "document.documentElement.dataset.mode==='docked' && !!document.querySelector('[data-standalone-peer=on]') && !document.querySelector('[data-g5-page]')", 'parent refresh remains yielded')
      const parentRefreshToken = await authToken(parent, 'parent refresh auth')
      safeAssert('④', 'parent_refresh_reused_session_token', sameSecret(parentRefreshToken, parentToken))
      const parentRefreshConfig = await chartConfigEvidence(parent)
      safeAssert('④', 'parent_refresh_blockcfg_persisted_while_peer', parentRefreshConfig.intervalStored, '4h')
      safeAssert('④', 'parent_refresh_markers_persisted_while_peer', JSON.stringify(parentRefreshConfig.persisted), JSON.stringify(['engine', 'system']))
      safeAssert('④', 'parent_refresh_chart_ui_deferred', parentRefreshConfig.intervalUi, null)
      refreshedEvidence.d2bParentTokens = await tokenEvidence(parent, parentRefreshToken, bootToken!)
      refreshedEvidence.d2bParentFrameHistory = await navigationEvidence(parent, parentRefreshToken, bootToken!)
      refreshedEvidence.d2bHostTopHistory = await navigationEvidence(hostTop!, parentRefreshToken, bootToken!)
       const countAfterParentRefresh = await stage.run('return k.auth.sessionCount')
       safeAssert('④', 'parent_refresh_kept_original_session', countAfterParentRefresh, sessionBefore)
      currentPhase('gate4-child-after-parent-refresh-readback')
      await pageEval(child, `location.hash=${JSON.stringify(chartRoute)}; true`)
      await until(() => chartIntervalUi(child).then((value) => value === '4h'), 10000, 'child Chart after parent refresh')
      const childAfterParentRefresh = await chartConfigEvidence(child)
      safeAssert('④', 'child_chart_after_parent_refresh_persisted', chartConfigMatches(childAfterParentRefresh, '4h', ['human', 'agent']))
      refreshedEvidence.d2bChildAfterParentTokens = await tokenEvidence(child, childToken, bootToken!)
      refreshedEvidence.d2bChildAfterParentHistory = await navigationEvidence(child, childToken, bootToken!)
      currentPhase('gate4-child-dock-click')
      await pageEval(child, "location.hash='#/overview'; true")
      const dock = await clickRealElement(child, 'button[data-act="standalone"]')
      safeAssert('④', 'child_real_dock_clicked', dock)
      parent = await contextUntil(async () => {
        const next = cdp!.contextFor(stageOrigin!, new Set([child.target.targetId]), parent!.target.targetId)
        if (!next) return null
        const mode = await captureMode(next)
        return mode.mode === 'docked' && !mode.peer ? next : null
      }, 'parent dock restored')
      currentPhase('gate4-parent-chart-after-dock-readback')
      await pageEval(parent, `location.hash=${JSON.stringify(chartRoute)}; true`)
      await until(() => chartIntervalUi(parent!).then((value) => value === '4h'), 10000, 'docked parent 4h Chart interval')
      const parentAfterDock = await chartConfigEvidence(parent)
      safeAssert('④', 'docked_parent_real_chart_config', chartConfigMatches(parentAfterDock, '4h', ['human', 'agent']))
      const dockToken = await authToken(parent, 'docked parent auth')
      safeAssert('④', 'dock_reused_session_token', sameSecret(dockToken, parentToken))
       const countAfterDock = await stage.run('return k.auth.sessionCount')
       safeAssert('④', 'all_chart_recovery_kept_one_session', countAfterDock, sessionBefore)
      dockedEvidence.d2bParentTokens = await tokenEvidence(parent, dockToken, bootToken!)
      dockedEvidence.d2bParentFrameHistory = await navigationEvidence(parent, dockToken, bootToken!)
      dockedEvidence.d2bHostTopHistory = await navigationEvidence(hostTop!, dockToken, bootToken!)
       gateResults['④'].counts = { initial: sessionBefore, afterDetach: countAfterDetach, afterChildRefresh: countAfterChildRefresh, afterParentRefresh: countAfterParentRefresh, afterDock: countAfterDock }
      gateResults['④'].observations = { ...gateResults['④'].observations, beforeDetach: chartConfigMatches(beforeDetach, '1h', ['human']), childInitial: chartConfigMatches(childInitial, '1h', ['human']), childModified: chartConfigMatches(childModified, '4h', ['human', 'agent']), childRefresh: chartConfigMatches(childRefresh, '4h', ['human', 'agent']), parentPeerDeferred: true, childAfterParentRefresh: chartConfigMatches(childAfterParentRefresh, '4h', ['human', 'agent']), parentAfterDock: chartConfigMatches(parentAfterDock, '4h', ['human', 'agent']) }
    })
  }, 180000)

  it('⑤ verifies one approval wins and a delayed real UI approval reports the original kernel error', async () => {
    await runGate('⑤', 'same-ticket-and-delayed-ui-approval', async () => {
      if (!cdp || !stage || !parent || !parentToken || !stageOrigin || !paperAgentToken || !paperAccountId || !testPin) throw new Error('approval gate setup unavailable')
      const approvalEvidence: Record<string, unknown> = {}
      const evidenceSecrets: string[] = []
      let delayedChildForEvidence: CdpContext | null = null
      let delayedUiMessage: unknown = null
      let delayedUiMatches: boolean | null = null
      let delayedKernelError: { code: unknown; name: unknown; message: unknown } | null = null
      let delayedFrameReleased: boolean | null = null
      const saveApprovalEvidence = () => {
        gateResults['⑤'].observations = { ...gateResults['⑤'].observations, approvalEvidence: JSON.stringify(approvalEvidence) }
      }
      const summarizeHttp = (result: { ok?: unknown; statusClass?: unknown; code?: unknown; name?: unknown; kernelStateError?: unknown; attestRequired?: unknown; message?: unknown }) => ({
        ok: result.ok === true,
        statusClass: typeof result.statusClass === 'number' ? result.statusClass : null,
        code: typeof result.code === 'number' ? result.code : null,
        name: safeErrorMarker(result.name),
        kernelStateError: result.kernelStateError === true,
        attestRequired: result.attestRequired === true,
        message: safeDiagnosticText(result.message, evidenceSecrets),
      })
      const rememberProposal = (proposal: { id?: unknown; ticket?: unknown; status?: unknown; verdict?: unknown; ruleHits?: unknown } | null | undefined) => {
        if (typeof proposal?.id === 'string') evidenceSecrets.push(proposal.id)
        if (typeof proposal?.ticket === 'string') evidenceSecrets.push(proposal.ticket)
        const enumOf = (value: unknown) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null)
        const hits = Array.isArray(proposal?.ruleHits) ? (proposal!.ruleHits as Array<{ code?: unknown; action?: unknown; scope?: unknown }>).slice(0, 8)
          .map((hit) => ({ code: enumOf(hit?.code), action: enumOf(hit?.action), scope: enumOf(hit?.scope) })) : []
        // status / verdict / 风控命中码都是安全枚举，不含 id、票号、金额；非 pending 时靠它们判定夹具还是产品问题。
        return { pending: proposal?.status === 'pending', status: enumOf(proposal?.status), verdict: enumOf(proposal?.verdict), ruleHits: hits, idPresent: typeof proposal?.id === 'string', ticketPresent: typeof proposal?.ticket === 'string' }
      }
      currentPhase('gate5-parent-recovery')
      await restoreParentFromLiveChild('⑤', 'parent restored before approval gate')
      currentPhase('gate5-session-count')
      const sessionBefore = await stage.run('return k.auth.sessionCount')
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, sessionBefore }
      approvalEvidence.sessionBefore = sessionBefore
      saveApprovalEvidence()
      currentPhase('gate5-proposal-A-create')
      const first = await createPendingPaperProposal('S1 two-window approval competition')
      const competitionProposalEvidence = [rememberProposal(first)]
      approvalEvidence.competitionProposals = competitionProposalEvidence
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, competitionPendingProposals: Number(first?.status === 'pending') }
      saveApprovalEvidence()
      currentPhase('gate5-proposal-B-anchor-create')
      const firstAnchor = await createPendingPaperProposal('S1 approval competition anchor')
      competitionProposalEvidence.push(rememberProposal(firstAnchor))
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, competitionPendingProposals: competitionProposalEvidence.filter((item) => item.pending).length }
      saveApprovalEvidence()
      safeAssert('⑤', 'competition_proposals_pending', first?.status === 'pending' && firstAnchor?.status === 'pending')
      const firstParentTarget = parent.target.targetId
      currentPhase('gate5-child-ui-competition')
      safeAssert('⑤', 'first_competition_detach_clicked', await clickRealElement(parent, '[data-act=standalone]'))
      let firstChild = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([firstParentTarget])), 'first approval child')
      await pageTrue(firstChild, "document.documentElement.dataset.mode==='standalone' && !!document.querySelector('[data-g5-page]')", 'first approval child online')
      await pageEval(firstChild, `window.dispatchEvent(new CustomEvent('gitrader:focus',{detail:{card:'pending',proposalId:${JSON.stringify(first.id)}}})); true`)
      await pageTrue(firstChild, `document.querySelector('#g5-pendpop .g5-pitem[data-ticket=${JSON.stringify(first.ticket)}]')`, 'first real pending ticket')
      await waitForPendingCount(firstChild, 2)
      safeAssert('⑤', 'yielded_parent_has_no_approval_action', await pageEval(parent, "!document.querySelector('[data-act=approve]')"))
      const firstNeedsPin = await stage.run(`return k.trading.approvalNeedsPin(${JSON.stringify(first.id)})`)
      const due = Date.now() + 350
      currentPhase('gate5-same-ticket-race')
      const [firstA, firstB] = await Promise.all([
        directApprove(parent, first.id, parentToken, testPin, firstNeedsPin === true, due),
        directApprove(firstChild, first.id, parentToken, testPin, firstNeedsPin === true, due),
      ])
      approvalEvidence.competitionResponses = [summarizeHttp(firstA), summarizeHttp(firstB)]
      approvalEvidence.competitionSuccessCount = Number(firstA.ok) + Number(firstB.ok)
      saveApprovalEvidence()
      safeAssert('⑤', 'same_ticket_competition_exactly_one_success', Number(firstA.ok) + Number(firstB.ok), 1)
      const firstFailure = firstA.ok ? firstB : firstA
      safeAssert('⑤', 'same_ticket_loser_original_kernel_state_error', firstFailure.kernelStateError)
      await waitForPendingCount(firstChild, 1)
      currentPhase('gate5-first-ledger')
      const firstLedger = await stage.run(`const id=${JSON.stringify(first.id)}; const rows=k.ledger.query({types:['proposal.decided'],limit:500}).filter((event)=>event.subject?.proposalId===id && event.payload?.decision==='approved'); const proposal=k.trading.getProposal(id); const decision=proposal?.decision; return {approved:rows.length,eventDecision:rows[0]?.payload?.decision??null,status:proposal?.status??null,decisionPresent:decision!==null&&decision!==undefined,decisionByHuman:typeof decision?.by==='string'&&decision.by.startsWith('user:'),decisionAtIsInteger:Number.isInteger(decision?.at)}`)
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, firstLedgerApproved: firstLedger.approved }
      const firstDecisionEvidence = firstLedger.eventDecision === 'approved' && firstLedger.decisionPresent === true && firstLedger.decisionByHuman === true && firstLedger.decisionAtIsInteger === true
      approvalEvidence.firstLedger = { approved: firstLedger.approved, eventDecisionApproved: firstLedger.eventDecision === 'approved', status: firstLedger.status, decisionPresent: firstLedger.decisionPresent === true, decisionByHuman: firstLedger.decisionByHuman === true, decisionAtIsInteger: firstLedger.decisionAtIsInteger === true }
      saveApprovalEvidence()
      safeAssert('⑤', 'same_ticket_approved_ledger_exactly_once', firstLedger.approved, 1)
      safeAssert('⑤', 'same_ticket_proposal_decision_approved', firstDecisionEvidence)
      currentPhase('gate5-proposal-B-anchor-approval')
      const anchorNeedsPin = await stage.run(`return k.trading.approvalNeedsPin(${JSON.stringify(firstAnchor.id)})`)
      const anchorApproved = await directApprove(parent, firstAnchor.id, parentToken, testPin, anchorNeedsPin === true)
      approvalEvidence.competitionAnchorResponse = summarizeHttp(anchorApproved)
      saveApprovalEvidence()
      safeAssert('⑤', 'competition_anchor_cleared', anchorApproved.ok)
      await waitForPendingCount(firstChild, 0)
      const sessionAfterFirstGroup = await stage.run('return k.auth.sessionCount')
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, sessionAfterFirstGroup }
      approvalEvidence.sessionAfterFirstGroup = sessionAfterFirstGroup
      saveApprovalEvidence()
      safeAssert('⑤', 'first_approval_group_kept_session_count', sessionAfterFirstGroup, sessionBefore)
      currentPhase('gate5-first-child-redock')
      safeAssert('⑤', 'first_child_redock_clicked', await clickRealElement(firstChild, '[data-act=standalone]'))
      parent = await contextUntil(async () => {
        const next = cdp!.contextFor(stageOrigin!, new Set([firstChild.target.targetId]), firstParentTarget)
        if (!next) return null
        const mode = await captureMode(next)
        return mode.mode === 'docked' && !mode.peer ? next : null
      }, 'first approval parent restored')

      currentPhase('gate5-delayed-proposal-A-create')
      // 夹具：风控 RATE 阶段对「同一账户 10 秒内重复意图」直接 deny（COOLDOWN / duplicateIntent）。第一组刚成交过 0.002，延迟组换数量避开，不碰风控。
      const delayed = await createPendingPaperProposal('S1 delayed approval response', '0.003')
      const delayedProposalEvidence = [rememberProposal(delayed)]
      approvalEvidence.delayedProposals = delayedProposalEvidence
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, delayedPendingProposals: Number(delayed?.status === 'pending') }
      saveApprovalEvidence()
      currentPhase('gate5-delayed-proposal-B-anchor-create')
      const delayedAnchor = await createPendingPaperProposal('S1 delayed approval anchor', '0.003')
      delayedProposalEvidence.push(rememberProposal(delayedAnchor))
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, delayedPendingProposals: delayedProposalEvidence.filter((item) => item.pending).length }
      saveApprovalEvidence()
      safeAssert('⑤', 'delayed_proposals_pending', delayed?.status === 'pending' && delayedAnchor?.status === 'pending')
      const delayedParentTarget = parent.target.targetId
      currentPhase('gate5-delayed-child-ui')
      safeAssert('⑤', 'delayed_group_detach_clicked', await clickRealElement(parent, '[data-act=standalone]'))
      let child = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([delayedParentTarget])), 'delayed approval child')
      delayedChildForEvidence = child
      await pageTrue(child, "document.documentElement.dataset.mode==='standalone'", 'delayed approval child online')
      await pageEval(child, `window.dispatchEvent(new CustomEvent('gitrader:focus',{detail:{card:'pending',proposalId:${JSON.stringify(delayed.id)}}})); true`)
      const targetSelector = `#g5-pendpop .g5-pitem[data-ticket=${JSON.stringify(delayed.ticket)}]`
      await pageTrue(child, `document.querySelector(${JSON.stringify(targetSelector)})?.querySelector('[data-act=approve]') && !document.querySelector(${JSON.stringify(targetSelector)})?.querySelector('[data-act=approve]')?.disabled`, 'target approve enabled')
      await waitForPendingCount(child, 2)
      const holdInstalled = await pageEval(child, `(() => {
        const proto=WebSocket.prototype, original=proto.send
        const hold={raw:null,socket:null,original,requestId:null,release(){ if(!this.raw || !this.socket) return false; const raw=this.raw; this.raw=null; this.original.call(this.socket,raw); return true }}
        proto.send=function(data){
          if(!hold.raw && typeof data==='string') { try { const msg=JSON.parse(data); if(msg.method==='command' && msg.params?.action==='proposal.approve' && msg.params?.params?.id===${JSON.stringify(delayed.id)}) { hold.raw=data; hold.socket=this; hold.requestId=msg.id; return } } catch {} }
          return original.call(this,data)
        }
        window.__S1_DELAYED_APPROVAL__=hold
        return true
      })()`)
      approvalEvidence.wsHoldInstalled = holdInstalled === true
      saveApprovalEvidence()
      try {
      safeAssert('⑤', 'delayed_ws_hold_installed_in_child', holdInstalled)
      currentPhase('gate5-delayed-target-ui-approve')
      const approveDiag = () => pageEval(child, `(() => { const item=document.querySelector(${JSON.stringify(targetSelector)}); const btn=item?.querySelector('[data-act=approve]'); const r=btn?.getBoundingClientRect(); const pop=document.querySelector('#g5-pendpop'); const pr=pop?.getBoundingClientRect();
          return { pend: document.documentElement.dataset.pend ?? null, item: !!item, btn: !!btn, disabled: !!btn?.disabled, text: (btn?.textContent ?? '').trim().slice(0, 20), rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
            pop: pr ? [Math.round(pr.x), Math.round(pr.y), Math.round(pr.width), Math.round(pr.height)] : null, popDisplay: pop ? getComputedStyle(pop).display : null,
            hit: r ? (() => { const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e ? e.tagName + '.' + String(e.className).slice(0, 40) : null })() : null,
            dialogs: document.querySelectorAll('[role=dialog]').length, held: !!window.__S1_DELAYED_APPROVAL__?.raw, vw: innerWidth, vh: innerHeight } })()`).catch(() => null)
      // P1 待批卡换卡后有 500 ms 误触死区（按钮 aria-disabled=true，点了无效）：等死区过了再点，和真人手速一致。
      await pause(700) // 换卡的布局副作用晚一拍才把按钮置灰：先让死区真正开始，再等它过去
      await pageTrue(child, `document.querySelector(${JSON.stringify(targetSelector)})?.querySelector('[data-act=approve]')?.getAttribute('aria-disabled') !== 'true'`, 'approve dead zone over')
      approvalEvidence.beforeApproveClickDiag = await approveDiag()
      saveApprovalEvidence()
      safeAssert('⑤', 'target_approve_real_pointer_click', await clickRealElement(child, `${targetSelector} [data-act=approve]`))
      currentPhase('gate5-delayed-frame-held')
      const held = await until(() => pageEval(child, 'window.__S1_DELAYED_APPROVAL__?.raw ? ({raw:window.__S1_DELAYED_APPROVAL__.raw,id:window.__S1_DELAYED_APPROVAL__.requestId}) : null'), 10000, 'first real approval frame held').catch(async (error) => {
        approvalEvidence.heldFrameDiag = await approveDiag()
        approvalEvidence.heldFrameAfter = await pageEval(child, `(() => { const item=document.querySelector(${JSON.stringify(targetSelector)}); const btn=item?.querySelector('[data-act=approve]');
          return { btnText: (btn?.textContent ?? '').trim().slice(0, 20), ariaDisabled: btn?.getAttribute('aria-disabled') ?? null, toast: (document.querySelector('[role=status], .gr-toast, [data-toast]')?.textContent ?? '').trim().slice(0, 120),
            itemText: (item?.textContent ?? '').trim().slice(0, 200), dialogs: [...document.querySelectorAll('[role=dialog]')].map((n) => n.id || String(n.className).slice(0, 30)) } })()`).catch(() => null)
        approvalEvidence.heldFrameSent = cdp!.wsFramesSent.filter((frame) => frame.sessionId === child.target.sessionId).slice(-6).map((frame) => {
          try { const msg = JSON.parse(frame.payload); return { method: String(msg.method ?? '').slice(0, 20), action: String(msg.params?.action ?? '').slice(0, 30) } } catch { return null }
        })
        saveApprovalEvidence()
        throw error
      })
      currentPhase('gate5-parent-approval-while-held')
      const needsPin = await stage.run(`return k.trading.approvalNeedsPin(${JSON.stringify(delayed.id)})`)
      const approvedWhileHeld = await directApprove(parent, delayed.id, parentToken, testPin, needsPin === true)
      approvalEvidence.parentApprovalWhileHeld = summarizeHttp(approvedWhileHeld)
      saveApprovalEvidence()
      safeAssert('⑤', 'parent_direct_approval_succeeded_while_child_frame_held', approvedWhileHeld.ok)
      await waitForPendingCount(child, 1)
      safeAssert('⑤', 'pending_count_changed_two_to_one', await pageEval(child, "Number(document.querySelector('#g5-pendpop .g5-ct')?.textContent ?? -1)"), 1)
      safeAssert('⑤', 'anchor_keeps_real_pending_float_open', await pageEval(child, "document.documentElement.dataset.pend==='open' && getComputedStyle(document.querySelector('#g5-pendpop')).display!=='none'"))
      delayedFrameReleased = await pageEval(child, 'window.__S1_DELAYED_APPROVAL__?.release() === true')
      approvalEvidence.delayedFrameReleased = delayedFrameReleased === true
      saveApprovalEvidence()
      safeAssert('⑤', 'original_child_frame_released_to_kernel', delayedFrameReleased)
      currentPhase('gate5-delayed-kernel-response')
      let originalError = await websocketError(child, Number(held.id))
      if (!originalError) throw new Error('original approval error evidence unavailable')
      delayedKernelError = originalError
      approvalEvidence.pinChallengeObserved = originalError.name === 'ATTESTATION_REQUIRED'
      approvalEvidence.firstDelayedWebSocketError = { code: typeof originalError.code === 'number' ? originalError.code : safeEnumMarker(originalError.code), name: safeErrorMarker(originalError.name), message: safeDiagnosticText(originalError.message, evidenceSecrets) }
      saveApprovalEvidence()
      let errorRequestId = Number(held.id)
      if (originalError.name === 'ATTESTATION_REQUIRED') {
        currentPhase('gate5-pin-challenge')
        await pageTrue(child, "document.querySelector('.gr-pin input[type=password]') && document.querySelector('[data-act=pin-confirm]')", 'real PIN dialog after kernel challenge')
        await pageEval(child, "document.querySelector('.gr-pin input[type=password]').focus(); true")
        await cdp.send('Input.insertText', { text: testPin }, child.target.sessionId)
        await pageTrue(child, "document.querySelector('.gr-pin input[type=password]')?.value.length >= 6", 'real PIN entered')
        safeAssert('⑤', 'real_pin_dialog_confirm_clicked', await clickRealElement(child, '[data-act=pin-confirm]'))
        const retry = await until(() => {
          for (const frame of cdp!.wsFramesSent) {
            if (frame.sessionId !== child.target.sessionId) continue
            try { const msg=JSON.parse(frame.payload); if(msg.method==='command' && msg.params?.action==='proposal.approve' && msg.params?.params?.id===delayed.id && msg.params?.attestation) return Number(msg.id) } catch {}
          }
          return null
        }, 10000, 'real attested approval retry')
        if (retry === null) throw new Error('attested approval retry evidence unavailable')
        errorRequestId = retry
        originalError = await websocketError(child, errorRequestId)
        if (!originalError) throw new Error('attested approval error evidence unavailable')
        delayedKernelError = originalError
        approvalEvidence.pinRetryWebSocketError = { code: typeof originalError.code === 'number' ? originalError.code : safeEnumMarker(originalError.code), name: safeErrorMarker(originalError.name), message: safeDiagnosticText(originalError.message, evidenceSecrets) }
        saveApprovalEvidence()
      }
      currentPhase('gate5-delayed-p1-error-ui')
      await pageTrue(child, `document.querySelector(${JSON.stringify(targetSelector)})?.querySelector('[role=status][data-tone=err]')`, 'real P1 original approval error')
      delayedUiMessage = await pageEval(child, `document.querySelector(${JSON.stringify(targetSelector)})?.querySelector('[role=status][data-tone=err]')?.textContent?.trim() ?? null`)
      delayedUiMatches = typeof delayedUiMessage === 'string' && delayedUiMessage === `没有批成：${originalError.message}`
      approvalEvidence.delayedUiMessage = safeDiagnosticText(delayedUiMessage, evidenceSecrets)
      approvalEvidence.delayedUiMatchesOriginal = delayedUiMatches
      saveApprovalEvidence()
      safeAssert('⑤', 'p1_error_matches_original_websocket_message', delayedUiMatches)
      currentPhase('gate5-delayed-ledger')
      const delayedLedger = await stage.run(`const id=${JSON.stringify(delayed.id)}; const rows=k.ledger.query({types:['proposal.decided'],limit:500}).filter((event)=>event.subject?.proposalId===id && event.payload?.decision==='approved'); const proposal=k.trading.getProposal(id); const decision=proposal?.decision; return {approved:rows.length,eventDecision:rows[0]?.payload?.decision??null,status:proposal?.status??null,decisionPresent:decision!==null&&decision!==undefined,decisionByHuman:typeof decision?.by==='string'&&decision.by.startsWith('user:'),decisionAtIsInteger:Number.isInteger(decision?.at),sessionCount:k.auth.sessionCount}`)
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, delayedLedgerApproved: delayedLedger.approved, sessionAfter: delayedLedger.sessionCount }
      const delayedDecisionEvidence = delayedLedger.eventDecision === 'approved' && delayedLedger.decisionPresent === true && delayedLedger.decisionByHuman === true && delayedLedger.decisionAtIsInteger === true
      approvalEvidence.delayedLedger = { approved: delayedLedger.approved, eventDecisionApproved: delayedLedger.eventDecision === 'approved', status: delayedLedger.status, decisionPresent: delayedLedger.decisionPresent === true, decisionByHuman: delayedLedger.decisionByHuman === true, decisionAtIsInteger: delayedLedger.decisionAtIsInteger === true, sessionMatchesBefore: delayedLedger.sessionCount === sessionBefore }
      saveApprovalEvidence()
      safeAssert('⑤', 'delayed_target_approved_once', delayedLedger.approved, 1)
      safeAssert('⑤', 'delayed_target_decision_approved', delayedDecisionEvidence)
      safeAssert('⑤', 'approval_groups_did_not_mint_session', delayedLedger.sessionCount, sessionBefore)
      gateResults['⑤'].counts = { ...gateResults['⑤'].counts, sessionBefore, sessionAfter: delayedLedger.sessionCount, sameTicketApproved: firstLedger.approved, delayedApproved: delayedLedger.approved }
      refreshedEvidence.d2bApprovalChildTokens = await tokenEvidence(child, await authToken(child, 'approval child auth'), bootToken!)
      refreshedEvidence.d2bApprovalChildTopHistory = await navigationEvidence(child, await authToken(child, 'approval child history auth'), bootToken!)
      saveApprovalEvidence()
      } finally {
        let wsRestored = false
        try {
          wsRestored = (await pageEval(child, `(() => {
            const hold=window.__S1_DELAYED_APPROVAL__;
            if(!hold) return true;
            WebSocket.prototype.send=hold.original;
            if(hold.raw && hold.socket) hold.original.call(hold.socket, hold.raw);
            hold.raw=null; hold.socket=null; delete window.__S1_DELAYED_APPROVAL__;
            return true;
          })()`)) === true
        } catch (error) { audit({ event: 'delayed-approval-hook-cleanup-failed', details: { errorType: errorType(error) } }) }
        if (delayedUiMessage === null && delayedChildForEvidence) {
          try { delayedUiMessage = await pageEval(delayedChildForEvidence, `document.querySelector(${JSON.stringify(targetSelector)})?.querySelector('[role=status][data-tone=err]')?.textContent?.trim() ?? null`) } catch { /* final UI snapshot unavailable */ }
        }
        if (delayedUiMatches === null && typeof delayedUiMessage === 'string' && delayedKernelError) {
          delayedUiMatches = delayedUiMessage === `没有批成：${String(delayedKernelError.message ?? '')}`
        }
        approvalEvidence.delayedFrameReleased = delayedFrameReleased
        approvalEvidence.delayedKernelError = delayedKernelError ? {
          code: typeof delayedKernelError.code === 'number' ? delayedKernelError.code : safeEnumMarker(delayedKernelError.code),
          name: safeErrorMarker(delayedKernelError.name),
          message: safeDiagnosticText(delayedKernelError.message, evidenceSecrets),
        } : null
        approvalEvidence.delayedUiMessage = safeDiagnosticText(delayedUiMessage, evidenceSecrets)
        approvalEvidence.delayedUiMatchesOriginal = delayedUiMatches
        approvalEvidence.wsRestored = wsRestored
        approvalEvidence.failurePhase = phase
        saveApprovalEvidence()
      }
      const delayedAnchorNeedsPin = await stage.run(`return k.trading.approvalNeedsPin(${JSON.stringify(delayedAnchor.id)})`)
      const delayedAnchorResult = await directApprove(parent, delayedAnchor.id, parentToken, testPin, delayedAnchorNeedsPin === true)
      approvalEvidence.delayedAnchorResponse = summarizeHttp(delayedAnchorResult)
      saveApprovalEvidence()
      safeAssert('⑤', 'delayed_anchor_cleared', delayedAnchorResult.ok)
      await waitForPendingCount(child, 0)
      safeAssert('⑤', 'delayed_child_redock_clicked', await clickRealElement(child, '[data-act=standalone]'))
      parent = await contextUntil(async () => {
        const next = cdp!.contextFor(stageOrigin!, new Set([child.target.targetId]), delayedParentTarget)
        if (!next) return null
        const mode = await captureMode(next)
        return mode.mode === 'docked' && !mode.peer ? next : null
      }, 'delayed approval parent restored')
      dockedEvidence.d2bApprovalParentTokens = await tokenEvidence(parent, parentToken, bootToken!)
      dockedEvidence.d2bApprovalParentFrameHistory = await navigationEvidence(parent, parentToken, bootToken!)
      dockedEvidence.d2bApprovalHostTopHistory = await navigationEvidence(hostTop!, parentToken, bootToken!)
    })
  }, 180000)

  it('⑥ removes session and launch tokens from both windows and visible history', async () => {
    await runGate('⑥', 'token-storage-and-history', async () => {
      if (!parentToken || !bootToken) throw new Error('startup tokens unavailable')
      if (!cdp || !parent || !hostTop || !stageOrigin) throw new Error('gate 6 setup unavailable')
      // 必要证据自己采：分离 → 子窗刷新 → 回嵌，每个稳定点对父 iframe、子窗、宿主顶层扫三处（URL、localStorage、sessionStorage）；
      // 顶层历史（子窗、宿主顶层）用 Page.getNavigationHistory。iframe 自身的 history 超出验收三处，只记「未验」，不卡门。
      currentPhase('gate6-own-detach-refresh-dock')
      await restoreParentFromLiveChild('⑥', 'parent restored before token gate')
      const own: Record<string, any> = {}
      const scan = async (name: string, where: CdpContext) => { own[name] = await tokenEvidence(where, parentToken!, bootToken!) }
      await scan('own docked parent', parent)
      await scan('own docked host top', hostTop)
      const sixParentTarget = parent.target.targetId
      safeAssert('⑥', 'own_detach_real_button_clicked', await clickRealElement(parent, 'button[data-act="standalone"]'))
      let sixChild = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set([sixParentTarget])), 'gate 6 child document')
      const childOnline = "document.documentElement.dataset.mode === 'standalone' && document.documentElement.dataset.kernel === 'open'"
      await pageTrue(sixChild, childOnline, 'gate 6 child online')
      await scan('own detached child', sixChild)
      await scan('own detached parent', parent)
      await scan('own detached host top', hostTop)
      const sixOldContext = sixChild.contextId
      const sixOldTarget = sixChild.target.targetId
      await pageEval(sixChild, 'location.reload(); true')
      sixChild = await contextUntil(() => {
        const next = cdp!.contextFor(stageOrigin!, new Set([sixParentTarget]), sixOldTarget)
        return next && next.contextId !== sixOldContext ? next : null
      }, 'gate 6 child refreshed document')
      await pageTrue(sixChild, childOnline, 'gate 6 child online after refresh')
      // 子窗刷新只是短暂离线：内嵌页要一直让位，不闪回整页工作台。
      safeAssert('⑥', 'own_parent_stays_yielded_through_child_refresh', (await captureMode(parent)).peer)
      await scan('own refreshed child', sixChild)
      await scan('own refreshed parent', parent)
      await scan('own refreshed host top', hostTop)
      safeAssert('⑥', 'own_redock_real_button_clicked', await clickRealElement(sixChild, 'button[data-act="standalone"]'))
      const sixChildTarget = sixChild.target.targetId
      parent = await contextUntil(async () => {
        const next = cdp!.contextFor(stageOrigin!, new Set([sixChildTarget]), sixParentTarget)
        if (!next) return null
        const mode = await captureMode(next)
        return mode.mode === 'docked' && !mode.peer ? next : null
      }, 'gate 6 parent redocked')
      await scan('own redocked parent', parent)
      await scan('own redocked host top', hostTop)
      const ownRequired = Object.entries(own)
      const ownMissing: string[] = []
      const threePlaceFields = ['storageReadable', 'urlNoSession', 'urlNoLaunch', 'storageNoSession', 'storageNoLaunch']
      for (const [name, evidence] of ownRequired) {
        safeAssert('⑥', `${name} URL and storage hold no session or launch`, threePlaceFields.every((field) => evidence?.[field] === true))
        if (/child|host top/.test(name)) {
          if (evidence?.navigation?.available !== true) ownMissing.push(`${name}:navigation-history`)
          else {
            safeAssert('⑥', `${name} history has no session`, evidence.navigation.noSession === true)
            safeAssert('⑥', `${name} history has no launch`, evidence.navigation.noLaunch === true)
          }
        }
      }
      gateResults['⑥'].observations.ownScanPoints = ownRequired.length
      gateResults['⑥'].observations.ownMissing = ownMissing
      gateResults['⑥'].observations.iframeHistoryScope = 'OUT_OF_SCOPE'
      suiteResult.ownTokenObservations = Object.fromEntries(ownRequired.map(([name, evidence]) => [name, recordTokenEvidence(evidence)]))
      safeAssert('⑥', 'own required evidence complete', ownMissing.length === 0)
      const groups = [
        ['startup parent iframe', startupEvidence.parentTokens, false],
        ['startup host top', startupEvidence.hostTokens, true],
        ['startup child', startupEvidence.childTokens, false],
        ['child refresh', refreshedEvidence.childTokens, false],
        ['parent iframe refresh', refreshedEvidence.parentTokens, false],
        ['refreshed host top', refreshedEvidence.hostTokens, true],
        ['docked parent', dockedEvidence.parentTokens, false],
        ['docked host top', dockedEvidence.hostTokens, true],
        ['D2B child refresh', refreshedEvidence.d2bChildTokens, false],
        ['D2B parent refresh', refreshedEvidence.d2bParentTokens, false],
        ['D2B child after parent refresh', refreshedEvidence.d2bChildAfterParentTokens, false],
        ['D2B docked parent', dockedEvidence.d2bParentTokens, false],
        ['D2B approval child', refreshedEvidence.d2bApprovalChildTokens, false],
        ['D2B approval parent', dockedEvidence.d2bApprovalParentTokens, false],
      ] as const
      const missingEvidence: string[] = []
      const topHistory = [
        ['startup host history', startupEvidence.hostTokens?.navigation],
        ['child popup history', startupEvidence.childTopHistory],
        ['refreshed child popup history', refreshedEvidence.childTopHistory],
        ['refreshed host history', refreshedEvidence.hostTopHistory],
        ['docked host history', dockedEvidence.hostTopHistory],
        ['D2B child popup history', refreshedEvidence.d2bChildTopHistory],
        ['D2B child after parent refresh history', refreshedEvidence.d2bChildAfterParentHistory],
        ['D2B refreshed host history', refreshedEvidence.d2bHostTopHistory],
        ['D2B approval child popup history', refreshedEvidence.d2bApprovalChildTopHistory],
        ['D2B approval host history', dockedEvidence.d2bApprovalHostTopHistory],
      ] as const
      const iframeHistory = [startupEvidence.parentTokens?.navigation, refreshedEvidence.parentFrameHistory, dockedEvidence.parentFrameHistory,
        refreshedEvidence.d2bParentFrameHistory, dockedEvidence.d2bParentFrameHistory, dockedEvidence.d2bApprovalParentFrameHistory]
      gateResults['⑥'].observations.iframeHistoryChecks = iframeHistory.length
      gateResults['⑥'].observations.iframeHistoryUnavailable = iframeHistory.filter((history: any) => history?.available !== true).length
      // iframe 自身 history 不在验收三处之内：可读就核，不可读记「未验（超出验收范围）」，不进必要证据。
      gateResults['⑥'].observations.iframeHistoryStatus = iframeHistory.some((history: any) => history?.available !== true) ? 'NOT VERIFIED (out of scope)' : 'VERIFIED'
      gateResults['⑥'].observations.iframeHistoryNotVerified = iframeHistory.flatMap((history: any, index: number) => history?.available === true ? [] : [`iframe-${index}`])
      for (const [name, evidence] of groups) {
        if (!evidence) missingEvidence.push(`${name}:token-evidence`)
      }
      for (const [name, history] of topHistory) {
        if (!history || history.available !== true) missingEvidence.push(`${name}:navigation-history`)
      }
      const uniqueMissingEvidence = [...new Set(missingEvidence)]
      gateResults['⑥'].observations.missingEvidence = ownMissing
      gateResults['⑥'].observations.supplementalMissing = uniqueMissingEvidence
      gateResults['⑥'].observations.hostFrameSrcBootstrapObserved = [startupEvidence.hostTokens?.domNoLaunch, refreshedEvidence.hostTokens?.domNoLaunch, dockedEvidence.hostTokens?.domNoLaunch].filter((value) => value === false).length
      gateResults['⑥'].observations.hostFrameSrcIsSupplemental = true
      const launchEvidenceComplete = groups.every(([, evidence]) =>
        typeof evidence?.urlNoLaunch === 'boolean' && typeof evidence.storageNoLaunch === 'boolean' && typeof evidence.stateNoLaunch === 'boolean')
      gateResults['⑥'].observations.launchRemovedVerified = launchEvidenceComplete
      gateResults['⑥'].observations.launchRemoved = launchEvidenceComplete
        ? groups.every(([, evidence]) => evidence?.urlNoLaunch === true && evidence?.storageNoLaunch === true && evidence?.stateNoLaunch === true)
        : null
      suiteResult.tokenObservations = Object.fromEntries(groups.map(([name, evidence]) => [name, evidence ? recordTokenEvidence(evidence) : { evidencePresent: false }]))

      for (const [name, evidence, isHostDocument] of groups) {
        if (evidence) safeAssert('⑥', `${name} contains no session or launch`, allTokenChecksForPage(evidence, isHostDocument))
      }
      for (const [name, history] of topHistory) {
        if (!history || history.available !== true) continue
        safeAssert('⑥', `${name} available`, true)
        safeAssert('⑥', `${name} has no session`, history.noSession === true)
        safeAssert('⑥', `${name} has no launch`, history.noLaunch === true)
      }
      for (const [index, history] of iframeHistory.entries()) {
        if (!history || history.available !== true) continue
        safeAssert('⑥', `iframe history ${index} no session`, history.noSession === true)
        safeAssert('⑥', `iframe history ${index} no launch`, history.noLaunch === true)
      }
      // 之前各门留下的样本（含 ⑤ 的 D2B 后续样本）是补充：有就核，缺不判红；必要证据只看上面自采的。
    })
  }, 120000)

  it('① verifies dock and standalone modes, direct boot, blocked popup, and host loss', async () => {
    await runGate('①', 'mode-and-negative-branches', async () => {
      if (!cdp || !stage || !host || !hostTarget || !parent || !parentToken || !stageOrigin || !alias) throw new Error('setup state unavailable')
      await restoreParentFromLiveChild('①', 'parent restored before mode and host-loss gate')
      const docked = await captureMode(parent)
      safeAssert('①', 'restored_parent_is_docked', docked.mode, 'docked')
      safeAssert('①', 'docked_button_unpressed', docked.pressed, 'false')
      safeAssert('①', 'docked_semantic_label', docked.label, '独立模式')

      const beforeSecondDetach = await stage.run('return k.auth.sessionCount')
      const firstChildTargets = targetIdsForOrigin(cdp, stageOrigin)
      const clicked = await clickRealElement(parent, 'button[data-act="standalone"]')
      safeAssert('①', 'standalone_button_clicked', clicked)
      const detached = await contextUntil(() => cdp!.contextFor(stageOrigin!, firstChildTargets), 'second detached child')
      await pageTrue(detached, "document.documentElement.dataset.mode === 'standalone' && document.documentElement.dataset.kernel === 'open'", 'second child online')
      const detachedMode = await captureMode(detached)
      safeAssert('①', 'child_actual_standalone_mode', detachedMode.mode, 'standalone')
      safeAssert('①', 'child_button_pressed', detachedMode.pressed, 'true')
      safeAssert('①', 'child_semantic_label', detachedMode.label, '回嵌')
      safeAssert('①', 'parent_peer_marker', (await captureMode(parent)).peer)
      const parentPeer = await captureMode(parent)
      safeAssert('①', 'parent_peer_button_pressed', parentPeer.pressed, 'true')
      safeAssert('①', 'parent_peer_card_button_present', parentPeer.peerButton)
      safeAssert('①', 'parent_peer_card_button_pressed', parentPeer.peerButtonPressed, 'true')
      safeAssert('①', 'peer_has_no_approval_action', !parentPeer.approve)
      safeAssert('①', 'peer_has_no_pin_dialog', !parentPeer.pinDialog)
      safeAssert('①', 'peer_has_no_palette', !parentPeer.palette)
      safeAssert('①', 'peer_has_no_trading_workspace', !parentPeer.chart && !parentPeer.overview)
      const afterSecondDetach = await stage.run('return k.auth.sessionCount')
      safeAssert('①', 'detach_did_not_create_session', afterSecondDetach, beforeSecondDetach)

      currentPhase('gate-①-direct-online')
      const countBeforeDirect = await stage.run('return k.auth.sessionCount')
      const directBoot = await stage.boot()
      const directTarget = await cdp.createPage(entryUrl(directBoot, '#/overview'))
      const direct = await contextUntil(() => cdp!.contextFor(stageOrigin!, new Set(), directTarget.targetId), 'direct online document')
      await pageTrue(direct, "document.documentElement.dataset.kernel === 'open' && !!document.querySelector('[data-g5-page]')", 'direct online shell')
      const directMode = await captureMode(direct)
      safeAssert('①', 'direct_online_has_no_mode_button', !directMode.button)
      safeAssert('①', 'direct_online_has_no_peer_card', !directMode.peer)
      const directToken = await authToken(direct, 'direct boot auth')
       const countAfterDirect = await stage.run('return k.auth.sessionCount')
       safeAssert('①', 'direct_boot_created_its_own_session', countAfterDirect, countBeforeDirect + 1)
      await cdp.send('Target.closeTarget', { targetId: directTarget.targetId })

      currentPhase('gate-①-sandbox-blocked')
      const blockedBoot = await stage.boot()
      const blockedFrameUrl = entryUrl(blockedBoot, '#/overview')
      if (!hostHtml) throw new Error('cross-site host document unavailable')
      hostHtml.value = embeddedHostHtml(blockedFrameUrl, true)
      const existingStageTargets = targetIdsForOrigin(cdp, stageOrigin)
      const blockedHostTarget = await cdp.createPage(`${host.origin}/`)
      const blockedParent = await contextUntil(() => cdp!.contextFor(stageOrigin!, existingStageTargets), 'sandbox parent document')
      await pageTrue(blockedParent, "document.documentElement.dataset.kernel === 'open' && !!document.querySelector('[data-g5-page]')", 'sandbox shell online')
      const countBeforeBlockedClick = await stage.run('return k.auth.sessionCount')
      const tradesBeforeBlocked = await tradeEventCount()
      const blockedClick = await clickRealElement(blockedParent, 'button[data-act="standalone"]')
      safeAssert('①', 'sandbox_detach_clicked_real_button', blockedClick)
      const blockedUi = await until(() => pageEval(blockedParent, `(() => {
        const card = document.querySelector('.g5-blocked-notice'); if (!card) return null;
        const buttons = [...card.querySelectorAll('button')];
        return { mode: document.documentElement.dataset.mode, peer: !!document.querySelector('[data-standalone-peer="on"]'),
          workspace: !!document.querySelector('[data-g5-page]'), message: card.querySelector('[data-wire="off"] .g5-msg')?.textContent?.trim() ?? null,
          status: card.querySelector('[data-wire="off"] .g5-t3')?.textContent?.trim() ?? null,
          actions: buttons.map((button) => button.getAttribute('data-act')) };
      })()`), 20000, 'blocked popup facts')
      safeAssert('①', 'blocked_kept_docked_mode', blockedUi.mode, 'docked')
      safeAssert('①', 'blocked_did_not_yield_parent', !blockedUi.peer)
      safeAssert('①', 'blocked_kept_original_workspace', blockedUi.workspace)
      safeAssert('①', 'blocked_fact_message', blockedUi.message, '宿主不允许打开新窗口')
      safeAssert('①', 'blocked_unwired_label', blockedUi.status, '未接通')
      safeAssert('①', 'blocked_only_copy_action', JSON.stringify(blockedUi.actions), JSON.stringify(['copy-relink']))
       const countAfterBlockedClick = await stage.run('return k.auth.sessionCount')
       safeAssert('①', 'blocked_click_did_not_create_session', countAfterBlockedClick, countBeforeBlockedClick)
      safeAssert('①', 'blocked_click_did_not_trade', await tradeEventCount(), tradesBeforeBlocked)
      await cdp.send('Target.closeTarget', { targetId: blockedHostTarget.targetId })

      currentPhase('gate-①-child-hard-close')
      await restoreParentFromLiveChild('①', 'parent restored before hard-close branch')
      const countBeforeCrash = await stage.run('return k.auth.sessionCount')
      const crashTargets = targetIdsForOrigin(cdp, stageOrigin)
      const crashClick = await clickRealElement(parent, 'button[data-act="standalone"]')
      safeAssert('①', 'hard_close_child_opened', crashClick)
      const crashChild = await contextUntil(() => cdp!.contextFor(stageOrigin!, crashTargets), 'hard close child document')
      await pageTrue(crashChild, "document.documentElement.dataset.mode === 'standalone' && document.documentElement.dataset.kernel === 'open'", 'hard close child online')
      await pageTrue(parent, "!!document.querySelector('[data-standalone-peer=on]')", 'parent yielded to child before hard close')
      const crashedAt = Date.now()
      // 子窗与内嵌页同站共用渲染进程，崩进程会连内嵌页一起带走。改为让子窗对外「哑掉」：断开 opener、通道改空操作，
      // 再关窗——等于崩溃或被休眠冻结后硬关：宿主收不到 pagehide / dock / ping 任何一条。
      await pageEval(crashChild, "BroadcastChannel.prototype.postMessage = function () {}; window.opener = null; true")
      await cdp.send('Target.closeTarget', { targetId: crashChild.target.targetId })
      let resetAfterMs: number | null = null
      const timeline: string[] = []
      try {
        await until(async () => {
          const mode = await captureMode(parent!)
          if (timeline.length < 40) timeline.push(`${Date.now() - crashedAt}:${mode.peer ? 'peer' : 'free'}:${mode.mode}:${mode.disabled ? 'disabled' : 'enabled'}`)
          const reset = !mode.peer && mode.mode === 'docked' && mode.button && !mode.disabled
          if (reset) resetAfterMs = Date.now() - crashedAt
          return reset
        }, 3000, 'parent resets after child hard close')
      } catch { /* the direct assertions below record this as a failed gate */ }
      const afterCrash = await captureMode(parent)
      gateResults['①'].observations.hardCloseToResetMs = resetAfterMs
      gateResults['①'].observations.hardCloseTimeline = timeline.join(' ')
      safeAssert('①', 'hard_close_parent_reset_within_3000ms', resetAfterMs !== null && resetAfterMs <= 3000)
      safeAssert('①', 'hard_close_parent_peer_card_gone', !afterCrash.peer)
      safeAssert('①', 'hard_close_parent_workspace_back', afterCrash.overview || afterCrash.chart)
      safeAssert('①', 'hard_close_parent_mode_button_enabled', afterCrash.button && !afterCrash.disabled)
      safeAssert('①', 'hard_close_parent_button_unpressed', afterCrash.pressed, 'false')
      const redockTargets = targetIdsForOrigin(cdp, stageOrigin)
      const redockClick = await clickRealElement(parent, 'button[data-act="standalone"]')
      safeAssert('①', 'hard_close_parent_can_detach_again', redockClick)
      await contextUntil(() => cdp!.contextFor(stageOrigin!, redockTargets), 'child reopened after hard close')
      await pageTrue(parent, "!!document.querySelector('[data-standalone-peer=on]')", 'parent yielded to reopened child')
      const afterCrashCount = await stage.run('return k.auth.sessionCount')
      safeAssert('①', 'hard_close_reopen_did_not_create_session', afterCrashCount, countBeforeCrash)

      currentPhase('gate-①-host-loss')
      await pause(4000) // 同 ④：上面硬关分支多挂了两次整页，先等会话限流桶回满（依赖 K-r5-13），不改额度
      await restoreParentFromLiveChild('①', 'parent restored before host-loss branch')
      const countBeforeLoss = await stage.run('return k.auth.sessionCount')
      const hostLossTargets = targetIdsForOrigin(cdp, stageOrigin)
      const lossClick = await clickRealElement(parent, 'button[data-act="standalone"]')
      safeAssert('①', 'host_loss_child_opened', lossClick)
      const childAgain = await contextUntil(() => cdp!.contextFor(stageOrigin!, hostLossTargets), 'host loss child document')
      await pageTrue(childAgain, `document.documentElement.dataset.mode === 'standalone' && !document.querySelector('[data-act="standalone"]').disabled`, 'host loss child initially enabled')
      const hostClosedAt = Date.now()
      await cdp.send('Target.closeTarget', { targetId: hostTarget.targetId })
      let disabledAfterMs: number | null = null
      try {
        await until(async () => {
          const disabled = await pageEval(childAgain, "Boolean(document.querySelector('[data-act=standalone]')?.disabled)")
          if (disabled) disabledAfterMs = Date.now() - hostClosedAt
          return disabled
        }, 1800, 'host close disables child mode button')
      } catch { /* the direct assertion records this as a failed gate */ }
      const childAfterLoss = await captureMode(childAgain)
      safeAssert('①', 'host_close_disabled_child_mode', childAfterLoss.disabled)
      safeAssert('①', 'host_close_fact', childAfterLoss.hostUnavailable, '宿主侧栏未打开')
      safeAssert('①', 'host_close_latency_within_1800ms', disabledAfterMs !== null && disabledAfterMs <= 1800)
      gateResults['①'].observations.hostCloseToDisabledMs = disabledAfterMs
      const afterLossCount = await stage.run('return k.auth.sessionCount')
      safeAssert('①', 'host_close_did_not_create_session', afterLossCount, countBeforeLoss)
       gateResults['①'].counts = { countBeforeDirect, countAfterDirect, countBeforeBlockedClick, countAfterBlockedClick, countBeforeLoss, countAfterLoss: afterLossCount }
      void directToken
    })
  }, 180000)

  afterAll(async () => {
    currentPhase('cleanup')
    const processCleanup: Record<string, boolean | 'N/A'> = { browser: 'N/A', mcp: 'N/A', stage: 'N/A' }
    let hostClosed = host === null
    for (const resource of ['browser', 'mcp', 'stage'] as const) {
      const owned = ownedProcesses.find((row) => row.resource === resource)
      if (!owned) {
        audit({ event: 'owned-process-not-started', details: { resource } })
        continue
      }
      try { processCleanup[resource] = await verifyOwnedProcess(owned) }
      catch (error) { audit({ event: 'owned-process-verification-failed', pid: owned.child.pid ?? null, details: { resource, errorType: errorType(error) } }) }
    }
    try {
      if (host) {
        await new Promise<void>((done) => host!.server.close(() => done()))
        hostClosed = true
      }
    } catch (error) { audit({ event: 'host-cleanup-failed', details: { errorType: errorType(error) } }) }

    let stateCleanup: unknown = { status: 'NOT RUN' }
    const allOwnedProcessesVerified = ownedProcesses.every((row) => row.cleanupVerified)
    if (allOwnedProcessesVerified && hostClosed && home && manifest) {
      try { stateCleanup = retainManifestPaths() }
      catch (error) { stateCleanup = { status: 'FAIL', errorType: errorType(error), action: 'retained' } }
    }
    if (childDockScreenshotFile && existsSync(childDockScreenshotFile)) {
      try {
        const screenshotDir = join(process.env.GITRADER_SHOTS_DIR || join(workArea!.rootDir, 's1-shots'))
        mkdirSync(screenshotDir, { recursive: true })
        const screenshotName = `d2-d2-child-dock-${String(suiteResult.runId ?? 'run').slice(0, 8)}.png`
        copyFileSync(childDockScreenshotFile, join(screenshotDir, screenshotName))
        gateResults['②'].observations.screenshotArchived = screenshotName
      } catch (error) {
        gateResults['②'].observations.screenshotArchiveErrorType = errorType(error)
      }
    } else gateResults['②'].observations.screenshotArchived = null
    suiteResult.cleanup = { processes: processCleanup, allOwnedProcessesVerified, hostClosed, statePaths: stateCleanup }
    suiteResult.phase = phase
    if (resultFile) writeFileSync(resultFile, JSON.stringify(suiteResult, null, 2))
    audit({ event: 'suite-finished', details: { phase, setupStatus: String(suiteResult.setupStatus), cleanupStatus: String((stateCleanup as any)?.status ?? 'NOT RUN') } })
    if (ownedTempHome) {
      const clean = allOwnedProcessesVerified && GATES.every((gate) => gateResults[gate].status === 'PASS')
      if (clean) { try { rmSync(ownedTempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* temp dir; the OS reclaims it */ } }
      else console.info(`[S1-D2] temp home kept for inspection: ${ownedTempHome}`)
    }
  }, 180000)
})

export function ephemeralPin() {
  return String(100000 + (randomBytes(4).readUInt32BE(0) % 900000))
}
