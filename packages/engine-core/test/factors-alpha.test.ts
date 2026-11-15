// SPDX-License-Identifier: CPAL-1.0
// factors-alpha.ts 的单元测试：清单与形状、常数 Bar、等差上涨 / 下跌的手算口径。
import { describe, expect, it } from 'vitest'
import { ALPHA_FACTORS, computeAlphaFactors } from '../src/strategy/factors-alpha'
import type { Candle } from '../src/types'

/** 常数 Bar：o = h = l = c = 100，v = 10。 */
function constantCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ t: i, o: 100, h: 100, l: 100, c: 100, v: 10 }))
}

/** 等差上涨：c = 100 + i，o = c，h = c + 1，l = c - 1，v = 10 + i。 */
function risingCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const c = 100 + i
    return { t: i, o: c, h: c + 1, l: c - 1, c, v: 10 + i }
  })
}

/** 等差下跌：c = 100 - i，o = c，h = c + 1，l = c - 1，v = 10 + i。 */
function fallingCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const c = 100 - i
    return { t: i, o: c, h: c + 1, l: c - 1, c, v: 10 + i }
  })
}

/** 取一列，断言非空后返回数字。 */
function numAt(series: Array<number | null>, i: number): number {
  const value = series[i]
  expect(value).not.toBeNull()
  expect(value).not.toBeUndefined()
  return value!
}

/** 由收盘 / 成交量序列造 K 线：o = c，h = c + 1，l = c - 1，t = 下标。 */
function candlesFrom(closes: readonly number[], volumes: readonly number[]): Candle[] {
  return closes.map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c, v: volumes[i] ?? 10 }))
}

/** 给一组 id 统一设窗口。 */
function withPeriod(ids: readonly string[], period: number): Record<string, Record<string, number>> {
  return Object.fromEntries(ids.map((id) => [id, { period }]))
}

