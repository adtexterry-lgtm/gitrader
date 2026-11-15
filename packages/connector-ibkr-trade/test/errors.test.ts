// SPDX-License-Identifier: CPAL-1.0
// 场所常量（端口 / 环境对应表）与错误码映射（信息 / 警告类不当错误、专门 Problem + hint）。
import { describe, expect, it } from 'vitest'
import { AUTOMATION_CLIENT_ID, IB_PORTS, MANUAL_CLIENT_ID, environmentOf, gatewayOfPort, instrumentIdOf, isInstrumentIdOfVenue, isLoopbackHost, modeOf, portMatchesMode, symbolOf } from '../src/ids'
import { API_VERSION } from '../src/wire'
import { IB_ERRORS, isConnectionLost, isInformational, isNonError, problemForIbError } from '../src/errors'

describe('ids · 回环与端口（八条 7）', () => {
  it('127.0.0.1 / 127.x / ::1 / localhost 都算回环', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST']) expect(isLoopbackHost(h), h).toBe(true)
  })

  it('非回环地址一律不算（含 0.0.0.0 与内网地址）', () => {
    for (const h of ['0.0.0.0', '10.0.0.5', '192.168.1.10', 'example.org', '127.0.0.256', '']) expect(isLoopbackHost(h), h).toBe(false)
  })

  it('端口表：TWS 7496/7497、Gateway 4001/4002', () => {
    expect(IB_PORTS.tws).toEqual({ paper: 7497, live: 7496 })
    expect(IB_PORTS.gateway).toEqual({ paper: 4002, live: 4001 })
  })

  it('端口 ↔ 模式对应（模拟只用 7497/4002，实盘只用 7496/4001）', () => {
    expect(portMatchesMode(7497, 'paper')).toBe(true)
    expect(portMatchesMode(4002, 'paper')).toBe(true)
    expect(portMatchesMode(7497, 'live')).toBe(false)
    expect(portMatchesMode(7496, 'live')).toBe(true)
    expect(portMatchesMode(4001, 'live')).toBe(true)
  })

  it('gatewayOfPort 反查网关与模式', () => {
    expect(gatewayOfPort(7497)).toEqual({ gateway: 'tws', mode: 'paper' })
    expect(gatewayOfPort(4001)).toEqual({ gateway: 'gateway', mode: 'live' })
    expect(gatewayOfPort(12345)).toBeUndefined()
  })

  it('环境映射：paper → testnet，live → mainnet', () => {
    expect(environmentOf('paper')).toBe('testnet')
    expect(environmentOf('live')).toBe('mainnet')
    expect(modeOf('testnet')).toBe('paper')
    expect(modeOf('mainnet')).toBe('live')
  })

  it('clientId 规则：手动 1 / 自动化 7', () => {
    expect(MANUAL_CLIENT_ID).toBe(1)
    expect(AUTOMATION_CLIENT_ID).toBe(7)
  })

  it('标的 id 归一：ibkr:AAPL ↔ AAPL', () => {
    expect(instrumentIdOf(' aapl ')).toBe('ibkr:AAPL')
    expect(symbolOf('ibkr:aapl')).toBe('AAPL')
    expect(symbolOf('MSFT')).toBe('MSFT')
    expect(isInstrumentIdOfVenue('ibkr:TSLA')).toBe(true)
    expect(isInstrumentIdOfVenue('binance:BTCUSDT')).toBe(false)
  })

  it('API 版本常量是 178', () => {
    expect(API_VERSION).toBe(178)
  })
})

