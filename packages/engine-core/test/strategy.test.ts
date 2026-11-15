// SPDX-License-Identifier: CPAL-1.0
// 策略信号正确性与回测记账（固定 K 线夹具；搬运自 Demo test/strategy.test.ts，改成协议字段名：price / Ratio）。
import { describe, expect, it } from 'vitest'
import { evaluateStrategy, latestSignal, resolveParams, runBacktest } from '../src/strategy'
import { ALL, get } from './defs'
import { instanceParamsSchema as paramsSchema, validateStrictParams } from '../src/strategy/schema'
import { H, mk, sine, up } from './helpers'



describe('策略接口与参数', () => {
  it('四个教学示例 + 一个测试夹具，统一接口，名字标明身份，不挂业绩', () => {
    expect(ALL.map((s) => s.id)).toEqual(['ema-trend', 'mean-reversion', 'breakout', 'grid', 'dca'])
    for (const s of ALL) {
      expect(s.name).toMatch(/\((teaching example|test fixture)\)$/)
      expect(s.nameZh).toMatch(/（(教学示例|测试夹具)）$/)
      expect(s.desc).toBeTruthy()
      expect(s.params.length).toBeGreaterThan(0)
      for (const p of s.params) expect(s.defaults[p.key]).toBe(p.default)
      const out = s.evaluate(mk(sine(200)), s.defaults)
      expect(out.target).toHaveLength(200)
      expect(out.reasons).toHaveLength(200)
      expect(out.target.every((t) => t >= -1 && t <= 1)).toBe(true)
      // 不挂业绩：描述里不出现收益承诺
      expect(`${s.name}${s.nameZh}${s.desc}`).not.toMatch(/年化|胜率|收益承诺|guaranteed|outperform/)
    }
  })

  it('resolveParams：补默认、转类型、夹范围、丢未知键', () => {
    const p = resolveParams(get('ema-trend').params, { fast: '10', slow: 99999, allowShort: 'false', junk: 1 })
    expect(p).toEqual({ fast: 10, slow: 400, allowShort: false })
    expect(resolveParams(get('grid').params, undefined)).toEqual(get('grid').defaults)
    expect(resolveParams(get('breakout').params, { entry: 'abc' }).entry).toBe(20)
  })

  it('参数 JSON Schema 与严格校验：未知键 / 类型 / 范围 / 枚举明确报错，不静默改写', () => {
    const defs = get('ema-trend').params
    const sch = paramsSchema(defs, 'ema-trend') as { properties: Record<string, { type: string; minimum?: number; maximum?: number }>; additionalProperties: boolean }
    expect(sch.additionalProperties).toBe(false)
    expect(sch.properties.fast).toMatchObject({ type: 'integer', minimum: 2, maximum: 200 })
    expect(validateStrictParams(defs, undefined)).toEqual({ ok: true, params: get('ema-trend').defaults })
    expect(validateStrictParams(defs, { fast: 10 })).toEqual({ ok: true, params: { fast: 10, slow: 60, allowShort: true } })
    const bad = validateStrictParams(defs, { fast: 1, slow: 'x', nope: 1, allowShort: 'yes' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.join('|')).toMatch(/unknown parameter "nope"/)
      expect(bad.errors.join('|')).toMatch(/fast: must be >= 2/)
      expect(bad.errors.join('|')).toMatch(/slow: must be a finite number/)
      expect(bad.errors.join('|')).toMatch(/allowShort: must be a boolean/)
      expect(bad.errors.join('|')).not.toContain('yes') // 不回显调用方的值
    }
    expect(validateStrictParams(defs, { fast: 2.5 }).ok).toBe(false) // integer
  })
})

