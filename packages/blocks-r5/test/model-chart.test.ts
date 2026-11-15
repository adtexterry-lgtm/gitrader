// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import {
  ACTOR_TOKEN, EDGE, INTERVALS, INTERVAL_MS, addWatch, axisLabelWidth, axisRightMargin, axisTicks, axisTimeLabel, barIndexAt, candleEvent, changePct, chartStyles, clampLine, defaultAccount, fmtNum, fmtPct, fromLibTime, isStopOrder,
  lineTextStyle, markerSpecs, mergeBars, nearLiquidation, normalizeCandles, pctTone, pendingLegs, priceLines, pricePrecision, pushRecent, quotePrice, readout, searchHits, stringList,
  symbolRows, toChartPosition, toLibPeriod, toLibTime, toOpenOrder, unverifiedVenues, withAlpha, yRange, type Bar, type ChartPosition, type MarkerFill, type OpenOrder, type TokenReader,
} from '../src/model-chart'
import { toFill, pageOf, type FillRow } from '../src/model-records'
import { ACCT_LIVE, BTC, ETH, candlesFor, designSet } from '../fixtures/chart'

const NOW = Date.UTC(2026, 9, 23, 12, 7, 31)
const set = designSet(NOW)
const bars: Bar[] = normalizeCandles(candlesFor(BTC, '15m', 1000, NOW))
const fills = (): FillRow[] => pageOf('fills', { items: set.fills }, { names: { 'agent:key_claude': 'Claude Code' } }).rows as FillRow[]

