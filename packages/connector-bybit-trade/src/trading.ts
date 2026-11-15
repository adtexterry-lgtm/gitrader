// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 撤单 / 全撤 / 改单 / 杠杆 / 保证金模式 / 持仓级 TP-SL。
// 连接器自己不会主动下单——所有方法都在内核发起的 TradeContext 窗口里执行（契约 §3.6）。
// 端点与 HTTP 方法（教训 1 / 2，照 QD bybit.py 的当前实现 + Bybit v5 官方方法）：
//   · POST /v5/order/create        建单（普通单与 StopOrder 触发单同一个端点）；
//   · POST /v5/order/cancel        撤单（**POST，不是 DELETE**）；
//   · POST /v5/order/cancel-all    全撤（**POST**；给 symbol 或 settleCoin）；
//   · POST /v5/order/amend         改单（**POST**；只改原生支持的订单类型）；
//   · POST /v5/position/set-leverage、POST /v5/account/set-margin-mode；
//   · POST /v5/position/trading-stop（持仓级 TP / SL / 追踪）。
//   GET 只用于查询（order/realtime、position/list、execution/list、wallet-balance）。
// 其它口径：
//   · 签名是 HMAC（apiKey / apiSecret 从构造参数进），不是签名器句柄：ctx.signer 在 Bybit 上没有对应物，
//     本模块**不使用**它，也不回调 ctx.onSigned（没有载荷摘要可写账本；README 写明）；
//   · tpsl：本包 submit 不自动挂保护单（带 tpsl 的意图回 1004），成交后走 orders.buildProtectionOrders()
//     或持仓级 orders.buildTradingStop()；
//   · amend：只有 Limit / stop_limit / take_limit 有原生改单；market / 触发市价 / 追踪一律 1004；
//   · scheduleCancel：Bybit 没有场所级定时撤单 → CAPABILITY_UNSUPPORTED（5002）；
//   · 回执 receiptHash = sha256(原始响应数组的 JSON)；requestWeight 按 Bybit 口径（下单请求权重 0）。
//   · 「结果未知」（3006）一律回 status 'unknown'，等内核按 clientOrderId 对账，绝不盲目重发。
//   · submit 不切账户级保证金模式；显式 marginMode（非 reduce-only）fail-closed，显式 setter 保留切换能力。
import { createHash } from 'node:crypto'
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type { Decimal, InstrumentId, OrderIntent, Problem } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, OrderAck, SubmitResult, TradeContext, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import type { BybitAccounts } from './account'
import { BYBIT_WEIGHTS } from './budget'
import { asProblem, ProblemError, redactSecret } from './errors'
import { buildOrderParams, buildTradingStop, OrderBuildError, sanitizeClientOrderId } from './orders'
import type { BuildOptions, BuiltOrder, TradingStopSpec } from './orders'
import type { Instrument } from '@gitrader/protocol'
import { symbolOf } from './parse'
import type { BybitHttp } from './rest'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

/** 撤单时「已不在场上」的码：110001 订单不存在 / 110008 订单已完成或已撤 / 110010 订单已撤（Bybit v5 码表）。 */
const GONE_CODES = new Set([110001, 110008, 110010])
const isGone = (p: Problem): boolean => GONE_CODES.has(Number(p.venue?.code))
/** 杠杆未变更（110043）：QD 把它当成功（bybit.py:996-1000）。 */
const isLeverageUnchanged = (p: Problem): boolean =>
  Number(p.venue?.code) === 110043 || /leverage not modified/i.test(p.venue?.message ?? '')
/** 保证金模式未变更（110026）：QD 把它当成功（bybit.py:1019-1023）。 */
const isModeUnchanged = (p: Problem): boolean =>
  Number(p.venue?.code) === 110026 || /not modified/i.test(p.venue?.message ?? '')

