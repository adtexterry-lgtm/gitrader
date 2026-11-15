// SPDX-License-Identifier: CPAL-1.0
// 批 10 · L2 修复回归（反证用）：L2-13 —— 订单状态 / 成交回报帧解码失败。
// 修前：只留一行 warn（无 orderId 关联、无计数），ORDER_STATUS 帧丢了会话一点痕迹都没有，
//       之后只能靠 ack 超时兜底成 3006，对账成本高。
// 修后：statusFrameLost 回调点名 orderId / reqId + lostStatusFrames 计数（会话照旧不断）。
import { describe, expect, it } from 'vitest'
import { IbSession } from '../src/session'
import { FakeTws } from './helpers/fake-tws'
import { tick } from './helpers/harness'
import * as M from '../src/messages'
import { encodeMessage } from '../src/wire'

const makeSession = (port: number): IbSession =>
  new IbSession({
    port,
    clientId: 7,
    mode: 'paper',
    connectTimeoutMs: 2000,
    requestTimeoutMs: 800,
    reconnect: { enabled: false },
  })

type LostFrame = { kind: 'order_status' | 'execution'; orderId?: number; reqId?: number; message: string }

describe('L2-13 状态帧解码失败要留痕（点名 orderId / reqId + 计数）', () => {
  it('ORDER_STATUS 畸形帧：lostStatusFrames=1，回调带 orderId=77，会话不断', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port)
    const lost: LostFrame[] = []
    const warns: string[] = []
    s.on({ statusFrameLost: (i) => lost.push(i as LostFrame), warn: (m) => warns.push(m) })
    try {
      await s.connect()
      expect(s.lostStatusFrames).toBe(0)

      // filled 字段不是数字（decodeOrderStatus 的 r.dec0() 会抛 RangeError）
      tws.sendRaw(encodeMessage([M.IN.ORDER_STATUS, 77, 'Submitted', 'not-a-number']))
      await tick(60)

      expect(s.connected).toBe(true)
      expect(s.lostStatusFrames).toBe(1)
      expect(lost).toHaveLength(1)
      expect(lost[0]).toMatchObject({ kind: 'order_status', orderId: 77 })
      expect(lost[0]!.message).toContain('orderId=77')
      expect(lost[0]!.message).toContain('status receipt is lost')
      // warn 仍然有（原有行为不变），但不再是唯一痕迹
      expect(warns.some((w) => w.includes('orderId=77'))).toBe(true)
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('EXECUTION_DATA 畸形帧：回调带 reqId，计数累加', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port)
    const lost: LostFrame[] = []
    s.on({ statusFrameLost: (i) => lost.push(i as LostFrame) })
    try {
      await s.connect()
      // contractId 不是数字 → decodeExecDetails 抛
      tws.sendRaw(encodeMessage([M.IN.EXECUTION_DATA, 55, 'not-a-number']))
      await tick(60)

      expect(s.connected).toBe(true)
      expect(s.lostStatusFrames).toBe(1)
      expect(lost[0]).toMatchObject({ kind: 'execution', reqId: 55 })
      expect(lost[0]!.message).toContain('reqId=55')
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('对照：非状态类帧解码失败只记 warn，不污染「状态回执缺失」计数', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port)
    const lost: LostFrame[] = []
    const warns: string[] = []
    s.on({ statusFrameLost: (i) => lost.push(i as LostFrame), warn: (m) => warns.push(m) })
    try {
      await s.connect()
      // OPEN_ORDER 帧缺字段
      tws.sendRaw(encodeMessage([M.IN.OPEN_ORDER, 1]))
      await tick(60)

      expect(s.connected).toBe(true)
      expect(s.lostStatusFrames).toBe(0)
      expect(lost).toHaveLength(0)
      expect(warns.some((w) => w.includes('handler failed'))).toBe(true)
    } finally {
      s.close()
      await tws.stop()
    }
  })

  it('对照：合法 ORDER_STATUS 帧照旧进 orderStatus 回调，计数保持 0', async () => {
    const tws = await FakeTws.start()
    const s = makeSession(tws.port)
    const seen: unknown[] = []
    const lost: LostFrame[] = []
    s.on({ orderStatus: (st) => seen.push(st), statusFrameLost: (i) => lost.push(i as LostFrame) })
    try {
      await s.connect()
      tws.sendRaw(encodeMessage([M.IN.ORDER_STATUS, 42, 'Filled', '1', '0', '100.5', '9', '0', '100.5', '7', '', '0']))
      await tick(60)

      expect(s.lostStatusFrames).toBe(0)
      expect(lost).toHaveLength(0)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ orderId: 42, status: 'Filled' })
    } finally {
      s.close()
      await tws.stop()
    }
  })
})
