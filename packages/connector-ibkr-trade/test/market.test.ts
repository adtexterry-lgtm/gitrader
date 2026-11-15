// SPDX-License-Identifier: CPAL-1.0
// 行情：只做下单价带要用的快照；无权限不伪造价格；K 线 / L2 老实回 5002。
import { afterEach, describe, expect, it } from 'vitest'
import * as M from '../src/messages'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => {
  if (h !== undefined) await h.close()
  h = undefined
})

describe('market · 快照报价', () => {
  it('快照给出 bid / ask / last，并标记新鲜', async () => {
    h = await makeHarness({ tws: { quote: { bid: 100, ask: 100.02, last: 100.01 } } })
    const q = await h.connector.refreshQuote('ibkr:AAPL')
    expect(q?.bid).toBe(100)
    expect(q?.ask).toBe(100.02)
    expect(q?.last).toBe(100.01)
    expect(q?.stale).toBe(false)
    expect(q?.ageMs).toBe(0)
  })

  it('参考价优先取 mid（价带基准）', async () => {
    h = await makeHarness({ tws: { quote: { bid: 100, ask: 101, last: 100.5 } } })
    await h.connector.refreshQuote('ibkr:AAPL')
    expect(h.connector.market.referencePrice('ibkr:AAPL')).toBe(100.5)
  })

  it('未拉过快照时 quote() 返回 undefined（不编价格）', async () => {
    h = await makeHarness()
    expect(h.connector.quote('ibkr:AAPL')).toBeUndefined()
  })

  it('快照超过陈旧阈值 → stale=true', async () => {
    h = await makeHarness({ tws: { quote: { bid: 100, ask: 100, last: 100 } }, connector: {} })
    await h.connector.refreshQuote('ibkr:AAPL')
    h.clock.now += 60_000
    const q = h.connector.quote('ibkr:AAPL')
    expect(q?.stale).toBe(true)
    expect(q?.ageMs).toBe(60_000)
  })

  it('无行情权限（IB 354）→ undefined + 记下错误码（供拒单说明）', async () => {
    h = await makeHarness({ tws: { quote: null } })
    const q = await h.connector.refreshQuote('ibkr:AAPL')
    expect(q).toBeUndefined()
    expect(h.connector.market.lastMarketErrorCode).toBe(354)
  })

  it('快照请求是 snapshot=true 的 reqMktData（不订阅长连接行情），tickerId 用 allocateReqId', async () => {
    h = await makeHarness()
    await h.connector.refreshQuote('ibkr:AAPL')
    const frame = h.tws.frames(M.OUT.REQ_MKT_DATA)[0]!
    expect(frame.fields[0]).toBe('1')
    expect(frame.fields[1]).toBe('11')
    expect(Number(frame.fields[2])).toBeGreaterThanOrEqual(1_000_000)
    expect(frame.fields[16]).toBe('')
    expect(frame.fields[17]).toBe('1')
    expect(frame.fields[18]).toBe('0')
  })

  it('未知标的的快照 → undefined（标的先要 qualify）', async () => {
    h = await makeHarness()
    expect(await h.connector.refreshQuote('ibkr:MSFT')).toBeUndefined()
  })

  it('status()：连接态 + 数据来源', async () => {
    h = await makeHarness()
    await h.connector.refreshQuote('ibkr:AAPL')
    const st = h.connector.status()
    expect(st.venue).toBe('ibkr')
    expect(st.environment).toBe('testnet')
    expect(st.wsState).toBe('connected')
    expect(st.source).toBe('rest')
  })
})

describe('market · 不假装支持', () => {
  it('K 线 → 5002 CAPABILITY_UNSUPPORTED', async () => {
    h = await makeHarness()
    await expect(h.connector.candles('ibkr:AAPL', '1m')).rejects.toMatchObject({ problem: { code: 5002 } })
  })

  it('L2 盘口 → 5002 CAPABILITY_UNSUPPORTED', async () => {
    h = await makeHarness()
    await expect(h.connector.book('ibkr:AAPL', 5)).rejects.toMatchObject({ problem: { code: 5002 } })
  })

  it('没有快照就取行情上下文 → 4005 DATA_UNAVAILABLE', async () => {
    h = await makeHarness()
    await expect(h.connector.context('ibkr:AAPL')).rejects.toMatchObject({ problem: { code: 4005 } })
  })

  it('有快照时行情上下文给 mid', async () => {
    h = await makeHarness({ tws: { quote: { bid: 100, ask: 101, last: 100 } } })
    await h.connector.refreshQuote('ibkr:AAPL')
    const ctx = await h.connector.context('ibkr:AAPL')
    expect(ctx.markPrice).toBe(100.5)
  })

  it('不支持的消息通道只 warning，返回空 unsubscribe', async () => {
    const warns: string[] = []
    h = await makeHarness({ connector: { onWarn: (m) => warns.push(m) } })
    const unsub = h.connector.subscribe({ channel: 'book', instrumentId: 'ibkr:AAPL' }, () => {})
    expect(typeof unsub).toBe('function')
    unsub()
    expect(warns.some((w) => w.includes('not supported'))).toBe(true)
  })
})
