// SPDX-License-Identifier: CPAL-1.0
// 工作台 WebSocket（壳 ↔ 内核）。线格式以 protocol 的 `src/ui/wire.ts`（v0.1.3）为准：
//   路径 /ui；JSON-RPC 2.0 文本帧，每帧一个对象，≤ 1 MiB；
//   首帧必须是 `auth`（5 s 内），令牌永远不放 URL；方法 auth / subscribe / unsubscribe / query / command；内核 → 壳的通知 `event`；
//   命令带 origin{tool, via:"ui"}（actor / actorType / requestId 由内核按已认证身份盖章，壳不能自报）与可选 attestation（PIN 在场证明）；
//   需要在场证明而没带 → 错误 data.name = ATTESTATION_REQUIRED（1010）；错误的 PIN → AUTH_FAILED（5003）。
// 只有会话 / service 主体能连；Agent 钥匙走 MCP / HTTP 面，不走人面通道。
import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { EVENT_TOPICS } from '../events'
import { UI_LIMITS, UI_WS_PATH, makeProblem, splitInstrumentId } from '../proto'
import type { Kernel } from '../kernel'
import type { Principal } from '../auth'
import { KernelError, toProblem } from '../util/errors'

const MAX_BUFFERED = 4 * 1024 * 1024
const SNAPSHOT_TOPICS = /^(market\.|account\.summary|account\.positions|venue\.status|engine\.health)/

interface Sub { sid: string; topic: string; minGapMs: number; lastSent: number; pending?: { topic: string; data: unknown; ts: number }[]; timer?: ReturnType<typeof setTimeout>; unsub: () => void; unwatch?: () => void }
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const matchesFilter = (data: unknown, filter: Record<string, unknown>): boolean => {
  const d = data as Json | null
  for (const [k, want] of Object.entries(filter)) {
    const cands = [d?.[k], d?.subject?.[k], d?.order?.[k], d?.fill?.[k], d?.position?.[k]].filter((v) => v !== undefined)
    if (cands.length && !cands.includes(want)) return false
  }
  return true
}

const rpcError = (id: unknown, e: unknown): Json => {
  const p = toProblem(e)
  return { jsonrpc: '2.0', id: id ?? null, error: { code: p.code, message: p.message, data: p } }
}