describe('ALPHA_FACTORS 清单与输出形状', () => {
  it('至少 30 条、id 唯一', () => {
    expect(ALPHA_FACTORS.length).toBeGreaterThanOrEqual(30)
    const ids = ALPHA_FACTORS.map((def) => def.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('computeAlphaFactors 每列长度等于 candles 长度', () => {
    const candles = risingCandles(30)
    const result = computeAlphaFactors(candles)
    expect(Object.keys(result).length).toBe(ALPHA_FACTORS.length)
    for (const def of ALPHA_FACTORS) {
      expect(result[def.id]!.length).toBe(candles.length)
    }
  })

  it('period: 1 不抛；窗口因子全 null，K 线形态仍有值', () => {
    const candles = risingCandles(30)
    const params = Object.fromEntries(ALPHA_FACTORS.map((def) => [def.id, { period: 1 }]))
    expect(() => computeAlphaFactors(candles, undefined, params)).not.toThrow()
    const result = computeAlphaFactors(candles, undefined, params)
    for (const id of ['roc_n', 'ma_n', 'rank_n', 'sump_n', 'corr_n']) {
      expect(result[id]!.every((value) => value === null)).toBe(true)
    }
  })

  it('空输入得到空列', () => {
    const result = computeAlphaFactors([])
    for (const def of ALPHA_FACTORS) {
      expect(result[def.id]).toEqual([])
    }
  })
})

describe('常数 Bar（o = h = l = c = 100，v = 10，30 根）', () => {
  const candles = constantCandles(30)
  const result = computeAlphaFactors(candles)
  const column = (id: string): Array<number | null> => result[id]!

  it('K 线形态为 0', () => {
    for (const id of ['kmid', 'klen', 'kup', 'klow', 'ksft', 'kup2', 'klow2', 'ksft2']) {
      for (const value of column(id)) expect(value).toBe(0)
    }
  })

  it('对齐 Qlib：分母为 0 的比率返回 0（不再 null）', () => {
    // K 线形态无窗口（start 0）；按窗口的从 n - 1 起；按变动的从 n 起。
    const specs: Array<{ id: string; start: number }> = [
      { id: 'kmid2', start: 0 },
      { id: 'rsv_n', start: 9 },
      { id: 'sump_n', start: 10 },
      { id: 'sumn_n', start: 10 },
      { id: 'sumd_n', start: 10 },
      { id: 'vsump_n', start: 10 },
      { id: 'vsumn_n', start: 10 },
      { id: 'vsumd_n', start: 10 },
      { id: 'wvma_n', start: 10 },
      { id: 'cntd_n', start: 10 },
    ]
    for (const { id, start } of specs) {
      const values = column(id)
      for (let i = start; i < values.length; i++) expect(numAt(values, i)).toBe(0)
    }
  })

  it('价格比类为 1', () => {
    for (const id of ['open0', 'high0', 'low0']) {
      for (const value of column(id)) expect(value).toBeCloseTo(1, 12)
    }
  })

  it('滚动统计：均值 / 极值 / 分位为 1，标准差与斜率为 0，R² 与相关性为 null', () => {
    for (const id of ['ma_n', 'max_n', 'min_n', 'qtlu_n', 'qtld_n']) {
      const values = column(id)
      for (let i = 9; i < values.length; i++) expect(numAt(values, i)).toBeCloseTo(1, 12)
    }
    for (const id of ['std_n', 'beta_n', 'vstd_n']) {
      const values = column(id)
      for (let i = 9; i < values.length; i++) expect(numAt(values, i)).toBe(0)
    }
    for (const id of ['rsqr_n', 'corr_n']) {
      for (const value of column(id)) expect(value).toBeNull()
    }
  })

  it('分位秩 0.55（对齐 Qlib）、涨跌根数 0、涨跌幅度 0（对齐 Qlib）、量比 1', () => {
    const rank = column('rank_n')
    for (let i = 9; i < rank.length; i++) expect(numAt(rank, i)).toBeCloseTo(0.55, 12)
    for (const id of ['cntp_n', 'cntn_n', 'cntd_n']) {
      const values = column(id)
      for (let i = 10; i < values.length; i++) expect(numAt(values, i)).toBe(0)
    }
    // 对齐 Qlib：Σ|Δc| = 0 时 SUMP 返回 0（QD 分母 + 1e-12）。
    for (const id of ['sump_n', 'sumn_n', 'sumd_n']) {
      const values = column(id)
      for (let i = 10; i < values.length; i++) expect(numAt(values, i)).toBe(0)
    }
    const vma = column('vma_n')
    for (let i = 9; i < vma.length; i++) expect(numAt(vma, i)).toBeCloseTo(1, 9)
  })
})

describe('等差上涨（c = 100 + i，h = c + 1，l = c - 1，v = 10 + i，40 根，n = 10）', () => {
  const candles = risingCandles(40)
  const result = computeAlphaFactors(candles, undefined, Object.fromEntries(
    ALPHA_FACTORS.map((def) => [def.id, { period: 10 }]),
  ))
  const at = (id: string): number => numAt(result[id]!, 20)

  it('滞后收盘比、均值比与回归口径', () => {
    expect(at('roc_n')).toBeCloseTo(110 / 120, 12)
    expect(at('ma_n')).toBeCloseTo(115.5 / 120, 12)
    expect(at('beta_n')).toBeCloseTo(1 / 120, 12)
    expect(at('rsqr_n')).toBeCloseTo(1, 12)
    expect(at('resi_n')).toBeCloseTo(0, 12)
  })

  it('极值、分位秩（对齐 Qlib）与 RSV', () => {
    // 对齐 Qlib：MAX 取窗口最高 high = 121（i = 20 的 h），MIN 取窗口最低 low = 110（i = 11 的 l）。
    expect(at('max_n')).toBeCloseTo(121 / 120, 12)
    expect(at('min_n')).toBeCloseTo(110 / 120, 12)
    // 对齐 Qlib：pandas rank(pct=True) 并列取平均名次，末值最大 → (9 + (1 + 1) / 2) / 10 = 1。
    expect(at('rank_n')).toBeCloseTo(1, 12)
    expect(at('rsv_n')).toBeCloseTo(10 / 11, 12)
  })

  it('对齐 Qlib：std_n / vstd_n / wvma_n 用 ddof = 1', () => {
    // 收盘窗口 111..120：Σ(x - 115.5)² = 82.5，ddof 1 → √(82.5 / 9)；再除 c = 120。
    expect(at('std_n')).toBeCloseTo(Math.sqrt(82.5 / 9) / 120, 12)
    // 成交量窗口 21..30：Σ(v - 25.5)² = 82.5，ddof 1 → √(82.5 / 9)；再除 v = 30（+1e-12）。
    expect(at('vstd_n')).toBeCloseTo(Math.sqrt(82.5 / 9) / 30, 12)
    // WVMA 的 std 同为 ddof 1（此处只断言非负且有限）。
    const wvma = at('wvma_n')
    expect(wvma).toBeGreaterThan(0)
    expect(Number.isFinite(wvma)).toBe(true)
  })

  it('极值位置、涨跌统计与量价相关', () => {
    expect(at('imax_n')).toBeCloseTo(0, 12)
    expect(at('imin_n')).toBeCloseTo(0.9, 12)
    expect(at('imxd_n')).toBeCloseTo(-0.9, 12)
    expect(at('cntp_n')).toBeCloseTo(1, 12)
    expect(at('cntn_n')).toBeCloseTo(0, 12)
    expect(at('sump_n')).toBeCloseTo(1, 12)
    // Pearson(c, log(v + 1))：窗口 i = 20 取最近 10 根，x = 111..120，y = ln(22)..ln(31)。
    // 手算：x 均值 115.5，Sxx = 82.5；Sxy、Syy 由下列循环累加，r = Sxy / √(Sxx · Syy)。
    const xs = [111, 112, 113, 114, 115, 116, 117, 118, 119, 120]
    const ys = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31].map((v) => Math.log(v))
    const my = ys.reduce((sum, y) => sum + y, 0) / ys.length
    const syy = ys.reduce((sum, y) => sum + (y - my) ** 2, 0)
    const sxy = xs.reduce((sum, x, k) => sum + (x - 115.5) * (ys[k]! - my), 0)
    expect(at('corr_n')).toBeCloseTo(sxy / Math.sqrt(82.5 * syy), 9)
  })
})

describe('等差下跌（c = 100 - i，h = c + 1，l = c - 1，v = 10 + i，40 根，n = 10）', () => {
  const candles = fallingCandles(40)
  const result = computeAlphaFactors(candles, undefined, Object.fromEntries(
    ALPHA_FACTORS.map((def) => [def.id, { period: 10 }]),
  ))
  const at = (id: string): number => numAt(result[id]!, 20)

  it('下跌根数占 1、上涨幅度占 0、极值位置反向', () => {
    expect(at('cntn_n')).toBeCloseTo(1, 12)
    expect(at('sump_n')).toBeCloseTo(0, 12)
    expect(at('imax_n')).toBeCloseTo(0.9, 12)
    expect(at('imin_n')).toBeCloseTo(0, 12)
  })
})

describe('KBAR2：上 / 下影线与收盘偏移的振幅比', () => {
  it('单根 o=10 h=14 l=8 c=12 → 振幅 6', () => {
    const candles: Candle[] = [{ t: 0, o: 10, h: 14, l: 8, c: 12, v: 100 }]
    const ids = ['kup2', 'klow2', 'ksft2']
    const result = computeAlphaFactors(candles, ids)
    // kup2 = (h - max(o, c)) / (h - l) = (14 - 12) / 6
    expect(numAt(result['kup2']!, 0)).toBeCloseTo(2 / 6, 12)
    // klow2 = (min(o, c) - l) / (h - l) = (10 - 8) / 6
    expect(numAt(result['klow2']!, 0)).toBeCloseTo(2 / 6, 12)
    // ksft2 = (2c - h - l) / (h - l) = (24 - 14 - 8) / 6
    expect(numAt(result['ksft2']!, 0)).toBeCloseTo(2 / 6, 12)
  })
})

describe('涨跌分解族（closes 100,102,99,103,103,101；n = 3，末根 Δc = [+4, 0, -2]）', () => {
  const closes = [100, 102, 99, 103, 103, 101]
  const volumes = [10, 30, 20, 45, 40, 25]
  const candles = candlesFrom(closes, volumes)
  const ids = ['cntp_n', 'cntn_n', 'cntd_n', 'sump_n', 'sumn_n', 'sumd_n']
  const result = computeAlphaFactors(candles, ids, withPeriod(ids, 3))
  const at = (id: string): number => numAt(result[id]!, 5)

  it('gain = 4、loss = 2、Σ|Δc| = 6，up = 1、down = 1', () => {
    expect(at('cntp_n')).toBeCloseTo(1 / 3, 12)
    expect(at('cntn_n')).toBeCloseTo(1 / 3, 12)
    expect(at('cntd_n')).toBeCloseTo(0, 12)
    expect(at('sump_n')).toBeCloseTo(4 / 6, 12)
    expect(at('sumn_n')).toBeCloseTo(2 / 6, 12)
    expect(at('sumd_n')).toBeCloseTo((4 - 2) / 6, 12)
  })
})

describe('量变族（volumes 10,30,20,45,40,25；n = 3，末根 Δv = [+25, -5, -15]）', () => {
  const candles = candlesFrom([100, 102, 99, 103, 103, 101], [10, 30, 20, 45, 40, 25])
  const ids = ['vsump_n', 'vsumn_n', 'vsumd_n']
  const result = computeAlphaFactors(candles, ids, withPeriod(ids, 3))
  const at = (id: string): number => numAt(result[id]!, 5)

  it('volume gain = 25、loss = 20、Σ|Δv| = 45', () => {
    expect(at('vsump_n')).toBeCloseTo(25 / 45, 12)
    expect(at('vsumn_n')).toBeCloseTo(20 / 45, 12)
    expect(at('vsumd_n')).toBeCloseTo((25 - 20) / 45, 12)
  })
})

describe('变动量价相关 cord_n（closes 10,10,20,20；volumes 10,20,10,20；n = 3）', () => {
  const candles = candlesFrom([10, 10, 20, 20], [10, 20, 10, 20])
  const result = computeAlphaFactors(candles, ['cord_n'], withPeriod(['cord_n'], 3))

  it('x = c/c[-1] = [1,2,1]，y = ln(v/v[-1] + 1) = [ln3, ln1.5, ln3]，手算 corr = -1', () => {
    // mean(x) = 4/3，Σdx² = 6/9；mean(y) = (2ln3 + ln1.5)/3，dy = [ln2/3, -2ln2/3, ln2/3]，
    // Σdxdy = -(ln2/9) - (4ln2/9) - (ln2/9) = -2ln2/3，Σdy² = 6·(ln2/3)²，corr = -1。
    expect(numAt(result['cord_n']!, 3)).toBeCloseTo(-1, 12)
  })
})

describe('加权波动 wvma_n（closes 10,11,13.2,17.16；v = 10；n = 3）', () => {
  const candles = candlesFrom([10, 11, 13.2, 17.16], [10, 10, 10, 10])
  const result = computeAlphaFactors(candles, ['wvma_n'], withPeriod(['wvma_n'], 3))

  it('|ret|·v ≈ [1,2,3] → mean 2、ddof 1 std 1、比值 0.5', () => {
    // ret = c/c[-1] - 1 ≈ [0.1, 0.2, 0.3]；加权序列 ≈ [1, 2, 3]。
    expect(numAt(result['wvma_n']!, 3)).toBeCloseTo(0.5, 9)
  })
})

describe('极值位置并列取最早（对齐 Qlib）', () => {
  // highs [10,12,12,11]、lows [9,9,8,8]；n = 4，末根下标 3。
  const candles: Candle[] = [0, 1, 2, 3].map((i) => ({
    t: i,
    o: 10,
    h: [10, 12, 12, 11][i]!,
    l: [9, 9, 8, 8][i]!,
    c: 10,
    v: 10,
  }))
  const ids = ['imax_n', 'imin_n', 'imxd_n']
  const result = computeAlphaFactors(candles, ids, withPeriod(ids, 4))

  it('最高 12 首次在下标 1（距今 2 根）、最低 8 首次在下标 2（距今 1 根）', () => {
    expect(numAt(result['imax_n']!, 3)).toBeCloseTo(2 / 4, 12)
    expect(numAt(result['imin_n']!, 3)).toBeCloseTo(1 / 4, 12)
    expect(numAt(result['imxd_n']!, 3)).toBeCloseTo((2 - 1) / 4, 12)
  })
})
