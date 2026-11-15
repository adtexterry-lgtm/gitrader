// SPDX-License-Identifier: CPAL-1.0
// 行情：只用 packages/connector-bitget-data 的解析与轮询；本包补的是「记录 + 报价缓存 + 诚实的能力边界」。
import { describe, expect, it } from 'vitest'
import { BitgetTradeMarket } from '../src/market'
import { createCountBudget } from '../src/budget'
import { BASE_URL, FakeBitget, NOW, contractRow } from './helpers/fake-bitget'

function makeMarket(fake: FakeBitget, over: Partial<ConstructorParameters<typeof BitgetTradeMarket>[0]> = {}): BitgetTradeMarket {
  return new BitgetTradeMarket({
    baseUrl: BASE_URL,
    fetchImpl: fake.fetch,
    clock: () => NOW,
    budget: createCountBudget({ clock: () => NOW, sleep: async () => {} }),
    ...over,
  })
}

describe('标的目录', () => {
  it('refresh() 走数据包的 /contracts，并剔除已下架标的', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    await market.refresh()
    expect(fake.callsTo('/api/v2/mix/market/contracts')).toHaveLength(1)
    expect(market.listInstruments().map((i) => i.symbol)).toEqual(['BTCUSDT', 'ETHUSDT'])
  })
  it('非 normal 的合约在数据包解析层就被剔除（includeDelisted 也看不到，如实断言）', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    await market.refresh()
    expect(market.listInstruments({ includeDelisted: true }).map((i) => i.symbol)).not.toContain('OLDUSDT')
    expect(market.getRecord('bitget:OLDUSDT')).toBeUndefined()
  })
  it('记录带 tick / step / minSize（来自数据包的 pricePlace / volumePlace 推导）', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    await market.refresh()
    const record = market.getRecord('bitget:BTCUSDT')!
    expect(record.tick).toBe('0.1')
    expect(record.step).toBe('0.001')
    expect(record.minSize).toBe('0.001')
    expect(record.contractSize).toBe('1')
  })
  it('未知标的：getRecord=undefined，requireRecord 抛 1001', async () => {
    const market = makeMarket(new FakeBitget())
    expect(market.getRecord('bitget:NOPE')).toBeUndefined()
    expect(() => market.requireRecord('bitget:NOPE')).toThrowError(/unknown instrument/)
    try {
      market.requireRecord('bitget:NOPE')
    } catch (e) {
      expect((e as { problem: { code: number } }).problem.code).toBe(1001)
    }
  })
  it('seedContracts 不联网就能栽目录（测试用）', () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    market.seedContracts([contractRow()], NOW)
    expect(market.getInstrument('bitget:BTCUSDT')?.symbol).toBe('BTCUSDT')
    expect(fake.calls).toHaveLength(0)
  })
  it('symbolOf 从记录取，未知时按 id 规则解析', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    await market.refresh()
    expect(market.symbolOf('bitget:BTCUSDT')).toBe('BTCUSDT')
  })
})

describe('报价缓存', () => {
  it('seedQuote 之后 quote() 同步可读，refOf 给 mid', () => {
    const market = makeMarket(new FakeBitget())
    market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW)
    const quote = market.quote('bitget:BTCUSDT')!
    expect(quote.bid).toBe(100.1)
    expect(quote.ask).toBe(100.2)
    expect(quote.stale).toBe(false)
    const ref = market.refOf('bitget:BTCUSDT')!
    expect(ref.mid).toBeCloseTo(100.15, 10)
    expect(ref.stale).toBe(false)
  })
  it('时间戳陈旧 → stale=true（下单会拒绝市价模拟）', () => {
    const market = makeMarket(new FakeBitget(), { staleMs: 1_000 })
    market.seedQuote('bitget:BTCUSDT', 100.1, 100.2, NOW - 5_000)
    expect(market.quote('bitget:BTCUSDT')!.stale).toBe(true)
    expect(market.refOf('bitget:BTCUSDT')!.stale).toBe(true)
  })
  it('没有报价时 quote / refOf 都是 undefined', () => {
    const market = makeMarket(new FakeBitget())
    expect(market.quote('bitget:BTCUSDT')).toBeUndefined()
    expect(market.refOf('bitget:BTCUSDT')).toBeUndefined()
  })
  it('refreshQuote 走数据包的 ticker 端点并写缓存', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    const quote = await market.refreshQuote('bitget:BTCUSDT')
    expect(fake.callsTo('/api/v2/mix/market/ticker')).toHaveLength(1)
    expect(quote?.bid).toBe(100.1)
    expect(quote?.ask).toBe(100.2)
    expect(market.quote('bitget:BTCUSDT')?.bid).toBe(100.1)
  })
})

describe('其它只读入口', () => {
  it('book() 用 merge-depth', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    const book = await market.book('bitget:BTCUSDT', 5)
    expect(fake.callsTo('/api/v2/mix/market/merge-depth')).toHaveLength(1)
    expect(book.bids[0]?.price).toBe(100.1)
  })
  it('candles() 用 /candles', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    const candles = await market.candles('bitget:BTCUSDT', '1m', { n: 1 })
    expect(fake.callsTo('/api/v2/mix/market/candles')).toHaveLength(1)
    expect(candles).toHaveLength(1)
    expect(candles[0]?.c).toBe(100.5)
  })
  it('context() 读 ticker + 资金费率', async () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    const context = await market.context('bitget:BTCUSDT')
    expect(context.instrumentId).toBe('bitget:BTCUSDT')
    expect(Number.isFinite(context.markPrice)).toBe(true)
  })
  it('订阅只支持 quote（数据包的能力边界），其它通道抛 5002', () => {
    const market = makeMarket(new FakeBitget())
    expect(() => market.subscribe({ channel: 'trades', instrumentId: 'bitget:BTCUSDT' } as never, () => {})).toThrowError(/CAPABILITY_UNSUPPORTED|quote/)
  })
  it('status() 带环境与 rateBudget', () => {
    const fake = new FakeBitget()
    const market = makeMarket(fake)
    const status = market.status()
    expect(status.venue).toBe('bitget')
    expect(status.environment).toBe('mainnet')
    expect(status.wsState).toBe('disconnected')
    expect(status.rateBudget?.limit).toBe(20)
  })
  it('close() 把数据包也关掉（幂等）', async () => {
    const market = makeMarket(new FakeBitget())
    await market.close()
    await market.close()
    expect(market.data.closedState).toBe(true)
  })
})
