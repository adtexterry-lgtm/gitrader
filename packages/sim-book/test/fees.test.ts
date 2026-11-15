// SPDX-License-Identifier: CPAL-1.0
// 费用：maker / taker 分档、按币种覆盖、负费率返佣、18 位定点精确计费，以及引擎里的累计账本。
import { describe, expect, it } from 'vitest'
import { fx } from '@gitrader/protocol/decimal'
import { FeeLedger, FeeModel, SimBook } from '../src'
import type { LevelTuple, SimBookOptions } from '../src'

function sim(
  bids: LevelTuple[] = [['100', '10']],
  asks: LevelTuple[] = [['101', '10']],
  options: SimBookOptions = {},
): SimBook {
  const book = new SimBook({ instrument: 'BTCUSDT', ...options })
  book.apply({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', bids, asks })
  return book
}

describe('费率与计费', () => {
  it('maker 与 taker 各按自己的费率计费', () => {
    const model = new FeeModel({ maker: '0.0002', taker: '0.0005' })
    expect(model.charge('USD', fx('100'), fx('2'), 'maker')).toBe(fx('0.04'))
    expect(model.charge('USD', fx('100'), fx('2'), 'taker')).toBe(fx('0.1'))
  })

  it('佣金 = 成交价 × 数量 × 费率，18 位定点精确', () => {
    const model = new FeeModel({ maker: '0.00025', taker: '0.00025' })
    // 101.5 × 1.5 × 0.00025 = 0.0380625
    expect(model.charge('USD', fx('101.5'), fx('1.5'), 'taker')).toBe(fx('0.0380625'))
  })

  it('负费率是返佣（费用为负）', () => {
    const model = new FeeModel({ maker: '-0.0001', taker: '0.0005' })
    expect(model.charge('USD', fx('2000'), fx('0.5'), 'maker')).toBe(fx('-0.1'))
  })

  it('按币种覆盖：USDT 走覆盖费率，其它币种落回缺省', () => {
    const model = new FeeModel({ maker: '0.001', taker: '0.002', overrides: { USDT: { maker: '0', taker: '0.0004' } } })
    expect(model.rateFor('USDT', 'maker')).toBe(fx('0'))
    expect(model.rateFor('USDT', 'taker')).toBe(fx('0.0004'))
    expect(model.rateFor('USD', 'maker')).toBe(fx('0.001'))
    expect(model.charge('USDT', fx('100'), fx('1'), 'maker')).toBe(fx('0'))
  })

  it('零费率模型一律不计费', () => {
    const model = FeeModel.zero('USDT')
    expect(model.currency).toBe('USDT')
    expect(model.charge('USDT', fx('100'), fx('3'), 'taker')).toBe(fx('0'))
    expect(model.charge('USDT', fx('100'), fx('3'), 'maker')).toBe(fx('0'))
  })

  it('费率超过 1 或不是十进制文本时报错', () => {
    expect(() => new FeeModel({ maker: '2', taker: '0' })).toThrow(/绝对值不能超过 1/)
    expect(() => new FeeModel({ maker: '0.1', taker: '1e-4' })).toThrow(/不是十进制文本/)
    expect(() => new FeeModel({ maker: '-1.5', taker: '0' })).toThrow(/绝对值不能超过 1/)
  })

  it('覆盖表的费率同样校验', () => {
    expect(() => new FeeModel({ maker: '0', taker: '0', overrides: { USDT: { maker: '5', taker: '0' } } })).toThrow(
      /fees.overrides.USDT.maker 绝对值不能超过 1/,
    )
  })

  it('FeeLedger 分开累计 maker / taker 并给出字符串总计', () => {
    const ledger = new FeeLedger('USDT')
    ledger.charge('taker', fx('0.1'))
    ledger.charge('taker', fx('0.2'))
    ledger.charge('maker', fx('-0.05'))
    expect(ledger.totals()).toEqual({ currency: 'USDT', maker: '-0.05', taker: '0.3', total: '0.25', fills: 3 })
  })
})

describe('引擎里的费用累计', () => {
  it('市价单逐档吃量：按每一档成交价分别计 taker 费', () => {
    const book = sim([['100', '10']], [['101', '1'], ['102', '2']], { fees: { maker: '0.0002', taker: '0.001' } })
    book.submit({ id: 'mkt', side: 'buy', type: 'market', qty: '3' }, 2)
    // 101×1×0.001 + 102×2×0.001 = 0.101 + 0.204
    expect(book.feesOf('mkt')).toEqual({ currency: 'USD', maker: '0', taker: '0.305', total: '0.305', fills: 2 })
    expect(book.feeSummary()).toEqual({ currency: 'USD', maker: '0', taker: '0.305', total: '0.305', fills: 2 })
  })

  it('挂单成交按 maker 费率计费，与 taker 分开记', () => {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { fees: { maker: '0.0002', taker: '0.001' } })
    book.submit({ id: 'mk', side: 'buy', type: 'limit', qty: '0.5', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '0.5', aggressor: 'sell' })
    // 100 × 0.5 × 0.0002 = 0.01
    expect(book.feesOf('mk')).toEqual({ currency: 'USD', maker: '0.01', taker: '0', total: '0.01', fills: 1 })
    book.submit({ id: 'tk', side: 'buy', type: 'market', qty: '1' }, 4)
    expect(book.feeSummary()).toEqual({ currency: 'USD', maker: '0.01', taker: '0.101', total: '0.111', fills: 2 })
  })

  it('逐笔成交与报价穿越两笔都按 maker 计费：费用累加在同一张单的账上', () => {
    const book = sim([['99', '5']], [['101', '5']], { fees: { maker: '0.0002', taker: '0.001' } })
    book.submit({ id: 'both', side: 'buy', type: 'limit', qty: '2', price: '100' }, 2)
    // 先被逐笔成交喂到 1 手（maker，价格 100）
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    // 卖一压到 100：已挂簿的限价单被穿越，按自己的限价记 maker
    book.apply({ type: 'book_delta', ts: 4, instrument: 'BTCUSDT', side: 'ask', action: 'add', price: '100', size: '1' })
    const totals = book.feesOf('both')
    expect(totals.maker).toBe('0.04')
    expect(totals.taker).toBe('0')
    expect(totals.total).toBe('0.04')
  })

  it('费用币种取引擎的 currency 选项', () => {
    const book = sim([['100', '10']], [['101', '10']], {
      currency: 'USDT',
      fees: { maker: '0.001', taker: '0.001', overrides: { USDT: { maker: '0', taker: '0.0004' } } },
    })
    book.submit({ id: 'u', side: 'buy', type: 'market', qty: '1' }, 2)
    expect(book.feesOf('u').currency).toBe('USDT')
    expect(book.feesOf('u').taker).toBe('0.0404')
  })

  it('没配费用模型时账本是零，不影响成交', () => {
    const book = sim()
    book.submit({ id: 'free', side: 'buy', type: 'market', qty: '1' }, 2)
    expect(book.feeSummary()).toEqual({ currency: 'USD', maker: '0', taker: '0', total: '0', fills: 0 })
    expect(book.feesOf('free').total).toBe('0')
    expect(book.report('free')?.filledQty).toBe('1')
  })

  it('返佣费率让 maker 费用成为负数（净返佣）', () => {
    const book = sim([['100', '5'], ['99', '5']], [['101', '5']], { fees: { maker: '-0.0001', taker: '0.001' } })
    book.submit({ id: 'reb', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
    book.apply({ type: 'trade', ts: 3, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
    expect(book.feesOf('reb').maker).toBe('-0.01')
    expect(book.feesOf('reb').total).toBe('-0.01')
  })

  it('同一份输入两次跑出的费用完全一致', () => {
    const run = (): string => {
      const book = sim([['100', '5'], ['99', '5']], [['101', '1'], ['102', '4']], { fees: { maker: '0.0002', taker: '0.0007' } })
      book.submit({ id: 'a', side: 'buy', type: 'limit', qty: '1', price: '100' }, 2)
      book.submit({ id: 'b', side: 'buy', type: 'market', qty: '2' }, 3)
      book.apply({ type: 'trade', ts: 4, instrument: 'BTCUSDT', price: '100', size: '1', aggressor: 'sell' })
      return JSON.stringify(book.feeSummary())
    }
    expect(run()).toBe(run())
  })
})
