// SPDX-License-Identifier: CPAL-1.0
// 盘口撮合引擎：市价 / 限价 / 止损 / 止损限价 / post-only / IOC / FOK / 减仓，逐档吃量并消耗流动性。
// 所有方法都是确定性的：同一串记录 + 同一串订单必得同一串回报；不读时钟、不用随机数（延迟抖动只来自种子）、不做 I/O。
//
// Q1b 加进来的三件模型都由选项注入，缺省值等于 Q1a 的行为：
//   fillModel —— 挂单成交判定三档（严格 / 队列位置 / 宽松），见 queue.ts；
//   latency  —— 下单 / 改单 / 撤单各自的固定延迟 + 可复现抖动，订单按**到达场所时刻**的盘口撮合，见 latency.ts；
//   fees     —— maker / taker 分档计费、可按币种覆盖，见 fees.ts（资金费不在本包）。
//
// 设计参照：nautilus_trader crates/execution/src/matching_core.rs@55c0e820 —— 限价簿与停损簿分册、
//   停损按触发价排序、同价 FIFO 时间优先；改价丢队列位置（本包的 modify 照此重记前方量）。
// 设计参照：nautilus_trader crates/execution/src/matching_engine/mod.rs@55c0e820 —— post-only 会吃单则整单拒；
//   IOC / FOK 无可成交即撤；同一笔成交量只分配一次（我方多张单不会重复吃同一份量）；
//   reduce-only 按持仓截断、无仓可平即拒。
// 设计参照：nautilus_trader crates/execution/src/matching_engine/mod.rs@55c0e820 —— process_market_order 的
//   “No market for …” 拒单：市价单没有对手盘即拒单。
// 设计参照：nautilus_trader crates/backtest/src/engine.rs@55c0e820 与 crates/backtest/src/exchange.rs@55c0e820 ——
//   命令「发出 → 延迟 → 到场 → 撮合」的因果序，在途命令按到达时刻排序的队列在 exchange.rs；
//   到场之前场所里没有这张单。
// 设计参照：nautilus_trader crates/execution/src/matching_engine/mod.rs@55c0e820 —— determine_limit_price_and_volume
//   的 “Filling as MAKER” 段：挂在簿上的限价单被报价穿越时按自己的限价记 maker 成交，不改记对手档位价。
// 只借设计；代码结构、命名与状态机按本包协议从零写。
import { ZERO, add, str, sub, type Fx } from '@gitrader/protocol/decimal'
import { MarketBook } from './book'
import { FeeLedger, toFeeModel, type FeeConfig, type FeeModel, type FeeTotals } from './fees'
import { LatencyModel, toLatencyModel, type LatencyConfig } from './latency'
import { commitWalk, isTriggered, planWalk, wouldCross, type TriggerBasis } from './match'
import { fmtDecimal, parseDecimal, parsePositive } from './num'
import { MakerFillJudge, type MakerFillMode } from './queue'
import type {
  FillReport,
  LiquiditySide,
  MarketRecord,
  OrderReason,
  OrderReport,
  OrderRequest,
  OrderType,
  Side,
  SubmitContext,
  TimeInForce,
  WorkingOrder,
} from './types'

export interface SimBookOptions {
  /** 标的；给了之后记录标的必须与之一致，不给则取第一条记录的标的。 */
  instrument?: string
  /** 停损触发价口径，缺省 last（无成交时退回对手方最优价）。 */
  triggerBasis?: TriggerBasis
  /** 挂单成交判定档位，缺省 optimistic（触价即成交 = Q1a 行为）。 */
  fillModel?: MakerFillMode
  /** 延迟模型；缺省零延迟（命令在发出时刻就到场所）。 */
  latency?: LatencyModel | LatencyConfig
  /** maker / taker 费率与按币种覆盖；缺省不计费。 */
  fees?: FeeModel | FeeConfig
  /** 计费币种（本包单标的），缺省 USD。 */
  currency?: string
}

