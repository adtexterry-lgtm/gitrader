// SPDX-License-Identifier: CPAL-1.0
// 连接器装配：能力声明（八条 8）、模拟 / 实盘不混（八条 7）、构造校验、start / close。
import { afterEach, describe, expect, it } from 'vitest'
import { IbkrTradeConnector } from '../src/index'
import { ibkrCapabilities } from '../src/capabilities'
import { FakeTws } from './helpers/fake-tws'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness | undefined
afterEach(async () => {
  if (h !== undefined) await h.close()
  h = undefined
})

describe('connector · 能力声明（八条 8：能力老实）', () => {
  it('市价是 emulated + ioc_limit（不发裸市价）', () => {
    const caps = ibkrCapabilities()
    expect(caps.orderTypes.market).toBe('emulated')
    expect(caps.marketEmulation).toEqual({ method: 'ioc_limit' })
  })

  it('支持的四种单型 native，止盈类 / twap 声明 none', () => {
    const caps = ibkrCapabilities()
    expect(caps.orderTypes.limit).toBe('native')
    expect(caps.orderTypes.stop_market).toBe('native')
    expect(caps.orderTypes.stop_limit).toBe('native')
    expect(caps.orderTypes.trailing_stop).toBe('native')
    expect(caps.orderTypes.take_market).toBe('none')
    expect(caps.orderTypes.take_limit).toBe('none')
    expect(caps.orderTypes.twap).toBe('none')
  })

  it('tpsl 只声明 order 级 bracket；amend=none；cancelAll=emulated', () => {
    const caps = ibkrCapabilities()
    expect(caps.tpsl).toEqual({ attachToOrder: true, positionLevel: false, parentPartialCancel: 'cancel_children' })
    expect(caps.amend).toBe('none')
    expect(caps.cancelAll).toBe('emulated')
  })

  it('不声明死人开关与杠杆（IB 没有定时全撤 / 按单杠杆）', () => {
    const caps = ibkrCapabilities()
    expect(caps.deadman).toBeUndefined()
    expect(caps.marginModes).toEqual(['cross'])
  })

  it('socket 形态写进扩展键（回环 + 版本）；扩展键不改语义', () => {
    const caps = ibkrCapabilities()
    expect(caps['x-ibkr']).toMatchObject({ socketApi: { loopbackOnly: true, apiVersion: 178 } })
    expect(caps.environments).toEqual(['testnet', 'mainnet'])
  })

  it('允许盘前盘后时扩展键如实反映（缺省 refused）', () => {
    expect(ibkrCapabilities()['x-ibkr']).toMatchObject({ extendedHours: 'refused' })
    expect(ibkrCapabilities({ extendedHours: true })['x-ibkr']).toMatchObject({ extendedHours: 'limit_day_only' })
  })

  it('连上后 describe() 与实际会话一致', async () => {
    h = await makeHarness()
    const caps = h.connector.describe()
    expect(caps.venue).toBe('ibkr')
    expect(caps.tif).toEqual(['gtc', 'ioc', 'gtd'])
    expect(caps.triggerPriceTypes).toEqual(['last'])
  })

  it('多账户且没给 account → start() 抛 INVALID_PARAMS；给了 account 就能启动', async () => {
    h = await makeHarness({ start: false, tws: { accounts: ['DU1', 'DU2'] } })
    await expect(h.connector.start()).rejects.toMatchObject({ problem: { code: -32602 } })
    await h.connector.close()
    h = await makeHarness({ tws: { accounts: ['DU1', 'DU2'] }, connector: { account: 'DU1' } })
    expect(h.connector.accounts.accountId).toBe('DU1')
  })
})