export interface TradingDeps {
  http: BybitHttp
  /** 本地标的记录（精度 + symbol）。 */
  instrumentOf: (instrumentId: string) => Instrument | undefined
  /** 最新报价（报价缓存；市价意图需要参考价）。 */
  quoteOf: (instrumentId: string) => { bid: number; ask: number; last?: number; stale: boolean } | undefined
  /** 挂单读取（由 account.ts 提供，避免两处解析）。 */
  openOrders: (ref: AccountRef, instrumentId?: InstrumentId) => Promise<VenueOpenOrder[]>
  /** 单张订单状态（由 account.ts 提供）。 */
  orderStatus: (ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }, opts?: { symbol?: string }) => Promise<VenueOrderStatus>
  clock?: () => number
  /** oneWay（缺省）/ hedge：决定 positionIdx 与 reduceOnly 的用法。 */
  positionMode?: 'oneWay' | 'hedge'
  /** 缺省标的（orderStatus 这类不强制的接口用）。 */
  defaultSymbol?: string
  accounts?: BybitAccounts
}

interface RawOrderResponse {
  orderId?: string
  orderLinkId?: string
  /** amend 的响应会带回被改后的下单参数（官方字段）。 */
  qty?: string
  price?: string
}

export interface LeverageState {
  instrumentId: string
  leverage: number
  /** account = 沿用账户当前保证金模式（意图没给 marginMode 时只设杠杆）。 */
  marginMode: 'cross' | 'isolated' | 'account'
}

export class BybitTrading {
  private readonly positionMode: 'oneWay' | 'hedge'
  readonly #secrets: readonly string[]
  /** 杠杆缓存：key = instrumentId，value = String(leverage)（保证金模式是账户级，不拼进键）。 */
  private readonly leverage = new Map<string, string>()
  /** 本实例最近一次成功设置的账户级保证金模式（未知 = undefined）。 */
  #accountMarginMode: 'cross' | 'isolated' | undefined = undefined

  /** secrets 单独传，不放进 this.d：JSON.stringify / inspect 看不到密钥。 */
  constructor(private readonly d: TradingDeps, secrets: readonly string[] = []) {
    this.positionMode = d.positionMode ?? 'oneWay'
    this.#secrets = secrets
  }

  private buildOptions(instrumentId: string): BuildOptions {
    const q = this.d.quoteOf(instrumentId)
    return {
      positionMode: this.positionMode,
      ...(q
        ? { ref: { bid: q.bid, ask: q.ask, ...(q.last !== undefined ? { last: q.last } : {}), mid: (q.bid + q.ask) / 2, stale: q.stale } }
        : {}),
    }
  }

  // ───────────── 下单 ─────────────

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const raws: unknown[] = []

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!
      const clientOrderId = intent.clientOrderId !== undefined ? String(intent.clientOrderId) : undefined

      // 本包 submit 不挂保护单：带 tpsl 的意图一律 1004（由内核成交后调 buildProtectionOrders / buildTradingStop）
      if (intent.tpsl !== undefined) {
        acks.push(this.rejectedAck(i, clientOrderId ?? sanitizeClientOrderId(`gt-tpsl-${i}`), makeProblem(
          'ORDER_TYPE_UNSUPPORTED',
          'this connector does not attach protective orders on submit; send the parent alone and call buildProtectionOrders() after the fill (or setTradingStop() for position-level TP/SL)',
        )))
        continue
      }

      let built: BuiltOrder
      try {
        built = buildOrderParams(intent, this.d.instrumentOf(intent.instrumentId), this.buildOptions(intent.instrumentId))
      } catch (e) {
        if (!(e instanceof OrderBuildError)) throw e
        acks.push(this.rejectedAck(i, clientOrderId ?? `gt-rejected-${i}`, e.problem))
        continue
      }

      if (intent.marginMode !== undefined && intent.reduceOnly !== true) {
        acks.push(this.rejectedAck(i, built.clientOrderId, makeProblem(
          'INVALID_PARAMS',
          'submit cannot change or confirm account margin mode; hint: 请在场所显式确认模式并省略 marginMode 以沿用账户现状',
        )))
        continue
      }