describe('策略信号', () => {
  it('ema-trend：单边上涨 → 做多；单边下跌 → 做空（可关闭）', () => {
    const upS = evaluateStrategy(get('ema-trend'), mk(up(150)), {}).series
    expect(upS.target.slice(-1)[0]).toBe(1)
    expect(upS.target.slice(0, 59).every((t) => t === 0)).toBe(true) // 预热
    const dn = mk(up(150, 300, -1))
    expect(evaluateStrategy(get('ema-trend'), dn, {}).series.target.slice(-1)[0]).toBe(-1)
    expect(evaluateStrategy(get('ema-trend'), dn, { allowShort: false }).series.target.slice(-1)[0]).toBe(0)
  })

  it('mean-reversion：急跌破下轨做多，回中轨平仓；理由字段说明原因', () => {
    const closes = [...Array.from({ length: 30 }, () => 100), 90, 91, 95, 100, 101]
    const s = evaluateStrategy(get('mean-reversion'), mk(closes), {}).series
    expect(s.target[30]).toBe(1)
    expect(s.reasons[30]).toContain('下轨')
    expect(s.target.slice(-1)[0]).toBe(0)
  })

  it('breakout：突破前高做多，跌破离场通道平仓', () => {
    const closes = [...Array.from({ length: 30 }, () => 100), 110, 112, 114, 95]
    const s = evaluateStrategy(get('breakout'), mk(closes), { entry: 20, exit: 5 }).series
    expect(s.target[30]).toBe(1)
    expect(s.target[32]).toBe(1)
    expect(s.target[33]).toBe(0)
  })

  it('grid：价格越低仓位越大，越高越小，出区间清仓', () => {
    const g = get('grid')
    const s = evaluateStrategy(g, mk([100, 95, 90, 100, 110, 120]), { center: 100, rangeRatio: 0.1, grids: 4 }).series
    expect(s.target[0]).toBeCloseTo(0.5, 6) // 中心价：半仓
    expect(s.target[2]).toBeCloseTo(1, 6) // 下沿：满仓
    expect(s.target[4]).toBeCloseTo(0, 6) // 上沿：空
    expect(s.target[5]).toBe(0) // 出区间：清仓
    expect(g.anchor!(mk([100, 105]), g.defaults).center).toBe(105)
    expect(g.anchor!(mk([100, 105]), { ...g.defaults, center: 80 }).center).toBe(80)
  })

  it('dca：按间隔逐份买入，买满不再加；到止盈线整笔卖出重来', () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i)
    const s = evaluateStrategy(get('dca'), mk(closes), { everyBars: 2, orders: 3, takeProfitRatio: 0 }).series
    expect(s.target.map((t) => Number(t.toFixed(3)))).toEqual([0.333, 0.333, 0.667, 0.667, 1, 1, 1, 1, 1, 1])
    const tp = evaluateStrategy(get('dca'), mk([100, 100, 100, 130, 130]), { everyBars: 1, orders: 5, takeProfitRatio: 0.2 }).series
    expect(tp.target[3]).toBe(0)
    expect(tp.reasons[3]).toContain('止盈')
    expect(tp.target[4]).toBeCloseTo(0.2, 6)
  })

  it('dca 锚点：实例启动前的 K 线不参与，下一根收盘才开始买', () => {
    const d = get('dca')
    const c = mk(Array.from({ length: 20 }, () => 100))
    const p = d.anchor!(c.slice(0, 11), d.defaults) // 假设实例在第 10 根（forming）时启动
    expect(p.startTs).toBe(c[10]!.t)
    const s = evaluateStrategy(d, c, { ...p, everyBars: 1, orders: 4 }).series
    expect(s.target.slice(0, 10).every((t) => t === 0)).toBe(true)
    expect(s.target[10]).toBeCloseTo(0.25, 6)
    expect(s.target[13]).toBeCloseTo(1, 6)
  })

  it('latestSignal：最后一根没收盘就用前一根；预热未完返回 null', () => {
    const c = mk(up(150))
    const closed = latestSignal(get('ema-trend'), c, {}, H, c[149]!.t + H + 1)!
    const live = latestSignal(get('ema-trend'), c, {}, H, c[149]!.t + H - 1)!
    expect(closed.index).toBe(149)
    expect(live.index).toBe(148)
    expect(closed.target).toBe(1)
    expect(latestSignal(get('ema-trend'), mk(up(10)), {}, H, Date.now() + 1e12)).toBeNull()
  })
})

