// SPDX-License-Identifier: CPAL-1.0
// 私有流 trade_updates（十二条 #10：保留执行 id；八条 #1 的鉴权顺序照官方文档）。
// 全部用假 socket：不联网、不起端口。
import { describe, expect, it } from 'vitest'
import { fillDedupeKey, parseActivityFill } from '../src/parse'
import { AlpacaTradeStream, fillFromUpdate, normalizeStreamMessage } from '../src/stream'
import type { SocketLike, TradeUpdate } from '../src/stream'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true; this.onclose?.() }
  open(): void { this.onopen?.() }
  emit(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  emitRaw(text: string): void { this.onmessage?.({ data: text }) }
  emitBinary(payload: unknown): void {
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }
}

const KEY = 'PKTESTKEY0000000000'
const SECRET = 'test-alpaca-secret-not-real'

function makeStream(socket: FakeSocket, warns: string[] = []): AlpacaTradeStream {
  return new AlpacaTradeStream({
    url: 'wss://paper-api.alpaca.markets/stream',
    apiKey: KEY,
    apiSecret: SECRET,
    socket: () => socket,
    clock: () => 1_792_591_200_000,
    onWarn: (m) => warns.push(m),
    authTimeoutMs: 50,
  })
}

const fillMessage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  stream: 'trade_updates',
  data: {
    event: 'fill',
    execution_id: 'exec-1',
    price: '190.01',
    qty: '5',
    position_qty: '5',
    timestamp: '2026-10-21T13:35:00Z',
    order: {
      id: 'ord-1', client_order_id: 'c-1', symbol: 'AAPL', side: 'buy', type: 'limit',
      status: 'filled', qty: '5', filled_qty: '5', filled_avg_price: '190.01',
    },
    ...over,
  },
})

