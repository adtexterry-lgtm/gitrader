// SPDX-License-Identifier: CPAL-1.0
// dist.ts 的单元测试：分布、夏普、PSR、DSR。
import { describe, expect, it } from 'vitest'
import {
  annualizeSharpe,
  dsr,
  expectedMaxSharpe,
  kurtosis,
  mean,
  normalCdf,
  normalInv,
  psr,
  sharpe,
  sharpeOfTrials,
  skewness,
  stdev,
  variance,
} from '../src/dist'

describe('mean / variance / stdev', () => {
  it('mean([1,2,3]) === 2', () => {
    expect(mean([1, 2, 3])).toBe(2)
  })

  it('variance([1,2,3,4]) ≈ 1.6666667', () => {
    expect(variance([1, 2, 3, 4])).toBeCloseTo(1.6666666666666667, 9)
  })

  it('stdev([1,2,3,4]) ≈ 1.2909944', () => {
    expect(stdev([1, 2, 3, 4])).toBeCloseTo(1.2909944487358056, 9)
  })

  it('variance([1], 1) 为 NaN', () => {
    expect(variance([1], 1)).toBeNaN()
  })
})

describe('skewness / kurtosis', () => {
  it('skewness([1,2,3,4,5]) ≈ 0', () => {
    expect(skewness([1, 2, 3, 4, 5])).toBeCloseTo(0, 12)
  })

  it('kurtosis([1,2,3,4,5]) ≈ 1.7', () => {
    expect(kurtosis([1, 2, 3, 4, 5])).toBeCloseTo(1.7, 9)
  })

  it('skewness([1,1,1]) = 0', () => {
    expect(skewness([1, 1, 1])).toBe(0)
  })
})

describe('sharpe / annualizeSharpe', () => {
  it('sharpe([0.01,0.02,0.03]) ≈ 2', () => {
    expect(sharpe([0.01, 0.02, 0.03])).toBeCloseTo(2, 9)
  })

  it('sharpe([0.01,0.01]) = 0', () => {
    expect(sharpe([0.01, 0.01])).toBe(0)
  })

  it('annualizeSharpe(1, 365) ≈ 19.1049732', () => {
    expect(annualizeSharpe(1, 365)).toBeCloseTo(19.1049732, 6)
  })
})

describe('normalCdf / normalInv', () => {
  it('normalCdf(0) = 0.5', () => {
    expect(normalCdf(0)).toBe(0.5)
  })

  it('normalCdf(1.96) ≈ 0.9750021', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6)
  })

  it('normalCdf(-1.96) ≈ 0.0249979', () => {
    expect(normalCdf(-1.96)).toBeCloseTo(0.0249979, 6)
  })

  it('normalCdf(6) > 0.999999999', () => {
    expect(normalCdf(6)).toBeGreaterThan(0.999999999)
  })

  it('normalInv(0.975) ≈ 1.959964', () => {
    expect(normalInv(0.975)).toBeCloseTo(1.959964, 6)
  })

  it('normalInv(0.5) ≈ 0', () => {
    expect(normalInv(0.5)).toBeCloseTo(0, 12)
  })

  it('normalInv(normalCdf(x)) ≈ x', () => {
    for (const x of [-3, -1, 0, 0.5, 2.5]) {
      expect(normalInv(normalCdf(x))).toBeCloseTo(x, 7)
    }
  })

  it('normalInv(0) = -Infinity, normalInv(1) = Infinity', () => {
    expect(normalInv(0)).toBe(-Infinity)
    expect(normalInv(1)).toBe(Infinity)
  })
})

describe('psr', () => {
  it('psr(0.1, { n: 101 }) ≈ 0.8407', () => {
    expect(psr(0.1, { n: 101 })).toBeCloseTo(0.8407, 3)
  })

  it('psr(0.3, { n: 50, benchmark: 0.3 }) = 0.5', () => {
    expect(psr(0.3, { n: 50, benchmark: 0.3 })).toBeCloseTo(0.5, 12)
  })

  it('psr 随 n 增大而增大', () => {
    expect(psr(0.1, { n: 500 })).toBeGreaterThan(psr(0.1, { n: 50 }))
  })

  it('负偏高尖峰压低 psr', () => {
    expect(psr(0.1, { n: 101, skew: -1, kurt: 6 })).toBeLessThan(
      psr(0.1, { n: 101 }),
    )
  })

  it('psr(0.1, { n: 1 }) 为 NaN', () => {
    expect(psr(0.1, { n: 1 })).toBeNaN()
  })
})

describe('expectedMaxSharpe', () => {
  it('expectedMaxSharpe(1, 1) = 0', () => {
    expect(expectedMaxSharpe(1, 1)).toBe(0)
  })

  it('expectedMaxSharpe(2, 1) ≈ 0.5198', () => {
    expect(expectedMaxSharpe(2, 1)).toBeCloseTo(0.5198, 3)
  })

  it('expectedMaxSharpe(100, 0.01) ≈ 0.2529', () => {
    expect(expectedMaxSharpe(100, 0.01)).toBeCloseTo(0.2529, 3)
  })

  it('更多试验 → 期望最大夏普更大', () => {
    expect(expectedMaxSharpe(1000, 1)).toBeGreaterThan(expectedMaxSharpe(100, 1))
  })
})

describe('dsr', () => {
  it('单次试验时 dsr 等于 psr', () => {
    expect(
      dsr(0.1, { n: 101, nTrials: 1, trialVariance: 0.01 }),
    ).toBeCloseTo(psr(0.1, { n: 101 }), 12)
  })

  it('试验次数越多 dsr 越低', () => {
    expect(
      dsr(0.1, { n: 101, nTrials: 100, trialVariance: 0.01 }),
    ).toBeLessThan(dsr(0.1, { n: 101, nTrials: 2, trialVariance: 0.01 }))
  })
})

describe('sharpeOfTrials', () => {
  it('各组夏普与横截面方差', () => {
    const result = sharpeOfTrials([
      [0.01, 0.02, 0.03],
      [0.01, 0.01, 0.01],
    ])
    expect(result.sharpes[0]).toBeCloseTo(2, 9)
    expect(result.sharpes[1]).toBeCloseTo(0, 9)
    expect(result.variance).toBeCloseTo(2, 9)
  })
})
