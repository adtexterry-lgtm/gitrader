// SPDX-License-Identifier: CPAL-1.0
// 能力声明（工单教训 9）：做不到的写 none 并回 1004；市价是 emulated；不假装原生批量 / 死人开关。
import { describe, expect, it } from 'vitest'
import { findPromiseLanguage } from '@gitrader/protocol'
import { gateioCapabilities } from '../src/capabilities'
import { GATE_ORDER_LIMIT_PER_SEC, GATE_ORDER_WINDOW_MS, GATE_QUERY_LIMIT, GATE_QUERY_WINDOW_MS } from '../src/budget'
import { gateioCapabilities as fromIndex } from '../src/index'

const caps = gateioCapabilities()

describe('能力声明', () => {
  it('1. 场所 / 环境 / 标的类型：gateio、mainnet+testnet、只有 perp', () => {
    expect(caps.venue).toBe('gateio')
    expect(caps.environments).toEqual(['mainnet', 'testnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
  })

  it('2. 市价是 emulated（不是 native），市场模拟方式是价带限价 + ioc', () => {
    expect(caps.orderTypes['market']).toBe('emulated')
    expect(caps.marketEmulation).toEqual({ method: 'ioc_limit' })
  })

  it('3. 限价 native；stop / take 四类 native；追踪 / twap 仍 none', () => {
    expect(caps.orderTypes['limit']).toBe('native')
    for (const type of ['stop_market', 'stop_limit', 'take_market', 'take_limit'] as const) {
      expect(caps.orderTypes[type]).toBe('native')
    }
    for (const type of ['trailing_stop', 'twap'] as const) {
      expect(caps.orderTypes[type]).toBe('none')
    }
  })

  it('4. tif 声明 gtc / ioc / fok / alo', () => {
    expect(caps.tif).toEqual(['gtc', 'ioc', 'fok', 'alo'])
  })

  it('5. 触发价类型声明 mark / last / index', () => {
    expect(caps.triggerPriceTypes).toEqual(['mark', 'last', 'index'])
  })

  it('6. tpsl 两个位都是 false（attachToOrder / positionLevel）', () => {
    expect(caps.tpsl).toEqual({ attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' })
  })

  it('7. amend = none（QD 没有 amend；本连接器回 1004）', () => {
    expect(caps.amend).toBe('none')
  })

  it('8. cancelAll = native（按合约全撤：普通单 + 触发单）', () => {
    expect(caps.cancelAll).toBe('native')
  })

  it('9. batch 只声明 1 张、非原子', () => {
    expect(caps.batch).toEqual({ maxOrders: 1, atomic: false })
  })

  it('10. 持仓模式只有 oneWay；保证金模式 cross / isolated', () => {
    expect(caps.positionMode).toEqual(['oneWay'])
    expect(caps.marginModes).toEqual(['cross', 'isolated'])
    expect(caps.accountModels).toEqual(['standard'])
  })

  it('11. 不声明 deadman（countdown_cancel_all 存在但未实现）', () => {
    expect(caps.deadman).toBeUndefined()
  })

  it('12. 限流声明与 budget.ts 的常量一致（查询 200/10s，下单 10/1s 本地自定上限）', () => {
    const limits = caps.rateLimits ?? []
    expect(limits[0]).toMatchObject({ scope: 'ip', model: 'weight', limit: GATE_QUERY_LIMIT, windowMs: GATE_QUERY_WINDOW_MS })
    expect(limits[1]).toMatchObject({ scope: 'uid', model: 'count', limit: GATE_ORDER_LIMIT_PER_SEC, windowMs: GATE_ORDER_WINDOW_MS })
    expect(limits[1]?.note).toContain('local cap for order endpoints')
  })

  it('13. clientOrderId 格式 = hex128；签名者是 api-key', () => {
    expect(caps.clientOrderId).toEqual({ format: 'hex128' })
    expect(caps.signers).toMatchObject({ type: 'api-key', withdrawCapable: false, noncePerSigner: false })
  })

  it('14. 扩展键如实写清触发单 / 死人开关 / 数据来源', () => {
    expect(caps['x-triggerOrders']).toContain('price_orders')
    expect(caps['x-data-source']).toContain('connector-gateio-data')
    expect(caps['x-withdrawPermission']).toContain('not verified')
    expect(caps['x-deadman']).toContain('countdown_cancel_all')
    expect(caps['x-clientOrderIdEncoding']).toContain('base64url')
    expect((caps['x-order-endpoints'] as string[]).length).toBe(17)
  })

  it('15. 只有在显式给参数时才声明 rules（不写死名义额下限）', () => {
    expect(caps.rules).toBeUndefined()
    const withRules = gateioCapabilities({ marketPriceBandBps: 50, minOrderNotional: '5' })
    expect(withRules.rules).toMatchObject({ marketPriceBandBps: 50, minOrderNotional: '5' })
  })

  it('16. 声明的文案没有承诺语言（协议自检）', () => {
    const texts = [JSON.stringify(caps.rateLimits), String(caps['x-withdrawPermission']), String(caps['x-triggerOrders'])]
    for (const text of texts) expect(findPromiseLanguage(text)).toBeNull()
  })

  it('17. 索引出口导出的能力函数与直接导入一致', () => {
    expect(fromIndex().venue).toBe('gateio')
    expect(fromIndex().orderTypes['market']).toBe('emulated')
  })
})
