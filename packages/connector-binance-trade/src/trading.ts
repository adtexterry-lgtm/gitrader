// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 撤单 / 全撤 / 改单 / 杠杆 / 保证金模式。连接器自己不会主动下单——所有方法都在内核发起的
// TradeContext 窗口里执行（契约 §3.6）。
//   · 签名是 HMAC（apiKey / apiSecret 从构造参数进），不是签名器句柄：ctx.signer 在 Binance 上没有对应物，
//     本模块**不使用**它，也不回调 ctx.onSigned（没有载荷摘要可写账本；README 里写明）。
//   · 触发类（STOP_MARKET / TAKE_PROFIT_MARKET / STOP / TAKE_PROFIT / TRAILING_STOP_MARKET）走
//     POST /fapi/v1/algoOrder（algoType=CONDITIONAL）；撤 / 查 / 挂单走 algo 端点。
//   · tpsl：币安没有原生父子单，submit 对带 tpsl 的意图返回 1004，成交后补挂走 orders.buildProtectionOrders()（也是 algo 形状）。
//   · amend：只有 LIMIT 走原生 PUT /fapi/v1/order；其它类型 1004。
//   · scheduleCancel：Binance 有 countdownCancelAll（按 symbol），本包未接入内核死人开关 → CAPABILITY_UNSUPPORTED（5002）。
//   · 回执 receiptHash = sha256(原始响应数组的 JSON)；requestWeight 按 Binance 口径（下单请求权重 0）。
import { createHash } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import type { InstrumentId, OrderIntent, Problem } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, OrderAck, SubmitResult, TradeContext, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { BINANCE_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import { buildOrderParams, OrderBuildError, sanitizeClientOrderId } from './orders'
import type { BuiltOrderParams } from './orders'
import { mapOrderStatus, decimalOf, symbolOf } from './parse'
import type { BinanceMarket } from './market'
import type { BinanceHttp } from './rest'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

const venueText = (p: Problem): string => `${p.venue?.code ?? ''} ${p.venue?.message ?? ''}`
/** 撤单退回 algo 的判定：-2011（未知订单）/ -2013（不存在）。 */
const isUnknownOrder = (p: Problem): boolean => /-2011(?!\d)|-2013(?!\d)|unknown order|order does not exist/i.test(venueText(p))
/** 端点不存在（官方若没有 algoOpenOrders）：404 / 未处理路径。 */
const isMissingEndpoint = (p: Problem): boolean => /(^|\D)404(\D|$)|unhandled|not found/i.test(venueText(p))

export interface TradingDeps {
  http: BinanceHttp
  market: BinanceMarket
  clock?: () => number
  /** oneWay（缺省）/ hedge：决定 positionSide 与 reduceOnly 的用法。 */
  positionMode?: 'oneWay' | 'hedge'
  /** 挂单读取（由 account.ts 提供，避免两处解析）。 */
  marginMode: (ref: AccountRef, instrumentId: InstrumentId) => Promise<'cross' | 'isolated' | undefined>
  openOrders: (ref: AccountRef, instrumentId?: InstrumentId) => Promise<VenueOpenOrder[]>
  /** 单张订单状态（由 account.ts 提供）。 */
  orderStatus: (ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }, opts?: { symbol?: string; algo?: boolean }) => Promise<VenueOrderStatus>
  /** 缺省标的（orderStatus / userTrades 这类强制要 symbol 的接口）。 */
  defaultSymbol?: string
  /** 市价参考报价最大年龄，缺省 5000 ms。 */
  refPriceMaxAgeMs?: number
}

interface RawOrderResponse {
  orderId?: number
  clientOrderId?: string
  status?: string
  executedQty?: string
  avgPrice?: string
  cumQuote?: string
  type?: string
  updateTime?: number
  price?: string
  origQty?: string
  // algo 单响应（POST /fapi/v1/algoOrder）用这些字段
  algoId?: number
  clientAlgoId?: string
  algoStatus?: string
  orderType?: string
  quantity?: string
  triggerPrice?: string
}

