// SPDX-License-Identifier: CPAL-1.0
// 回测撮合核心（搬运 Demo src/strategy/backtest.ts 并拆成可逐根推进的类，回测与回放共用同一份记账）。
// 成交模型 next-bar-open：信号出在第 i 根收盘，第 i+1 根开盘价成交（含不利滑点与吃单手续费）。
// 永续合约记账：现金只含已实现盈亏与手续费，权益 = 现金 + 持仓浮盈。仓位大小 = 目标 × 成交时权益 × 杠杆 / 价格，成交后不持续再平衡。
// 资金费按给定点逐根结算（多头在 rate > 0 时付钱），可选强平（按最不利价对维持保证金判定）与单根成交量上限；默认关闭，结果的 assumptions 里如实写 false。
import type { Candle } from '../types'
import { normalizeLot } from '../util/decimal'
import { evaluateProtection, openProtection } from './protection'
import type { ProtectionConfig, ProtectionState } from './protection'
import { BookFiller, FillModeError, type FillMode } from './fill-modes'
import type { BookFeed } from './fill-modes'
import type { BacktestTrade } from './types'

export const DAY_MS = 86_400_000
const EPS = 1e-12

export interface SimOptions {
  initialCash: number
  leverage: number
  /** 吃单费率（分数）。 */
  feeRate: number
  slippageBps: number
  /** 资金费点（按 t 升序）；缺省无。rate 为分数：多头在 rate > 0 时付钱。 */
  funding?: { t: number; rate: number }[]
  /** 是否模拟强平；缺省 false。 */
  liquidation?: boolean
  /** 维持保证金比例（分数）；缺省 0.5 / leverage。 */
  maintenanceMarginRatio?: number
  /** 单根 K 线最多吃该比例成交量（0–1）；缺省不限。 */
  maxVolumeShare?: number
  /** 强平时额外扣除维持保证金的比例；缺省 0。 */
  liquidationPenaltyRatio?: number
  /** 仓位保护规则（止损 / 止盈 / 移动止损 / 时限）；缺省不做保护。 */
  protection?: ProtectionConfig
  /** 手数步长（币数量）；给了就按步长向零取整，归一后为 0 视为不成交。 */
  lotStep?: number
  /** 最小手数（币数量）；归一后小于它视为不成交。 */
  minLot?: number
  /**
   * 成交模式：'bar'（缺省）= 下一根开盘价 + 固定滑点（老行为，逐字节不变）；
   * 'book' = 按盘口逐档吃单，需要 bookFeed。见 fill-modes/README.md。
   */
  fillMode?: FillMode
  /** 'book' 模式的盘口 / 逐笔记录；'book' 模式没给就报错，不退回到 'bar'。 */
  bookFeed?: BookFeed
}

export interface SimStats {
  totalReturnRatio: number
  annualizedRatio: number
  maxDrawdownRatio: number
  sharpe: number
  sortino: number
  winRatio: number
  profitFactor: number | null
  trades: number
  avgHoldBars: number
  fills: number
  spanDays: number
  finalEquity: number
  fundingPaid: number
  feesPaid: number
  liquidations: number
  /** 保护规则触发的出场笔数。 */
  protectionExits: number
  unfilledShare: number
}

export interface SimOpenPosition { side: 'long' | 'short'; size: number; entryPrice: number; unrealizedPnl: number }

interface Trip { pnl: number; bars: number }

export function inferIntervalMs(candles: readonly Candle[]): number {
  if (candles.length < 2) return 3_600_000
  const gaps: number[] = []
  for (let i = 1; i < Math.min(candles.length, 50); i++) gaps.push(candles[i]!.t - candles[i - 1]!.t)
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] || 3_600_000
}

/**
 * 按 fillMode 装配成交器。
 *   缺省 / 'bar' → null，走原有撮合（逐字节不变）；
 *   'book'     → 需要盘口数据；缺数据、以及和盘口口径冲突的选项都在这里报错，绝不退回 'bar'。
 * 这条边界对应自查项 S15 / 成长档案 G16：数据缺失或状态不明只许报错，不许换个口径接着算。
 */