describe('消息归一（保留执行 id）', () => {
  it('fill → 一条 TradeUpdate，executionId 保留', () => {
    const updates = normalizeStreamMessage(fillMessage())
    expect(updates).toHaveLength(1)
    const u = updates[0]!
    expect(u.event).toBe('fill')
    expect(u.executionId).toBe('exec-1')
    expect(u.venueOrderId).toBe('ord-1')
    expect(u.clientOrderId).toBe('c-1')
    expect(u.instrumentId).toBe('alpaca:AAPL')
    expect(u.qty).toBe('5')
    expect(u.price).toBe('190.01')
    expect(u.status).toBe('filled')
    expect(u.positionQty).toBe('5')
    expect(u.ts).toBe(Date.parse('2026-10-21T13:35:00Z'))
  })
  it('partial_fill 同样是成交事件', () => {
    const u = normalizeStreamMessage(fillMessage({ event: 'partial_fill' }))[0]!
    expect(u.event).toBe('partial_fill')
    expect(u.qty).toBe('5')
  })
  it('订单事件（new / canceled）不带成交数量', () => {
    const u = normalizeStreamMessage(fillMessage({ event: 'canceled', execution_id: undefined, qty: undefined, price: undefined, order: { id: 'ord-2', symbol: 'AAPL', side: 'sell', status: 'canceled' } }))[0]!
    expect(u.event).toBe('canceled')
    expect(u.qty).toBeNull()
    expect(u.executionId).toBeNull()
  })
  it('控制消息（authorization / listening）不产生更新', () => {
    expect(normalizeStreamMessage({ stream: 'authorization', data: { status: 'authorized' } })).toEqual([])
    expect(normalizeStreamMessage({ stream: 'listening', data: { streams: ['trade_updates'] } })).toEqual([])
  })
  it('其它 stream 的消息忽略', () => {
    expect(normalizeStreamMessage({ stream: 'trade_updates2', data: {} })).toEqual([])
    expect(normalizeStreamMessage('nope')).toEqual([])
  })
  it('成交事件缺 order.filled_qty → 丢弃并告警（去重键是 order id + 累计成交量）', () => {
    const warns: string[] = []
    const updates = normalizeStreamMessage(fillMessage({
      order: { id: 'ord-1', client_order_id: 'c-1', symbol: 'AAPL', side: 'buy', status: 'filled', qty: '5' },
    }), (m) => warns.push(m))
    expect(updates).toEqual([])
    expect(warns[0]).toContain('filled_qty')
  })
  it('缺 execution_id 仍可入账（execution_id 只作诊断）', () => {
    const updates = normalizeStreamMessage(fillMessage({ execution_id: undefined }))
    expect(updates).toHaveLength(1)
    expect(updates[0]?.executionId).toBeNull()
    expect(fillFromUpdate(updates[0]!)?.venueFillId).toBe('ord-1:5')
  })
  it('缺 order.id / symbol 的消息忽略（不猜）', () => {
    expect(normalizeStreamMessage(fillMessage({ order: { symbol: 'AAPL' } }))).toEqual([])
    expect(normalizeStreamMessage(fillMessage({ order: { id: 'ord-1' } }))).toEqual([])
  })
  it('fillFromUpdate → VenueFill，venueFillId=order id + 累计成交量', () => {
    const u: TradeUpdate = normalizeStreamMessage(fillMessage())[0]!
    const fill = fillFromUpdate(u)
    expect(fill?.venueFillId).toBe('ord-1:5')
    expect(fill?.venueOrderId).toBe('ord-1')
    expect(fill?.clientOrderId).toBe('c-1')
    expect(fill?.size).toBe('5')
    expect(fill?.price).toBe('190.01')
    expect(fill?.ts).toBe(Date.parse('2026-10-21T13:35:00Z'))
  })
  it('非成交事件没有 fill', () => {
    const u = normalizeStreamMessage(fillMessage({ event: 'canceled', execution_id: undefined }))[0]!
    expect(fillFromUpdate(u)).toBeNull()
  })
  it('同一笔成交：REST 活动行与流事件得到相同的 venueFillId', () => {
    const rest = parseActivityFill({
      id: 'act-x', activity_type: 'FILL', transaction_time: '2026-10-21T13:35:00Z', price: '190.01', qty: '5',
      side: 'buy', symbol: 'AAPL', order_id: 'ord-x', cum_qty: '1790.86', leaves_qty: '0', order_status: 'filled',
    }, { now: 1_792_591_200_000 })
    const update = normalizeStreamMessage(fillMessage({
      execution_id: 'exec-x', qty: '5', price: '190.01',
      order: { id: 'ord-x', client_order_id: 'c-x', symbol: 'AAPL', side: 'buy', status: 'filled', filled_qty: '1790.86' },
    }))[0]!
    const stream = fillFromUpdate(update)
    expect(rest.fill.venueFillId).toBe('ord-x:1790.86')
    expect(stream?.venueFillId).toBe(rest.fill.venueFillId)
    expect(rest.activityId).toBe('act-x')
    expect(rest.executionId).toBeNull()
    expect(update.executionId).toBe('exec-x')
    expect(fillDedupeKey({ venueOrderId: 'ord-x', cumQty: '1790.860' })).toBe(rest.fill.venueFillId)
    expect(() => fillDedupeKey({ venueOrderId: 'ord-x' })).toThrow(TypeError)
  })
})

