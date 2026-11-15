// SPDX-License-Identifier: CPAL-1.0
// 测试窗预热（warm-up lookback）与数据隔离：
// ① 预热期内照跑但成绩不累计、不参与比较；② 留出期 / 盲段在寻优阶段物理不可见（用可观测行为证明）。
import { describe, expect, it } from 'vitest'
import type { StrategyDef } from '@gitrader/engine-core'
import { evaluateCandidate, sharpeMetric } from '../src/evaluate'
import { optimize, type OptimizeRequest } from '../src/optimize'
import { renderReport } from '../src/report'
import { canonicalKey } from '../src/space'
import { clampWarmupBars, parameterLookbackBars, resolveWarmupBars } from '../src/warmup'
import {
  bars,
  LOOKBACK_BARS,
  lookbackProbe,
  lookbackSpace,
  poisonCandles,
  probeSpace,
  PROBE_WARMUP,
  rampCandles,
  scheduleProbe,
  simOptions,
  smaCross,
  smaSpace,
} from './fixtures'

const probeParams = { fast: 4, slow: 20, allowShort: false }

describe('warmup · 预热根数怎么定（QuantDinger _parameter_lookback_bars 口径）', () => {
  it('只看名字带 period / lookback / window / length / bars 的维度，取上界最大值', () => {
    expect(
      parameterLookbackBars({
        period: { type: 'integer', min: 2, max: 50, step: 1 },
        lookback: { type: 'integer', min: 1, max: 12, step: 1 },
        fast: { type: 'integer', min: 2, max: 8, step: 2 },
      }),
    ).toBe(50)
    // 大小写不敏感、number 上界向上取整；非数值维度不参与
    expect(
      parameterLookbackBars({
        WindowLength: { type: 'number', min: 1, max: 19.2 },
        mode: { type: 'select', options: ['a', 'b'] },
        toggle: { type: 'boolean' },
      }),
    ).toBe(20)
    expect(parameterLookbackBars(smaSpace)).toBe(0)
  })

  it('显式值优先并标 explicit；推不出来就是 0 且标 none；非法值抛 RangeError', () => {
    expect(resolveWarmupBars(smaSpace)).toEqual({ bars: 0, source: 'none' })
    expect(resolveWarmupBars(smaSpace, 30)).toEqual({ bars: 30, source: 'explicit' })
    expect(resolveWarmupBars({ period: { type: 'integer', min: 5, max: 25 } })).toEqual({ bars: 25, source: 'params' })
    expect(() => resolveWarmupBars(smaSpace, -1)).toThrowError(RangeError)
    expect(() => resolveWarmupBars(smaSpace, 2.5)).toThrowError(RangeError)
  })

  it('窗口比预热短时夹住，但必须留得下一期成绩', () => {
    expect(clampWarmupBars(30, 200)).toBe(30)
    expect(clampWarmupBars(30, 20)).toBe(18)
    expect(clampWarmupBars(30, 2)).toBe(0)
    expect(clampWarmupBars(0, 200)).toBe(0)
  })
})