describe('图表 · 毫秒 ↔ 库时间', () => {
  it('KLineChart 的时间单位就是整数毫秒：往返不变，小数毫秒取整', () => {
    expect(toLibTime(1_792_703_700_000)).toBe(1_792_703_700_000)
    expect(toLibTime(1_792_703_700_000.9)).toBe(1_792_703_700_000)
    expect(fromLibTime(toLibTime(NOW))).toBe(NOW)
  })
  it('周期 → 库的 {type, span}：15m = 15 分钟，4h = 4 小时，1d = 1 天', () => {
    expect(toLibPeriod('1m')).toEqual({ type: 'minute', span: 1 })
    expect(toLibPeriod('15m')).toEqual({ type: 'minute', span: 15 })
    expect(toLibPeriod('1h')).toEqual({ type: 'hour', span: 1 })
    expect(toLibPeriod('4h')).toEqual({ type: 'hour', span: 4 })
    expect(toLibPeriod('1d')).toEqual({ type: 'day', span: 1 })
    expect(INTERVALS.map((i) => INTERVAL_MS[i])).toEqual([60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000])
  })
  it('market.candles 回包规整：升序、同刻去重、认不出的行丢弃、数值串也认', () => {
    const raw = [{ t: 2000, o: '2', h: '3', l: '1', c: '2.5', v: '10' }, { t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 }, { t: 1000, o: 9, h: 9, l: 9, c: 9, v: 9 }, { t: 'x' }, null]
    const out = normalizeCandles(raw)
    expect(out.map((b) => b.timestamp)).toEqual([1000, 2000])
    expect(out[0]).toEqual({ timestamp: 1000, open: 9, high: 9, low: 9, close: 9, volume: 9 })
    expect(out[1]).toEqual({ timestamp: 2000, open: 2, high: 3, low: 1, close: 2.5, volume: 10 })
    expect(normalizeCandles({ candles: raw }).length).toBe(2)
    expect(normalizeCandles(undefined)).toEqual([])
  })
  it('增量并入：同一开盘时间覆盖形成中的那根，新的一根追加', () => {
    const last = bars[bars.length - 1]!
    const merged = mergeBars(bars, [{ ...last, close: last.close + 1 }, { ...last, timestamp: last.timestamp + 900_000 }])
    expect(merged.length).toBe(bars.length + 1)
    expect(merged[bars.length - 1]!.close).toBe(last.close + 1)
    expect(candleEvent({ instrumentId: BTC, interval: '15m', candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }] })?.bars.length).toBe(1)
    expect(candleEvent({ interval: '15m', candles: [] })).toBeNull()
  })
  it('价格小数位取 K 线里最多的位数（至少 1）；读数行千分位 + 缺值写「未设」', () => {
    expect(pricePrecision(bars)).toBe(1)
    expect(pricePrecision([{ timestamp: 1, open: 148.21, high: 148.3, low: 148.1, close: 148.25, volume: 1 }])).toBe(2)
    expect(fmtNum(64812, 1)).toBe('64,812.0')
    expect(fmtNum(-1204.5, 1)).toBe('−1,204.5')
    expect(fmtNum(null, 1)).toBe('未设')
    expect(readout(null, 1).open).toBe('未设')
    expect(readout({ timestamp: 1, open: 64880, high: 65020, low: 64700, close: 64812, volume: 1204 }, 1)).toEqual({ open: '64,880.0', high: '65,020.0', low: '64,700.0', close: '64,812.0', vol: '1,204' })
  })
  it('涨跌幅：相对前收两位小数；前收不是正数给 null；±0.005% 内算平', () => {
    expect(fmtPct(changePct(64541, 64812))).toBe('+0.42%')
    expect(fmtPct(changePct(3217.4, 3182))).toBe('−1.10%')
    expect(fmtPct(changePct(145.22, 148.2))).toBe('+2.05%')
    expect(changePct(0, 1)).toBeNull()
    expect(changePct(undefined, 1)).toBeNull()
    expect(pctTone(0.001)).toBe('flat')
    expect(pctTone(-1.1)).toBe('down')
    expect(quotePrice({ price: '64812.0' })).toBe(64812)
    expect(quotePrice({ bid: 10, ask: 12 })).toBe(11)
    expect(quotePrice({ last: 5 })).toBe(5)
    expect(quotePrice(null)).toBeNull()
  })
  it('成交落在哪根 K 线：开盘时间 ≤ 成交时间的最后一根；图外的不画', () => {
    const first = bars[0]!, last = bars[bars.length - 1]!
    expect(barIndexAt(bars, first.timestamp, 900_000)).toBe(0)
    expect(barIndexAt(bars, first.timestamp + 899_999, 900_000)).toBe(0)
    expect(barIndexAt(bars, first.timestamp + 900_000, 900_000)).toBe(1)
    expect(barIndexAt(bars, last.timestamp + 899_999, 900_000)).toBe(bars.length - 1)
    expect(barIndexAt(bars, last.timestamp + 900_000, 900_000)).toBe(-1)
    expect(barIndexAt(bars, first.timestamp - 1, 900_000)).toBe(-1)
    expect(barIndexAt([], 1, 900_000)).toBe(-1)
  })
})

