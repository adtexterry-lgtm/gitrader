// SPDX-License-Identifier: CPAL-1.0
// 会话：握手、版本（只 178）、clientId 占用（新连接被 326 拒）、信息 / 警告类消息、断线状态。全部打假 TWS 的真 socket。
import { describe, expect, it } from 'vitest'
import { IbSession } from '../src/session'
import { FakeTws } from './helpers/fake-tws'
import { tick } from './helpers/harness'
import * as M from '../src/messages'
import { encodeMessage } from '../src/wire'

const makeSession = (port: number, over: Partial<ConstructorParameters<typeof IbSession>[0]> = {}): IbSession =>
  new IbSession({
    port,
    clientId: 7,
    mode: 'paper',
    connectTimeoutMs: 2000,
    requestTimeoutMs: 800,
    reconnect: { enabled: false },
    ...over,
  })

describe('session · 握手与版本协商', () => {
  it('连上后握手 v178..178 → START_API(clientId) → nextValidId', async () => {
    const tws = await FakeTws.start({ startOrderId: 4242 })
    const s = makeSession(tws.port)
    try {
      await s.connect()
      expect(s.connected).toBe(true)
      expect(s.serverVersion).toBe(178)
      expect(s.apiVersion).toBe(178)
      expect(s.nextOrderId).toBe(4242)
      expect(tws.startApiClientIds).toEqual([7])
      expect(tws.received.find((f) => f.msgId === -1)?.fields).toEqual(['v178..178'])
      expect(tws.frames(M.OUT.START_API)).toHaveLength(1)
      expect(tws.frames(M.OUT.START_API)[0]!.fields).toEqual(['71', '2', '7', ''])
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('服务器版本低于 178 → 连接失败（5001 VERSION_UNSUPPORTED），不重连', async () => {
    const tws = await FakeTws.start({ serverVersion: 99 })
    const s = makeSession(tws.port)
    try {
      await expect(s.connect()).rejects.toMatchObject({ problem: { code: 5001 } })
      await tick(30)
      expect(s.state).toBe('closed')
      expect(tws.frames(M.OUT.START_API)).toHaveLength(0)
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('服务器版本高于 178 也拒绝（本包只支持 178）', async () => {
    const tws = await FakeTws.start({ serverVersion: 200 })
    const s = makeSession(tws.port)
    try {
      await expect(s.connect()).rejects.toMatchObject({ problem: { code: 5001 } })
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('非回环地址在构造时拒绝（不走远程 socket）', () => {
    expect(() => makeSession(7497, { host: '10.1.2.3' })).toThrow(/loopback/)
  })

  it('端口没人监听 → 连接失败（3003）', async () => {
    const tws = await FakeTws.start()
    const port = tws.port
    await tws.stop()
    const s = makeSession(port, { connectTimeoutMs: 600 })
    await expect(s.connect()).rejects.toMatchObject({ problem: { code: 3003 } })
    s.close()
  })
})

describe('session · 本地限速（IB 每秒 50 条上限）', () => {
  it('低于上限时连发不等待', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port, { maxMessagesPerSecond: 45 })
    try {
      await s.connect()
      const t0 = Date.now()
      for (let i = 0; i < 5; i += 1) await s.send(M.reqOpenOrders())
      expect(Date.now() - t0).toBeLessThan(300)
      await tick(60)
      expect(tws.frames(M.OUT.REQ_OPEN_ORDERS)).toHaveLength(5)
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('超过每秒上限时等窗口（不丢消息）', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port, { maxMessagesPerSecond: 1 })
    try {
      await s.connect()
      const t0 = Date.now()
      await s.send(M.reqOpenOrders())
      await s.send(M.reqOpenOrders())
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
      await tick(60)
      expect(tws.frames(M.OUT.REQ_OPEN_ORDERS)).toHaveLength(2)
      expect(s.connected).toBe(true)
    } finally {
      s.close()
      await tws.stop()
    }
  })
})

describe('session · clientId 规则（326：新连接被拒，旧连接不动）', () => {
  it('同一个 clientId 的第二个连接收到 326 → VENUE_AUTH；第一个仍在线', async () => {
    const tws = await FakeTws.start()
    const first = makeSession(tws.port)
    const second = makeSession(tws.port)
    try {
      await first.connect()
      expect(first.connected).toBe(true)
      await expect(second.connect()).rejects.toMatchObject({ problem: { code: 3005 } })
      await tick(60)
      expect(second.connected).toBe(false)
      expect(first.connected).toBe(true)
      expect(tws.liveClientIds).toEqual([7])
    } finally {
      first.close()
      second.close()
      await tws.stop()
    }
  })

  it('不同 clientId 可以并存（手动 1 + 自动化 7）', async () => {
    const tws = await FakeTws.start()
    const auto = makeSession(tws.port, { clientId: 7 })
    const manual = makeSession(tws.port, { clientId: 1 })
    try {
      await auto.connect()
      await manual.connect()
      await tick(40)
      expect(auto.connected).toBe(true)
      expect(manual.connected).toBe(true)
      expect(tws.startApiClientIds.sort()).toEqual([1, 7])
    } finally {
      auto.close()
      manual.close()
      await tws.stop()
    }
  })
})

describe('session · 消息与错误通道', () => {
  it('信息类消息（2104 / 2158 农场状态）走 info，不当错误', async () => {
    const tws = await FakeTws.start({ infoOnConnect: [2104, 2158] })
    const infos: number[] = []
    const errors: number[] = []
    const s = makeSession(tws.port)
    s.on({ error: (e) => { if (e.info) infos.push(e.code); else errors.push(e.code) } })
    try {
      await s.connect()
      await tick(40)
      expect(infos).toEqual([2104, 2158])
      expect(errors).toEqual([])
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('警告类（2109 / 404）也走 info，不当错误', async () => {
    const tws = await FakeTws.start()
    const infos: number[] = []
    const s = makeSession(tws.port)
    s.on({ error: (e) => { if (e.info) infos.push(e.code) } })
    try {
      await s.connect()
      tws.emitError(2109, 'farm ok')
      tws.emitError(404, 'order sent to exchange')
      await tick(50)
      expect(infos).toEqual([2109, 404])
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('真错误（354 无行情权限）走 error 通道并带 Problem + hint', async () => {
    const tws = await FakeTws.start({ quote: null })
    const seen: Array<{ code: number; problem?: number; hint?: string }> = []
    const s = makeSession(tws.port)
    s.on({ error: (e) => seen.push({ code: e.code, ...(e.problem !== undefined ? { problem: e.problem.code } : {}), ...(e.hint !== undefined ? { hint: e.hint } : {}) }) })
    try {
      await s.connect()
      await s.send(M.reqMarketData(77, M.stockContract('AAPL')))
      await tick(60)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.code).toBe(354)
      expect(seen[0]!.problem).toBe(3003)
      expect(seen[0]!.hint).toContain('参考价')
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('未连接时 send → 3003 + hint（不静默丢单）', async () => {
    const s = makeSession(1)
    await expect(s.send(M.reqCurrentTime())).rejects.toMatchObject({ problem: { code: 3003 } })
  })

  it('请求超时 → 3003（只读可重试）', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port, { requestTimeoutMs: 120 })
    try {
      await s.connect()
      await expect(
        s.request({ label: 'never', build: M.reqCurrentTime(), initial: 0, onFrame: () => false }),
      ).rejects.toMatchObject({ problem: { code: 3003 } })
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('对端断开 → 状态离开 connected，并上报 disconnect', async () => {
    const tws = await FakeTws.start()
    const seen: Array<{ code: number; unexpected: boolean }> = []
    const s = makeSession(tws.port)
    s.on({ disconnect: (i) => seen.push({ code: i.code, unexpected: i.unexpected }) })
    try {
      await s.connect()
      tws.dropAll()
      await tick(80)
      expect(s.connected).toBe(false)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.unexpected).toBe(true)
      expect(seen[0]!.code).toBe(1100)
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('用户 close() 不算意外断开（不发 1100）', async () => {
    const tws = await FakeTws.start()
    const seen: Array<{ unexpected: boolean }> = []
    const s = makeSession(tws.port)
    s.on({ disconnect: (i) => seen.push({ unexpected: i.unexpected }) })
    await s.connect()
    s.close()
    await tick(60)
    expect(seen).toHaveLength(0)
    expect(s.state).toBe('closed')
    await tws.stop()
  })

  it('未订阅的消息号被忽略，会话保持连接', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port)
    const warns: string[] = []
    s.on({ warn: (m) => warns.push(m) })
    try {
      await s.connect()
      tws.sendRaw(encodeMessage(['999', '1', 'x']))
      await tick(50)
      expect(s.connected).toBe(true)
      expect(warns).toEqual([])
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('字段不足的 orderStatus 帧只记 warning，不断连接', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port)
    const warns: string[] = []
    s.on({ warn: (m) => warns.push(m) })
    try {
      await s.connect()
      tws.sendRaw(encodeMessage([M.IN.ORDER_STATUS, 1]))
      await tick(60)
      expect(s.connected).toBe(true)
      expect(warns.some((w) => w.includes('handler failed'))).toBe(true)
      await s.request({ label: 'afterGarbage', build: M.reqCurrentTime(), initial: 0, onFrame: (f, acc) => (Number(f[0]) === M.IN.CURRENT_TIME ? (void acc, true) : false) })
    } finally {
      s.close()
      await tws.stop()
    }
  })
})
