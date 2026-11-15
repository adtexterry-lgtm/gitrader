// SPDX-License-Identifier: CPAL-1.0
// 十进制与容差：对账的判定基础，必须逐位精确（不碰浮点）。
import { describe, expect, it } from 'vitest'
import {
  addDecimal, compareDecimal, equalDecimal, isDecimalString, isZeroDecimal, normalizeDecimal, parseDecimal,
  signDecimal, subtractDecimal, sumDecimal, withinTolerance,
} from '../src/decimal'
import {
  DEFAULT_VENUE_LATENCY_MS, inFlightWindowMs, isBeforeLookback, isBeyondClockSkew, isEarlierBeyondSkew, isStale,
  isWithinLatency, priceDriftBeyondBps, resolveOptions, sizeEqual,
} from '../src/tolerance'
import { NOW } from './helpers'

describe('十进制（不经浮点）', () => {
  it('0.1 + 0.2 精确等于 0.3', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3')
    expect(addDecimal('0.1', '0.2')).not.toBe(String(0.1 + 0.2))
  })
  it('相等判定忽略尾零与正号', () => {
    expect(equalDecimal('1.10', '1.1')).toBe(true)
    expect(equalDecimal('+007.500', '7.5')).toBe(true)
    expect(compareDecimal('1.10', '1.1')).toBe(0)
    expect(normalizeDecimal('+007.500')).toBe('7.5')
  })
  it('减法给出带符号结果', () => {
    expect(subtractDecimal('0.3', '0.4')).toBe('-0.1')
    expect(subtractDecimal('0.4', '0.3')).toBe('0.1')
    expect(subtractDecimal('1.000', '1')).toBe('0')
  })
  it('求和保留最小标度', () => {
    expect(sumDecimal(['0.01', '0.02', '0.005'])).toBe('0.035')
    expect(sumDecimal([])).toBe('0')
  })
  it('负零归一为零', () => {
    expect(isZeroDecimal('-0.000')).toBe(true)
    expect(signDecimal('-0.000')).toBe(0)
    expect(normalizeDecimal('-0.000')).toBe('0')
  })
  it('非法输入抛错（不静默当 0）', () => {
    for (const bad of ['1e5', 'NaN', '', '.', '1,000', 'abc']) {
      expect(isDecimalString(bad), bad).toBe(false)
      expect(() => parseDecimal(bad), bad).toThrow(TypeError)
    }
  })
  it('容差比较：差值等于容差算在容差内', () => {
    expect(withinTolerance('0.1001', '0.1', '0.0001')).toBe(true)
    expect(withinTolerance('0.1002', '0.1', '0.0001')).toBe(false)
    expect(sizeEqual('0.1', '0.1005', '0.001')).toBe(true)
    expect(() => withinTolerance('1', '1', '-1')).toThrow(RangeError)
  })
  it('价格相对漂移按基点判', () => {
    expect(priceDriftBeyondBps('100.004', '100', 5)).toBe(false) // 0.4 bp
    expect(priceDriftBeyondBps('100.1', '100', 5)).toBe(true) // 10 bp
    expect(priceDriftBeyondBps('0', '0', 5)).toBe(false)
    expect(priceDriftBeyondBps('0.1', '0', 5)).toBe(true)
  })
})

describe('时间窗与容差参数', () => {
  it('缺省容差可回显（时钟偏差 2 s、场所延迟 5 s）', () => {
    const opts = resolveOptions({ now: NOW })
    expect(opts.clockSkewMs).toBe(2_000)
    expect(opts.venueLatencyMs).toBe(DEFAULT_VENUE_LATENCY_MS)
    expect(opts.sizeTolerance).toBe('0')
    expect(inFlightWindowMs(opts)).toBe(7_000)
  })
  it('在途窗口内不下「丢失」结论，窗口外才下', () => {
    const opts = resolveOptions({ now: NOW })
    expect(isWithinLatency(NOW - 4_000, opts)).toBe(true)
    expect(isWithinLatency(NOW - 7_000, opts)).toBe(true)
    expect(isWithinLatency(NOW - 7_001, opts)).toBe(false)
    expect(isWithinLatency(undefined, opts)).toBe(false)
  })
  it('时钟偏差：只放过允许范围内的未来时间', () => {
    const opts = resolveOptions({ now: NOW, clockSkewMs: 2_000 })
    expect(isBeyondClockSkew(NOW + 1_000, opts)).toBe(false)
    expect(isBeyondClockSkew(NOW + 5_000, opts)).toBe(true)
    expect(isEarlierBeyondSkew(NOW - 100, NOW, opts)).toBe(false)
    expect(isEarlierBeyondSkew(NOW - 5_000, NOW, opts)).toBe(true)
  })
  it('回补窗口与新鲜度可配', () => {
    const opts = resolveOptions({ now: NOW, fillLookbackMs: 60_000, staleAfterMs: 30_000 })
    expect(isBeforeLookback(NOW - 59_000, opts)).toBe(false)
    expect(isBeforeLookback(NOW - 61_000, opts)).toBe(true)
    expect(isStale(NOW - 30_000, opts)).toBe(false)
    expect(isStale(NOW - 30_001, opts)).toBe(true)
  })
  it('负容差直接拒绝（负容差等于没有容差）', () => {
    expect(() => resolveOptions({ now: NOW, sizeTolerance: '-1' })).toThrow(RangeError)
    expect(() => resolveOptions({ now: NOW, venueLatencyMs: -1 })).toThrow(RangeError)
    expect(() => resolveOptions({ now: Number.NaN })).toThrow(TypeError)
  })
})