function buildBookFiller(opts: SimOptions): BookFiller | null {
  const mode: string | undefined = opts.fillMode
  if (mode === undefined || mode === 'bar') {
    // 给了盘口数据却没开 'book'：明确报错，避免用户以为在用盘口成交
    if (opts.bookFeed !== undefined) {
      throw new FillModeError('unknown_mode', "给了 bookFeed 但 fillMode 不是 'book'；要按盘口成交请显式写 fillMode: 'book'")
    }
    return null
  }
  if (mode !== 'book') {
    throw new FillModeError('unknown_mode', `未知成交模式：${mode}；只支持 'bar' / 'book'`)
  }
  if (opts.protection !== undefined) {
    throw new FillModeError('unsupported_option', "'book' 模式不支持 protection：保护规则按 K 线高低价判定并按其价格成交，与盘口口径冲突")
  }
  if (opts.liquidation === true) {
    throw new FillModeError('unsupported_option', "'book' 模式不支持 liquidation：强平按 K 线最不利价判定，与盘口口径冲突")
  }
  return new BookFiller(opts.bookFeed)
}

export class Simulator {
  cash: number
  /** 带符号的币数量。 */
  pos = 0
  /** 持仓均价。 */
  entry = 0
  /** 已执行的目标仓位。 */
  applied = 0
  readonly trades: BacktestTrade[] = []
  readonly equity: Array<{ t: number; v: number }> = []
  private readonly trips: Trip[] = []
  private trip: { pnl: number; openBar: number } | null = null
  private readonly slip: number
  /** 已结算的资金费明细。 */
  readonly funding: Array<{ t: number; rate: number; notional: number; paid: number }> = []
  /** 资金费净支出（正数 = 支出）。 */
  fundingPaid = 0
  feesPaid = 0
  liquidations = 0
  /** 穿仓记录：强平价跌穿破产价时，保证金之外的亏损（由保险基金承担，不进现金）。 */
  readonly shortfalls: Array<{ t: number; amount: number }> = []
  get shortfall(): number { return this.shortfalls.reduce((s, x) => s + x.amount, 0) }
  unfilledNotional = 0
  wantedNotional = 0
  bankrupt = false
  /**
   * 短窗口年化算不出有限值（stats.annualizedRatio 已报 0）。由 stats() 置位，引擎据此在
   * 结果 warnings 里说明，与 Python 的 `annualized_unavailable`（engine/backtest.py）同一口径：
   * 不给数就不许静默给一个 0，调用方要能区分「真 0」与「算不出」。
   */
  private annualizedNonFinite = false
  private notes: string[] = []
  private fundingIdx = 0
  private lastBarT: number | null = null
  private readonly mmr: number
  private protectionExits = 0
  private prot: ProtectionState | null = null
  /** 'book' 模式的盘口成交器；'bar' 模式为 null（走原有撮合，一行不多）。 */
  private readonly book: BookFiller | null

  /** 实际生效的成交模式（'bar' 为缺省；诊断与测试用）。 */
  get fillMode(): FillMode { return this.book === null ? 'bar' : 'book' }

  /** 上一次 stats() 的年化是否因窗口太短而算不出有限值（true = annualizedRatio 报 0 只是占位）。 */
  get annualizedUnavailable(): boolean { return this.annualizedNonFinite }

  /** 上一次 stats() 产生的「退化说明」（不改数值，只让调用方能区分「真 0 / 真 null」与「算不出」）。 */
  get statNotes(): readonly string[] { return this.notes }

  /** 当前持仓的保护状态（只读，给测试和诊断看）；空仓时为 null。 */
  get protectionState(): ProtectionState | null { return this.prot }