/** 改单补丁：只改给到的字段；改价会丢掉队列位置（重新记前方量）。 */
export interface OrderPatch {
  price?: string
  qty?: string
}

type PendingCommand =
  | { kind: 'submit'; at: number; seq: number; order: WorkingOrder }
  | { kind: 'cancel'; at: number; seq: number; orderId: string }
  | { kind: 'modify'; at: number; seq: number; orderId: string; price: Fx | null; qty: Fx | null }

const ORDER_TYPES: readonly OrderType[] = ['market', 'limit', 'stop_market', 'stop_limit']
const TIFS: readonly TimeInForce[] = ['gtc', 'ioc', 'fok']

export class SimBook {
  readonly book: MarketBook
  readonly fillModel: MakerFillJudge
  readonly latency: LatencyModel
  readonly fees: FeeModel | null
  readonly currency: string
  private readonly triggerBasis: TriggerBasis
  private readonly working = new Map<string, WorkingOrder>()
  private readonly done = new Map<string, WorkingOrder>()
  private readonly seen = new Set<string>()
  /** 已登记过队列位置的订单（改单后清掉，按新盘口重记）。 */
  private readonly joined = new Set<string>()
  /** 在途命令的到达时刻（订单 id → ts）。仍在途的单不参与撮合。 */
  private readonly arrivalAt = new Map<string, number>()
  /** GQ-25: 同一毫秒分组时，当前正在延迟处理的时间戳（该 ts 的命令推迟到该毫秒最后一条记录后）。 */
  private deferredTs: number | null = null
  private pending: PendingCommand[] = []
  private pendingSeq = 0
  private readonly feeLedgers = new Map<string, FeeLedger>()
  private readonly feeTotal: FeeLedger
  private nextSeq = 0

  constructor(options: SimBookOptions = {}) {
    this.book = new MarketBook()
    if (options.instrument !== undefined) this.book.instrument = options.instrument
    this.triggerBasis = options.triggerBasis ?? 'last'
    this.fillModel = new MakerFillJudge(options.fillModel ?? 'optimistic')
    this.latency = toLatencyModel(options.latency)
    this.fees = toFeeModel(options.fees)
    this.currency = options.currency ?? 'USD'
    this.feeTotal = new FeeLedger(this.currency)
  }

  /**
   * 喂一条盘口 / 成交记录。处理顺序就是行情与命令的因果序：
   *   1. 到达时刻**早于**本条记录的在途命令 → 用本条记录之前的盘口撮合；
   *   2. 本条记录落到盘口；
   *   3. 到达时刻**正好等于**本条记录 ts 的在途命令 → 用本条记录之后的盘口撮合
   *      （同一毫秒分不出先后，取较晚的那版盘口，对我方更不利）；
   *   4. 复查挂单：先判停损触发，再按判定档位判挂单成交。
   * 逐笔成交会把成交量作为「本笔可分配额度」，我方挂单的成交只能从这笔额度里分，不能重复吃同一份量。
   *
   * 逐条喂入时，同一毫秒后面还有记录就传 `{ sameMsFollows: true }`：到达时刻等于本条 ts 的命令推迟到该毫秒最后一条记录落盘后再撮合
   * （「同一毫秒取较晚那版」）。不传（默认）= 本条就是这一毫秒的最后一条，与旧行为一致。
   * R1-PERF-10：opts 不设默认对象——热路径上每条记录分配一个 `{}` 是 d47a71c（GQ-25）引入的唯一新增分配。
   */
  apply(record: MarketRecord, opts?: { sameMsFollows?: boolean }): void {
    this.runDue(record.ts, false)
    if (record.type === 'trade') this.book.applyTrade(record)
    else if (record.type === 'book_snapshot') this.book.applySnapshot(record)
    else this.book.applyDelta(record)
    if (opts !== undefined && opts.sameMsFollows === true) {
      // 同一毫秒后面还有记录：标记延迟处理，推迟 runDue(ts, true) 到该毫秒最后一条记录
      this.deferredTs = record.ts
    } else {
      // 该毫秒最后一条记录（或单独记录）：处理到达时刻 == ts 的命令，并清除延迟标记
      this.runDue(record.ts, true)
      this.deferredTs = null
    }
    const budget = record.type === 'trade' ? (this.book.lastTrade?.size ?? ZERO) : null
    this.processWorking(record.ts, budget)
  }

