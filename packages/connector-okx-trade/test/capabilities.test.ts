// SPDX-License-Identifier: CPAL-1.0
// 能力声明：实跑协议的 VenueCapabilities JSON Schema 校验器，并逐项断言「老实声明」。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateVenueCapabilities } from '@gitrader/protocol'
import { okxCapabilities } from '../src/capabilities'

const PKG = join(import.meta.dirname, '..')

describe('VenueCapabilities', () => {
  it('passes the protocol JSON Schema validator', () => {
    const result = validateVenueCapabilities(okxCapabilities())
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true)
  })

  it('declares the seven order types it really sends, and twap: none', () => {
    expect(okxCapabilities().orderTypes).toEqual({
      market: 'native',
      limit: 'native',
      stop_market: 'native',
      stop_limit: 'native',
      take_market: 'native',
      take_limit: 'native',
      trailing_stop: 'native',
      twap: 'none',
    })
    expect(okxCapabilities().venue).toBe('okx')
    expect(okxCapabilities().environments).toEqual(['mainnet', 'testnet'])
    expect(okxCapabilities().instrumentKinds).toEqual(['perp'])
  })

  it('tpsl.attachToOrder is false (no attach-style parent-child orders on OKX)', () => {
    expect(okxCapabilities().tpsl).toEqual({ attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' })
    expect(okxCapabilities().batch).toEqual({ maxOrders: null, atomic: false })
  })

  it('amend is native, cancelAll is emulated (no single cancel-everything endpoint)', () => {
    expect(okxCapabilities().amend).toBe('native')
    expect(okxCapabilities().cancelAll).toBe('emulated')
  })

  it('declares the real venue-side deadman (cancel-all-after)', () => {
    expect(okxCapabilities().deadman).toEqual({ method: 'cancel_all_after', minDelaySec: 10, maxTriggersPerDay: 0 })
  })

  it('mode / margin / tif / trigger declarations match the implementation', () => {
    const caps = okxCapabilities()
    expect(caps.positionMode).toEqual(['oneWay', 'hedge'])
    expect(caps.marginModes).toEqual(['cross', 'isolated'])
    expect(caps.tif).toEqual(['gtc', 'ioc', 'fok', 'alo'])
    expect(caps.triggerPriceTypes).toEqual(['mark'])
    expect(caps.clientOrderId).toEqual({ format: 'okx-alnum32' })
  })

  it('signers are api-key based and the connector never uses withdrawal', () => {
    const caps = okxCapabilities()
    expect(caps.signers?.type).toBe('api-key')
    expect(caps.signers?.withdrawCapable).toBe(false)
    expect(caps.withdrawPermissionCheck).toBe('not_applicable')
  })

  it('rate limits mirror the documented 60/2s, 10/2s and read buckets', () => {
    const caps = okxCapabilities()
    expect(caps.rateLimits?.[0]).toMatchObject({ scope: 'account', model: 'count', limit: 60, windowMs: 2_000 })
    expect(caps.rateLimits?.[1]).toMatchObject({ scope: 'instrument', model: 'count', limit: 10, windowMs: 2_000 })
    expect(caps.rateLimits?.[2]).toMatchObject({ scope: 'account', model: 'count', limit: 10, windowMs: 2_000 })
  })

  it('names the two order channels and the post-fill OCO model', () => {
    expect(okxCapabilities()['x-orderChannels']).toEqual({
      order: ['limit', 'post_only', 'ioc', 'fok'],
      'order-algo': ['conditional', 'oco', 'move_order_stop'],
    })
    expect(String(okxCapabilities()['x-deadman'])).toContain('cancel-all-after')
    expect(String(okxCapabilities()['x-tpslModel'])).toContain('OCO')
  })

  it('states the settleCcy filter it inherits from the data package', () => {
    expect(String(okxCapabilities()['x-settleFilter'])).toContain('USDT')
    expect(String(okxCapabilities()['x-settleFilter'])).toContain('USDC')
  })
})

describe('README copy', () => {
  const readme = readFileSync(join(PKG, 'README.md'), 'utf8')
  const head = readme.split('\n').slice(0, 6).join('\n')

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
