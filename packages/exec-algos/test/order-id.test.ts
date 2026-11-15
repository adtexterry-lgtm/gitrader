// SPDX-License-Identifier: CPAL-1.0
// clientOrderId：摘要 + 阶段后缀；OKX 32 位上限与字母数字字符集、default 形态、碰撞与确定性。
import { describe, expect, it } from 'vitest'
import { clientOrderId } from '../src'

/** 26 位 ULID 队列号（真实形态）。 */
const ULID_QUEUE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('clientOrderId', () => {
  it('okx：32 位纯字母数字，阶段后缀在末尾', () => {
    const id = clientOrderId({ strategyId: '12', queueId: '34', phase: 'maker', venue: 'okx' })
    expect(id).toHaveLength(32)
    expect(id).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(id.endsWith('maker')).toBe(true)
  })

  it('okx：阶段非字母数字剔除后取前 8 位', () => {
    const id = clientOrderId({ strategyId: 'strat-1', queueId: 'q:2', phase: 'market-fallback', venue: 'okx' })
    expect(id).toHaveLength(32)
    expect(id).toMatch(/^[A-Za-z0-9]{32}$/)
    // market-fallback → marketfallback → 前 8 位 marketfa
    expect(id.endsWith('marketfa')).toBe(true)
  })

  it('okx：超长号码不再截掉阶段，结果仍是 32 位', () => {
    const id = clientOrderId({
      strategyId: 'a'.repeat(30),
      queueId: 'b'.repeat(30),
      phase: 'market-fallback',
      venue: 'okx',
    })
    expect(id).toHaveLength(32)
    expect(id).toMatch(/^gt[A-Za-z0-9]{30}$/)
    expect(id.endsWith('marketfa')).toBe(true)
  })

  it('okx：阶段大写被归一为小写，同输入同 id', () => {
    const upper = clientOrderId({ strategyId: '7', queueId: '9', phase: 'TAKER', venue: 'okx' })
    expect(upper).toBe(clientOrderId({ strategyId: '7', queueId: '9', phase: 'taker', venue: 'okx' }))
    expect(upper.endsWith('taker')).toBe(true)
  })

  it('okx：{12,34} 与 {1,234} 不再撞号', () => {
    const a = clientOrderId({ strategyId: '12', queueId: '34', phase: 'maker', venue: 'okx' })
    const b = clientOrderId({ strategyId: '1', queueId: '234', phase: 'maker', venue: 'okx' })
    expect(a).not.toBe(b)
  })

  it('okx：26 位 ULID 队列号下 maker / market 两个阶段的 id 不同且都保留阶段后缀', () => {
    const maker = clientOrderId({ strategyId: 's', queueId: ULID_QUEUE, phase: 'maker', venue: 'okx' })
    const market = clientOrderId({ strategyId: 's', queueId: ULID_QUEUE, phase: 'market', venue: 'okx' })
    expect(maker).not.toBe(market)
    expect(maker.endsWith('maker')).toBe(true)
    expect(market.endsWith('market')).toBe(true)
    for (const id of [maker, market]) {
      expect(id).toHaveLength(32)
      expect(id).toMatch(/^[A-Za-z0-9]{32}$/)
    }
  })

  it('okx：号码 trim 后为空 → RangeError', () => {
    expect(() => clientOrderId({ strategyId: '  ', queueId: '34', phase: 'maker', venue: 'okx' })).toThrow(RangeError)
    expect(() => clientOrderId({ strategyId: '12', queueId: '', phase: 'maker', venue: 'okx' })).toThrow(RangeError)
  })

  it('default：摘要 + 下划线阶段形态，长度 ≤ 36', () => {
    const id = clientOrderId({ strategyId: '12', queueId: '34', phase: 'maker', venue: 'default' })
    expect(id.endsWith('_maker')).toBe(true)
    expect(id.length).toBeLessThanOrEqual(36)
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('default 缺省 venue 同 default 形态，空阶段不带尾段', () => {
    const id = clientOrderId({ strategyId: '12', queueId: '34', phase: '' })
    expect(id).toMatch(/^gt_[0-9a-f]{32}$/)
    expect(id).toHaveLength(35)
  })

  it('default：阶段非法字符换成 -，同输入同输出', () => {
    const a = clientOrderId({ strategyId: 's 1', queueId: 'q/2', phase: 'market fallback' })
    // market fallback → market-fallback → 前 8 位 market-f
    expect(a.endsWith('_market-f')).toBe(true)
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(clientOrderId({ strategyId: 's 1', queueId: 'q/2', phase: 'market fallback' })).toBe(a)
  })

  it('default：{a_b,c} 与 {a,b_c} 不再撞号', () => {
    const a = clientOrderId({ strategyId: 'a_b', queueId: 'c', phase: 'maker' })
    const b = clientOrderId({ strategyId: 'a', queueId: 'b_c', phase: 'maker' })
    expect(a).not.toBe(b)
  })

  it('default：26 位 ULID 队列号下 maker / market 两个阶段 id 不同且都保留阶段后缀', () => {
    const maker = clientOrderId({ strategyId: 's', queueId: ULID_QUEUE, phase: 'maker' })
    const market = clientOrderId({ strategyId: 's', queueId: ULID_QUEUE, phase: 'market' })
    expect(maker).not.toBe(market)
    expect(maker.endsWith('_maker')).toBe(true)
    expect(market.endsWith('_market')).toBe(true)
    expect(maker.length).toBeLessThanOrEqual(36)
    expect(market.length).toBeLessThanOrEqual(36)
  })

  it('default：上限 36 位（Bybit orderLinkId 口径）', () => {
    const id = clientOrderId({
      strategyId: 'x'.repeat(20),
      queueId: 'y'.repeat(20),
      phase: 'market-fallback',
    })
    expect(id).toHaveLength(36)
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('default：号码 trim 后为空 → RangeError', () => {
    expect(() => clientOrderId({ strategyId: '', queueId: '34', phase: 'maker' })).toThrow(RangeError)
    expect(() => clientOrderId({ strategyId: '12', queueId: '   ', phase: 'maker' })).toThrow(RangeError)
  })
})
