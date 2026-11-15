// SPDX-License-Identifier: CPAL-1.0
// 一致性对照：无限流动性 + 零延迟 + 触价即成交的退化配置 vs packages/engine-core 现有 K 线模拟器。
// 参照数据由 scripts/gen-kline-parity.mts 跑**真实的 engine-core 模拟器**生成（test/fixtures/kline-parity.json），
// 不是本包照着答案写的期望值。这里不要求两边数字相等，只要求每一处差异都能指出来源。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SimBook } from '../src'
import type { LevelTuple, Side } from '../src'

interface KlineTrade {
  t: number
  side: Side
  price: number
  size: number
  fee: number
  barOpen: number
}
interface KlineCandle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}
interface Fixture {
  candles: KlineCandle[]
  wants: number[]
  feeRate: number
  configs: Record<string, { trades: KlineTrade[]; feesPaid: number; finalEquity: number }>
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kline-parity.json', import.meta.url), 'utf8')) as Fixture
const FEE_RATE = String(fixture.feeRate)
const SLIP = 25 / 10_000

/** 8 位小数的十进制文本（夹具里的数量是浮点，按 8 位截断后喂给定点引擎）。 */
function dec(value: number): string {
  return value.toFixed(8)
}

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1e-12, Math.abs(b))
}

/** 退化配置：宽松判定（触价即成交）+ 零延迟 + maker 免费 / taker 按夹具费率。 */
function degenerate(taker = FEE_RATE): SimBook {
  return new SimBook({
    instrument: 'BTCUSDT',
    fillModel: 'optimistic',
    latency: { insertMs: 0, updateMs: 0, cancelMs: 0, jitterMs: 0 },
    fees: { maker: '0', taker },
  })
}

/**
 * 用一笔成交造一条两侧都足够深的盘口：买侧价 = 报单价，卖侧（或反向）= 报单价对侧 0.5。
 * 深度取下单量的 100 倍，等价于「无限流动性」——档位量永远吃不完。
 */
function quoteBook(book: SimBook, ts: number, side: Side, price: number, size: number): void {
  const depth = dec(size * 100)
  const level = dec(price)
  const opposite = dec(side === 'buy' ? price - 0.5 : price + 0.5)
  const bids: LevelTuple[] = [[side === 'buy' ? opposite : level, depth]]
  const asks: LevelTuple[] = [[side === 'buy' ? level : opposite, depth]]
  book.apply({ type: 'book_snapshot', ts, instrument: 'BTCUSDT', bids, asks })
}

/** 把一笔 engine-core 成交按「盘口价 = 给定价格」喂进退化配置的盘口模拟器，返回我方回报。 */
function replay(trade: KlineTrade, bookPrice: number): { price: number; fee: string } {
  const book = degenerate()
  quoteBook(book, trade.t, trade.side, bookPrice, trade.size)
  const report = book.submit({ id: `k-${trade.t}-${trade.side}`, side: trade.side, type: 'market', qty: dec(trade.size) }, trade.t)
  const fee = book.feesOf(`k-${trade.t}-${trade.side}`).total
  const filled = report.fills[0]
  if (filled === undefined) throw new Error(`退化配置没有成交：${JSON.stringify(trade)}`)
  return { price: Number(filled.price), fee }
}

describe('退化配置与 K 线模拟器：零滑点', () => {
  const trades = fixture.configs['no-slip']!.trades

  it('参照夹具来自 engine-core 真跑：4 笔成交，价格等于各自 K 线开盘价', () => {
    expect(trades).toHaveLength(4)
    for (const trade of trades) {
      expect(trade.price).toBe(trade.barOpen)
      expect(trade.size).toBeGreaterThan(0)
    }
  })

  it('成交价逐笔相等（盘口价 = 开盘价时，触价即成交正好复现 next-bar-open）', () => {
    for (const trade of trades) {
      const mine = replay(trade, trade.barOpen)
      expect(relDiff(mine.price, trade.price)).toBeLessThan(1e-9)
    }
  })

  it('手续费逐笔相等（taker 费率相同时，定点与浮点只差舍入）', () => {
    for (const trade of trades) {
      const mine = replay(trade, trade.barOpen)
      expect(relDiff(Number(mine.fee), trade.fee)).toBeLessThan(1e-6)
    }
  })

  it('手续费总额：两边的差异只来自浮点累加与数量 8 位截断（< 1e-6 相对误差）', () => {
    const book = degenerate()
    let total = 0
    for (const trade of trades) {
      quoteBook(book, trade.t, trade.side, trade.barOpen, trade.size)
      book.submit({ id: `sum-${trade.t}`, side: trade.side, type: 'market', qty: dec(trade.size) }, trade.t)
    }
    total = Number(book.feeSummary().total)
    expect(relDiff(total, fixture.configs['no-slip']!.feesPaid)).toBeLessThan(1e-6)
  })
})