describe('errors · IB 码 → Problem（信息 / 警告类不当错误）', () => {
  it('isNonError：信息类与警告类为 true', () => {
    for (const code of [2104, 2106, 2107, 2108, 2158, 1101, 1102, 10167, 105, 165, 329, 399, 404, 434, 492, 2109, 2137]) {
      expect(isNonError(code), String(code)).toBe(true)
    }
  })

  it('isNonError：拒单 / 限流 / 权限 / 撤单错误为 false', () => {
    for (const code of [110, 321, 202, 201, 135, 161, 100, 354, 326, 504, 200]) expect(isNonError(code), String(code)).toBe(false)
  })

  it('isInformational 只看 info 类（2109 是警告，不算 info）', () => {
    for (const code of [2104, 2106, 2108, 2158, 1101, 1102]) expect(isInformational(code), String(code)).toBe(true)
    expect(isInformational(2109)).toBe(false)
  })

  it('1100 / 1300 / 504 / 502 判为连接丢失', () => {
    expect(isConnectionLost(1100)).toBe(true)
    expect(isConnectionLost(1300)).toBe(true)
    expect(isConnectionLost(504)).toBe(true)
    expect(isConnectionLost(502)).toBe(true)
    expect(isConnectionLost(201)).toBe(false)
  })

  it('每个收录码都带语义出处（官方码表或参照实现行号）', () => {
    for (const [code, info] of Object.entries(IB_ERRORS)) {
      expect(info.src, code).toMatch(/^(IB message_codes\.html |ib_async wrapper\.py:)/)
      expect(info.meaning.length, code).toBeGreaterThan(5)
    }
  })

  it('201 拒单 → 3001 并保留原文', () => {
    const p = problemForIbError(201, 'Order rejected - reason:no margin', 5)
    expect(p.problem.code).toBe(3001)
    expect(p.problem.venue?.code).toBe(201)
    expect(p.problem.venue?.message).toBe('Order rejected - reason:no margin')
    expect(p.problem.message).toContain('reqId 5')
  })

  it('326 重复 clientId → 3005 + 换 id 的 hint（不抢连）', () => {
    const p = problemForIbError(326, 'client id is already in use')
    expect(p.problem.code).toBe(3005)
    expect(p.hint).toContain('clientId 冲突')
    expect(p.hint).toContain('7')
    expect(p.hint).toContain('不抢连')
  })

  it('504 未连接 → 3003 + hint（先 connect / 不要重发单）', () => {
    const p = problemForIbError(504, 'Not connected')
    expect(p.problem.code).toBe(3003)
    expect(p.hint).toContain('connect()')
  })

  it('100 限流 → 3002 且可重试', () => {
    const p = problemForIbError(100, 'Max rate of messages per second exceeded')
    expect(p.problem.code).toBe(3002)
    expect(p.problem.retryable).toBe(true)
  })

  it('354 无行情权限 → 3003 + hint 说明市价进不了', () => {
    const p = problemForIbError(354, 'not subscribed')
    expect(p.problem.code).toBe(3003)
    expect(p.hint).toContain('参考价')
  })

  it('200 合约不存在 → 1001；110 → 1002；111（TIF 与单型不兼容）→ INVALID_PARAMS', () => {
    expect(problemForIbError(200, 'No security definition').problem.code).toBe(1001)
    expect(problemForIbError(110, 'price variation').problem.code).toBe(1002)
    expect(problemForIbError(111, 'tif incompatible').problem.code).toBe(-32602)
    expect(problemForIbError(111, 'tif incompatible').problem.message).toContain('TIF')
  })

  it('135 / 161 有专门条目；10147 / 10168 / 2119 已删除并落兜底', () => {
    expect(IB_ERRORS[135]?.meaning).toContain("can't find order")
    expect(IB_ERRORS[161]?.meaning).toContain('cancellable')
    expect(IB_ERRORS[10147]).toBeUndefined()
    expect(IB_ERRORS[10168]).toBeUndefined()
    expect(IB_ERRORS[2119]).toBeUndefined()
    const p = problemForIbError(10147, 'old code', 3)
    expect(p.problem.code).toBe(3001)
    expect(p.problem.message).toContain('unclassified')
  })

  it('未收录码 → 3001，原文与码号都保留（不猜语义）', () => {
    const p = problemForIbError(9999, 'something odd', 3)
    expect(p.problem.code).toBe(3001)
    expect(p.problem.venue?.code).toBe(9999)
    expect(p.problem.message).toContain('unclassified')
  })

  it('问题 message 里带「处理：」提示', () => {
    expect(problemForIbError(1100, 'lost').problem.message).toContain('处理：')
  })
})
