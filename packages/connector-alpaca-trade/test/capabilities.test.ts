// SPDX-License-Identifier: CPAL-1.0
// 能力声明（十二条 #9；八条 #8）：只声明实际实现的，做不到的写 none 并回 1004 / 5002。
import { describe, expect, it } from 'vitest'
import { alpacaCapabilities } from '../src/capabilities'
import { VENUE } from '../src/constants'

const caps = alpacaCapabilities()

describe('Alpaca 能力声明', () => {
  it('场所与市场形态：美股现货，paper=testnet / live=mainnet', () => {
    expect(caps.venue).toBe(VENUE)
    expect(caps.environments).toEqual(['mainnet', 'testnet'])
    expect(caps.instrumentKinds).toEqual(['spot'])
  })
  it('市价是 emulated（价带限价 + IOC），不是 native', () => {
    expect(caps.orderTypes.market).toBe('emulated')
    expect(caps.marketEmulation).toEqual({ method: 'ioc_limit' })
  })
  it('限价 / 止损 / 止损限价 / 追踪是 native', () => {
    expect(caps.orderTypes.limit).toBe('native')
    expect(caps.orderTypes.stop_market).toBe('native')
    expect(caps.orderTypes.stop_limit).toBe('native')
    expect(caps.orderTypes.trailing_stop).toBe('native')
  })
  it('止盈单型与 TWAP 是 none（Alpaca 没有）', () => {
    expect(caps.orderTypes.take_market).toBe('none')
    expect(caps.orderTypes.take_limit).toBe('none')
    expect(caps.orderTypes.twap).toBe('none')
  })
  it('TIF 只有 gtc / ioc / fok（没有 alo / gtd）', () => {
    expect(caps.tif).toEqual(['gtc', 'ioc', 'fok'])
  })
  it('触发价按最后成交价（last）', () => {
    expect(caps.triggerPriceTypes).toEqual(['last'])
  })
  it('tpsl：原生挂单（bracket / oto），positionLevel=false（grouping=position 回 1004）', () => {
    expect(caps.tpsl).toEqual({ attachToOrder: true, positionLevel: false, parentPartialCancel: 'keep_children' })
  })
  it('全撤 / 改单是 native，批量只支持一张，没有 deadman', () => {
    expect(caps.cancelAll).toBe('native')
    expect(caps.amend).toBe('native')
    expect(caps.batch).toEqual({ maxOrders: 1, atomic: false })
    expect(caps.deadman).toBeUndefined()
  })
  it('保证金只有 cross，账户模型 standard', () => {
    expect(caps.marginModes).toEqual(['cross'])
    expect(caps.accountModels).toEqual(['standard'])
  })
  it('限频声明 200 次 / 分钟且注明只用 60%', () => {
    expect(caps.rateLimits?.[0]?.limit).toBe(200)
    expect(caps.rateLimits?.[0]?.windowMs).toBe(60_000)
    expect(caps.rateLimits?.[0]?.note).toContain('60%')
  })
  it('clientOrderId 声明 alnum48（Alpaca 上限）', () => {
    expect(caps.clientOrderId).toEqual({ format: 'alnum48' })
  })
  it('x-sessions 随 extendedHours 声明变化（盘前盘后拒绝 / 接受）', () => {
    expect(String(caps['x-sessions'])).toContain('refused')
    expect(String(alpacaCapabilities({ extendedHours: true })['x-sessions'])).toContain('accepted')
  })
  it('注明没有资金费 / 强平价，公司行动不在范围', () => {
    expect(String(caps['x-corrections'])).toContain('no funding rate')
    expect(String(caps['x-corrections'])).toContain('corporate-action')
  })
  it('给了滑点带才声明 rules.marketPriceBandBps', () => {
    expect(caps.rules).toBeUndefined()
    expect(alpacaCapabilities({ marketPriceBandBps: 50 }).rules?.marketPriceBandBps).toBe(50)
  })
  it('x-asset-metadata 指向资产端点（碎股 / 做空属性的来源）', () => {
    expect(String(caps['x-asset-metadata'])).toContain('/v2/assets/')
  })
})