describe('warmup · 预热期内的成绩不计入', () => {
  it('计分从预热之后开始：收益就是全长回测的尾巴，分数按尾巴重算', () => {
    const candles = bars(200)
    const full = evaluateCandidate(smaCross, candles, probeParams, { sim: simOptions })
    const warmed = evaluateCandidate(smaCross, candles, probeParams, { sim: simOptions, warmupBars: 30 })
    expect(warmed.warmupBars).toBe(30)
    expect(warmed.returns).toEqual(full.returns.slice(30))
    expect(warmed.returns.length).toBe(full.returns.length - 30)
    expect(warmed.score).toBe(sharpeMetric(full.returns.slice(30)))
    // 预热期内照跑：成交笔数与不预热那次一致（不是把前 30 根切掉重跑）
    expect(warmed.trades).toBe(full.trades)
  })

  it('早段赚到的分一律不算：只用早段持仓的组合，预热后只剩平仓那一期', () => {
    const candles = rampCandles(200)
    const hot = evaluateCandidate(scheduleProbe, candles, { mode: 'early' }, { sim: simOptions })
    const warmed = evaluateCandidate(scheduleProbe, candles, { mode: 'early' }, { sim: simOptions, warmupBars: PROBE_WARMUP })
    const late = evaluateCandidate(scheduleProbe, candles, { mode: 'late' }, { sim: simOptions, warmupBars: PROBE_WARMUP })
    // 不预热：早段单边上涨被当成本事（实测 0.332）
    expect(hot.score).toBeGreaterThan(0.3)
    expect(hot.returns.filter((r) => r !== 0).length).toBe(21)
    // 预热 20 根：那 20 期涨幅不进目标函数，只剩平仓手续费那一期（实测 −0.0747）
    expect(warmed.returns.length).toBe(hot.returns.length - PROBE_WARMUP)
    expect(warmed.returns.filter((r) => r !== 0).length).toBe(1)
    expect(Math.abs(warmed.score)).toBeLessThan(0.1)
    expect(warmed.score).toBeLessThan(hot.score / 3)
    // 预热不等于把整段抹零：预热之后才有信号的组合照旧计分
    expect(late.returns.filter((r) => r !== 0).length).toBeGreaterThan(100)
    expect(late.score).not.toBe(0)
  })

  it('改预热期的行情不影响成绩，改计分段的行情才影响', () => {
    const candles = rampCandles(200)
    const opts = { sim: simOptions, warmupBars: PROBE_WARMUP }
    const clean = evaluateCandidate(scheduleProbe, candles, { mode: 'late' }, opts)
    const dirtyWarmup = evaluateCandidate(scheduleProbe, poisonCandles(candles, 0, PROBE_WARMUP), { mode: 'late' }, opts)
    const dirtyScored = evaluateCandidate(scheduleProbe, poisonCandles(candles, PROBE_WARMUP, candles.length), { mode: 'late' }, opts)
    expect(dirtyWarmup.returns).toEqual(clean.returns)
    expect(dirtyWarmup.score).toBe(clean.score)
    // 对照组：同样的毒化落在计分段上，分数必须变（证明上一条不是测试看不见数据）
    expect(dirtyScored.score).not.toBe(clean.score)
    expect(dirtyScored.returns.length).toBe(clean.returns.length)
  })

  it('寻优排名不被早段行情买通：不预热时 early 第一，预热后它垫底、best 变成空仓', () => {
    const base: OptimizeRequest = {
      strategy: scheduleProbe,
      candles: rampCandles(200),
      space: probeSpace,
      search: { kind: 'grid' },
      validation: { kind: 'holdout', holdoutBars: 40 },
      sim: simOptions,
    }
    const noWarmup = optimize({ ...base, warmupBars: 0 })
    const warmed = optimize({ ...base, warmupBars: PROBE_WARMUP })
    const scoreOf = (result: typeof noWarmup, mode: string): number | undefined =>
      result.trials.find((trial) => canonicalKey(trial.params) === `mode=string:${mode}`)?.score
    // 不预热：只在早段持仓的组合拿了第一名（实测 0.3765）
    expect(noWarmup.best?.params.mode).toBe('early')
    expect(scoreOf(noWarmup, 'early')).toBeGreaterThan(0.3)
    // 预热后：同一组合只剩手续费，成绩转负，第一名变成「全程空仓」（0 分）
    expect(scoreOf(warmed, 'early')).toBeLessThan(0)
    expect(warmed.best?.params.mode).toBe('none')
    expect(warmed.best?.score).toBe(0)
    expect(warmed.scoringRange).toEqual([PROBE_WARMUP, 160])
    expect(warmed.trials.every((trial) => trial.returns.length === 160 - PROBE_WARMUP - 1)).toBe(true)
  })
})

describe('warmup · 测试窗也预热', () => {
  it('20 根长的测试窗自己凑不出 30 根历史 → 0 分；借 30 根预热后再评估 → 窗口里有信号', () => {
    const base: OptimizeRequest = {
      strategy: lookbackProbe,
      candles: bars(240),
      space: lookbackSpace,
      search: { kind: 'grid' },
      validation: { kind: 'walk-forward', trainBars: 100, testBars: 20, step: 20 },
      sim: simOptions,
    }
    const cold = optimize({ ...base, warmupBars: 0 })
    const warmed = optimize({ ...base, warmupBars: LOOKBACK_BARS })
    expect(cold.validation.folds.length).toBeGreaterThan(1)
    // 不预热：每个测试窗只有 20 根本地历史，探针始终空仓 → 样本外收益全是 0
    expect(cold.validation.folds.every((fold) => fold.warmupBars === 0)).toBe(true)
    expect(cold.validation.oosReturns.every((r) => r === 0)).toBe(true)
    // 预热：测试窗前面借 30 根，计分仍只覆盖测试窗（每折 19 期），窗口内立刻出信号
    expect(warmed.validation.folds.every((fold) => fold.warmupBars === LOOKBACK_BARS)).toBe(true)
    expect(warmed.validation.folds.every((fold) => fold.testReturns.length === 19)).toBe(true)
    expect(warmed.validation.oosReturns.length).toBe(cold.validation.oosReturns.length)
    expect(warmed.validation.oosReturns.some((r) => r !== 0)).toBe(true)
    // 留出期同理：借预热根数，收益长度仍等于留出根数 − 1
    const holdout = optimize({ ...base, validation: { kind: 'holdout', holdoutBars: 40 }, warmupBars: LOOKBACK_BARS })
    expect(holdout.validation.holdout?.warmupBars).toBe(LOOKBACK_BARS)
    expect(holdout.validation.holdout?.returns.length).toBe(39)
    expect(holdout.validation.holdout?.returns.some((r) => r !== 0)).toBe(true)
  })
})

