// SPDX-License-Identifier: CPAL-1.0
// 标的元数据 → 协议 Instrument（工单「协议是唯一标准」）：spot / stocks / USD / base 单位 / contractSize 1 / sessions。
import { describe, expect, it } from 'vitest'
import { assetNotes, normalizeSymbol, parseAsset, parseAssetList, symbolOf } from '../src/assets'
import { parseCalendar } from '../src/sessions'
import { assetRow, calendarRows, NOW } from './helpers/fake-alpaca'

const calendar = parseCalendar(calendarRows(), 'America/New_York', NOW)
const ctx = { calendar, now: NOW }

describe('资产 → Instrument', () => {
  it('协议字段：spot / stocks / USD / base / contractSize 1', () => {
    const record = parseAsset(assetRow(), ctx)
    const inst = record.instrument
    expect(inst.instrumentId).toBe('alpaca:AAPL')
    expect(inst.venue).toBe('alpaca')
    expect(inst.kind).toBe('spot')
    expect(inst.assetClass).toBe('stocks')
    expect(inst.quote).toBe('USD')
    expect(inst.settle).toBe('USD')
    expect(inst.settlement).toBe('linear')
    expect(inst.contractSize).toBe('1')
    expect(inst.venueSizeUnit).toBe('base')
    expect(inst.status).toBe('trading')
  })
  it('tick 来自 price_increment，步长来自 min_trade_increment', () => {
    const inst = parseAsset(assetRow(), ctx).instrument
    expect(inst.price.tick).toBe('0.01')
    expect(inst.size.step).toBe('0.0001')
    expect(inst.size.decimals).toBe(4)
    expect(inst.size.min).toBe('0.0001')
  })
  it('不可碎股的标的步长是 1 股、最小 1 股', () => {
    const inst = parseAsset(assetRow({ fractionable: false, min_trade_increment: '1', min_order_size: '1' }), ctx).instrument
    expect(inst.size.step).toBe('1')
    expect(inst.size.decimals).toBe(0)
    expect(inst.size.min).toBe('1')
  })
  it('缺 price_increment 时缺省 0.01', () => {
    expect(parseAsset(assetRow({ price_increment: undefined }), ctx).instrument.price.tick).toBe('0.01')
  })
  it('sessions 来自交易日历（三段窗口）', () => {
    const inst = parseAsset(assetRow(), ctx).instrument
    expect(inst.sessions?.tz).toBe('America/New_York')
    expect(inst.sessions?.windows).toHaveLength(3)
    expect(inst.sessions?.windows[1]?.from).toBe('09:30')
  })
  it('没有日历时不给 sessions（不编时段）', () => {
    expect(parseAsset(assetRow(), { now: NOW }).instrument.sessions).toBeUndefined()
  })
  it('单型 / TIF / 触发价类型如实列出', () => {
    const inst = parseAsset(assetRow(), ctx).instrument
    expect(inst.orderTypes).toEqual(['market', 'limit', 'stop_market', 'stop_limit', 'trailing_stop'])
    expect(inst.tif).toEqual(['gtc', 'ioc', 'fok'])
    expect(inst.triggerPriceTypes).toEqual(['last'])
  })
  it('零佣金 + 保证金资产 2 倍杠杆（八条 #8）', () => {
    const inst = parseAsset(assetRow(), ctx).instrument
    expect(inst.fees).toEqual({ maker: '0', taker: '0', source: 'venue' })
    expect(inst.maxLeverage).toBe(2)
  })
  it('不可保证金的资产 1 倍杠杆', () => {
    expect(parseAsset(assetRow({ marginable: false }), ctx).instrument.maxLeverage).toBe(1)
  })
  it('inactive → delisted；active 但不可交易 → halted', () => {
    expect(parseAsset(assetRow({ status: 'inactive', tradable: false }), ctx).instrument.status).toBe('delisted')
    expect(parseAsset(assetRow({ tradable: false }), ctx).instrument.status).toBe('halted')
  })
  it('碎股 / 做空属性进 AssetRecord', () => {
    const record = parseAsset(assetRow({ fractionable: false, shortable: false, borrow_status: 'hard_to_borrow' }), ctx)
    expect(record.fractionable).toBe(false)
    expect(record.shortable).toBe(false)
    expect(record.borrowStatus).toBe('hard_to_borrow')
    expect(record.easyToBorrow).toBe(false)
  })
  it('官方现行形状：borrow_status / margin_requirement_long / _short 原样进 AssetRecord', () => {
    const record = parseAsset(assetRow(), ctx)
    expect(record).toMatchObject({ borrowStatus: 'easy_to_borrow', easyToBorrow: true, marginRequirementLong: '30', marginRequirementShort: '30' })
    expect(record.maintenanceMarginRequirement).toBeUndefined()
    expect(assetNotes(record)).toContain('borrow_status=easy_to_borrow')
  })
  it('借券状态：新字段优先；旧字段只作回落；都没有 / 值不认识 → unknown（easyToBorrow=false）', () => {
    expect(parseAsset(assetRow({ borrow_status: 'hard_to_borrow', easy_to_borrow: true }), ctx).easyToBorrow).toBe(false)
    expect(parseAsset(assetRow({ borrow_status: undefined, easy_to_borrow: true }), ctx).borrowStatus).toBe('easy_to_borrow')
    expect(parseAsset(assetRow({ borrow_status: undefined, easy_to_borrow: false }), ctx).borrowStatus).toBe('hard_to_borrow')
    const none = parseAsset(assetRow({ borrow_status: undefined }), ctx)
    expect(none).toMatchObject({ borrowStatus: 'unknown', easyToBorrow: false })
    expect(parseAsset(assetRow({ borrow_status: 'weird' }), ctx).borrowStatus).toBe('unknown')
  })
  it('保证金要求缺失 → 字段不出现（不当作 0），notes 写 unavailable', () => {
    const record = parseAsset(assetRow({ margin_requirement_long: undefined, margin_requirement_short: undefined }), ctx)
    expect(record.marginRequirementLong).toBeUndefined()
    expect(record.marginRequirementShort).toBeUndefined()
    expect(assetNotes(record)).toContain('margin_requirement_long=unavailable')
  })
  it('非美股类别（crypto）→ 抛（本连接器只做 us_equity）', () => {
    expect(() => parseAsset(assetRow({ class: 'crypto', symbol: 'BTCUSD' }), ctx)).toThrow(/unsupported class/)
  })
  it('缺 symbol → 抛', () => {
    expect(() => parseAsset({ class: 'us_equity' }, ctx)).toThrow(/no symbol/)
  })
  it('资产列表：坏行跳过，好行保留', () => {
    const records = parseAssetList([assetRow(), { class: 'us_equity' }, assetRow({ symbol: 'MSFT', id: 'asset-msft' })], ctx)
    expect(records.map((r) => r.symbol)).toEqual(['AAPL', 'MSFT'])
  })
  it('资产列表不是数组 → 抛', () => {
    expect(() => parseAssetList({}, ctx)).toThrow(/not an array/)
  })
})

describe('符号归一', () => {
  it('BRK/B → BRK.B（照 QD symbols.py）', () => {
    expect(normalizeSymbol(' brk/b ')).toBe('BRK.B')
  })
  it('symbolOf 取 `<venue>:<symbol>` 的后半段', () => {
    expect(symbolOf('alpaca:BRK.B')).toBe('BRK.B')
  })
  it('别的场所的 id → 抛', () => {
    expect(() => symbolOf('hyperliquid:BTC')).toThrow(/is not an alpaca instrument/)
    expect(() => symbolOf('AAPL')).toThrow(/invalid instrumentId/)
  })
  it('assetNotes 列出碎股 / 做空 / 结算事实', () => {
    const notes = assetNotes(parseAsset(assetRow(), ctx))
    expect(notes.join(' ')).toContain('fractionable=true')
    expect(notes.join(' ')).toContain('shortable=true')
    expect(notes.join(' ')).toContain('settle T+1')
  })
})