export function attachWs(kernel: Kernel, server: Server, port: () => number): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: UI_LIMITS.maxFrameBytes })

  server.on('upgrade', (req, socket, head) => {
    const reject = (code: number, why: string): void => { socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); socket.destroy() }
    if (new URL(req.url ?? '/', 'http://x').pathname !== UI_WS_PATH) return reject(404, 'Not Found')
    const hc = kernel.auth.checkHeaders(req.headers, port())
    if (!hc.ok) return reject(403, 'Forbidden')
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws))
  })

  const onConnection = (ws: WebSocket): void => {
    let principal: Principal | null = null
    let seq = 0
    let nextSid = 1
    const subs = new Map<string, Sub>()
    const send = (o: unknown): void => { if (ws.readyState === 1) ws.send(JSON.stringify(o)) }
    const bye = (code: number, reason: string): void => { ws.close(code, reason) }
    const sessionActive = (): boolean => principal?.kind !== 'session' || kernel.auth.isSessionActive(principal)
    const rejectInactiveSession = (id?: unknown): boolean => {
      if (sessionActive()) return false
      send(rpcError(id, new KernelError(makeProblem('AUTH_FAILED', 'session is no longer active'))))
      bye(4401, 'authentication failed')
      return true
    }
    const authTimer = setTimeout(() => { if (!principal) bye(4401, 'auth timeout') }, UI_LIMITS.authTimeoutMs)

    const dropSub = (s: Sub): void => { s.unsub(); s.unwatch?.(); clearTimeout(s.timer); subs.delete(s.sid) }
    const deliver = (s: Sub, topic: string, data: unknown, ts: number): void => {
      if (rejectInactiveSession()) return
      if (ws.bufferedAmount > MAX_BUFFERED) { if (SNAPSHOT_TOPICS.test(topic)) return; bye(1013, 'client too slow'); return }
      send({ jsonrpc: '2.0', method: 'event', params: { subscriptionId: s.sid, topic, seq: ++seq, ts, data } })
      s.lastSent = Date.now()
    }

    const subscribe = (p: Json): { subscriptionId: string } => {
      const topic = String(p.topic ?? '')
      const filter = (p.filter ?? {}) as Record<string, unknown>
      if (!(topic === '*' || topic.endsWith('.*') || (EVENT_TOPICS as readonly string[]).includes(topic) || topic.startsWith('link.'))) throw new KernelError(makeProblem('INVALID_PARAMS', `unknown topic ${topic}`))
      if (topic === '*' && [...subs.values()].some((sub) => sub.topic === '*')) throw new KernelError(makeProblem('RATE_BUDGET', 'a wildcard subscription is already active; unsubscribe before retrying'))
      if (subs.size >= (kernel.config.server.maxWsSubscriptions ?? 64)) throw new KernelError(makeProblem('RATE_BUDGET', 'WebSocket subscription limit reached'))
      const sid = `sub_${nextSid++}`
      const maxHz = typeof p.maxHz === 'number' && p.maxHz > 0 ? p.maxHz : 0
      const sub: Sub = { sid, topic, minGapMs: maxHz ? Math.floor(1000 / maxHz) : 0, lastSent: 0, unsub: () => undefined }
      sub.unsub = kernel.events.subscribe(topic, (e) => {
        if (rejectInactiveSession()) return
        if (!matchesFilter(e.data, filter)) return
        if (!sub.minGapMs) return deliver(sub, e.topic, e.data, e.ts)
        const wait = sub.lastSent + sub.minGapMs - Date.now()
        if (wait <= 0 && !sub.timer) return deliver(sub, e.topic, e.data, e.ts)
        // 窗口内按顺序合批，不覆盖事件。慢客户端明确断开，绝不静默漏账。
        sub.pending ??= []
        sub.pending.push({ topic: e.topic, data: e.data, ts: e.ts })
        if (sub.pending.length > 10_000) { bye(1013, 'client too slow'); return }
        sub.timer ??= setTimeout(() => {
          sub.timer = undefined
          const pend = sub.pending
          sub.pending = undefined
          if (!pend?.length) return
          // 通配订阅按连续 topic 分组，保持跨主题原始顺序；每帧不超过协议上限。
          let batch: { seq: number; ts: number; data: unknown }[] = []
          let topic = pend[0]!.topic
          let bytes = 256
          const flush = (): void => {
            if (!batch.length) return
            if (rejectInactiveSession()) { batch = []; return }
            if (ws.bufferedAmount > MAX_BUFFERED) { bye(1013, 'client too slow'); batch = []; return }
            send({ jsonrpc: '2.0', method: 'event', params: { subscriptionId: sub.sid, topic, events: batch } })
            batch = []; bytes = 256; sub.lastSent = Date.now()
          }
          for (const item of pend) {
            const size = Buffer.byteLength(JSON.stringify(item.data), 'utf8') + 128
            if (size + 256 > UI_LIMITS.maxFrameBytes) { bye(1009, 'event too large'); return }
            if (item.topic !== topic || bytes + size > UI_LIMITS.maxFrameBytes) { flush(); topic = item.topic }
            batch.push({ seq: ++seq, ts: item.ts, data: item.data }); bytes += size
          }
          flush()
        }, Math.max(wait, 1))
      })
      // 行情主题：让连接器开始推送该标的
      if (topic.startsWith('market.') && typeof filter.instrumentId === 'string') {
        try {
          splitInstrumentId(filter.instrumentId)
          const ch = topic.slice('market.'.length)
          if (ch === 'quote' || ch === 'book') sub.unwatch = kernel.bus.watchMarket(filter.instrumentId, ch)
          else if (ch === 'candles') sub.unwatch = kernel.bus.watchMarket(filter.instrumentId, 'candles', (filter.interval ?? '1m') as never)
        } catch { /* 无效标的：订阅仍成立，只是没有行情 */ }
      }
      subs.set(sid, sub)
      return { subscriptionId: sid }
    }

    ws.on('message', (raw, isBinary) => {
      void (async () => {
        let msg: Json
        try {
          if (isBinary) throw new Error('binary')
          msg = JSON.parse(raw.toString('utf8')) as Json
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('not an object')
        } catch { send(rpcError(null, new KernelError(makeProblem('PARSE_ERROR', 'invalid JSON frame')))); return }
        const id = msg.id
        if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') { send(rpcError(id, new KernelError(makeProblem('INVALID_REQUEST', 'expected a JSON-RPC 2.0 request')))); return }
        const params = (msg.params ?? {}) as Json
        if (!principal) {
          if (msg.method !== 'auth') { send(rpcError(id, new KernelError(makeProblem('AUTH_FAILED', 'the first frame must be auth')))); return bye(4401, 'auth required') }
          const p = kernel.auth.authenticateToken(String(params.token ?? ''))
          if (!p || p.kind === 'agent') { send(rpcError(id, new KernelError(makeProblem('AUTH_FAILED', 'authentication failed')))); return bye(4401, 'authentication failed') }
          principal = p
          clearTimeout(authTimer)
          return send({ jsonrpc: '2.0', id, result: { ok: true, user: 'usr_local' } })
        }
        if (rejectInactiveSession(id)) return
        try {
          if (msg.method !== 'query' && msg.method !== 'command') kernel.consumeOperationRate(principal, `ws:${msg.method}`, params)
          let result: unknown
          switch (msg.method) {
            case 'auth': result = { ok: true, user: 'usr_local' }; break
            case 'subscribe': result = subscribe(params); break
            case 'unsubscribe': { const s = subs.get(String(params.subscriptionId)); if (s) dropSub(s); result = { ok: true }; break }
            case 'query': result = await kernel.ops.call(kernel, String(params.method ?? ''), { principal, params: (params.params ?? {}) as Json, transport: 'ws', kind: 'query' }); break
            case 'command': {
              const att = params.attestation as { method?: string; pin?: string } | undefined
              if (att && att.method && att.method !== 'pin') throw new KernelError(makeProblem('CAPABILITY_UNSUPPORTED', `attestation method ${att.method} is not supported yet (M1.1)`))
              const rawTool = (params.origin as { tool?: unknown } | undefined)?.tool
              const tool = typeof rawTool === 'string' && /^[\w:.\-/ ]{1,120}$/.test(rawTool) ? rawTool : `ui:${String(params.action ?? '')}`
              result = await kernel.ops.call(kernel, String(params.action ?? ''), { principal, params: (params.params ?? {}) as Json, ...(typeof att?.pin === 'string' ? { pin: att.pin } : {}), transport: 'ws', kind: 'command', tool })
              break
            }
            default: throw new KernelError(makeProblem('METHOD_NOT_FOUND', `unknown method ${String(msg.method)}`))
          }
          if (id !== undefined) send({ jsonrpc: '2.0', id, result: result ?? null })
        } catch (e) { if (id !== undefined) send(rpcError(id, e)) }
      })()
    })
    ws.on('close', () => { clearTimeout(authTimer); for (const s of [...subs.values()]) dropSub(s) })
    ws.on('error', () => undefined)
  }

  return { close: () => { for (const c of wss.clients) c.terminate(); wss.close() } }
}