describe('warmup · 留出期与盲段在寻优阶段物理不可见', () => {
  /** 寻优结果的指纹：只含样本内那侧的内容（留出期 / 盲段分数故意不在里面）。 */
  function inSampleFingerprint(result: ReturnType<typeof optimize>): string {
    return JSON.stringify({
      trialCount: result.trialCount,
      searchRange: result.searchRange,
      scoringRange: result.scoringRange,
      warmup: result.warmup,
      trials: result.trials.map((trial) => [canonicalKey(trial.params), trial.score, trial.returns]),
      best: result.best,
      overfit: result.overfit,
      duplicatesSkipped: result.duplicatesSkipped,
    })
  }

  it('把留出期的行情改成离谱价：试验、分数、best、PBO/DSR 逐位不变，只有留出期分数变', () => {
    const candles = bars(200)
    const request: OptimizeRequest = {
      strategy: smaCross,
      candles,
      space: smaSpace,
      search: { kind: 'grid' },
      validation: { kind: 'holdout', holdoutBars: 50 },
      seed: 13,
      sim: simOptions,
      warmupBars: 20,
    }
    const clean = optimize(request)
    const poisoned = optimize({ ...request, candles: poisonCandles(candles, 150, 200) })
    expect(inSampleFingerprint(poisoned)).toBe(inSampleFingerprint(clean))
    // 寻优区间 = [0, 150)、预热 20 根 → 每期收益 129 期
    expect(clean.trials.every((trial) => trial.returns.length === 150 - 20 - 1)).toBe(true)
    expect(clean.overfit.periods).toBe(129)
    // 对照组：留出期真的被改了（否则上面那条可能只是毒化没生效）
    expect(poisoned.validation.holdout?.score).not.toBe(clean.validation.holdout?.score)
    expect(poisoned.validation.holdout?.returns.length).toBe(clean.validation.holdout?.returns.length)
  })

  it('搜索阶段策略拿到的 K 线里没有任何留出期时间戳（按调用顺序观测）', () => {
    const candles = bars(200)
    const holdoutStartT = candles[150]!.t
    const seen: { length: number; lastT: number }[] = []
    const spy: StrategyDef = {
      ...smaCross,
      evaluate(slice, params) {
        const last = slice[slice.length - 1]
        seen.push({ length: slice.length, lastT: last === undefined ? -1 : last.t })
        return smaCross.evaluate(slice, params)
      },
    }
    const result = optimize({
      strategy: spy,
      candles,
      space: smaSpace,
      search: { kind: 'grid' },
      validation: { kind: 'holdout', holdoutBars: 50 },
      seed: 13,
      sim: simOptions,
      warmupBars: 20,
    })
    // 搜索阶段的策略调用 = 每个唯一组合一次；这些调用一根留出期 K 线都没碰
    expect(seen.length).toBeGreaterThan(result.trialCount)
    const searchCalls = seen.slice(0, result.trialCount)
    expect(searchCalls.length).toBe(result.trialCount)
    expect(searchCalls.every((call) => call.lastT < holdoutStartT)).toBe(true)
    expect(searchCalls.every((call) => call.length <= 150)).toBe(true)
    // 探针确实看得见留出期：含留出期时间戳的调用只出现在搜索阶段之后
    const firstHoldoutCall = seen.findIndex((call) => call.lastT >= holdoutStartT)
    expect(firstHoldoutCall).toBeGreaterThanOrEqual(result.trialCount)
    expect(seen.some((call) => call.lastT === candles[199]!.t)).toBe(true)
  })

  it('walk-forward 每一折的参数选择阶段只拿得到该折训练窗内的 K 线', () => {
    const candles = bars(240)
    const seen: { firstT: number; lastT: number }[] = []
    const spy: StrategyDef = {
      ...smaCross,
      evaluate(slice, params) {
        const first = slice[0]
        const last = slice[slice.length - 1]
        seen.push({ firstT: first === undefined ? -1 : first.t, lastT: last === undefined ? -1 : last.t })
        return smaCross.evaluate(slice, params)
      },
    }
    const result = optimize({
      strategy: spy,
      candles,
      space: smaSpace,
      search: { kind: 'grid' },
      validation: { kind: 'walk-forward', trainBars: 100, testBars: 20, step: 20 },
      seed: 3,
      sim: simOptions,
      warmupBars: 10,
    })
    const folds = result.validation.folds
    expect(folds.length).toBeGreaterThan(1)
    // 主搜索（寻优区间）在验证之前跑，它的调用不属于任何一折，先跳过。
    let cursor = result.trialCount
    for (const fold of folds) {
      const [a, b] = fold.train
      const [c, d] = fold.test
      const testEndT = candles[d - 1]!.t
      // 本折第一次碰到测试窗末根时间戳的调用 = 测试窗评估；它之前的调用都属于参数选择阶段。
      const testAt = seen.findIndex((call, index) => index >= cursor && call.lastT >= testEndT)
      expect(testAt).toBeGreaterThan(cursor)
      const searchCalls = seen.slice(cursor, testAt)
      expect(searchCalls.length).toBe(fold.trainTrials)
      // 参数选择阶段拿到的每一段都落在训练窗 [a, b) 内：首根 = a，末根 = b − 1 < 测试窗起点 c。
      expect(searchCalls.every((call) => call.firstT === candles[a]!.t)).toBe(true)
      expect(searchCalls.every((call) => call.lastT === candles[b - 1]!.t)).toBe(true)
      expect(searchCalls.every((call) => call.lastT < candles[c]!.t)).toBe(true)
      cursor = testAt + 2 // 跳过本折的测试窗评估与训练窗评分
    }
  })

  it('盲段同理：改 walk-forward 盲段的行情，寻优指纹逐位不变', () => {
    const candles = bars(240)
    const request: OptimizeRequest = {
      strategy: smaCross,
      candles,
      space: smaSpace,
      search: { kind: 'grid' },
      validation: { kind: 'walk-forward', trainBars: 100, testBars: 40, step: 40, blindHoldoutBars: 20 },
      seed: 5,
      sim: simOptions,
      warmupBars: 10,
    }
    const clean = optimize(request)
    const poisonedBlind = optimize({ ...request, candles: poisonCandles(candles, 220, 240) })
    expect(clean.searchRange).toEqual([0, 220])
    expect(inSampleFingerprint(poisonedBlind)).toBe(inSampleFingerprint(clean))
    // 对照：毒化落在测试窗里（也就在寻优区间内），样本外收益与寻优指纹都必须变
    const poisonedTest = optimize({ ...request, candles: poisonCandles(candles, 140, 180) })
    expect(poisonedTest.validation.oosReturns).not.toEqual(clean.validation.oosReturns)
    expect(inSampleFingerprint(poisonedTest)).not.toBe(inSampleFingerprint(clean))
  })
})