export interface LeverageState {
  instrumentId: string
  leverage: number
  marginMode: 'cross' | 'isolated' | 'account'
}

export class BinanceTrading {
  private readonly positionMode: 'oneWay' | 'hedge'
  readonly #secrets: readonly string[]
  private readonly leverage = new Map<string, string>()

  /** secrets 单独传，不放进 this.d：JSON.stringify / inspect 看不到密钥。 */
  constructor(private readonly d: TradingDeps, secrets: readonly string[] = []) {
    this.positionMode = d.positionMode ?? 'oneWay'
    this.#secrets = secrets
  }

  // ───────────── 下单 ─────────────

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const raws: unknown[] = []
    let weight = 0

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!
      const clientOrderId = intent.clientOrderId !== undefined ? String(intent.clientOrderId) : undefined

      // 币安没有原生父子单：带 tpsl 的意图一律 1004（由内核在成交后调 buildProtectionOrders）
      if (intent.tpsl !== undefined) {
        acks.push(this.rejectedAck(i, clientOrderId ?? sanitizeClientOrderId(`gt${i}`), makeProblem(
          'ORDER_TYPE_UNSUPPORTED',
          'Binance has no native parent-child orders; submit the parent alone and call buildProtectionOrders() after the fill',
        )))
        continue
      }