  constructor(readonly opts: SimOptions) {
    this.cash = opts.initialCash
    this.slip = opts.slippageBps / 1e4
    this.mmr = opts.maintenanceMarginRatio ?? 0.5 / opts.leverage
    this.book = buildBookFiller(opts)
  }

  /** 成交一笔；返回是否真的成交（手数归一后为 0 时不计成交，只记未成交名义）。 */
  private fill(bar: number, t: number, delta: number, rawPx: number, reason: string): boolean {
    const { pos, entry } = this
    let signed = delta
    const lotStep = this.opts.lotStep
    if (lotStep !== undefined) {
      const lot = Math.abs(normalizeLot(Math.abs(delta), lotStep, this.opts.minLot))
      if (lot === 0) {
        this.unfilledNotional += Math.abs(delta) * rawPx
        return false
      }
      signed = Math.sign(delta) * lot
    }
    const side: 'buy' | 'sell' = signed > 0 ? 'buy' : 'sell'
    // 'bar'：开盘价 + 固定滑点；'book'：盘口逐档吃到的加权均价（不再加滑点），量以盘口可吃量为准
    let price = rawPx * (1 + (signed > 0 ? 1 : -1) * this.slip)
    let size = Math.abs(signed)
    if (this.book !== null) {
      const direction = Math.sign(signed)
      const exec = this.book.execute(t, signed)
      // maxVolumeShare 已在 onBar 按截量前的 |delta| × c.o 记过想要的名义，这里只补记没开该选项的情况，避免同一笔想要量被记两次
      if (this.opts.maxVolumeShare === undefined) this.wantedNotional += (exec.filled + exec.shortfall) * exec.price
      if (exec.shortfall > 0) this.unfilledNotional += exec.shortfall * exec.price
      price = exec.price
      size = exec.filled
      signed = direction * size
    }
    // 强平封顶：最差价（含滑点）跌穿破产价（权益归零的价格）时，按破产价成交，亏损封顶在保证金；
    // 超出部分记穿仓、手续费也计入穿仓（保证金已亏光），现金精确归 0，自审才对得上。
    let capped = false
    let uncovered = 0
    if (reason === 'liquidation' && this.cash > 0 && Math.abs(pos) > EPS && Math.abs(size - Math.abs(pos)) <= 1e-9 * Math.abs(pos)) {
      const bankruptcy = entry - this.cash / pos          // 多头 < entry，空头 > entry
      if (pos > 0 ? price < bankruptcy : price > bankruptcy) {
        uncovered = Math.abs(price - entry) * size + size * price * this.opts.feeRate - this.cash
        price = bankruptcy
        capped = true
      }
    }
    const fee = capped ? 0 : size * price * this.opts.feeRate
    let realized = 0
    if (Math.abs(pos) > EPS && Math.sign(pos) !== Math.sign(signed)) {
      const closing = Math.min(size, Math.abs(pos))
      realized = capped ? -this.cash : (price - entry) * closing * Math.sign(pos)
    }
    const before = pos
    const after = pos + signed
    // 往返统计：开仓 → 回到空仓或反手
    if (Math.abs(before) < EPS) this.trip = { pnl: 0, openBar: bar }
    if (this.trip) this.trip.pnl += realized - fee
    if (Math.abs(before) > EPS && (Math.abs(after) < EPS || Math.sign(after) !== Math.sign(before))) {
      if (this.trip) this.trips.push({ pnl: this.trip.pnl, bars: bar - this.trip.openBar })
      this.trip = Math.abs(after) < EPS ? null : { pnl: 0, openBar: bar }
    }
    // 持仓均价
    if (Math.abs(after) < EPS) { this.pos = 0; this.entry = 0 }
    else if (Math.abs(before) < EPS || Math.sign(before) !== Math.sign(after)) { this.pos = after; this.entry = price }
    else if (Math.sign(before) === Math.sign(signed)) { this.entry = (Math.abs(before) * entry + size * price) / Math.abs(after); this.pos = after }
    else { this.pos = after }
    this.cash += realized - fee
    if (capped) this.shortfalls.push({ t, amount: uncovered })
    this.feesPaid += fee
    this.trades.push({ t, side, price, size, pnl: realized - fee, fee, reason })
    return true
  }