describe('退化配置与 K 线模拟器：有滑点', () => {
  const slipped = fixture.configs['slip-25bps']!.trades

  it('滑点体现在成交价上：买方加价、卖方减价，各为开盘价的 25 bps', () => {
    for (const trade of slipped) {
      const expected = trade.side === 'buy' ? trade.barOpen * (1 + SLIP) : trade.barOpen * (1 - SLIP)
      expect(relDiff(trade.price, expected)).toBeLessThan(1e-12)
    }
  })

  it('盘口只报开盘价时，差异恰好等于「滑点参数」：来源可解释、不是模型不一致', () => {
    for (const trade of slipped) {
      const mine = replay(trade, trade.barOpen)
      const diff = trade.price - mine.price
      const expected = trade.side === 'buy' ? trade.barOpen * SLIP : -trade.barOpen * SLIP
      expect(relDiff(diff, expected)).toBeLessThan(1e-9)
    }
  })

  it('把滑点写进盘口（报单价 = 已含滑点的价）后两边成交价再次逐笔相等', () => {
    for (const trade of slipped) {
      const mine = replay(trade, trade.price)
      expect(relDiff(mine.price, trade.price)).toBeLessThan(1e-9)
    }
  })

  it('滑点让 taker 费用略降（名义金额变小）：两边同向、量级一致', () => {
    const noSlip = degenerate()
    const withSlip = degenerate()
    let feeNoSlip = 0
    let feeSlip = 0
    for (const trade of fixture.configs['no-slip']!.trades) {
      quoteBook(noSlip, trade.t, trade.side, trade.barOpen, trade.size)
      noSlip.submit({ id: `n-${trade.t}`, side: trade.side, type: 'market', qty: dec(trade.size) }, trade.t)
    }
    for (const trade of slipped) {
      quoteBook(withSlip, trade.t, trade.side, trade.price, trade.size)
      withSlip.submit({ id: `s-${trade.t}`, side: trade.side, type: 'market', qty: dec(trade.size) }, trade.t)
    }
    feeNoSlip = Number(noSlip.feeSummary().total)
    feeSlip = Number(withSlip.feeSummary().total)
    expect(relDiff(feeSlip, fixture.configs['slip-25bps']!.feesPaid)).toBeLessThan(1e-6)
    expect(relDiff(feeNoSlip, fixture.configs['no-slip']!.feesPaid)).toBeLessThan(1e-6)
    expect(Math.abs(feeSlip - feeNoSlip)).toBeGreaterThan(0)
  })
})

describe('不复现的结构性差异（每处都要能指出来源）', () => {
  it('时间口径：K 线在下一根开盘成交（99.5），盘口在信号那刻成交（101.5），差 = 开盘 − 收盘', () => {
    const signalBar = fixture.candles[1]!
    const fillBar = fixture.candles[2]!
    const book = degenerate()
    // 在信号那根收盘时刻下单，盘口价取收盘价
    quoteBook(book, signalBar.t, 'buy', signalBar.c, 10)
    const report = book.submit({ id: 'timing', side: 'buy', type: 'market', qty: '10' }, signalBar.t)
    const mine = Number(report.fills[0]?.price)
    expect(mine).toBe(signalBar.c)
    expect(fillBar.o - mine).toBeCloseTo(fillBar.o - signalBar.c, 12)
    expect(fillBar.o).not.toBe(signalBar.c)
  })

  it('数量口径：K 线的仓位由权益 × 杠杆 / 价格算出（不是整数手），盘口按给定数量原样成交', () => {
    const trade = fixture.configs['no-slip']!.trades[2]!
    expect(Number.isInteger(trade.size)).toBe(false)
    const book = degenerate()
    quoteBook(book, trade.t, trade.side, trade.price, trade.size)
    const report = book.submit({ id: 'qty', side: trade.side, type: 'market', qty: dec(trade.size) }, trade.t)
    expect(report.filledQty).toBe(dec(trade.size))
  })

  it('深度口径：K 线整笔按一个价成交，盘口逐档吃量（薄簿时均价更差）', () => {
    const book = degenerate()
    book.apply({
      type: 'book_snapshot',
      ts: 1,
      instrument: 'BTCUSDT',
      bids: [['100', '1000']],
      asks: [['101', '0.5'], ['102', '9.5']],
    })
    const report = book.submit({ id: 'walk', side: 'buy', type: 'market', qty: '10' }, 1)
    const klinePrice = fixture.configs['no-slip']!.trades[0]!.price // K 线：10 手全在 100 成交
    expect(report.fills.map((fill) => fill.price)).toEqual(['101', '102'])
    expect(Number(report.avgPrice)).toBeGreaterThan(klinePrice)
    expect(report.avgPrice).toBe('101.95')
  })

  it('市场冲击：我方吃掉的量在同一时刻不可再吃（K 线没有这个概念）', () => {
    const book = degenerate()
    book.apply({ type: 'book_snapshot', ts: 1, instrument: 'BTCUSDT', bids: [['100', '100']], asks: [['101', '1']] })
    const first = book.submit({ id: 'w1', side: 'buy', type: 'market', qty: '0.6' }, 1)
    const second = book.submit({ id: 'w2', side: 'buy', type: 'market', qty: '0.6' }, 1)
    expect(first.filledQty).toBe('0.6')
    expect(second.filledQty).toBe('0.4')
    expect(second.reason).toBe('insufficient_liquidity')
  })
})
