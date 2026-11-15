// SPDX-License-Identifier: CPAL-1.0
// 传输层（契约 §2.1）：本地 WebSocket（loopback、路径 /gep、子协议 gep.v0、单帧 ≤ 4 MiB）与 stdio（NDJSON、单行 ≤ 1 MiB）。
// 传输层只搬帧：每个连接对应 EngineCore.connect() 返回的 Conn。
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { GEP_LIMITS, GEP_WS_PATH, GEP_WS_SUBPROTOCOL } from '../proto'
import type { EngineCore } from '../runtime/engine'

export interface WsListening { port: number; url: string; close(): Promise<void> }

/** 在 loopback 上监听 GEP WebSocket。port = 0 取空闲端口。 */
export function listenWs(core: EngineCore, opts: { port?: number; host?: '127.0.0.1' | '::1' } = {}): Promise<WsListening> {
  const host = opts.host ?? '127.0.0.1'
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host, port: opts.port ?? 0, path: GEP_WS_PATH, maxPayload: GEP_LIMITS.maxWsFrameBytes,
      // 浏览器页面带 Origin；宿主进程不带。拒绝浏览器发起的连接（防网页借 loopback 探测）
      verifyClient: (info: { origin: string }) => !info.origin,
      handleProtocols: (protocols: Set<string>) => (protocols.has(GEP_WS_SUBPROTOCOL) ? GEP_WS_SUBPROTOCOL : false),
    })
    wss.once('error', reject)
    wss.on('connection', (ws: WebSocket) => {
      const conn = core.connect({
        kind: 'ws', maxFrameBytes: GEP_LIMITS.maxWsFrameBytes,
        send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text) },
        closeTransport: () => { try { ws.close(1000) } catch { /* 已关 */ } setTimeout(() => ws.terminate(), 200).unref?.() },
      })
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        void conn.peer.receive(data.toString('utf8'))
      })
      ws.on('close', () => core.disconnect(conn))
      ws.on('error', () => core.disconnect(conn))
    })
    wss.once('listening', () => {
      wss.off('error', reject)
      const addr = wss.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port, url: `ws://${host === '::1' ? '[::1]' : host}:${port}${GEP_WS_PATH}`,
        close: () => new Promise<void>((res) => { for (const c of wss.clients) c.terminate(); wss.close(() => res()) }),
      })
    })
  })
}

/** stdio 传输：stdin 每行一个 JSON，stdout 每行一个 JSON；stderr 只放日志。输入结束视为宿主退出。 */
export function serveStdio(core: EngineCore, io: { stdin: Readable; stdout: Writable; onEnd?: () => void }): { close(): void } {
  const conn = core.connect({
    kind: 'stdio', maxFrameBytes: GEP_LIMITS.maxStdioLineBytes,
    send: (text) => { io.stdout.write(text + '\n') },
    closeTransport: () => { io.onEnd?.() },
  })
  const rl = createInterface({ input: io.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (line.trim() === '') return
    void conn.peer.receive(line)
  })
  rl.on('close', () => { core.disconnect(conn); io.onEnd?.() })
  return { close: () => rl.close() }
}