  /** 保护状态跟随实际仓位：开仓 / 反手时按新持仓建立，回到空仓时清空。 */
  private syncProtection(bar: number): void {
    if (this.opts.protection === undefined) return
    if (Math.abs(this.pos) <= EPS) { this.prot = null; return }
    const side: 'long' | 'short' = this.pos > 0 ? 'long' : 'short'
    if (this.prot !== null && this.prot.side === side) return
    this.prot = openProtection(side, this.entry, bar)
  }

  /**
   * 推进一根 K 线。`want` = 上一根收盘出的目标仓位（-1..1）；null = 上一根还在指标预热期，没有信号。
   * `notionalCap` = 策略自己的硬上限（可选）；换算名义额时取 min(notionalCap, 权益 × 杠杆)。
   * 返回本根产生的成交（0 或 1 笔，回放用）。
   *
   * `want` 非有限或越出 [-1, 1] → RangeError（审计 L4-02）：以前 Infinity 会算出 `size: Infinity`
   * 并把权益写成 NaN，NaN 则因为 `Math.abs(NaN - applied) > EPS` 恒假被静默当成"不调仓"。
   */
  onBar(bar: number, c: Candle, want: number | null, reason: string, notionalCap?: number): BacktestTrade | null {
    if (want !== null && !Number.isFinite(want)) {
      throw new RangeError(`simulator: target at bar ${bar} is not a finite number (${String(want)})`)
    }
    if (want !== null && (want < -1 || want > 1)) {
      throw new RangeError(`simulator: target at bar ${bar} is outside [-1, 1] (${String(want)})`)
    }
    const before = this.trades.length
    if (!this.bankrupt) {
      // 保护先于策略：本根触发保护就平掉全部仓位，并忽略本根的策略目标（想再开仓得等下一根）
      let exited = false
      const protection = this.opts.protection
      if (protection !== undefined && this.prot !== null && Math.abs(this.pos) > EPS) {
        const verdict = evaluateProtection(this.prot, { ...c, index: bar }, protection)
        this.prot = verdict.state
        const exit = verdict.exit
        if (exit !== null && this.fill(bar, c.t, -this.pos, exit.price, `protection:${exit.reason}`)) {
          this.prot = null
          this.protectionExits += 1
          this.applied = 0
          exited = true
        }
      }
      if (!exited && want !== null && Math.abs(want - this.applied) > EPS) {
        const eqOpen = this.cash + this.pos * (c.o - this.entry) * (Math.abs(this.pos) > EPS ? 1 : 0)
        // 按预计成交价定仓位，满仓 1× 时名义恰好等于权益；'book' 模式用该时刻盘口的最优价，不用 K 线开盘价
        const sizePx = this.book === null ? c.o * (1 + Math.sign(want) * this.slip) : this.book.topPrice(c.t, want > 0 ? 'buy' : 'sell')
        let base = eqOpen * this.opts.leverage
        if (notionalCap !== undefined && notionalCap > 0) base = Math.min(base, notionalCap)
        const desired = eqOpen > 0 ? (want * base) / sizePx : 0
        let delta = desired - this.pos
        if (Math.abs(delta) * c.o > 1e-9) {
          const share = this.opts.maxVolumeShare
          if (share !== undefined) {
            this.wantedNotional += Math.abs(delta) * c.o
            const cap = share * c.v
            if (Math.abs(delta) > cap) {
              this.unfilledNotional += (Math.abs(delta) - cap) * c.o
              delta = Math.sign(delta) * cap
            }
          }
          if (Math.abs(delta) > EPS) this.fill(bar, c.t, delta, c.o, reason)
        }
        this.applied = want
        this.syncProtection(bar)
      }
      // 强平：按本根最不利价对维持保证金判定，成交后扣罚金
      if (this.opts.liquidation === true && Math.abs(this.pos) > EPS) {
        const worst = this.pos > 0 ? c.l : c.h
        const eqWorst = this.cash + this.pos * (worst - this.entry)
        const mm = Math.abs(this.pos) * worst * this.mmr
        if (eqWorst < mm) {
          this.fill(bar, c.t, -this.pos, worst, 'liquidation')
          this.cash -= (this.opts.liquidationPenaltyRatio ?? 0) * mm
          this.liquidations += 1
          this.applied = 0
          this.prot = null
          if (this.cash <= 0) { this.cash = 0; this.bankrupt = true }
        }
      }
      // 资金费：只结算 (lastBarT, c.t] 内的点；第 0 根只推进指针
      const points = this.opts.funding
      if (points) {
        const prevT = this.lastBarT
        while (this.fundingIdx < points.length) {
          const f = points[this.fundingIdx]!
          if (f.t > c.t) break
          this.fundingIdx += 1
          if (prevT === null || !(prevT < f.t)) continue
          if (Math.abs(this.pos) > EPS) {
            const paid = this.pos * c.c * f.rate
            this.cash -= paid
            this.fundingPaid += paid
            this.funding.push({ t: f.t, rate: f.rate, notional: Math.abs(this.pos) * c.c, paid })
          }
        }
      }
    }
    const eq = this.bankrupt ? this.cash : this.cash + (Math.abs(this.pos) > EPS ? this.pos * (c.c - this.entry) : 0)
    if (!Number.isFinite(eq)) {
      // 权益一旦不是有限值，后面的每一根都是垃圾：显式报错，不写进 equity（审计 L4-02）。
      throw new RangeError(`simulator: equity at bar ${bar} is not a finite number (${String(eq)})`)
    }
    this.equity.push({ t: c.t, v: eq })
    this.lastBarT = c.t
    return this.trades.length > before ? this.trades[this.trades.length - 1]! : null
  }

