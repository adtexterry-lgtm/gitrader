// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from 'node:child_process'
import { GEP_LIMITS, validateJsonRpcResponse, type EngineLaunchCommand, type Problem } from '../../src'
import { wsTransport, type Transport } from '../transport'
export { createMemoryPair, memoryTransport } from '../transport'

export interface Response {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: Problem }
}

export class Session {
  closedAt = 0
  private nextId = 1
  private frames: (Response | Response[] | Error)[] = []
  private wake?: () => void
  private closed: Promise<void>
  constructor(private transport: Transport) {
    this.closed = new Promise(resolve => transport.onClose(() => {
      this.closedAt = Date.now()
      this.wake?.()
      resolve()
    }))
    transport.onMessage(text => {
      try {
        const frame: unknown = JSON.parse(text)
        const entries = Array.isArray(frame) ? frame : [frame]
        if (!entries.length || entries.some(entry => !validateJsonRpcResponse(entry).ok)) throw new Error('invalid JSON-RPC response frame')
        this.frames.push(frame as Response | Response[])
      } catch { this.frames.push(new Error('invalid JSON-RPC response frame')) }
      this.wake?.()
    })
  }
  async exchange(text: string, timeoutMs = 5000): Promise<Response | Response[]> {
    this.transport.send(text)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!this.frames.length && !this.closedAt) await new Promise<void>(resolve => {
        this.wake = resolve
        timer = setTimeout(resolve, timeoutMs)
      })
      const frame = this.frames.shift()
      if (!frame) throw new Error(this.closedAt ? 'GSP transport closed before response' : 'GSP response timeout')
      if (frame instanceof Error) throw frame
      return frame
    } finally { clearTimeout(timer); this.wake = undefined }
  }
  async request(method: string, params: unknown): Promise<Response> {
    const id = this.nextId++
    const frame = await this.exchange(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    if (Array.isArray(frame) || frame.id !== id) throw new Error('GSP response id does not match request')
    return frame
  }
  async waitClosed(ms: number): Promise<boolean> {
    if (this.closedAt) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([this.closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms) })]) }
    finally { clearTimeout(timer) }
  }
  exitCode(): number | null | undefined { return this.transport.exitCode?.() }
  async close(): Promise<void> { this.transport.close(); await this.waitClosed(2500) }
}

export async function remoteTransport(url: string): Promise<Transport> {
  // Reuse the engine suite's dependency-free client and gep.v0 subprotocol.
  return wsTransport(url, 10_000)
}

export function stdioTransport(launch: EngineLaunchCommand, token: string): Transport {
  const child = spawn(launch.command, launch.args ?? [], {
    cwd: launch.cwd,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...launch.env, GITRADER_GSP_TOKEN: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let onMessage: (text: string) => void = () => {}
  let onClose: () => void = () => {}
  let closed = false
  let buffer = ''
  const kill = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    else child.kill('SIGKILL')
  }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (Buffer.byteLength(line) > GEP_LIMITS.maxStdioLineBytes) { kill(); return }
      if (line.trim()) onMessage(line)
    }
    if (Buffer.byteLength(buffer) > GEP_LIMITS.maxStdioLineBytes) kill()
  })
  child.stderr.on('data', () => {}) // Target stderr may contain secrets; never include it in reports.
  child.stdin.on('error', () => {})
  child.on('error', () => {})
  child.once('close', () => { closed = true; onClose() })
  return {
    kind: 'stdio',
    send: text => { if (child.stdin.writable) child.stdin.write(text + '\n') },
    onMessage: cb => { onMessage = cb },
    onClose: cb => { onClose = cb; if (closed) queueMicrotask(cb) },
    close: () => { child.stdin.end(); const timer = setTimeout(kill, 1000); timer.unref(); child.once('close', () => clearTimeout(timer)) },
    exitCode: () => child.exitCode,
  }
}