describe('回测记账', () => {
  it('下一根开盘成交 + 滑点 + 手续费：账算得出来', () => {
    const c = mk(up(120))
    const r = runBacktest(get('ema-trend'), c, {}, { feeRate: 0.001, slippageBps: 10, initialCash: 10000 })
    const first = r.trades[0]!
    const sigBar = c.findIndex((_, i) => evaluateStrategy(get('ema-trend'), c, {}).series.target[i] !== 0)
    expect(first.side).toBe('buy')
    expect(first.t).toBe(c[sigBar + 1]!.t)
    expect(first.price).toBeCloseTo(c[sigBar + 1]!.o * 1.001, 8)
    expect(first.fee).toBeCloseTo(first.size * first.price * 0.001, 8)
    expect(first.size * first.price).toBeCloseTo(10000, 4) // 1× 满仓
    expect(first.pnl).toBeCloseTo(-first.fee, 8)
    expect(r.candlesUsed).toBe(120)
    expect(r.equity).toHaveLength(120)
    expect(r.openPosition?.side).toBe('long')
    expect(r.stats.totalReturnRatio).toBeGreaterThan(0.2)
    expect(r.stats.trades).toBe(0) // 一直没平仓：没有完成的往返
    expect(r.stats.fills).toBe(1)
  })

  it('零成本下，满仓持有的收益 = 价格涨幅；权益曲线逐根算', () => {
    const c = mk(up(150, 100, 1))
    const r = runBacktest(get('ema-trend'), c, {}, { feeRate: 0, slippageBps: 0 })
    const t = r.trades[0]!
    const final = 10000 + (c[149]!.c - t.price) * t.size
    expect(r.stats.finalEquity).toBeCloseTo(final, 1)
    expect(r.equity[149]!.v).toBeCloseTo(final, 6)
    expect(r.stats.maxDrawdownRatio).toBeLessThan(0.0001)
  })

  it('震荡行情里均值回归赚钱、往返被统计；胜率与盈亏比有值', () => {
    const c = mk(sine(600, 100, 8, 50))
    const r = runBacktest(get('mean-reversion'), c, { period: 60, k: 1 }, { feeRate: 0.0002, slippageBps: 1 })
    expect(r.stats.trades).toBeGreaterThan(5)
    expect(r.stats.totalReturnRatio).toBeGreaterThan(0)
    expect(r.stats.winRatio).toBeGreaterThan(0.5)
    expect(r.stats.avgHoldBars).toBeGreaterThan(0)
    expect(r.stats.sharpe).toBeGreaterThan(0)
    expect(r.stats.sortino).toBeGreaterThan(0)
    expect(r.stats.annualizedRatio).toBeGreaterThan(r.stats.totalReturnRatio) // 区间 25 天 < 1 年
    expect(r.stats.spanDays).toBeCloseTo(25, 1)
    expect(r.trades.every((t) => t.size > 0 && t.price > 0)).toBe(true)
  })

  it('网格：下跌时分批买入，回升时分批卖出，每笔都落在下一根开盘', () => {
    const c = mk([100, 98, 96, 94, 92, 94, 96, 98, 100, 102])
    const r = runBacktest(get('grid'), c, { center: 100, rangeRatio: 0.1, grids: 5 }, { feeRate: 0, slippageBps: 0 })
    expect(r.trades.filter((t) => t.side === 'buy').length).toBeGreaterThanOrEqual(3)
    expect(r.trades.filter((t) => t.side === 'sell').length).toBeGreaterThanOrEqual(2)
    expect(r.stats.totalReturnRatio).toBeGreaterThan(0)
    for (const t of r.trades) expect(c.some((k) => k.t === t.t && Math.abs(k.o - t.price) < 1e-9)).toBe(true)
  })

  it('反手：多 → 空 一次成交覆盖两边；杠杆放大名义', () => {
    const closes = [...up(80, 100, 1), ...up(80, 180, -2)]
    const r = runBacktest(get('ema-trend'), mk(closes), {}, { feeRate: 0, slippageBps: 0, leverage: 2 })
    const buys = r.trades.filter((t) => t.side === 'buy')
    expect(buys[0]!.size * buys[0]!.price).toBeCloseTo(20000, 2)
    expect(r.trades.some((t) => t.side === 'sell')).toBe(true)
    expect(r.stats.trades).toBeGreaterThanOrEqual(1)
  })

  it('空 / 短序列不崩；引擎不再硬切 5000 根（上限在 API 层按 maxBars 管）', () => {
    expect(runBacktest(get('breakout'), mk(sine(6000)), {}).candlesUsed).toBe(6000)
    const tiny = runBacktest(get('dca'), mk([100]), {})
    expect(tiny.stats.totalReturnRatio).toBe(0)
    expect(runBacktest(get('dca'), [], {}).equity).toEqual([])
  })
})