  openPosition(last: Candle | undefined): SimOpenPosition | null {
    if (!last || Math.abs(this.pos) <= EPS) return null
    return { side: this.pos > 0 ? 'long' : 'short', size: Math.abs(this.pos), entryPrice: this.entry, unrealizedPnl: this.pos * (last.c - this.entry) }
  }

  stats(candles: readonly Candle[], stepMs: number): SimStats {
    this.notes = []
    const { equity, trips } = this
    const initial = this.opts.initialCash
    const n = equity.length
    const finalEquity = n > 0 ? equity[n - 1]!.v : initial
    const spanDays = n > 0 ? (candles[n - 1]!.t + stepMs - candles[0]!.t) / DAY_MS : 0
    const totalReturn = finalEquity / initial - 1
    const years = spanDays / 365
    const rawAnnualized = years > 0 && finalEquity > 0 ? Math.pow(finalEquity / initial, 1 / years) - 1 : years > 0 ? -1 : 0
    // 短窗口年化会溢出（把 3 根 1 ms 的窗口年化 → 1.03^1e10 = Infinity）。与 Python 引擎同一口径：
    // 非有限时报 0（engine-python/README.md §stats 已写明"TS 侧此时得到 Infinity，JSON 里只能变 null"，
    // 这里把它收成 0，保住 stats 的数值契约）；其它统计量仍由下面的 fin() 硬拦。
    const annualized = Number.isFinite(rawAnnualized) ? rawAnnualized : 0
    // 记下来，让回测作业在 warnings 里显式提示；统计量本身仍是 0（stats 的数值契约不变）
    this.annualizedNonFinite = !Number.isFinite(rawAnnualized)
    // GQ-18: 短窗口外推说明（非有限值的情形已有 annualizedUnavailable warning，不重复）
    if (Number.isFinite(rawAnnualized) && spanDays < 30 && years > 0) {
      this.notes.push(`stats note: annualizedRatio is extrapolated from a ${Number(spanDays.toFixed(2))}-day window (< 30 days) and is not meaningful`)
    }

    let peak = initial
    let maxDd = 0
    let prev = initial
    let sum = 0
    let cnt = 0
    for (const p of equity) {
      peak = Math.max(peak, p.v)
      if (peak > 0) maxDd = Math.max(maxDd, (peak - p.v) / peak)
      if (prev > 0) { sum += p.v / prev - 1; cnt += 1 }
      prev = p.v
    }
    // 夏普 / 索提诺：逐根收益率，按每年根数年化
    let sharpe = 0
    let sortino = 0
    if (cnt > 2) {
      const m = sum / cnt
      let v = 0
      let dd = 0
      prev = initial
      for (const p of equity) {
        if (prev > 0) { const r = p.v / prev - 1; v += (r - m) ** 2; if (r < 0) dd += r * r }
        prev = p.v
      }
      const sd = Math.sqrt(v / (cnt - 1))
      const ddev = Math.sqrt(dd / cnt)
      const barsPerYear = (365 * DAY_MS) / stepMs
      if (sd > 1e-12) sharpe = (m / sd) * Math.sqrt(barsPerYear)
      if (ddev > 1e-12) sortino = (m / ddev) * Math.sqrt(barsPerYear)
      else this.notes.push('stats note: sortino is reported as 0 because the window has no downside deviation (undefined, not zero)')
    } else if (cnt > 0) {
      this.notes.push('stats note: sharpe and sortino are reported as 0: fewer than 4 equity samples')
    }

    let grossWin = 0
    let grossLoss = 0
    let wins = 0
    let holdBars = 0
    for (const t of trips) {
      if (t.pnl > 0) { wins += 1; grossWin += t.pnl } else if (t.pnl < 0) grossLoss -= t.pnl
      holdBars += t.bars
    }
    // GQ-18: profitFactor 退化说明
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null
    if (profitFactor === null) {
      if (trips.length === 0) {
        this.notes.push('stats note: profitFactor is null: no closed round trips')
      } else {
        this.notes.push('stats note: profitFactor is null: no losing round trip (gross loss is 0), the ratio is undefined')
      }
    }
    const r = (x: number, d: number): number => Number(x.toFixed(d))
    // 出口断言：NaN / ±Infinity 不许以 "NaN" 字符串的形式流进账本与图表（审计 L4-02 / G18）。
    const fin = (name: string, x: number): number => {
      if (!Number.isFinite(x)) throw new RangeError(`simulator: ${name} is not a finite number (${String(x)})`)
      return x
    }
    return {
      totalReturnRatio: fin('totalReturnRatio', r(totalReturn, 6)),
      annualizedRatio: fin('annualizedRatio', r(annualized, 6)),
      maxDrawdownRatio: fin('maxDrawdownRatio', r(maxDd, 6)),
      sharpe: fin('sharpe', r(sharpe, 3)),
      sortino: fin('sortino', r(sortino, 3)),
      winRatio: trips.length ? fin('winRatio', r(wins / trips.length, 6)) : 0,
      profitFactor: profitFactor !== null ? fin('profitFactor', r(profitFactor, 3)) : null,
      trades: trips.length,
      avgHoldBars: trips.length ? fin('avgHoldBars', r(holdBars / trips.length, 2)) : 0,
      fills: this.trades.length,
      spanDays: fin('spanDays', r(spanDays, 3)),
      finalEquity: fin('finalEquity', r(finalEquity, 2)),
      fundingPaid: fin('fundingPaid', r(this.fundingPaid, 6)),
      feesPaid: fin('feesPaid', r(this.feesPaid, 6)),
      liquidations: this.liquidations,
      protectionExits: this.protectionExits,
      unfilledShare: this.wantedNotional > 0 ? fin('unfilledShare', r(this.unfilledNotional / this.wantedNotional, 6)) : 0,
    }
  }
}
