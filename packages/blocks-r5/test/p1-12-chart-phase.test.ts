// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { chartPhase } from '../src/model-chart'

const T0 = 1_760_000_000_000
const at = (ms: number): number => T0 + ms

describe('图表 · 加载阶段', () => {
  it('loading before 8s', () => {
    expect(chartPhase({ startedAt: T0, now: at(0), candles: null, error: null })).toBe('loading')
    expect(chartPhase({ startedAt: T0, now: at(7_999), candles: null, error: null })).toBe('loading')
  })
  it('slow after 8s without candles', () => {
    expect(chartPhase({ startedAt: T0, now: at(8_000), candles: null, error: null })).toBe('slow')
    // fix-r4: 12 秒起改为 timeout（C8），原 30_000 的 slow 断言改在 11_999
    expect(chartPhase({ startedAt: T0, now: at(11_999), candles: 0, error: null })).toBe('slow')
  })
  it('timeout after 12s without candles (shown as an error state with retry)', () => {
    expect(chartPhase({ startedAt: T0, now: at(12_000), candles: null, error: null })).toBe('timeout')
    expect(chartPhase({ startedAt: T0, now: at(30_000), candles: 0, error: null })).toBe('timeout')
    expect(chartPhase({ startedAt: 0, now: 13_000, candles: null, error: null })).toBe('timeout')
    // 有数据 / 有错仍然压过 timeout
    expect(chartPhase({ startedAt: T0, now: at(30_000), candles: 5, error: null })).toBe('ready')
    expect(chartPhase({ startedAt: T0, now: at(30_000), candles: null, error: 'x' })).toBe('error')
  })
  it('ready when candles arrive', () => {
    expect(chartPhase({ startedAt: T0, now: at(500), candles: 12, error: null })).toBe('ready')
    expect(chartPhase({ startedAt: T0, now: at(60_000), candles: 1, error: null })).toBe('ready')
  })
  it('error wins', () => {
    expect(chartPhase({ startedAt: T0, now: at(100), candles: null, error: '连接断开' })).toBe('error')
    expect(chartPhase({ startedAt: T0, now: at(60_000), candles: 500, error: '连接断开' })).toBe('error')
  })
})
