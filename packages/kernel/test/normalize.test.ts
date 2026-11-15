// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { normalizeIntent, normalizePrice } from '../src/normalize'
import { KernelError } from '../src/util/errors'
import * as d from '../src/util/dec'
import { FakeClock } from '../src/util/clock'
import { BTC, FakeConnector } from './helpers/fake-connector'

const inst = new FakeConnector({ id: 'kernel-sim', clock: new FakeClock() }).getInstrument(BTC)!
const code = (f: () => unknown): number => { try { f() } catch (e) { return (e as KernelError).problem.code } return 0 }
const base = { accountId: 'acct_X' as never, instrumentId: BTC, side: 'buy' as const }
const px = (p: string, side: 'buy' | 'sell' = 'buy', r: 'reject' | 'passive' = 'reject'): string => normalizePrice(inst, p as never, side, r)

describe('十进制运算', () => {
  it('不丢精度、不出科学计数法', () => {
    expect(d.str(d.add(d.D('0.1'), d.D('0.2')))).toBe('0.3')
    expect(d.str(d.div(d.D('1'), d.D('3'), 6))).toBe('0.333333')
    expect(d.str(d.D('1e-7'))).toBe('0.0000001')
    expect(d.str(d.mul(d.D('83064.5'), d.D('0.003')))).toBe('249.1935')
    expect(d.str(d.sub(d.D('1'), d.D('1')))).toBe('0')
  })
})

describe('统一精度规则（契约 §1.3）', () => {
  it('价格：≤5 位有效数字且小数位受限；整数价恒合法', () => {
    expect(px('83064')).toBe('83064')
    expect(px('9999.9')).toBe('9999.9')
    expect(px('0.5')).toBe('0.5')
    expect(code(() => px('83064.5'))).toBe(1002)
    expect(code(() => px('9999.95'))).toBe(1002)
    expect(code(() => px('1.55'))).toBe(1002)
  })
  it('passive 取整：买向下、卖向上，永不朝成交方向取整', () => {
    expect(px('83064.5', 'buy', 'passive')).toBe('83064')
    expect(px('83064.5', 'sell', 'passive')).toBe('83065')
    expect(px('9999.95', 'buy', 'passive')).toBe('9999.9')
    expect(px('9999.95', 'sell', 'passive')).toBe('10000')
  })
  it('数量向零截断；名义额折算数量向零截断；低于最小量 / 最小名义额 → 1003', () => {
    const n = normalizeIntent({ ...base, type: 'limit', price: '80000' as never, size: '0.003456789' as never }, inst, { defaultMaxSlippageBps: 50 })
    expect(n.size).toBe('0.00345')
    const m = normalizeIntent({ ...base, type: 'limit', price: '80000' as never, notional: '100' as never }, inst, { defaultMaxSlippageBps: 50 })
    expect(m.size).toBe('0.00125')
    expect(code(() => normalizeIntent({ ...base, type: 'limit', price: '80000' as never, size: '0.000001' as never }, inst, { defaultMaxSlippageBps: 50 }))).toBe(1003)
    expect(code(() => normalizeIntent({ ...base, type: 'limit', price: '80000' as never, size: '0.0001' as never }, inst, { defaultMaxSlippageBps: 50 }))).toBe(1003)
  })
  it('市价类缺省滑点取风控策略值，tif 缺省 ioc；clientOrderId 32 位十六进制', () => {
    const n = normalizeIntent({ ...base, type: 'market', size: '0.01' as never }, inst, { mark: '80000' as never, defaultMaxSlippageBps: 50 })
    expect(n.maxSlippageBps).toBe(50)
    expect(n.tif).toBe('ioc')
    expect(n.clientOrderId).toMatch(/^[0-9a-f]{32}$/)
  })
  it('标的停牌 / 订单类型不支持被拒', () => {
    expect(code(() => normalizeIntent({ ...base, type: 'market', size: '0.01' as never }, { ...inst, status: 'halted' }, { defaultMaxSlippageBps: 50 }))).toBe(1001)
    expect(code(() => normalizeIntent({ ...base, type: 'twap', size: '0.01' as never }, { ...inst, orderTypes: ['limit'] }, { defaultMaxSlippageBps: 50 }))).toBe(1004)
  })
})
