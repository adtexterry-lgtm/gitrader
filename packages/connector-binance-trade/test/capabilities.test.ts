// SPDX-License-Identifier: CPAL-1.0
// 能力声明：实跑协议的 VenueCapabilities JSON Schema 校验器，并逐项断言「老实声明」。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateVenueCapabilities } from '@gitrader/protocol'
import { binanceCapabilities } from '../src/capabilities'

const PKG = join(import.meta.dirname, '..')

describe('VenueCapabilities', () => {
  it('passes the protocol JSON Schema validator', () => {
    const result = validateVenueCapabilities(binanceCapabilities())
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true)
  })

  it('declares the seven order types it really sends, and twap: none', () => {
    const caps = binanceCapabilities()
    expect(caps.orderTypes).toEqual({
      market: 'native',
      limit: 'native',
      stop_market: 'native',
      stop_limit: 'native',
      take_market: 'native',
      take_limit: 'native',
      trailing_stop: 'native',
      twap: 'none',
    })
    expect(caps.venue).toBe('binance')
    expect(caps.environments).toEqual(['mainnet', 'testnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
  })

  it('tpsl.attachToOrder is false and positionLevel is false (no native parent-child / position tpsl)', () => {
    const caps = binanceCapabilities()
    expect(caps.tpsl).toEqual({ attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' })
    expect(caps.batch).toEqual({ maxOrders: null, atomic: false })
  })

  it('amend is emulated because only LIMIT is natively amendable', () => {
    // 协议 SupportLevel 只有 native / emulated / none，表达不了「部分支持」；所以这里必须降级为 emulated。
    expect(binanceCapabilities().amend).toBe('emulated')
    expect(binanceCapabilities().cancelAll).toBe('native')
  })

  it('has no deadman capability (countdownCancelAll exists on the venue but is not wired in)', () => {
    expect(binanceCapabilities().deadman).toBeUndefined()
  })

  it('mode / margin / tif / trigger declarations match the implementation', () => {
    const caps = binanceCapabilities()
    expect(caps.positionMode).toEqual(['oneWay', 'hedge'])
    expect(caps.marginModes).toEqual(['cross', 'isolated'])
    expect(caps.tif).toEqual(['gtc', 'ioc', 'fok', 'alo'])
    expect(caps.triggerPriceTypes).toEqual(['mark'])
    expect(caps.clientOrderId).toEqual({ format: 'binance-36' })
  })

  it('signers are api-key based and the connector never uses withdrawal', () => {
    const caps = binanceCapabilities()
    expect(caps.signers?.type).toBe('api-key')
    expect(caps.signers?.withdrawCapable).toBe(false)
    expect(caps.withdrawPermissionCheck).toBe('not_applicable')
  })

  it('rate limits mirror the documented IP weight and order-count buckets', () => {
    const caps = binanceCapabilities()
    expect(caps.rateLimits?.[0]).toMatchObject({ scope: 'ip', model: 'weight', limit: 2400, windowMs: 60_000 })
    expect(caps.rateLimits?.[1]).toMatchObject({ scope: 'account', model: 'count', limit: 300, windowMs: 10_000 })
  })

  it('honours a custom min notional override', () => {
    expect(binanceCapabilities({ minOrderNotional: '100' }).rules?.minOrderNotional).toBe('100')
  })
})

describe('README copy', () => {
  const readme = readFileSync(join(PKG, 'README.md'), 'utf8')
  const head = readme.split('\n').slice(0, 4).join('\n')

  it('first line carries the licence line required by the hygiene test', () => {
    expect(readme.split('\n')[0]).toBe('> 许可证：CPAL-1.0。')
  })

  it('first sentence of prose forbids live trading before real-network verification', () => {
    expect(head).toContain('未经真网验证，不得接实盘')
    // fix-r3 E（裁决：README 状态句与 packages/cli/src/connectors.ts 注册表对齐——该连接器已注册进内核；「未经真网验证，不得接实盘」仍是首句）
    expect(readme).toContain('已注册进内核')
  })

  it('contains no promise language', () => {
    const banned = [['保', '守'].join(''), ['激', '进'].join(''), ['稳', '赚'].join(''), ['跑', '赢'].join(''), '保证收益', '零风险', 'risk-free', 'guaranteed']
    for (const word of banned) expect(readme.toLowerCase()).not.toContain(word.toLowerCase())
  })
})