describe('图表 · 成交标记', () => {
  const specs = () => markerSpecs(fills() as MarkerFill[], bars, '15m')
  it('买在 K 线下方（▲ 贴最低价）、卖在上方（▼ 贴最高价）', () => {
    const all = specs()
    expect(all).toHaveLength(12)
    for (const m of all) {
      const bar = bars.find((b) => b.timestamp === m.barTs)!
      if (m.side === 'buy') { expect(m.shape).toBe('up'); expect(m.anchor).toBe('low'); expect(m.value).toBe(bar.low) } else { expect(m.shape).toBe('down'); expect(m.anchor).toBe('high'); expect(m.value).toBe(bar.high) }
    }
    expect(all.filter((m) => m.side === 'buy')).toHaveLength(6)
  })
  it('颜色 = 执行方：你 / Agent / 引擎各一个令牌，系统与未知用系统色，绝不按买卖着色', () => {
    expect(ACTOR_TOKEN.human).toBe('--gr-actor-human')
    expect(ACTOR_TOKEN.agent).toBe('--gr-actor-agent')
    expect(ACTOR_TOKEN.engine).toBe('--gr-actor-engine')
    expect(ACTOR_TOKEN.system).toBe('--gr-actor-system')
    expect(ACTOR_TOKEN.unknown).toBe('--gr-actor-system')
    const all = specs()
    for (const m of all) expect(m.colorToken).toBe(ACTOR_TOKEN[m.actor])
    const byActor = (k: string) => new Set(all.filter((m) => m.actor === k).map((m) => m.colorToken))
    expect(byActor('human').size).toBe(1)
    // 同一执行方的买与卖同色
    expect(new Set(all.filter((m) => m.actor === 'human').map((m) => m.side)).size).toBe(2)
    expect(all.filter((m) => m.actor === 'agent')[0]!.actorName).toBe('Claude Code')
    expect(all.filter((m) => m.actor === 'human')[0]!.actorName).toBe('你')
  })
  it('回测成交空心，真实成交实心', () => {
    const f = fills().slice(0, 2).map((x, i) => ({ ...x, backtest: i === 0 })) as MarkerFill[]
    const out = markerSpecs(f, bars, '15m')
    expect(out.map((m) => m.hollow)).toEqual([true, false])
  })
  it('按执行方开关过滤；未知执行方跟系统开关走；图外成交丢弃', () => {
    const all = fills() as MarkerFill[]
    expect(markerSpecs(all, bars, '15m', new Set(['human'])).every((m) => m.actor === 'human')).toBe(true)
    expect(markerSpecs(all, bars, '15m', new Set()).length).toBe(0)
    const unknown = { ...all[0]!, actor: { kind: 'unknown' as const, name: '未知' } }
    expect(markerSpecs([unknown], bars, '15m', new Set(['system'])).length).toBe(1)
    expect(markerSpecs([unknown], bars, '15m', new Set(['human'])).length).toBe(0)
    expect(markerSpecs([{ ...all[0]!, ts: bars[0]!.timestamp - 1 }], bars, '15m').length).toBe(0)
  })
  it('records.query 的成交行直接可用：toFill 带 origin → 执行方', () => {
    const f = toFill(set.fills[1])!
    expect(f.actor.kind).toBe('agent')
    expect(f.source).toBe('无')
  })
})

