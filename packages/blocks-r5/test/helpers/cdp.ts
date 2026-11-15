// SPDX-License-Identifier: CPAL-1.0
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import WebSocket from 'ws'

type CdpReply = { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown> }
type LaunchOptions = { width?: number; height?: number }
type EventWaiter = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }
type CdpApi = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  once(method: string): Promise<Record<string, unknown>>
  evaluate(expression: string): Promise<unknown>
  navigate(url: string): Promise<void>
  screenshot(): Promise<Buffer>
  errors: string[]
  close(): Promise<void>
  pid: number
  profileDir: string
  /** 清理阶段放过的非致命问题（如 profile 目录仍 EBUSY）；不判红，只留痕。 */
  cleanupNotes: string[]
}

const restrictedPorts = new Set([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831])
const timeoutMs = 20_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Edge 正在写 DevToolsActivePort 时读它会偶发 EBUSY：只对这一种错有限重试（≤3 次，退避 delayMs、2×、4×），别的错原样抛。 */
export async function retryBusy<T>(fn: () => T, delayMs = 100): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return fn() }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EBUSY' || attempt >= 3) throw error
      await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt))
    }
  }
}

/** 命令行里带本次 profile 目录的进程 PID（Windows；Edge 子进程都带 --user-data-dir=<profile>）。只认自己的 profile，不按进程名。 */
export function listProfileProcs(profile: string): number[] {
  if (process.platform !== 'win32') return []
  const needle = resolve(profile).replaceAll("'", "''")
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { $_.ProcessId }`
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  return String(out.stdout ?? '').split(/\r?\n/).map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 0)
}

/** 按 PID 杀进程树（含子进程）；绝不按名字。 */
function killTree(pid: number) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

/** 删 profile 目录：EBUSY 经 retryBusy 重试，仍失败则记入 notes 并放过（不抛）。 */
export async function removeProfileDir(dir: string, notes: string[], remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }), delayMs = 200) {
  try { await retryBusy(() => remove(dir), delayMs) }
  catch (error) { notes.push(`profile 目录未能删除（已放过）：${basename(dir)}: ${(error as NodeJS.ErrnoException)?.code ?? String(error)}`) }
}

export async function launchCdp({ width = 1440, height = 900 }: LaunchOptions = {}): Promise<CdpApi> {
  const home = process.env.GITRADER_HOME
  if (!home) throw new Error('GITRADER_HOME is required')
  const resolvedHome = resolve(home)
  mkdirSync(resolvedHome, { recursive: true })
  const systemRoot = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles
  const edge = process.env.GITRADER_EDGE ?? (systemRoot ? join(systemRoot, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '')
  if (!edge || !existsSync(edge)) throw new Error('Edge executable is unavailable')
  const profile = mkdtempSync(join(resolvedHome, 'cdp-profile-'))
  if (!resolve(profile).startsWith(resolvedHome + sep)) throw new Error('browser profile escaped GITRADER_HOME')

  let child: ChildProcess | undefined
  let spawnError = false
  let socket: WebSocket | undefined
  let closed = false
  let sendCommand: ((method: string, params?: Record<string, unknown>, timeout?: number) => Promise<Record<string, unknown>>) | undefined
  const errors: string[] = []
  const cleanupNotes: string[] = []
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  const events = new Map<string, EventWaiter[]>()
  let id = 0

  const failEvents = (error: Error) => {
    for (const waiters of events.values()) for (const entry of waiters) { clearTimeout(entry.timer); entry.reject(error) }
    events.clear()
  }
  const failPending = (error: Error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
  }
  const cleanup = async () => {
    if (closed) return
    closed = true
    if (socket?.readyState === WebSocket.OPEN && sendCommand) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        sendCommand('Browser.close', {}, 900).then(() => undefined, () => undefined),
        new Promise<void>((resolveWait) => { timer = setTimeout(resolveWait, 1_000) }),
      ])
      if (timer) clearTimeout(timer)
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
      await new Promise<void>((resolveClose) => {
        let timer: NodeJS.Timeout
        const done = () => { clearTimeout(timer); resolveClose() }
        socket!.once('close', done)
        timer = setTimeout(done, 600)
        if (socket!.readyState === WebSocket.OPEN) socket!.close()
      })
    }
    failPending(new Error('CDP closed'))
    failEvents(new Error('CDP closed'))
    // 顺序：Browser.close（上面）→ 等主进程 exit（5 s）→ 超时才按自己记录的 PID 杀树 → 收掉带本 profile 的残留子进程 → 再删目录
    if (child && child.exitCode === null) {
      const exited = new Promise<boolean>((resolveExit) => { child!.once('exit', () => resolveExit(true)) })
      if (!await Promise.race([exited, sleep(5_000).then(() => false)])) {
        killTree(child.pid ?? 0)
        await Promise.race([exited, sleep(2_000)])
      }
    }
    if (resolve(profile).startsWith(resolvedHome + sep)) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const left = listProfileProcs(profile)
        if (left.length === 0) break
        if (attempt >= 1) for (const leftPid of left) killTree(leftPid)
        await sleep(300)
      }
      await removeProfileDir(profile, cleanupNotes)
    }
  }

  try {
    child = spawn(edge, [
      '--headless=new', '--lang=zh-CN', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--window-size=${width},${height}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => { spawnError = true })
    const activePortFile = join(profile, 'DevToolsActivePort')
    const started = Date.now()
    while (!existsSync(activePortFile)) {
      if (spawnError || child.exitCode !== null) throw new Error('Edge could not start CDP')
      if (Date.now() - started > timeoutMs) throw new Error('CDP startup timed out')
      await new Promise((r) => setTimeout(r, 100))
    }
    const [portText] = (await retryBusy(() => readFileSync(activePortFile, 'utf8'))).split(/\r?\n/)
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || restrictedPorts.has(port)) throw new Error('CDP selected a restricted port')
    // 浏览器刚写出 DevToolsActivePort 时 about:blank 的页面目标可能还没登记（负载下更常见）：在启动时限内轮询，而不是一次没看到就判失败
    let target: { type: string; webSocketDebuggerUrl: string } | undefined
    for (;;) {
      const targetsResponse = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!targetsResponse.ok) throw new Error('CDP target listing failed')
      const targets = await targetsResponse.json() as Array<{ type: string; webSocketDebuggerUrl: string }>
      target = targets.find((entry) => entry.type === 'page')
      if (target) break
      if (Date.now() - started > timeoutMs) throw new Error('CDP page target is unavailable')
      await new Promise((r) => setTimeout(r, 100))
    }
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timed out')), timeoutMs)
      socket!.once('open', () => { clearTimeout(timer); resolveOpen() })
      socket!.once('error', () => { clearTimeout(timer); reject(new Error('CDP websocket failed')) })
    })
    socket.on('message', (raw) => {
      let message: CdpReply
      try { message = JSON.parse(String(raw)) as CdpReply } catch { errors.push('CDP.invalidMessage'); return }
      if (message.id !== undefined) {
        const entry = pending.get(message.id)
        if (entry) {
          clearTimeout(entry.timer)
          pending.delete(message.id)
          if (message.error) entry.reject(new Error(message.error.message ?? 'CDP command failed'))
          else entry.resolve(message.result ?? {})
        }
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push('Runtime.exceptionThrown')
      if (message.method === 'Log.entryAdded') {
        const entry = message.params?.entry as { level?: string; text?: string; url?: string } | undefined
        if (entry?.level === 'error') {
          let resource = ''
          try { resource = entry.url ? new URL(entry.url).pathname : '' } catch { /* omit unparseable resource */ }
          errors.push(`Log.error: ${entry.text ?? ''}; resource=${resource}`)
        }
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') errors.push('console.error')
      const waiters = message.method ? events.get(message.method) : undefined
      const waiter = waiters?.shift()
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message.params ?? {}) }
    })
    socket.on('close', () => { failPending(new Error('CDP websocket closed')); failEvents(new Error('CDP websocket closed')) })
    sendCommand = (method, params = {}, commandTimeout = timeoutMs) => new Promise<Record<string, unknown>>((resolveReply, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error('CDP websocket is not open')); return }
      const requestId = ++id
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP command timed out')) }, commandTimeout)
      pending.set(requestId, { resolve: resolveReply, reject, timer })
      socket.send(JSON.stringify({ id: requestId, method, params }), (error) => {
        if (!error) return
        const entry = pending.get(requestId)
        if (entry) { clearTimeout(entry.timer); pending.delete(requestId); entry.reject(new Error('CDP command send failed')) }
      })
    })
    const send = (method: string, params?: Record<string, unknown>) => sendCommand!(method, params)
    const onceInternal = (method: string) => {
      let waiter!: EventWaiter
      const promise = new Promise<Record<string, unknown>>((resolveEvent, rejectEvent) => {
        const timer = setTimeout(() => {
          const list = events.get(method) ?? []
          events.set(method, list.filter((entry) => entry !== waiter))
          rejectEvent(new Error('CDP event timed out'))
        }, timeoutMs)
        waiter = { resolve: resolveEvent, reject: rejectEvent, timer }
        const list = events.get(method) ?? []
        list.push(waiter)
        events.set(method, list)
      })
      return { promise, cancel(error: Error) {
        const list = events.get(method) ?? []
        events.set(method, list.filter((entry) => entry !== waiter))
        clearTimeout(waiter.timer)
        waiter.reject(error)
      } }
    }
    const once = (method: string) => onceInternal(method).promise
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Log.enable')
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      const exception = result.exceptionDetails as { text?: string } | undefined
      if (exception) throw new Error(exception.text ?? 'Page evaluation failed')
      return (result.result as { value?: unknown } | undefined)?.value
    }
    const navigate = async (url: string) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      const load = onceInternal('Page.loadEventFired')
      const navigation = send('Page.navigate', { url }).then((result) => {
        if (typeof result.errorText === 'string' && result.errorText) throw new Error('Page navigation failed')
        return result
      })
      try { await Promise.all([navigation, load.promise]) }
      catch (error) { load.cancel(new Error('Page navigation did not load')); throw error }
    }
    const screenshot = async () => {
      const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      return Buffer.from(String(result.data ?? ''), 'base64')
    }
    return { send, once, evaluate, navigate, screenshot, errors, close: cleanup, pid: child.pid ?? 0, profileDir: profile, cleanupNotes }
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error))
    const ownership = `ownedPid: ${child?.pid ?? 0}; ownedProfile: ${basename(profile)}`
    try {
      await cleanup()
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      throw new Error(`CDP launch: ${original.message}; cleanup: ${cleanupMessage}; ${ownership}`, { cause: original })
    }
    throw new Error(`${original.message}; ${ownership}`, { cause: original })
  }
}
