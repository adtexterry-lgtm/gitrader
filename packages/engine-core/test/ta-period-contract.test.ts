// SPDX-License-Identifier: CPAL-1.0
// engine-core ta/ 的非法周期（period=0）行为现状：两种口径并存。这个测试不是在说它们「对」，
// 而是钉住现状，让文档（13-指标库补充 §1）与代码不再各说各话；要统一口径请另开一单并同时改本测试与文档。
import { describe, expect, it } from 'vitest'
import * as ta from '../src/strategy/ta'

const vals = Array.from({ length: 60 }, (_, i) => 100 + ((i * 7) % 11))
const bars = vals.map((c, i) => ({ t: i, o: c, h: c + 2, l: c - 2, c, v: 10 + (i % 5) }))
const allNull = (x: unknown): boolean => !/[0-9]/.test(JSON.stringify(x).replace(/null/g, ''))

describe('engine-core 非法周期（period = 0）', () => {
  const throwing: Array<[string, () => unknown]> = [
    ['sma', () => ta.sma(vals, 0)],
    ['ema', () => ta.ema(vals, 0)],
    ['wma', () => ta.wma(vals, 0)],
    ['rsi', () => ta.rsi(vals, 0)],
    ['roc', () => ta.roc(vals, 0)],
    ['atr', () => ta.atr(bars, 0)],
    ['cci', () => ta.cci(bars, 0)],
    ['williamsR', () => ta.williamsR(bars, 0)],
    ['rollingStd', () => ta.rollingStd(vals, 0)],
    ['bollinger', () => ta.bollinger(vals, 0)],
    ['donchian', () => ta.donchian(bars, 0)],
    ['mfi', () => ta.mfi(bars, 0)],
    ['cmf', () => ta.cmf(bars, 0)],
  ]
  const silent: Array<[string, () => unknown]> = [
    ['dema', () => ta.dema(vals, 0)],
    ['tema', () => ta.tema(vals, 0)],
    ['hma', () => ta.hma(vals, 0)],
    ['kama', () => ta.kama(vals, 0)],
    ['trix', () => ta.trix(vals, 0)],
    ['dpo', () => ta.dpo(vals, 0)],
    ['adx', () => ta.adx(bars, 0)],
    ['aroon', () => ta.aroon(bars, 0)],
  ]
  it('一类抛 RangeError', () => {
    for (const [name, run] of throwing) expect(run, name).toThrow(RangeError)
  })
  it('另一类不抛、返回全 null', () => {
    for (const [name, run] of silent) expect(allNull(run()), name).toBe(true)
  })
})
