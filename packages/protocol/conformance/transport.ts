// SPDX-License-Identifier: Apache-2.0
// GEP 一致性套件的传输层：内存（自测）、WebSocket（本地 ws / 远程 wss）、stdio（任意语言子进程，NDJSON）。
// 只依赖 Node 内置模块。
import { spawn, type ChildProcess } from 'node:child_process'
import { GEP_LIMITS, GEP_WS_SUBPROTOCOL, type EngineLaunchCommand } from '../src'

export interface Transport {
  readonly kind: 'memory' | 'ws' | 'stdio'
  /** 发送一帧（WS）或一行（stdio，自动补换行）。 */
  send(text: string): void
  onMessage(cb: (text: string) => void): void
  onClose(cb: () => void): void
  close(): void
  /** stdio：子进程退出码（未退出为 undefined）。 */
  exitCode?(): number | null | undefined
  /** stdio / ws 关闭后的诊断。 */
  readonly info?: () => string
}

// ---- 内存 -------------------------------------------------------------------------------

export interface MemoryEndpoint {
  send(text: string): void
  onMessage(cb: (text: string) => void): void
  onClose(cb: () => void): void
  close(): void
}

/** 成对的内存端点：一端的 send 异步送达另一端的 onMessage。 */
export function createMemoryPair(): [MemoryEndpoint, MemoryEndpoint] {
  const make = () => {
    let msg: (t: string) => void = () => {}
    let cls: () => void = () => {}
    let closed = false
    return { get msg() { return msg }, set msg(v) { msg = v }, get cls() { return cls }, set cls(v) { cls = v }, get closed() { return closed }, set closed(v) { closed = v } }
  }
  const a = make()
  const b = make()
  const end = (me: ReturnType<typeof make>, peer: ReturnType<typeof make>): MemoryEndpoint => ({
    send: (text) => { if (me.closed || peer.closed) return; setImmediate(() => { if (!peer.closed) peer.msg(text) }) },
    onMessage: (cb) => { me.msg = cb },
    onClose: (cb) => { me.cls = cb },
    close: () => {
      if (me.closed) return
      me.closed = true
      setImmediate(() => { me.cls(); if (!peer.closed) { peer.closed = true; peer.cls() } })
    },
  })
  return [end(a, b), end(b, a)]
}

export function memoryTransport(endpoint: MemoryEndpoint): Transport {
  return { kind: 'memory', send: (t) => endpoint.send(t), onMessage: (cb) => endpoint.onMessage(cb), onClose: (cb) => endpoint.onClose(cb), close: () => endpoint.close() }
}

// ---- WebSocket --------------------------------------------------------------------------

export function wsTransport(url: string, openTimeoutMs = 5000): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string, protocols?: string | string[]) => WsLike }).WebSocket
    if (!Ctor) return reject(new Error('global WebSocket is not available (Node >= 22 required)'))
    const ws = new Ctor(url, GEP_WS_SUBPROTOCOL)
    let onMsg: (t: string) => void = () => {}
    let onCls: () => void = () => {}
    let lastClose = ''
    const timer = setTimeout(() => { reject(new Error(`WebSocket open timeout: ${url}`)); try { ws.close() } catch { /* ignore */ } }, openTimeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        kind: 'ws',
        send: (t) => ws.send(t),
        onMessage: (cb) => { onMsg = cb },
        onClose: (cb) => { onCls = cb },
        close: () => { try { ws.close() } catch { /* ignore */ } },
        info: () => lastClose,
      })
    })
    ws.addEventListener('message', (ev) => onMsg(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    ws.addEventListener('close', (ev) => { lastClose = `code=${ev.code ?? ''} reason=${ev.reason ?? ''}`; onCls() })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket error: ${url}`)) })
  })
}

interface WsLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'error', cb: () => void): void
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void
  addEventListener(type: 'close', cb: (ev: { code?: number; reason?: string }) => void): void
}

// ---- stdio 子进程 -------------------------------------------------------------------------

/** 只传显式列出的环境变量（契约 S3：不继承宿主环境）；Windows 下 Node 需要的最小系统变量由套件补上，便于被测引擎起得来。 */
export function stdioTransport(launch: EngineLaunchCommand, token: string): Transport & { child: ChildProcess; pid: number | undefined } {
  const baseEnv: Record<string, string> = {}
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) { const v = process.env[k]; if (v !== undefined) baseEnv[k] = v }
  const child = spawn(launch.command, launch.args ?? [], {
    cwd: launch.cwd,
    env: { ...baseEnv, ...(launch.env ?? {}), GITRADER_GEP_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let onMsg: (t: string) => void = () => {}
  let onCls: () => void = () => {}
  let buf = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim() === '') continue
      onMsg(line)
    }
    if (buf.length > GEP_LIMITS.maxStdioLineBytes) { child.kill() }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => { stderr = (stderr + c).slice(-4000) })
  child.on('close', () => onCls())
  child.on('error', () => onCls())
  return {
    kind: 'stdio',
    child,
    pid: child.pid,
    send: (t) => { if (!child.stdin.destroyed) child.stdin.write(`${t}\n`) },
    onMessage: (cb) => { onMsg = cb },
    onClose: (cb) => { onCls = cb },
    close: () => { try { child.stdin.end() } catch { /* ignore */ } setTimeout(() => { if (child.exitCode === null) child.kill() }, 1500).unref() },
    exitCode: () => (child.exitCode === null ? undefined : child.exitCode),
    info: () => stderr,
  }
}