describe('图表 · 价格线', () => {
  const pos = (over: Partial<ChartPosition> = {}): ChartPosition => ({ accountId: ACCT_LIVE, instrumentId: BTC, side: 'long', size: '0.08', entryPrice: 64210, liquidationPrice: 52100, estimated: true, markPrice: 64812, unrealizedPnl: '48.16', leverage: 4, notional: '5184.96', ...over })
  const orders = (): OpenOrder[] => (set.orders[ACCT_LIVE] as unknown[]).flatMap((o) => { const x = toOpenOrder(o); return x ? [x] : [] })
  const lines = (over: Partial<Parameters<typeof priceLines>[0]> = {}) => priceLines({ instrumentId: BTC, positions: [pos()], orders: orders(), proposals: set.proposals, last: 64812, ...over })

  it('四种线：开仓实线 / 止损虚线 / 待批虚线（更灰）/ 强平虚线，标签与稿一致', () => {
    const l = lines()
    expect(l.map((x) => [x.kind, x.label, x.price, x.dash])).toEqual([
      ['entry', '多 0.08', 64210, null], ['liq', '强平 约', 52100, [4, 4]], ['stop', '止损', 63100, [4, 4]], ['pending', '待批 买 0.05', 64600, [4, 4]],
    ])
    expect(l.find((x) => x.kind === 'pending')!.lineToken).toBe('--gr-text-2')
    expect(l.filter((x) => x.kind !== 'pending').every((x) => x.lineToken === '--gr-text-3')).toBe(true)
  })
  it('强平价不是估计值时标签不带「约」；空头写「空」', () => {
    expect(lines({ positions: [pos({ estimated: false })] }).find((x) => x.kind === 'liq')!.label).toBe('强平')
    expect(lines({ positions: [pos({ side: 'short' })] }).find((x) => x.kind === 'entry')!.label).toBe('空 0.08')
  })
  it('强平近（≤ 5%）只把字色换 down，线色不变；刚好 5% 算近，5.01% 不算', () => {
    expect(lines({ last: 64812 }).find((x) => x.kind === 'liq')!.textToken).toBe('--gr-text-body')
    const near = lines({ positions: [pos({ liquidationPrice: 62000 })], last: 64812 }).find((x) => x.kind === 'liq')!
    expect(near.textToken).toBe('--gr-down')
    expect(near.lineToken).toBe('--gr-text-3')
    expect(nearLiquidation(95, 100)).toBe(true)
    expect(nearLiquidation(94.99, 100)).toBe(false)
    expect(nearLiquidation(null, 100)).toBe(false)
    expect(nearLiquidation(95, null)).toBe(false)
  })
  it('挂单只取 reduceOnly 且带触发价的单：限价单、没触发价的减仓单、已撤销的都不画线', () => {
    const base = orders()[0]!
    const limit: OpenOrder = { ...base, orderId: 'a', type: 'limit', triggerPrice: null, price: '64000.0', reduceOnly: false }
    const reduceNoTrigger: OpenOrder = { ...base, orderId: 'b', triggerPrice: null }
    const triggerNotReduce: OpenOrder = { ...base, orderId: 'c', reduceOnly: false }
    const cancelled: OpenOrder = { ...base, orderId: 'd', status: 'cancelled' }
    const tp: OpenOrder = { ...base, orderId: 'e', type: 'take_profit_market', triggerPrice: '66000.0' }
    expect([limit, reduceNoTrigger, triggerNotReduce, cancelled].map(isStopOrder)).toEqual([false, false, false, false])
    const l = priceLines({ instrumentId: BTC, positions: [], orders: [limit, reduceNoTrigger, triggerNotReduce, cancelled, tp, base], proposals: [], last: 64812 })
    expect(l.map((x) => [x.label, x.price])).toEqual([['止盈', 66000], ['止损', 63100]])
  })
  it('只取本标的；待批只取 pending 且带价格的腿', () => {
    expect(lines({ instrumentId: ETH }).map((x) => x.kind)).toEqual(['pending'])
    expect(pendingLegs(set.proposals, ETH)).toEqual([{ id: 'prop_0007:0', side: 'sell', size: '2', price: 3190 }])
    const done = [{ ...set.proposals[0], status: 'executed' }, { proposalId: 'p', status: 'pending', intents: [{ instrumentId: BTC, side: 'buy', size: '1', type: 'market' }] }]
    expect(pendingLegs(done, BTC)).toEqual([])
  })
  it('价轴范围：只并入离边缘不远的线；远处的强平价不拉伸价轴，钉在窗格边缘', () => {
    expect(yRange({ from: 64000, to: 65000 }, [{ price: 64600 }])).toEqual({ from: 64000, to: 65000 })
    const r = yRange({ from: 64000, to: 65000 }, [{ price: 63900 }])
    expect(r.from).toBeLessThan(63900)
    expect(r.to).toBe(65000)
    expect(yRange({ from: 64000, to: 65000 }, [{ price: 52100 }])).toEqual({ from: 64000, to: 65000 })
    expect(clampLine(5, 400)).toEqual({ y: EDGE, out: 'up' })
    expect(clampLine(900, 400)).toEqual({ y: 400 - EDGE, out: 'down' })
    expect(clampLine(200, 400)).toEqual({ y: 200, out: null })
  })
  it('持仓 / 挂单规整：空仓、数量 0、缺字段的行丢弃', () => {
    expect(toChartPosition({ instrumentId: BTC, side: 'long', size: '0' }, 'a')).toBeNull()
    expect(toChartPosition({ instrumentId: BTC, side: 'flat', size: '1' }, 'a')).toBeNull()
    expect(toChartPosition(set.positions[ACCT_LIVE]![0], 'a')).toMatchObject({ size: '0.08', entryPrice: 64210, leverage: 4, estimated: true })
    expect(toOpenOrder({ orderId: 'x' })).toBeNull()
  })
})