describe('warmup · 配置与文档', () => {
  it('optimize 缺省按参数名推预热根数，收益长度与计分区间跟着走', () => {
    const request: OptimizeRequest = {
      strategy: smaCross,
      candles: bars(200),
      // 多一个 windowBars 维度：策略不认它，只用来验证「按参数名推上界」
      space: { ...smaSpace, windowBars: { type: 'integer', min: 20, max: 20 } },
      search: { kind: 'grid' },
      validation: { kind: 'holdout', holdoutBars: 40 },
      sim: simOptions,
    }
    const result = optimize(request)
    expect(result.warmup).toEqual({ bars: 20, source: 'params' })
    expect(result.scoringRange).toEqual([20, 160])
    expect(result.trials.every((trial) => trial.returns.length === 160 - 20 - 1)).toBe(true)
    expect(result.overfit.periods).toBe(160 - 20 - 1)
    // 显式值覆盖推导结果
    const explicit = optimize({ ...request, warmupBars: 0 })
    expect(explicit.warmup).toEqual({ bars: 0, source: 'explicit' })
    expect(explicit.trials.every((trial) => trial.returns.length === 159)).toBe(true)
  })

  it('预热占满寻优区间时抛 RangeError，不静默给 0 分', () => {
    const request: OptimizeRequest = {
      strategy: smaCross,
      candles: bars(60),
      space: smaSpace,
      search: { kind: 'grid' },
      validation: { kind: 'holdout', holdoutBars: 10 },
      sim: simOptions,
      warmupBars: 50,
    }
    expect(() => optimize(request)).toThrowError(/warmupBars 50 leaves no scored period/)
  })

  it('报告里写清预热根数、来源与计分区间', () => {
    const result = optimize({
      strategy: smaCross,
      candles: bars(200),
      space: smaSpace,
      search: { kind: 'grid' },
      validation: { kind: 'holdout', holdoutBars: 50 },
      sim: simOptions,
      warmupBars: 20,
    })
    const report = renderReport(result)
    expect(report).toContain('- 预热: 前 20 根不计分（来源 调用方指定），计分区间 [20, 150)')
    expect(report).toContain('- 寻优区间: [0, 150)')
    const auto = optimize({
      strategy: smaCross,
      candles: bars(200),
      space: { ...smaSpace, lookbackPeriod: { type: 'integer', min: 30, max: 30 } },
      search: { kind: 'grid' },
      validation: { kind: 'holdout', holdoutBars: 50 },
      sim: simOptions,
    })
    expect(renderReport(auto)).toContain('（来源 按参数名推上界）')
  })
})