      let built: BuiltOrderParams
      try {
        const cached = this.d.market.quoteCached(intent.instrumentId)
        built = buildOrderParams(intent, this.d.market.getRecord(intent.instrumentId), {
          positionMode: this.positionMode,
          ...(this.d.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: this.d.refPriceMaxAgeMs } : {}),
          ...(cached
            ? { ref: { bid: cached.bid, ask: cached.ask, mid: (cached.bid + cached.ask) / 2, stale: cached.stale, ageMs: cached.ageMs } }
            : {}),
        })
      } catch (e) {
        if (!(e instanceof OrderBuildError)) throw e
        acks.push(this.rejectedAck(i, clientOrderId ?? `gt-rejected-${i}`, e.problem))
        continue
      }

      const explicitMode = intent.marginMode === undefined ? undefined
        : intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated' || intent.marginMode === 'noCross'
          ? 'isolated'
          : 'cross'
      let leverageMode: 'cross' | 'isolated' | 'account' = explicitMode ?? 'account'
      if (explicitMode !== undefined && intent.reduceOnly !== true) {
        let currentMode: 'cross' | 'isolated' | undefined
        try {
          currentMode = await this.d.marginMode(ctx.account, intent.instrumentId)
        } catch (e) {
          acks.push(this.rejectedAck(i, built.clientOrderId, asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })))
          continue
        }
        if (currentMode === undefined || currentMode !== explicitMode) {
          acks.push(this.rejectedAck(i, built.clientOrderId, makeProblem(
            'INVALID_PARAMS',
            'requested margin mode is unknown or differs from the current venue setting; hint: 请在场所显式确认保证金模式；订单不会切换模式',
          )))
          continue
        }
      }

      // 下单仅设置标的杠杆；模式只可由显式 setter 修改。
      if (intent.leverage !== undefined) {
        const err = await this.ensureLeverage(intent.instrumentId, intent.leverage, leverageMode, ctx.signal, false)
        if (err !== null) {
          acks.push(this.rejectedAck(i, built.clientOrderId, err))
          continue
        }
      }

      try {
        const path = built.endpoint === 'algo' ? '/fapi/v1/algoOrder' : '/fapi/v1/order'
        const raw = await this.d.http.signed<RawOrderResponse>('POST', path, built.params, {
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        raws.push(raw ?? null)
        acks.push(this.ackFromOrder(i, built, raw))
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        raws.push({ error: problem.name })
        acks.push(this.problemAck(i, built.clientOrderId, problem))
      }
    }

    weight += BINANCE_WEIGHTS.order * intents.length
    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: weight }
  }

  private ackFromOrder(index: number, built: BuiltOrderParams, raw: RawOrderResponse | undefined): OrderAck {
    const isAlgo = built.endpoint === 'algo'
    const rawStatus = (isAlgo ? raw?.algoStatus : raw?.status) ?? raw?.status ?? ''
    const status = mapOrderStatus(rawStatus)
    const filledSize = decimalOf(raw?.executedQty ?? '0')
    const rawAvg = raw?.avgPrice
    const avgPrice = rawAvg !== undefined && Number(rawAvg) > 0 ? decimalOf(rawAvg) : null
    const venueOrderId = isAlgo ? raw?.algoId : raw?.orderId
    const clientOrderId = (isAlgo ? raw?.clientAlgoId : raw?.clientOrderId) ?? raw?.clientOrderId ?? raw?.clientAlgoId
    const base: OrderAck = {
      intentIndex: index,
      clientOrderId: clientOrderId !== undefined && clientOrderId !== '' ? clientOrderId : built.clientOrderId,
      venueOrderId: venueOrderId !== undefined ? String(venueOrderId) : null,
      filledSize,
      avgFillPrice: avgPrice,
      builder: { attached: false },
      status: 'unknown',
    }
    if (status === null) {
      return {
        ...base,
        status: 'unknown',
        problem: makeProblem('VENUE_OUTCOME_UNKNOWN',
          'unrecognized submit status; check clientOrderId before deciding whether to retry', {
          retryable: false,
          venue: { id: 'binance', message: String(rawStatus) },
        }),
      }
    }
    const origQty = raw?.origQty ?? raw?.quantity
    const cumulative = origQty !== undefined ? decimalOf(origQty) : undefined
    const fullyFilled = cumulative !== undefined && cumulative === filledSize && filledSize !== '0'
    switch (status) {
      case 'filled': return { ...base, status: 'filled' }
      case 'partially_filled': return { ...base, status: 'open' }
      case 'open':
        // algo 单 NEW / TRIGGERING 还没触发；TRIGGERED 已在场上工作。
        return {
          ...base,
          status: isAlgo && (rawStatus === 'NEW' || rawStatus === 'TRIGGERING' || rawStatus === '') ? 'untriggered' : 'open',
        }
      case 'cancelled':
        if (filledSize !== '0') return { ...base, status: fullyFilled ? 'filled' : 'open' }
        return {
          ...base,
          status: 'rejected',
          problem: makeProblem('VENUE_REJECTED', 'venue reported the order as canceled in the submit response', {
            venue: { id: 'binance', message: String(rawStatus) },
          }),
        }
      case 'expired':
        // 有成交的 EXPIRED / CANCELED 不是拒单：成了就 filled，部分成就是 open（部分成交）。
        if (filledSize !== '0') return { ...base, status: fullyFilled ? 'filled' : 'open' }
        return {
          ...base,
          status: 'rejected',
          problem: makeProblem('VENUE_REJECTED', 'venue reported the order as expired in the submit response', {
            venue: { id: 'binance', message: String(rawStatus) },
          }),
        }
      default:
        return {
          ...base,
          status: 'rejected',
          problem: makeProblem('VENUE_REJECTED', `venue rejected the order (${status})`, {
            venue: { id: 'binance', message: String(rawStatus) },
          }),
        }
    }
  }

  private rejectedAck(index: number, clientOrderId: string, problem: Problem): OrderAck {
    return {
      intentIndex: index,
      clientOrderId,
      venueOrderId: null,
      status: 'rejected',
      filledSize: decimalOf('0'),
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
      status: problem.code === 3006 ? 'unknown' : 'rejected',
      filledSize: decimalOf('0'),
      avgFillPrice: null,
      builder: { attached: false },
      problem,
    }
  }

  // ───────────── 撤单 ─────────────

  /**
   * 撤单：先 DELETE /fapi/v1/order；上游报「未知订单」（-2011 / -2013）时再试
   * DELETE /fapi/v1/algoOrder（algoId / clientAlgoId），覆盖触发单与保护单。
   */
  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = []
    for (const target of targets) {
      const params: Record<string, string | number | undefined> = {}
      try {
        params.symbol = symbolOf(target.instrumentId)
      } catch (e) {
        out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) })
        continue
      }
      if (target.venueOrderId !== undefined) params.orderId = target.venueOrderId
      else if (target.clientOrderId !== undefined) params.origClientOrderId = String(target.clientOrderId)
      else {
        out.push({
          target,
          ok: false,
          problem: makeProblem('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId'),
        })
        continue
      }
      try {
        await this.d.http.signed<RawOrderResponse>('DELETE', '/fapi/v1/order', params, {
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        out.push({ target, ok: true })
        continue
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        if (!isUnknownOrder(problem)) {
          out.push({ target, ok: false, problem })
          continue
        }
        const algoParams: Record<string, string | number | undefined> = {}
        if (target.venueOrderId !== undefined) algoParams.algoId = target.venueOrderId
        else algoParams.clientAlgoId = String(target.clientOrderId)
        try {
          await this.d.http.signed<RawOrderResponse>('DELETE', '/fapi/v1/algoOrder', algoParams, {
            order: true,
            kind: 'trade',
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          })
          out.push({ target, ok: true })
        } catch {
          // 两边都不认：原错误更有信息量（普通订单的真实拒因）。
          out.push({ target, ok: false, problem })
        }
      }
    }
    return out
  }

  /**
   * 全撤：给 instrumentId → DELETE /fapi/v1/allOpenOrders + DELETE /fapi/v1/algoOpenOrders；
   * 不给 → 先读全量挂单，再按 symbol 逐个撤（每个 symbol 一条 ack）。
   */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    if (instrumentId !== undefined) {
      return [await this.cancelAllFor(instrumentId, ctx)]
    }
    const open = await this.d.openOrders(ctx.account)
    const symbols = [...new Set(open.map((o) => o.instrumentId))]
    const out: CancelAck[] = []
    for (const id of symbols) out.push(await this.cancelAllFor(id, ctx))
    return out
  }

  private async cancelAllFor(instrumentId: string, ctx: TradeContext): Promise<CancelAck> {
    const target: CancelTarget = { instrumentId }
    let symbol: string
    try {
      symbol = symbolOf(instrumentId)
    } catch (e) {
      return { target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) }
    }
    const opts = { order: true, kind: 'trade' as const, ...(ctx.signal ? { signal: ctx.signal } : {}) }
    try {
      await this.d.http.signed<unknown>('DELETE', '/fapi/v1/allOpenOrders', { symbol }, opts)
    } catch (e) {
      return { target, ok: false, problem: asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }) }
    }
    try {
      await this.d.http.signed<unknown>('DELETE', '/fapi/v1/algoOpenOrders', { symbol }, {
        ...opts,
        weight: BINANCE_WEIGHTS.algoOpenOrders,
      })
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      // 官方若没有 algoOpenOrders（404）：退回逐单撤 algo 单。
      if (!isMissingEndpoint(problem)) return { target, ok: false, problem }
      try {
        await this.cancelAllAlgoIndividually(symbol, ctx)
      } catch (fallbackErr) {
        return { target, ok: false, problem: asProblem(fallbackErr, { secrets: this.#secrets, endpoint: 'signed' }) }
      }
    }
    return { target, ok: true }
  }

  /** 逐单撤：GET /fapi/v1/openAlgoOrders → DELETE /fapi/v1/algoOrder（algoOpenOrders 不可用时）。 */
  private async cancelAllAlgoIndividually(symbol: string, ctx: TradeContext): Promise<void> {
    const rows = await this.d.http.signed<Array<{ algoId?: number; clientAlgoId?: string }>>('GET', '/fapi/v1/openAlgoOrders', { symbol }, {
      kind: 'query',
      weight: BINANCE_WEIGHTS.openAlgoOrders,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      const params: Record<string, string | number | undefined> = {}
      if (row?.algoId !== undefined) params.algoId = row.algoId
      else if (row?.clientAlgoId !== undefined) params.clientAlgoId = row.clientAlgoId
      else continue
      await this.d.http.signed<unknown>('DELETE', '/fapi/v1/algoOrder', params, {
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    }
  }

  // ───────────── 改单 ─────────────

  /**
   * 改单：只有 LIMIT 有原生 PUT /fapi/v1/order（改价 / 改量）。
   * 其它类型（含触发单、追踪单）→ 1004，由内核撤旧挂新。
   */
  async amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    if (req.order.type !== 'limit') {
      const problem = makeProblem(
        'ORDER_TYPE_UNSUPPORTED',
        `Binance only amends LIMIT orders natively; ${req.order.type} must be canceled and re-submitted`,
      )
      return { acks: [this.rejectedAck(0, String(req.clientOrderId ?? req.order.clientOrderId ?? ''), problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
    }
    if (req.venueOrderId === undefined && req.clientOrderId === undefined) {
      const problem = makeProblem('INVALID_PARAMS', 'amend needs venueOrderId or clientOrderId')
      return { acks: [this.rejectedAck(0, '', problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
    }
    let built: BuiltOrderParams
    try {
      built = buildOrderParams({ ...req.order, type: 'limit' }, this.d.market.getRecord(req.instrumentId), { positionMode: this.positionMode })
    } catch (e) {
      if (!(e instanceof OrderBuildError)) throw e
      return {
        acks: [this.rejectedAck(0, String(req.clientOrderId ?? req.order.clientOrderId ?? ''), e.problem)],
        receiptHash: sha256(e.problem.message),
        requestWeight: 0,
      }
    }
    // 官方只允许改这几个字段：symbol / orderId 或 origClientOrderId / side / quantity / price。
    // 不发 timeInForce / positionSide（会 -1106 / -1107）。
    const params: Record<string, string | number | undefined> = {
      symbol: built.params.symbol,
      side: built.params.side,
      quantity: built.params.quantity,
      price: built.params.price,
    }
    if (req.venueOrderId !== undefined) params.orderId = req.venueOrderId
    else params.origClientOrderId = String(req.clientOrderId)
    try {
      const raw = await this.d.http.signed<RawOrderResponse>('PUT', '/fapi/v1/order', params, {
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      const ack = this.ackFromAmend(req, built, raw)
      return { acks: [ack], receiptHash: sha256(JSON.stringify(raw ?? null, jsonSafe)), requestWeight: BINANCE_WEIGHTS.order }
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      return {
        acks: [this.problemAck(0, built.clientOrderId, problem)],
        receiptHash: sha256(problem.venue?.message ?? problem.message),
        requestWeight: BINANCE_WEIGHTS.order,
      }
    }
  }

  /** 改单回执：status 按上游返回映射（不写死 open），成交量原样带回。 */
  private ackFromAmend(req: AmendRequest, built: BuiltOrderParams, raw: RawOrderResponse | undefined): OrderAck {
    const mapped = mapOrderStatus(raw?.status)
    const filledSize = decimalOf(raw?.executedQty ?? '0')
    let status: OrderAck['status'] = 'unknown'
    if (mapped === 'filled') status = 'filled'
    else if (mapped === 'partially_filled' || mapped === 'open') status = 'open'
    else if (mapped === 'cancelled' || mapped === 'expired') status = filledSize !== '0' ? 'open' : 'rejected'
    else if (mapped === 'rejected') status = 'rejected'
    return {
      intentIndex: 0,
      clientOrderId: raw?.clientOrderId !== undefined && raw.clientOrderId !== '' ? raw.clientOrderId : built.clientOrderId,
      venueOrderId: raw?.orderId !== undefined ? String(raw.orderId) : (req.venueOrderId ?? null),
      status,
      filledSize,
      avgFillPrice: raw?.avgPrice !== undefined && Number(raw.avgPrice) > 0 ? decimalOf(raw.avgPrice) : null,
      builder: { attached: false },
      ...(mapped === null
        ? { problem: makeProblem('VENUE_REJECTED', 'unrecognized order status from venue', { venue: { id: 'binance', message: String(raw?.status ?? '') } }) }
        : {}),
    }
  }

  // ───────────── 查询 ─────────────

  openOrders(ref: AccountRef, instrumentId?: InstrumentId): Promise<VenueOpenOrder[]> {
    return this.d.openOrders(ref, instrumentId)
  }

  status(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }, opts: { symbol?: string; algo?: boolean } = {}): Promise<VenueOrderStatus> {
    return this.d.orderStatus(ref, key, opts)
  }

  // ───────────── 杠杆 / 保证金模式 ─────────────

  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    const err = await this.ensureLeverage(instrumentId, leverage, marginMode, ctx.signal, true)
    if (err !== null) throw new ProblemError(err)
  }

  /** 只在变化时发请求；返回 null = 成功，否则返回 Problem（供 submit 把单张打回）。 */
  private async ensureLeverage(
    instrumentId: string,
    leverage: number,
    marginMode: 'cross' | 'isolated' | 'account',
    signal?: AbortSignal,
    allowMarginChange = false,
  ): Promise<Problem | null> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      return makeProblem('INVALID_PARAMS', 'leverage must be an integer from 1 to 125')
    }
    const key = `${marginMode}|${leverage}`
    if (this.leverage.get(instrumentId) === key) return null
    let symbol: string
    try {
      symbol = symbolOf(instrumentId)
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets })
    }
    try {
      await this.d.http.signed<unknown>('POST', '/fapi/v1/leverage', { symbol, leverage }, {
        kind: 'trade',
        weight: BINANCE_WEIGHTS.leverage,
        ...(signal ? { signal } : {}),
      })
      if (allowMarginChange && marginMode !== 'account') await this.setMarginType(symbol, marginMode, signal)
      this.leverage.set(instrumentId, key)
      return null
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
    }
  }

  /** 保证金模式：-4046（无需修改）视为成功；-4048（有持仓不能改）原样报错。 */
  private async setMarginType(symbol: string, marginMode: 'cross' | 'isolated', signal?: AbortSignal): Promise<void> {
    try {
      await this.d.http.signed<unknown>('POST', '/fapi/v1/marginType', {
        symbol,
        marginType: marginMode === 'isolated' ? 'ISOLATED' : 'CROSSED',
      }, { kind: 'trade', weight: BINANCE_WEIGHTS.marginType, ...(signal ? { signal } : {}) })
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      const text = problem.venue?.message ?? problem.message
      if (problem.venue?.code === -4046 || text.includes('-4046')) return
      throw new ProblemError(problem)
    }
  }

  /** 已设置的杠杆（诊断）。 */
  leverageState(): LeverageState[] {
    return [...this.leverage.entries()].map(([instrumentId, value]) => {
      const [mode, lev] = value.split('|')
      return { instrumentId, leverage: Number(lev), marginMode: mode === 'account' ? 'account' : mode === 'isolated' ? 'isolated' : 'cross' }
    })
  }

  // ───────────── 场所级死人开关 ─────────────

  /** 场所级死人开关：Binance 有 countdownCancelAll（按 symbol），本包**未接入**内核死人开关。 */
  async scheduleCancel(_ctx: TradeContext, _atMs: number | null): Promise<void> {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Binance exposes countdownCancelAll per symbol, but this connector does not wire it into the kernel deadman; keep the cancel loop in the kernel'))
  }

  /** 诊断：预算占用（含下单计数桶）。 */
  budgetUsage(): ReturnType<BinanceHttp['usage']> {
    return this.d.http.usage()
  }
}