describe('图表 · 令牌 → 库 options', () => {
  const reader: TokenReader = {
    color: (t) => ({ '--gr-up': 'rgb(70, 198, 141)', '--gr-down': 'rgb(239, 106, 110)', '--gr-text-3': 'rgb(142, 140, 135)' } as Record<string, string>)[t] ?? `rgb(1, 2, 3)/*${t}*/`,
    raw: (t) => ({ '--gr-font': 'Inter, sans-serif', '--gr-vol-alpha': '.28' } as Record<string, string>)[t] ?? '',
  }
  it('蜡烛涨跌色只来自 --gr-up / --gr-down（红涨绿跌互换时令牌值互换，这里不写死）', () => {
    const s = chartStyles(reader)
    expect(s.candle.bar.upColor).toBe('rgb(70, 198, 141)')
    expect(s.candle.bar.downColor).toBe('rgb(239, 106, 110)')
    expect(s.candle.bar.upWickColor).toBe(s.candle.bar.upColor)
    const swapped = chartStyles({ ...reader, color: (t) => (t === '--gr-up' ? reader.color('--gr-down') : t === '--gr-down' ? reader.color('--gr-up') : reader.color(t)) })
    expect(swapped.candle.bar.upColor).toBe('rgb(239, 106, 110)')
    expect(swapped.candle.bar.downColor).toBe('rgb(70, 198, 141)')
  })
  it('量柱带透明度（令牌 --gr-vol-alpha），字体走 --gr-font，网格 / 十字线 / 价签底各取自己的令牌', () => {
    const s = chartStyles(reader)
    expect(s.indicator.bars[0]!.upColor).toBe('rgba(70, 198, 141, 0.28)')
    expect(s.yAxis.tickText.family).toBe('Inter, sans-serif')
    expect(s.grid.horizontal.color).toContain('--gr-grid')
    expect(s.crosshair.vertical.line.color).toContain('--gr-crosshair')
    expect(s.crosshair.vertical.text.backgroundColor).toContain('--gr-ink-3')
    expect(s.separator.color).toContain('--gr-sep')
    expect(withAlpha('rgba(255, 255, 255, 0.04)', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
    expect(withAlpha('not a color', 0.5)).toBe('not a color')
  })
  it('价格线字样式：近强平只换字色令牌', () => {
    const a = lineTextStyle(reader, { textToken: '--gr-text-body' })
    const b = lineTextStyle(reader, { textToken: '--gr-down' })
    expect(a.color).toContain('--gr-text-body')
    expect(b.color).toBe('rgb(239, 106, 110)')
    expect(a.backgroundColor).toBe(b.backgroundColor)
  })
})

describe('图表 · 横轴时间标签', () => {
  // 本地时区构造，跨时区跑结果一样。
  const at = (h: number, m: number, day = 23): number => new Date(2026, 9, day, h, m).getTime()
  it('分钟 / 小时周期一律输出完整 HH:mm（5 字），最后一位不被截', () => {
    expect(axisTimeLabel(at(16, 0), '15m')).toBe('16:00')
    expect(axisTimeLabel(at(9, 5), '1h')).toBe('09:05')
    expect(axisTimeLabel(at(0, 0, 24), '4h')).toBe('00:00')
    expect(axisTimeLabel(at(16, 0), '15m')).toHaveLength(5)
    expect(axisTimeLabel(at(9, 5), '5m')).toHaveLength(5)
    expect(axisTimeLabel(at(0, 0, 24), '1m')).toHaveLength(5)
  })
  it('日线周期输出 MM-DD', () => {
    expect(axisTimeLabel(at(16, 0), '1d')).toBe('10-23')
    expect(axisTimeLabel(new Date(2026, 0, 5, 0, 0).getTime(), '1d')).toBe('01-05')
    expect(axisTimeLabel(at(16, 0), '1d')).toHaveLength(5)
  })
  it('右侧留白 ≥ 最长标签宽度（宽度按字号算，不写死像素）', () => {
    const longest = Math.max(axisLabelWidth('HH:mm'), axisLabelWidth('MM-DD'))
    expect(axisRightMargin()).toBeGreaterThanOrEqual(longest)
    expect(axisRightMargin(14)).toBeGreaterThanOrEqual(axisLabelWidth('HH:mm', 14))
    expect(axisLabelWidth('16:00')).toBeGreaterThan(25)
  })
  it('刻度文本一律完整；落进右侧留白区的刻度不画（宁缺不裁）', () => {
    const width = 400
    const margin = axisRightMargin()
    const ticks = [
      { coord: 40, value: at(9, 5), text: '旧' },
      { coord: width - margin - 20, value: at(16, 0), text: '旧' },
      { coord: width - 4, value: at(17, 0), text: '旧' },
    ]
    const out = axisTicks(ticks, { interval: '15m', width })
    expect(out.map((t) => t.text)).toEqual(['09:05', '16:00'])
    for (const t of out) expect(t.coord + axisLabelWidth(t.text) / 2).toBeLessThanOrEqual(width - margin)
    expect(axisTicks([{ coord: 20, value: at(0, 0, 24), text: '' }], { interval: '1d', width })[0]!.text).toBe('10-24')
  })
})

describe('图表 · 标的卡', () => {
  it('持仓标的置顶 → 最近查看 → 手动加入，去重保持先出现的位置', () => {
    const rows = symbolRows({ positions: [BTC, ETH], recent: ['hyperliquid:SOL', BTC], watch: ['hyperliquid:DOGE', 'hyperliquid:SOL'] })
    expect(rows.map((r) => [r.symbol, r.pinned])).toEqual([['BTC', true], ['ETH', true], ['SOL', false], ['DOGE', false]])
    expect(rows[0]!.venue).toBe('hyperliquid')
  })
  it('最近查看：新的在前、去重、最多 5 个；手动加入去重', () => {
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'c')).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'z')).toEqual(['z', 'a', 'b', 'c', 'd'])
    expect(addWatch(['a'], 'a')).toEqual(['a'])
    expect(addWatch(['a'], 'b')).toEqual(['a', 'b'])
    expect(stringList(['a', 1, '', null, 'b'])).toEqual(['a', 'b'])
  })
  it('搜索回包两种形状都认；场所未验证集合来自 venue.status', () => {
    expect(searchHits({ hits: [{ id: BTC, name: 'BTC-PERP', venue: 'hyperliquid' }] })).toEqual([{ instrumentId: BTC, symbol: 'BTC-PERP', venue: 'hyperliquid' }])
    expect(searchHits([{ instrumentId: ETH, displaySymbol: 'ETH-PERP', venue: 'hyperliquid' }])[0]!.symbol).toBe('ETH-PERP')
    expect(searchHits({ nope: 1 })).toEqual([])
    expect([...unverifiedVenues([{ venue: 'a', unverified: true }, { venue: 'b' }])]).toEqual(['a'])
  })
  it('票据缺省账户：同场所实盘 → 纸面 → 第一个', () => {
    const acc = [{ accountId: 'p', mode: 'paper', venue: 'kernel-sim' }, { accountId: 'l', mode: 'live', venue: 'hyperliquid' }]
    expect(defaultAccount(acc, BTC)!.accountId).toBe('l')
    expect(defaultAccount([acc[0]!], BTC)!.accountId).toBe('p')
    expect(defaultAccount([{ accountId: 'x', mode: 'live', venue: 'okx' }], BTC)!.accountId).toBe('x')
    expect(defaultAccount([], BTC)).toBeNull()
  })
})