describe('连接握手（auth → listen → listening）', () => {
  it('连上后立刻发 auth（key / secret 在消息里，不出现在诊断文本）', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const ready = stream.connect()
    socket.open()
    expect(socket.sent).toHaveLength(1)
    const auth = JSON.parse(socket.sent[0]!) as Record<string, unknown>
    expect(auth['action']).toBe('auth')
    expect(auth['key']).toBe(KEY)
    expect(auth['secret']).toBe(SECRET)
    expect(stream.state).toBe('authorizing')
    socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
    expect(stream.state).toBe('subscribing')
    expect(JSON.parse(socket.sent[1]!)).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } })
    socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await expect(ready).resolves.toBeUndefined()
    expect(stream.state).toBe('connected')
  })
  it('授权失败 → connect 拒绝', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const ready = stream.connect()
    socket.open()
    socket.emit({ stream: 'authorization', data: { status: 'unauthorized' } })
    await expect(ready).rejects.toThrow(/refused the credentials/)
  })
  it('二进制帧（ArrayBuffer）也能走完握手并收到 fill', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const got: TradeUpdate[] = []
    stream.onUpdate((u) => got.push(u))
    const ready = stream.connect()
    socket.open()
    socket.emitBinary({ stream: 'authorization', data: { status: 'authorized' } })
    expect(stream.state).toBe('subscribing')
    socket.emitBinary({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await expect(ready).resolves.toBeUndefined()
    socket.emitBinary(fillMessage())
    expect(got).toHaveLength(1)
    expect(got[0]?.venueOrderId).toBe('ord-1')
  })
  it('错误帧 → connect 拒绝', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const ready = stream.connect()
    socket.open()
    socket.emit({ stream: 'error', data: { code: 406, msg: 'connection limit exceeded' } })
    await expect(ready).rejects.toThrow(/connection limit exceeded/)
  })
  it('未就绪就断开 → connect 拒绝', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const ready = stream.connect()
    socket.open()
    socket.close()
    await expect(ready).rejects.toThrow(/closed before it was ready/)
    expect(stream.state).toBe('closed')
  })
  it('非 JSON 帧忽略并告警', async () => {
    const socket = new FakeSocket()
    const warns: string[] = []
    const stream = makeStream(socket, warns)
    const ready = stream.connect()
    socket.open()
    socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
    socket.emitRaw('not json')
    socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await expect(ready).resolves.toBeUndefined()
    expect(warns.some((w) => w.includes('non-JSON'))).toBe(true)
  })
  it('已连接时重复 connect 直接返回', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const ready = stream.connect()
    socket.open()
    socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
    socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await ready
    const sentBefore = socket.sent.length
    await expect(stream.connect()).resolves.toBeUndefined()
    expect(socket.sent.length).toBe(sentBefore)
  })
})

describe('订阅与关闭', () => {
  it('update 推给监听者；退订后不再推', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const got: TradeUpdate[] = []
    const off = stream.onUpdate((u) => got.push(u))
    const ready = stream.connect()
    socket.open()
    socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
    socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await ready
    socket.emit(fillMessage())
    expect(got).toHaveLength(1)
    off()
    socket.emit(fillMessage({ execution_id: 'exec-2' }))
    expect(got).toHaveLength(1)
  })
  it('lastMessageTs 记录最近一条消息（注入时钟）', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const ready = stream.connect()
    socket.open()
    socket.emit({ stream: 'authorization', data: { status: 'authorized' } })
    socket.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await ready
    expect(stream.lastMessageTs).toBe(1_792_591_200_000)
  })
  it('close 幂等并把状态置 closed（未连接时 close 也不抛）', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    stream.close()
    expect(stream.state).toBe('closed')
    const socket2 = new FakeSocket()
    const stream2 = makeStream(socket2)
    const ready = stream2.connect()
    socket2.open()
    socket2.emit({ stream: 'authorization', data: { status: 'authorized' } })
    socket2.emit({ stream: 'listening', data: { streams: ['trade_updates'] } })
    await ready
    stream2.close()
    stream2.close()
    expect(stream2.state).toBe('closed')
    expect(socket2.closed).toBe(true)
  })
  it('鉴权超时 → connect 拒绝', async () => {
    const socket = new FakeSocket()
    const stream = makeStream(socket)
    const ready = stream.connect()
    socket.open()
    await expect(ready).rejects.toThrow(/did not authorize/)
  })
  it('没有 socket 实现且宿主无 WebSocket → 抛明确错误', async () => {
    const original = (globalThis as { WebSocket?: unknown }).WebSocket
    delete (globalThis as { WebSocket?: unknown }).WebSocket
    try {
      const stream = new AlpacaTradeStream({ url: 'wss://x/stream', apiKey: KEY, apiSecret: SECRET })
      await expect(stream.connect()).rejects.toThrow(/no WebSocket implementation/)
    } finally {
      if (original !== undefined) (globalThis as { WebSocket?: unknown }).WebSocket = original
    }
  })
})