describe('connector · 模拟 / 实盘不混（八条 7）', () => {
  it('paper + 实盘端口（7496）→ 构造就拒绝', () => {
    expect(() => new IbkrTradeConnector({ mode: 'paper', port: 7496 })).toThrow(/belongs to the live environment/)
  })

  it('live + 模拟端口（7497）→ 构造就拒绝', () => {
    expect(() => new IbkrTradeConnector({ mode: 'live', port: 7497 })).toThrow(/belongs to the paper environment/)
  })

  it('paper + 模拟端口（7497 / 4002）通过（不连，只看校验）', () => {
    const c1 = new IbkrTradeConnector({ mode: 'paper', port: 7497 })
    const c2 = new IbkrTradeConnector({ mode: 'paper', port: 4002 })
    expect(c1.environment).toBe('testnet')
    expect(c2.environment).toBe('testnet')
    c1.close()
    c2.close()
  })

  it('live 环境的连接器 environment=mainnet', () => {
    const c = new IbkrTradeConnector({ mode: 'live', port: 7496 })
    expect(c.environment).toBe('mainnet')
    c.close()
  })

  it('自定义端口必须显式 allowCustomPort（假服务器 / 隧道）', () => {
    expect(() => new IbkrTradeConnector({ mode: 'paper', port: 15000 })).toThrow(/does not match the declared paper environment/)
    const c = new IbkrTradeConnector({ mode: 'paper', port: 15000, allowCustomPort: true })
    expect(c.mode).toBe('paper')
    c.close()
  })

  it('非回环 host → 构造拒绝', () => {
    expect(() => new IbkrTradeConnector({ mode: 'paper', host: '192.168.1.20' })).toThrow(/loopback/)
  })

  it('clientId 非法（0 / 10000 / 小数）→ 拒绝', () => {
    for (const id of [0, 10000, 1.5, -3]) expect(() => new IbkrTradeConnector({ mode: 'paper', clientId: id }), String(id)).toThrow(/clientId/)
  })

  it('缺省 clientId=7（自动化），用 1 会提醒那是手动号', () => {
    const warns: string[] = []
    const c = new IbkrTradeConnector({ mode: 'paper', clientId: 1, onWarn: (m) => warns.push(m) })
    expect(c.session.clientId).toBe(1)
    expect(warns.some((w) => w.includes('manual'))).toBe(true)
    c.close()
  })
})

describe('connector · 启动与收尾', () => {
  it('start() 拉合约详情并登记标的（美股 STK/SMART/USD）', async () => {
    h = await makeHarness({ symbols: ['AAPL', 'MSFT'] })
    expect(h.connector.listInstruments().map((i) => i.symbol).sort()).toEqual(['AAPL', 'MSFT'])
    expect(h.connector.getInstrument('ibkr:AAPL')?.assetClass).toBe('stocks')
  })

  it('未知标的的 qualify → INSTRUMENT_UNKNOWN（200）', async () => {
    h = await makeHarness({ symbols: [] })
    await expect(h.connector.qualify('NOPE')).rejects.toMatchObject({ problem: { code: 1001 } })
  })

  it('start() 之前 listInstruments 为空（不猜标的）', async () => {
    const tws = await FakeTws.start()
    const c = new IbkrTradeConnector({ mode: 'paper', port: tws.port, allowCustomPort: true, reconnect: { enabled: false } })
    expect(c.listInstruments()).toEqual([])
    c.close()
    await tws.stop()
  })

  it('setLeverage → 5002（IB 现金股票没有按单杠杆）', async () => {
    h = await makeHarness()
    await expect(h.connector.setLeverage(h.ctx, 'ibkr:AAPL', 2)).rejects.toMatchObject({ problem: { code: 5002 } })
  })

  it('scheduleCancel → 5002（IB 只有立即全撤）', async () => {
    h = await makeHarness()
    await expect(h.connector.scheduleCancel(h.ctx, Date.now() + 1000)).rejects.toMatchObject({ problem: { code: 5002 } })
  })

  it('close() 后会话关闭、连接归零（不留后台连接）', async () => {
    h = await makeHarness()
    await h.connector.close()
    expect(h.connector.session.state).toBe('closed')
    await new Promise((r) => setTimeout(r, 60))
    expect(h.tws.connections).toBe(0)
    await h.tws.stop()
    h = undefined
  })

  it('连接器的诊断输出不含凭证形状（IB 无 API key，仅会话参数）', async () => {
    h = await makeHarness()
    const text = `${JSON.stringify(h.connector.describe())} ${String(h.connector.session.state)}`
    expect(text).not.toMatch(/apiKey|apiSecret|password|token/i)
  })
})