  /** 批量喂入：按毫秒分组，每个毫秒的命令在该毫秒最后一条记录落盘后撮合。 */
  applyBatch(records: readonly MarketRecord[]): void {
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!
      this.apply(record, { sameMsFollows: records[i + 1]?.ts === record.ts })
    }
  }

  /**
   * 提交一张订单。有下单延迟时先挂成「在途」，到达场所那一刻才撮合；
   * 零延迟时与 Q1a 完全相同：触发 → 吃单 → 剩余挂簿，返回这一时刻的回报。
   */
  submit(request: OrderRequest, ts: number, context: SubmitContext = {}): OrderReport {
    const built = this.buildOrder(request, ts, context)
    if (built.order === undefined) return built.report

    const order = built.order
    const delay = this.latency.latency('insert')
    if (delay > 0) {
      const at = ts + delay
      order.status = 'accepted'
      order.notes.push(`在途：下单延迟 ${delay} ms，预计 ${at} 到达场所`)
      this.working.set(order.id, order)
      this.arrivalAt.set(order.id, at)
      this.schedule({ kind: 'submit', at, seq: this.pendingSeq++, order })
      return this.toReport(order, ts)
    }
    return this.place(order, ts)
  }

  /**
   * 撤单：撤掉剩余量，已成交部分保留在回报里。未知单 / 已终态的单给出原因码。
   * 有撤单延迟时撤单先进入在途，到达场所之前订单仍可被行情成交（这正是延迟的意义）。
   */
  cancel(orderId: string, ts: number): OrderReport {
    const order = this.working.get(orderId)
    if (order === undefined) {
      return this.rejectReport(orderId, this.done.has(orderId) ? 'already_terminal' : 'unknown_order', ts)
    }
    const delay = this.latency.latency('cancel')
    // 下单仍在途：场所里还没有这张单，撤单按未知单拒绝，订单不动。
    if (delay === 0 && this.arrivalAt.has(orderId)) {
      return this.rejectReport(
        orderId,
        'unknown_order',
        ts,
        '撤单先于下单到达场所，场所按未知单拒绝；下单到达后照常撮合',
      )
    }
    if (delay > 0) {
      const at = ts + delay
      order.notes.push(`在途：撤单延迟 ${delay} ms，预计 ${at} 到达场所`)
      this.schedule({ kind: 'cancel', at, seq: this.pendingSeq++, orderId })
      return this.toReport(order, ts)
    }
    return this.cancelNow(order, ts)
  }

  /**
   * 改单：只改 price / qty，改价会丢掉队列位置（与参照「改过的单当新单排队」一致）。
   * 有改单延迟时旧参数继续挂在簿上，直到补丁到达场所。
   */
  modify(orderId: string, patch: OrderPatch, ts: number): OrderReport {
    const order = this.working.get(orderId)
    if (order === undefined) {
      return this.rejectReport(orderId, this.done.has(orderId) ? 'already_terminal' : 'unknown_order', ts)
    }
    const parsed = this.parsePatch(order, patch)
    if ('note' in parsed) return this.rejectReport(orderId, 'invalid_order', ts, parsed.note)
    const delay = this.latency.latency('update')
    // 下单仍在途：场所里还没有这张单，改单按未知单拒绝，订单不动。
    if (delay === 0 && this.arrivalAt.has(orderId)) {
      return this.rejectReport(
        orderId,
        'unknown_order',
        ts,
        '改单先于下单到达场所，场所按未知单拒绝；下单到达后按原参数撮合',
      )
    }
    if (delay > 0) {
      const at = ts + delay
      order.notes.push(`在途：改单延迟 ${delay} ms，预计 ${at} 到达场所`)
      this.schedule({ kind: 'modify', at, seq: this.pendingSeq++, orderId, price: parsed.price, qty: parsed.qty })
      return this.toReport(order, ts)
    }
    return this.applyPatch(order, parsed.price, parsed.qty, ts)
  }

  /** 记录流收尾：把在途命令按最后的盘口全部走完（`ts` 是流末时刻）。 */
  flush(ts = Number.MAX_SAFE_INTEGER): void {
    this.runDue(ts, true)
  }

  /** 仍挂在簿上（或在途）的单，按提交顺序，可撤。 */
  openOrders(): OrderReport[] {
    return [...this.working.values()].sort((a, b) => a.seq - b.seq).map((order) => this.toReport(order, order.ts))
  }

  hasOpenOrder(orderId: string): boolean {
    return this.working.has(orderId)
  }

  /** 订单的到达时刻；零延迟 / 已到达 / 未知单为 null。 */
  arrivalOf(orderId: string): number | null {
    return this.arrivalAt.get(orderId) ?? null
  }

  /** 仍在途的命令数（诊断用）。 */
  get pendingCount(): number {
    return this.pending.length
  }

  /** 某张单的手续费累计；没配费用模型时是零账本。 */
  feesOf(orderId: string): FeeTotals {
    const ledger = this.feeLedgers.get(orderId)
    return ledger === undefined
      ? { currency: this.currency, maker: '0', taker: '0', total: '0', fills: 0 }
      : ledger.totals()
  }

  /** 整场仿真的手续费累计（maker / taker 分开）。 */
  feeSummary(): FeeTotals {
    return this.feeTotal.totals()
  }

  /** 查某张单的最新回报（挂单与已终结的都查）。未知 id 返回 undefined。 */
  report(orderId: string): OrderReport | undefined {
    const order = this.working.get(orderId) ?? this.done.get(orderId)
    return order === undefined ? undefined : this.toReport(order, order.ts)
  }

  // ---- 下单校验 ------------------------------------------------------------------------------

  private buildOrder(
    request: OrderRequest,
    ts: number,
    context: SubmitContext,
  ): { order: WorkingOrder; report: undefined } | { order: undefined; report: OrderReport } {
    const bad = (reason: OrderReason, note?: string): { order: undefined; report: OrderReport } => ({
      order: undefined,
      report: this.rejectReport(this.requestId(request), reason, ts, note),
    })

    if (typeof request.id !== 'string' || request.id.trim() === '') return bad('invalid_order', '订单 id 不能为空')
    if (this.seen.has(request.id)) return bad('duplicate_order_id', `订单 id 重复：${request.id}`)
    this.seen.add(request.id)

    if (request.side !== 'buy' && request.side !== 'sell') return bad('invalid_order', `未知方向：${String(request.side)}`)
    if (!ORDER_TYPES.includes(request.type)) return bad('invalid_order', `未知订单类型：${String(request.type)}`)
    const tif = request.tif ?? 'gtc'
    if (!TIFS.includes(tif)) return bad('invalid_order', `未知有效期：${String(tif)}`)

    let qty: Fx
    try {
      qty = parsePositive(request.qty, 'qty')
    } catch (error) {
      return bad('invalid_order', messageOf(error))
    }

    const isLimit = request.type === 'limit' || request.type === 'stop_limit'
    const isStop = request.type === 'stop_market' || request.type === 'stop_limit'

    let price: Fx | null = null
    if (isLimit) {
      if (request.price === undefined) return bad('invalid_order', '限价类订单缺 price')
      try {
        price = parsePositive(request.price, 'price')
      } catch (error) {
        return bad('invalid_order', messageOf(error))
      }
    } else if (request.price !== undefined) {
      return bad('invalid_order', '市价类订单不接受 price')
    }

    let triggerPrice: Fx | null = null
    if (isStop) {
      if (request.triggerPrice === undefined) return bad('invalid_order', '停损类订单缺 triggerPrice')
      try {
        triggerPrice = parsePositive(request.triggerPrice, 'triggerPrice')
      } catch (error) {
        return bad('invalid_order', messageOf(error))
      }
    } else if (request.triggerPrice !== undefined) {
      return bad('invalid_order', '非停损订单不接受 triggerPrice')
    }

    const postOnly = request.postOnly === true
    if (postOnly && !isLimit) return bad('invalid_order', 'post-only 只能用于限价类订单')
    if (postOnly && tif !== 'gtc') return bad('invalid_order', 'post-only 与 IOC / FOK 互斥')

    const notes: string[] = []
    if (request.reduceOnly === true) {
      const cap = reduceOnlyCap(request.side, context)
      if (cap === null) return bad('invalid_order', '持仓量不是十进制文本')
      if (cap === ZERO) return bad('reduce_only_no_position', '减仓单没有可减的持仓')
      if (qty > cap) {
        notes.push(`减仓单数量按持仓截断：${str(qty)} → ${str(cap)}`)
        qty = cap
      }
    }

    const order: WorkingOrder = {
      id: request.id,
      side: request.side,
      type: request.type,
      tif,
      seq: this.nextSeq,
      price,
      triggerPrice,
      postOnly,
      reduceOnly: request.reduceOnly === true,
      qty,
      filled: ZERO,
      triggered: false,
      status: 'accepted',
      reason: undefined,
      fills: [],
      notes,
      ts,
    }
    this.nextSeq += 1
    return { order, report: undefined }
  }

  /** 改单补丁的校验与解析：只许改价格 / 数量，数量不能小于已成交量。 */
  private parsePatch(order: WorkingOrder, patch: OrderPatch): { price: Fx | null; qty: Fx | null } | { note: string } {
    if (patch.price === undefined && patch.qty === undefined) return { note: '改单必须给 price 或 qty' }
    let price: Fx | null = null
    if (patch.price !== undefined) {
      if (order.price === null) return { note: '市价类订单没有可改的价格' }
      try {
        price = parsePositive(patch.price, 'price')
      } catch (error) {
        return { note: messageOf(error) }
      }
    }
    let qty: Fx | null = null
    if (patch.qty !== undefined) {
      try {
        qty = parsePositive(patch.qty, 'qty')
      } catch (error) {
        return { note: messageOf(error) }
      }
      if (qty < order.filled) return { note: `改单数量不能小于已成交量 ${str(order.filled)}` }
    }
    return { price, qty }
  }

  private requestId(request: OrderRequest): string {
    return typeof request?.id === 'string' ? request.id : ''
  }

  private triggerMet(order: WorkingOrder): boolean {
    if (order.triggerPrice === null) return true
    return isTriggered(this.book, order.side, order.triggerPrice, this.triggerBasis)
  }

  // ---- 在途命令 ------------------------------------------------------------------------------

  private schedule(command: PendingCommand): void {
    this.pending.push(command)
    this.pending.sort((a, b) => a.at - b.at || a.seq - b.seq)
  }

  /** 把到达时刻满足条件的命令按 (at, seq) 顺序执行；inclusive=false 取严格小于。 */
  private runDue(limit: number, inclusive: boolean): void {
    if (this.pending.length === 0) return
    const due: PendingCommand[] = []
    const later: PendingCommand[] = []
    for (const command of this.pending) {
      const ready = inclusive ? command.at <= limit : command.at < limit
      if (ready) due.push(command)
      else later.push(command)
    }
    if (due.length === 0) return
    this.pending = later
    for (const command of due) this.dispatch(command)
  }

  private dispatch(command: PendingCommand): void {
    if (command.kind === 'submit') {
      const order = command.order
      this.arrivalAt.delete(order.id)
      // 下单到达场所时单已不在簿上（防御）：本次下单不再生效。
      if (!this.working.has(order.id)) return
      this.place(order, command.at)
      return
    }
    const order = this.working.get(command.orderId)
    if (order === undefined) return // 已经终结（例如撤单在途期间被行情成交）
    // 下单仍在途：场所里还没有这张单，撤单 / 改单按未知单拒绝，订单不动。
    if (this.arrivalAt.has(command.orderId)) {
      const label = command.kind === 'cancel' ? '撤单' : '改单'
      order.notes.push(`${label} ${command.at} 先于下单到达场所，被按未知单拒绝`)
      return
    }
    if (command.kind === 'cancel') {
      this.cancelNow(order, command.at)
      return
    }
    this.applyPatch(order, command.price, command.qty, command.at)
  }

  /** 到达场所后的推进：触发 → 吃单 → 剩余挂簿。 */
  private place(order: WorkingOrder, ts: number): OrderReport {
    if (!this.triggerMet(order)) {
      order.status = 'accepted'
      order.ts = ts
      this.rest(order)
      return this.toReport(order, ts)
    }
    order.triggered = true
    return this.execute(order, ts)
  }

  private cancelNow(order: WorkingOrder, ts: number): OrderReport {
    order.status = 'canceled'
    order.reason = undefined
    order.ts = ts
    this.finish(order)
    return this.toReport(order, ts)
  }

  /** 改单落到场所：改参数、丢队列位置、按新参数重新撮合一次。 */
  private applyPatch(order: WorkingOrder, price: Fx | null, qty: Fx | null, ts: number): OrderReport {
    if (price !== null) order.price = price
    if (qty !== null) order.qty = qty
    // 改价丢队列位置：前方量按到达之后的盘口重记。
    this.fillModel.forget(order.id)
    this.joined.delete(order.id)
    order.status = order.filled === ZERO ? 'accepted' : 'partially_filled'
    order.ts = ts
    this.rest(order)
    return this.execute(order, ts)
  }

  // ---- 执行 ----------------------------------------------------------------------------------

  private execute(order: WorkingOrder, ts: number): OrderReport {
    const limit = order.type === 'market' || order.type === 'stop_market' ? null : order.price
    const crossing = limit === null ? true : wouldCross(this.book, order.side, limit)

    if (order.postOnly && crossing) return this.reject(order, 'post_only_would_take', ts)

    if (!crossing) {
      if (order.tif === 'fok') return this.cancelWith(order, 'fok_unfillable', ts)
      if (order.tif === 'ioc') return this.cancelWith(order, 'ioc_remainder_void', ts)
      order.status = 'accepted'
      this.rest(order)
      return this.toReport(order, ts)
    }

    const plan = planWalk(this.book, order.side, limit, sub(order.qty, order.filled))
    // FOK：整单吃得下才算，吃不下就一格都不落账，盘口可吃量保持原样。
    if (order.tif === 'fok' && plan.filled !== sub(order.qty, order.filled)) {
      return this.cancelWith(order, 'fok_unfillable', ts)
    }
    const consumed = commitWalk(this.book, order.side, plan)
    if (consumed !== plan.filled) throw new RangeError('试算量与落账量不一致（盘口在同一时刻被改动）')
    for (const fill of plan.fills) this.recordFill(order, fill.price, fill.qty, 'taker')

    const remaining = sub(order.qty, order.filled)
    if (remaining === ZERO) {
      order.status = 'filled'
      this.finish(order)
      return this.toReport(order, ts)
    }
    if (limit === null) {
      if (order.filled === ZERO) return this.reject(order, 'no_liquidity', ts)
      order.status = 'partially_filled'
      order.reason = 'insufficient_liquidity'
      this.finish(order)
      return this.toReport(order, ts)
    }
    if (order.tif === 'ioc') {
      order.status = order.filled === ZERO ? 'canceled' : 'partially_filled'
      order.reason = 'ioc_remainder_void'
      this.finish(order)
      return this.toReport(order, ts)
    }
    order.status = order.filled === ZERO ? 'accepted' : 'partially_filled'
    this.rest(order)
    return this.toReport(order, ts)
  }

  /**
   * 每条记录之后的挂单复查。tradeBudget 非空表示当前记录是逐笔成交：
   * 挂单从这笔成交量里分配成交额（maker，按自己的限价成交），额度用完就等下一笔。
   */
  private processWorking(ts: number, tradeBudget: Fx | null): void {
    const orders = [...this.working.values()].sort((a, b) => a.seq - b.seq)
    let budget = tradeBudget

    for (const order of orders) {
      if (order.status !== 'accepted' && order.status !== 'partially_filled') continue
      // 还在途的单在场所里还不存在，不参与撮合。
      const arrival = this.arrivalAt.get(order.id)
      if (arrival !== undefined && arrival > ts) continue
      // GQ-25: 到达时刻正好等于当前延迟处理的时间戳：推迟到该毫秒最后一条记录之后再处理
      if (arrival !== undefined && this.deferredTs !== null && arrival === this.deferredTs) continue

      // 本轮刚触发 = 这张单是在这一时刻才开始吃单，仍是主动方（taker）；
      // 之前就已经挂在簿上的单被后续行情穿越时只能当被动方（maker）。
      let justTriggered = false
      if (!order.triggered) {
        if (order.triggerPrice !== null && !isTriggered(this.book, order.side, order.triggerPrice, this.triggerBasis)) continue
        order.triggered = true
        justTriggered = true
        order.ts = ts
      }

      let leaves = sub(order.qty, order.filled)
      if (leaves <= ZERO) {
        order.status = 'filled'
        this.finish(order)
        continue
      }

      const limit = order.type === 'market' || order.type === 'stop_market' ? null : order.price

      // 成交驱动的挂单成交：maker，按自己的限价成交，从本笔成交量里扣。
      const trade = this.book.lastTrade
      // 只有对手方主动成交（或方向未知）才可能吃到我的挂单：买方主动的成交不会打到我的买单。
      const tradeFillsMe = trade !== null && trade.aggressor !== order.side
      if (limit !== null && budget !== null && budget > ZERO && tradeFillsMe) {
        const verdict = this.fillModel.judge({
          orderId: order.id,
          side: order.side,
          limit,
          leaves,
          budget,
          tradePrice: trade.price,
          tradeSize: trade.size,
        })
        if (verdict.budgetUsed > ZERO) budget = sub(budget, verdict.budgetUsed)
        if (verdict.qty > ZERO) {
          this.recordFill(order, limit, verdict.qty, 'maker')
          order.ts = ts
          leaves = sub(order.qty, order.filled)
          order.status = leaves === ZERO ? 'filled' : 'partially_filled'
          if (order.status === 'filled') {
            this.finish(order)
            continue
          }
        }
      }

      // 触发后的市价单、本轮刚触发的止损限价单：按盘口逐档吃，成交价取档位价（taker）。
      // 已挂在簿上的限价单被行情穿越：对手方是主动方，我们是被动方，只按自己的限价记一笔 maker 成交，
      // 但仍要消耗对手档位的流动性（试算 / 落账照旧）。
      const crossing = limit === null || wouldCross(this.book, order.side, limit)
      if (crossing) {
        const plan = planWalk(this.book, order.side, limit, sub(order.qty, order.filled))
        if (plan.filled > ZERO) {
          const consumed = commitWalk(this.book, order.side, plan)
          if (consumed !== plan.filled) throw new RangeError('试算量与落账量不一致（盘口在同一时刻被改动）')
          if (limit !== null && !justTriggered) {
            this.recordFill(order, limit, plan.filled, 'maker')
          } else {
            for (const fill of plan.fills) this.recordFill(order, fill.price, fill.qty, 'taker')
          }
          order.ts = ts
          order.status = sub(order.qty, order.filled) === ZERO ? 'filled' : 'partially_filled'
          if (order.status === 'filled') {
            this.finish(order)
            continue
          }
        }
      }

      // 触发后的市价单不挂簿：吃完（或吃不到）就结束。
      if (limit === null) {
        if (order.filled === ZERO) {
          order.reason = 'no_liquidity'
          order.status = 'rejected'
        } else {
          order.reason = 'insufficient_liquidity'
          order.status = 'partially_filled'
        }
        order.ts = ts
        this.finish(order)
      }
    }
  }

  /** 挂到簿上：登记队列位置估计（只在第一次挂上时记；改单会先清掉再记）。 */
  private rest(order: WorkingOrder): void {
    this.working.set(order.id, order)
    this.arrivalAt.delete(order.id)
    if (order.price === null || this.joined.has(order.id)) return
    const ownSide = order.side === 'buy' ? 'bid' : 'ask'
    this.fillModel.join(order.id, this.book.sizeAt(ownSide, order.price))
    this.joined.add(order.id)
  }

  private reject(order: WorkingOrder, reason: OrderReason, ts: number): OrderReport {
    order.status = 'rejected'
    order.reason = reason
    this.finish(order)
    return this.toReport(order, ts)
  }

  private cancelWith(order: WorkingOrder, reason: OrderReason, ts: number): OrderReport {
    order.status = 'canceled'
    order.reason = reason
    this.finish(order)
    return this.toReport(order, ts)
  }

  private finish(order: WorkingOrder): void {
    this.working.delete(order.id)
    this.done.set(order.id, order)
    this.arrivalAt.delete(order.id)
    this.fillModel.forget(order.id)
    this.joined.delete(order.id)
  }

  // ---- 费用 ----------------------------------------------------------------------------------

  /** 记一笔成交并按 maker / taker 计费（没配费用模型时只记成交）。 */
  private recordFill(order: WorkingOrder, price: Fx, qty: Fx, liquidity: LiquiditySide): void {
    order.fills.push({ price, qty, liquidity })
    order.filled = add(order.filled, qty)
    if (this.fees === null) return
    const fee = this.fees.charge(this.currency, price, qty, liquidity)
    let ledger = this.feeLedgers.get(order.id)
    if (ledger === undefined) {
      ledger = new FeeLedger(this.currency)
      this.feeLedgers.set(order.id, ledger)
    }
    ledger.charge(liquidity, fee)
    this.feeTotal.charge(liquidity, fee)
  }

  // ---- 回报 ----------------------------------------------------------------------------------

  private toReport(order: WorkingOrder, ts: number): OrderReport {
    const fills: FillReport[] = []
    let sum = ZERO
    let qty = ZERO
    for (const fill of order.fills) {
      sum = add(sum, fill.price * fill.qty)
      qty = add(qty, fill.qty)
      fills.push({ price: fmtDecimal(fill.price), qty: fmtDecimal(fill.qty), liquidity: fill.liquidity })
    }
    const avg = qty === ZERO ? ZERO : sum / qty
    return {
      orderId: order.id,
      status: order.status,
      fills,
      filledQty: fmtDecimal(order.filled),
      remainingQty: fmtDecimal(sub(order.qty, order.filled)),
      avgPrice: fmtDecimal(avg),
      resting: this.working.has(order.id),
      reason: order.reason,
      notes: [...order.notes],
      ts,
    }
  }

  private rejectReport(orderId: string, reason: OrderReason, ts: number, note?: string): OrderReport {
    return {
      orderId,
      status: 'rejected',
      fills: [],
      filledQty: '0',
      remainingQty: '0',
      avgPrice: '0',
      resting: false,
      reason,
      notes: note === undefined ? [] : [note],
      ts,
    }
  }
}

/**
 * 减仓上限：持仓方向与订单方向相反才可减，上限为持仓绝对量；同向或空仓为 0。
 * 持仓量不是十进制文本时返回 null，由调用方按非法入参处理。
 */
function reduceOnlyCap(side: Side, context: SubmitContext): Fx | null {
  const position = context.position
  if (position === undefined || position.side === 'flat') return ZERO
  let holding: Fx
  try {
    holding = parseDecimal(position.qty, 'position.qty')
  } catch {
    return null
  }
  const absolute = holding < ZERO ? -holding : holding
  const closes = (side === 'sell' && position.side === 'long') || (side === 'buy' && position.side === 'short')
  return closes ? absolute : ZERO
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