      // 杠杆 / 保证金模式是仓位级设置：给了就先设（失败则单张不发出）。
      // reduce-only 只是平仓，不做账户配置（QD tests:59-66）；没给 marginMode 时不切账户级保证金模式。
      if (intent.leverage !== undefined && intent.reduceOnly !== true) {
        const mode = intent.marginMode === undefined
          ? undefined
          : intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated' || intent.marginMode === 'noCross'
            ? 'isolated'
            : 'cross'
        const err = await this.ensureLeverage(intent.instrumentId, intent.leverage, mode)
        if (err !== null) {
          acks.push(this.rejectedAck(i, built.clientOrderId, err))
          continue
        }
      }

      try {
        const raw = await this.d.http.signed<RawOrderResponse>('POST', '/v5/order/create', {
          body: built.body,
        }, { order: true, kind: 'trade', ...(ctx.signal ? { signal: ctx.signal } : {}) })
        raws.push(raw ?? null)
        acks.push(this.ackFromOrder(i, built, raw))
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        raws.push({ error: problem.name })
        acks.push(this.problemAck(i, built.clientOrderId, problem))
      }
    }

    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: BYBIT_WEIGHTS.order * intents.length }
  }

  /**
   * 建单响应只有 orderId / orderLinkId（没有成交回报）：
   *   · 拿不到 orderId → 3006 结果未知（`{}` / `{result:{}}` 不是「单已挂上」的证据，也不能据此报 rejected）；
   *   · 触发单（StopOrder）→ 'untriggered'；
   *   · 其余 → 'open'（IOC 也可能立刻成交，成交量由 execution/list 或私有流补上）。
   */
  private ackFromOrder(index: number, built: BuiltOrder, raw: RawOrderResponse | undefined): OrderAck {
    const trigger = built.body.triggerPrice !== undefined
    const clientOrderId = typeof raw?.orderLinkId === 'string' && raw.orderLinkId !== '' ? raw.orderLinkId : built.clientOrderId
    const venueOrderId = raw?.orderId !== undefined && raw.orderId !== null && String(raw.orderId) !== '' ? String(raw.orderId) : null
    if (venueOrderId === null) {
      // 钱路红线：请求已发出、场所回 200，但没有订单号 → 不许宣告 open/untriggered（内核会以为单已进场）。
      // 也不许报 rejected（那会让内核重发）——只能 3006，按 clientOrderId（Bybit 的 orderLinkId）对账。
      return this.problemAck(index, clientOrderId, makeProblem(
        'VENUE_OUTCOME_UNKNOWN',
        'bybit accepted the order request but returned no orderId; query by clientOrderId (orderLinkId) before retrying',
        { venue: { id: 'bybit', message: redactSecret(raw === undefined ? 'empty response body' : JSON.stringify(raw, jsonSafe), this.#secrets).slice(0, 200) } },
      ))
    }
    return {
      intentIndex: index,
      clientOrderId,
      venueOrderId,
      status: trigger ? 'untriggered' : 'open',
      filledSize: asDecimal('0'),
      avgFillPrice: null,
      builder: { attached: false },
    }
  }

  private rejectedAck(index: number, clientOrderId: string, problem: Problem): OrderAck {
    return {
      intentIndex: index,
      clientOrderId,
      venueOrderId: null,
      status: 'rejected',
      filledSize: asDecimal('0'),
      avgFillPrice: null,
      builder: { attached: false },
      problem,
    }
  }

  private problemAck(index: number, clientOrderId: string, problem: Problem): OrderAck {
    return {
      intentIndex: index,
      clientOrderId,
      venueOrderId: null,
      // 3006 = 结果未知：不能报 rejected（那会让内核以为单没出），必须让它去对账。
      status: problem.code === 3006 ? 'unknown' : 'rejected',
      filledSize: asDecimal('0'),
      avgFillPrice: null,
      builder: { attached: false },
      problem,
    }
  }

  // ───────────── 撤单 ─────────────

  /** 撤单：POST /v5/order/cancel（body: category / symbol / orderId 或 orderLinkId）。 */
  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = []
    for (const target of targets) {
      let symbol: string
      try {
        symbol = symbolOf(target.instrumentId)
      } catch (e) {
        out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) })
        continue
      }
      const body: Record<string, unknown> = { category: 'linear', symbol }
      if (target.venueOrderId !== undefined) body.orderId = String(target.venueOrderId)
      else if (target.clientOrderId !== undefined) body.orderLinkId = String(target.clientOrderId)
      else {
        out.push({ target, ok: false, problem: makeProblem('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId') })
        continue
      }
      try {
        await this.d.http.signed<RawOrderResponse>('POST', '/v5/order/cancel', { body }, {
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        out.push({ target, ok: true })
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        // 已经不在场上了（110001 / 110008 / 110010）：撤单目的已达成，按 ok 回报并保留上游原文。
        if (isGone(problem)) out.push({ target, ok: true })
        else out.push({ target, ok: false, problem })
      }
    }
    return out
  }

  /**
   * 全撤：POST /v5/order/cancel-all。
   *   给 instrumentId → { category, symbol }；不给 → { category, settleCoin }（USDT 线性全撤）。
   */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    if (instrumentId !== undefined) {
      let symbol: string
      try {
        symbol = symbolOf(instrumentId)
      } catch (e) {
        return [{ target: { instrumentId }, ok: false, problem: asProblem(e, { secrets: this.#secrets }) }]
      }
      return [await this.cancelAllFor({ instrumentId }, { category: 'linear', symbol }, ctx)]
    }
    // 没有 instrumentId：按结算币一次全撤（一条 ack，target 用 USDT 线性永续的 settleCoin 口径占位）。
    const target: CancelTarget = { instrumentId: `bybit:USDT` }
    return [await this.cancelAllFor(target, { category: 'linear', settleCoin: 'USDT' }, ctx)]
  }

  private async cancelAllFor(target: CancelTarget, body: Record<string, unknown>, ctx: TradeContext): Promise<CancelAck> {
    try {
      const raw = await this.d.http.signed<{ success?: string }>('POST', '/v5/order/cancel-all', { body }, {
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      if (raw?.success === '0') {
        return {
          target,
          ok: false,
          problem: makeProblem('VENUE_REJECTED', 'bybit cancel-all reported success=0', {
            venue: { id: 'bybit', message: JSON.stringify(raw) },
          }),
        }
      }
      return { target, ok: true }
    } catch (e) {
      return { target, ok: false, problem: asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }) }
    }
  }

  // ───────────── 改单 ─────────────

  /**
   * 改单：POST /v5/order/amend（qty / price / triggerPrice）。
   * Bybit 原生只改 Limit 系（含 StopOrder 的限价触发单）；market / 触发市价 / 追踪 → 1004，由内核撤旧挂新。
   */
  async amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    const fallbackClientOrderId = (built?: BuiltOrder): string =>
      String(req.clientOrderId ?? req.order.clientOrderId ?? built?.clientOrderId ?? '')
    if (req.order.type !== 'limit' && req.order.type !== 'stop_limit' && req.order.type !== 'take_limit') {
      const problem = makeProblem(
        'ORDER_TYPE_UNSUPPORTED',
        `Bybit only amends limit orders natively; ${req.order.type} must be canceled and re-submitted`,
      )
      return { acks: [this.rejectedAck(0, fallbackClientOrderId(), problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
    }
    if (req.venueOrderId === undefined && req.clientOrderId === undefined) {
      const problem = makeProblem('INVALID_PARAMS', 'amend needs venueOrderId or clientOrderId')
      return { acks: [this.rejectedAck(0, fallbackClientOrderId(), problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
    }
    let built: BuiltOrder
    try {
      built = buildOrderParams({ ...req.order, type: req.order.type }, this.d.instrumentOf(req.instrumentId), {
        positionMode: this.positionMode,
      })
    } catch (e) {
      if (!(e instanceof OrderBuildError)) throw e
      return {
        acks: [this.rejectedAck(0, fallbackClientOrderId(), e.problem)],
        receiptHash: sha256(e.problem.message),
        requestWeight: 0,
      }
    }
    // 官方只接受这几个字段：category / symbol / orderId|orderLinkId / qty / price / triggerPrice。
    // 不发 side / orderType / timeInForce / positionIdx（会 10001 / 110015）。
    const body: Record<string, unknown> = { category: 'linear', symbol: built.body.symbol }
    if (req.venueOrderId !== undefined) body.orderId = String(req.venueOrderId)
    else body.orderLinkId = String(req.clientOrderId)
    if (built.body.qty !== undefined) body.qty = built.body.qty
    if (built.body.price !== undefined) body.price = built.body.price
    if (built.body.triggerPrice !== undefined) body.triggerPrice = built.body.triggerPrice
    try {
      const raw = await this.d.http.signed<RawOrderResponse>('POST', '/v5/order/amend', { body }, {
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      const ack: OrderAck = {
        intentIndex: 0,
        clientOrderId: typeof raw?.orderLinkId === 'string' && raw.orderLinkId !== '' ? raw.orderLinkId : built.clientOrderId,
        venueOrderId: raw?.orderId !== undefined && raw.orderId !== '' ? String(raw.orderId) : (req.venueOrderId ?? null),
        status: 'open',
        filledSize: asDecimal('0'),
        avgFillPrice: null,
        builder: { attached: false },
      }
      return { acks: [ack], receiptHash: sha256(JSON.stringify(raw ?? null, jsonSafe)), requestWeight: BYBIT_WEIGHTS.order }
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      return {
        acks: [this.problemAck(0, fallbackClientOrderId(built), problem)],
        receiptHash: sha256(problem.venue?.message ?? problem.message),
        requestWeight: BYBIT_WEIGHTS.order,
      }
    }
  }

  // ───────────── 查询 ─────────────

  openOrders(ref: AccountRef, instrumentId?: InstrumentId): Promise<VenueOpenOrder[]> {
    return this.d.openOrders(ref, instrumentId)
  }

  status(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }, opts: { symbol?: string } = {}): Promise<VenueOrderStatus> {
    return this.d.orderStatus(ref, key, opts)
  }

  // ───────────── 杠杆 / 保证金模式 ─────────────

  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    const err = await this.ensureLeverage(instrumentId, leverage, marginMode, ctx.signal)
    if (err !== null) throw new ProblemError(err)
  }

  /** 只在变化时发请求；marginMode 有值才先切模式。返回 null = 成功，否则返回 Problem（供 submit 把单张打回）。 */
  private async ensureLeverage(
    instrumentId: string,
    leverage: number,
    marginMode: 'cross' | 'isolated' | undefined,
    signal?: AbortSignal,
  ): Promise<Problem | null> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 100) {
      return makeProblem('INVALID_PARAMS', 'leverage must be an integer from 1 to 100')
    }
    const key = String(leverage)
    // 杠杆命中缓存也要账户模式对得上：同标的同杠杆、但这次要求另一种保证金模式时必须重切。
    if (this.leverage.get(instrumentId) === key && (marginMode === undefined || marginMode === this.#accountMarginMode)) return null
    let symbol: string
    try {
      symbol = symbolOf(instrumentId)
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets })
    }
    // 显式给了 marginMode 才先切模式（账户级设置，持仓时会被 110024 / 110025 挡下），再设杠杆。
    // 保证金模式是账户级：只有与本实例最近一次成功设置的模式不同才发请求；
    // 真的从一种模式切到另一种时清空杠杆缓存（旧的杠杆档位在新模式下不再作数）。
    if (marginMode !== undefined && marginMode !== this.#accountMarginMode) {
      const modeProblem = await this.setMarginMode(marginMode, signal)
      if (modeProblem !== null) return modeProblem
      if (this.#accountMarginMode !== undefined) this.leverage.clear()
      this.#accountMarginMode = marginMode
    }
    try {
      await this.d.http.signed<unknown>('POST', '/v5/position/set-leverage', {
        body: { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) },
      }, { kind: 'trade', weight: BYBIT_WEIGHTS.setLeverage, ...(signal ? { signal } : {}) })
      this.leverage.set(instrumentId, key)
      return null
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      // 110043 = leverage not modified：目标值已经是这个杠杆，算成功。
      if (isLeverageUnchanged(problem)) {
        this.leverage.set(instrumentId, key)
        return null
      }
      return problem
    }
  }

  /** 保证金模式：POST /v5/account/set-margin-mode；110026（未变更）视为成功。 */
  private async setMarginMode(marginMode: 'cross' | 'isolated', signal?: AbortSignal): Promise<Problem | null> {
    try {
      await this.d.http.signed<unknown>('POST', '/v5/account/set-margin-mode', {
        body: { setMarginMode: marginMode === 'isolated' ? 'ISOLATED_MARGIN' : 'REGULAR_MARGIN' },
      }, { kind: 'trade', weight: BYBIT_WEIGHTS.setMarginMode, ...(signal ? { signal } : {}) })
      return null
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      if (isModeUnchanged(problem)) return null
      return problem
    }
  }

  // ───────────── 持仓级 TP / SL / 追踪 ─────────────

  /** POST /v5/position/trading-stop（tpslMode 缺省 Full）。仓位级设置，会覆盖该槽位已有 TP/SL。 */
  async setTradingStop(ctx: TradeContext, spec: TradingStopSpec): Promise<void> {
    if (this.positionMode === 'hedge' && spec.positionIdx === undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'hedge mode needs positionIdx (1 = long, 2 = short) for trading-stop'))
    }
    let body: Record<string, unknown>
    try {
      body = buildTradingStop(spec)
    } catch (e) {
      if (e instanceof OrderBuildError) throw e
      throw new ProblemError(asProblem(e, { secrets: this.#secrets }))
    }
    try {
      await this.d.http.signed<unknown>('POST', '/v5/position/trading-stop', { body }, {
        kind: 'trade',
        weight: BYBIT_WEIGHTS.tradingStop,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }))
    }
  }

  /** 已设置的杠杆（诊断）。 */
  leverageState(): LeverageState[] {
    const marginMode = this.#accountMarginMode ?? 'account'
    return [...this.leverage.entries()].map(([instrumentId, value]) => ({
      instrumentId,
      leverage: Number(value),
      marginMode,
    }))
  }

  // ───────────── 场所级定时撤单 ─────────────

  /** Bybit v5 没有场所级定时撤单（deadman）：本包不伪装，直接 5002。 */
  async scheduleCancel(_ctx: TradeContext, _atMs: number | null): Promise<void> {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Bybit v5 has no venue-side scheduled cancel; keep the cancel loop in the kernel'))
  }

  /** 诊断：预算占用（含下单计数桶）。 */
  budgetUsage(): ReturnType<BybitHttp['usage']> {
    return this.d.http.usage()
  }

  /** 诊断：已登记的默认标的。 */
  defaultSymbol(): string | undefined {
    return this.d.defaultSymbol
  }

  /** 诊断：本连接器的持仓模式。 */
  mode(): 'oneWay' | 'hedge' {
    return this.positionMode
  }

  /** 诊断：小数位数（Decimal 只是字符串别名，这里只是给测试一个稳定的换算口）。 */
  static qtyOf(size: Decimal): string {
    return String(size)
  }
}
