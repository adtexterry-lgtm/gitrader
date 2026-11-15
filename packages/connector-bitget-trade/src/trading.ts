// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 撤单 / 全撤 / 改单 / 杠杆 / 位置级保护单。连接器自己不会主动下单——所有方法都在内核发起的
// TradeContext 窗口里执行（契约 §3.6）。
//   · 签名是 HMAC（apiKey / apiSecret / passphrase 从构造参数进），没有签名器句柄：ctx.signer 在 Bitget 上无对应物，
//     本模块**不使用**它，也不回调 ctx.onSigned（没有载荷摘要可写账本；README 写明）。
//   · 普通委托 → POST /api/v2/mix/order/place-order；触发 / 追踪 → POST /api/v2/mix/order/place-plan-order
//     （QD bitget.py:41-50 的下单端点表）。
//   · 撤单 → POST /api/v2/mix/order/cancel-order（QD :905-917）；上游说订单不存在时改打 cancel-plan-order。
//   · 全撤 = 按标的模拟：orders-pending + cancel-order 逐张，计划单 orders-plan-pending（三族）+ cancel-plan-order 逐张；
//     不用 cancel-all-orders（官方该端点按 productType 撤全部标的，且 failureList 被忽略；QD 也未调用）。
//   · 改单一律 1004，不发请求：modify-order 是撤旧挂新、换新 orderId / clientOid，而内核改单按原
//     clientOrderId 追踪并查单，新单的成交与撤单都接不上 → 做不到就声明 none 并回 1004（教训 9）。
//   · 40774（对冲 / 单向持仓不匹配）按 QD bitget.py:294-310 换一套持仓字段重试一次。
//   · 「结果未知」（非 GET 的 408 / 5xx / 断连 / 上游未知执行码）一律 3006 且不重发，ack.status='unknown'。
//   · 回执 receiptHash = sha256(原始响应数组的 JSON)；requestWeight 按 Bitget 口径（下单类 0）。
import { createHash } from 'node:crypto'
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type { InstrumentId, OrderIntent, Problem } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, OrderAck, SubmitResult, TradeContext, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import type { BitgetAccounts } from './account'
import { BITGET_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import type { BitgetTradeMarket } from './market'
import { buildOrder, buildProtectionOrders, newClientOrderId, OrderBuildError, sanitizeClientOid } from './orders'
import type { BuildOptions, BuiltOrder, ProtectionOrder, ProtectionRequest } from './orders'
import { MARGIN_COIN, PRODUCT_TYPE, instrumentIdOf, mapOrderStatus, symbolOf } from './parse'
import type { RawEntrusted } from './parse'
import type { BitgetHttp } from './rest'
import { isPositionModeMismatch, isUnknownOrderError } from './venue-errors'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Bitget 下单成功只回 orderId / clientOid（没有状态字段），所以状态由「端点语义」决定。 */
interface RawPlaceResponse {
  orderId?: unknown
  clientOid?: string
  planType?: string
  code?: string
  msg?: string
}

export interface TradingDeps {
  http: BitgetHttp
  market: BitgetTradeMarket
  accounts: BitgetAccounts
  clock?: () => number
  /** 缺省保证金模式（intent.marginMode 优先）。 */
  defaultMarginMode?: 'cross' | 'isolated'
  /** 市价参考报价最大年龄（毫秒），缺省 DEFAULT_REF_PRICE_MAX_AGE_MS（5 s）。 */
  refPriceMaxAgeMs?: number
  onWarn?: (message: string) => void
}

export interface LeverageState {
  instrumentId: string
  leverage: number
  marginMode: 'cross' | 'isolated'
}

export class BitgetTrading {
  readonly #secrets: readonly string[]
  private readonly leverage = new Map<string, string>()
  private readonly clock: () => number

  constructor(private readonly d: TradingDeps, secrets: readonly string[] = []) {
    this.#secrets = secrets.length > 0 ? secrets : d.http.secretsForRedaction()
    this.clock = d.clock ?? (() => Date.now())
  }

  private problemOf(e: unknown): Problem {
    return asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
  }

  private warn(message: string): void {
    this.d.onWarn?.(message)
  }

  // ───────────── 下单 ─────────────

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const raws: unknown[] = []
    let weight = 0

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!
      const presetClientOrderId = intent.clientOrderId !== undefined ? sanitizeClientOid(String(intent.clientOrderId)) : undefined
      let built: BuiltOrder
      try {
        const record = this.d.market.getRecord(intent.instrumentId)
        const ref = this.d.market.refOf(intent.instrumentId)
        const options = await this.buildOptions(intent, ctx)
        built = buildOrder(intent, record, ref ?? {}, options)
      } catch (e) {
        if (!(e instanceof OrderBuildError)) throw e
        acks.push(this.rejectedAck(i, presetClientOrderId ?? `gt-rejected-${i}`, e.problem))
        continue
      }

      // 记住这张单的标的 / 通道：Bitget 查单必须带 symbol，内核 lookup 不给。发请求之前就先记上。
      const knownInfo = {
        symbol: built.body['symbol']!,
        kind: built.endpoint === 'plan' ? 'plan' as const : 'order' as const,
        ...(built.planType ? { planType: built.planType } : {}),
      }
      this.d.accounts.remember([built.clientOrderId], knownInfo)

      if (intent.leverage !== undefined) {
        const mode = intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated' ? 'isolated' : 'cross'
        const err = await this.ensureLeverage(intent.instrumentId, intent.leverage, mode, ctx.signal)
        if (err !== null) {
          acks.push(this.rejectedAck(i, built.clientOrderId, err))
          continue
        }
      }

      const path = built.endpoint === 'plan' ? '/api/v2/mix/order/place-plan-order' : '/api/v2/mix/order/place-order'
      try {
        let raw: RawPlaceResponse | undefined
        try {
          raw = await this.place(path, built.body, ctx)
        } catch (e) {
          const problem = this.problemOf(e)
          // 40774：持仓模式与字段不匹配 → 换另一套字段重试一次（QD bitget.py:294-310）。
          if (!isPositionModeMismatch(problem) || built.endpoint !== 'order') throw e
          const alternate = await this.alternateBody(built, intent)
          this.warn('bitget position mode mismatch (40774); retrying once with alternate position fields')
          raw = await this.place(path, alternate, ctx)
        }
        raws.push(raw ?? null)
        const venueOrderId = this.validVenueOrderId(raw?.orderId) ? String(raw.orderId) : undefined
        if (venueOrderId !== undefined) this.d.accounts.remember([venueOrderId], knownInfo)
        acks.push(this.ackFromPlace(i, built, raw))
      } catch (e) {
        const problem = this.problemOf(e)
        raws.push({ error: problem.name })
        acks.push(this.problemAck(i, built.clientOrderId, problem))
      }
    }

    weight += BITGET_WEIGHTS.order * intents.length
    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: weight }
  }

  private async place(path: string, body: Record<string, string>, ctx: TradeContext): Promise<RawPlaceResponse | undefined> {
    return this.d.http.signed<RawPlaceResponse | undefined>('POST', path, {
      body,
      order: true,
      kind: 'trade',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
  }

  /** 下单前的持仓字段上下文：hedge 模式要知道 holdSide，posMode 取不到就按单向处理（QD 同口径）。 */
  private async buildOptions(intent: OrderIntent, _ctx: TradeContext): Promise<BuildOptions> {
    const marginMode = intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated'
      ? 'isolated'
      : intent.marginMode === 'cross'
        ? 'cross'
        : this.d.defaultMarginMode ?? 'cross'
    const extra: BuildOptions = {
      marginMode,
      ...(this.d.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: this.d.refPriceMaxAgeMs } : {}),
    }
    let symbol: string
    try {
      symbol = symbolOf(intent.instrumentId)
    } catch {
      return { posMode: 'oneWay', ...extra }
    }
    const mode = await this.d.accounts.posMode(symbol)
    if (mode !== 'hedge_mode') return { posMode: 'oneWay', ...extra }
    const holdSide = intent.reduceOnly === true
      ? (intent.side === 'buy' ? 'short' : 'long')
      : (intent.side === 'buy' ? 'long' : 'short')
    return { posMode: 'hedge', holdSide, ...extra }
  }

  /** 40774 的备用字段：把 oneWay ↔ hedge 的表达对调（QD bitget.py:302-310）。 */
  private async alternateBody(built: BuiltOrder, intent: OrderIntent): Promise<Record<string, string>> {
    const body: Record<string, string> = { ...built.body }
    const hadTradeSide = body['tradeSide'] !== undefined
    delete body['tradeSide']
    delete body['reduceOnly']
    if (hadTradeSide) {
      // 原本按对冲模式发 → 改成单向：side 用买卖方向 + reduceOnly
      body['side'] = intent.side
      body['reduceOnly'] = intent.reduceOnly === true ? 'YES' : 'NO'
    } else {
      // 原本按单向发 → 改成对冲：tradeSide + 持仓方向 side
      body['tradeSide'] = intent.reduceOnly === true ? 'close' : 'open'
      const holdSide = intent.reduceOnly === true
        ? (intent.side === 'buy' ? 'short' : 'long')
        : (intent.side === 'buy' ? 'long' : 'short')
      body['side'] = holdSide === 'long' ? 'buy' : 'sell'
    }
    return body
  }

  private ackFromPlace(index: number, built: BuiltOrder, raw: RawPlaceResponse | undefined): OrderAck {
    if (!this.validVenueOrderId(raw?.orderId)) {
      return this.problemAck(index, built.clientOrderId, makeProblem(
        'VENUE_OUTCOME_UNKNOWN',
        'place response had no valid orderId; query by clientOrderId before retrying',
        { retryable: false, venue: { id: 'bitget', message: 'place response did not contain a valid orderId' } },
      ))
    }
    const venueOrderId = String(raw.orderId)
    const clientOrderId = raw?.clientOid !== undefined && raw.clientOid !== '' ? String(raw.clientOid) : built.clientOrderId
    // 计划委托受理后就是「未触发」；普通委托受理后是「挂单中」。成交量交给 fills 对账（上游不回成交量）。
    const status: OrderAck['status'] = built.endpoint === 'plan' ? 'untriggered' : 'open'
    return {
      intentIndex: index,
      clientOrderId,
      venueOrderId,
      status,
      filledSize: asDecimal('0'),
      avgFillPrice: null,
      builder: { attached: false },
    }
  }

  private validVenueOrderId(value: unknown): value is string | number {
    if (typeof value === 'string') return value.trim() !== ''
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
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
      status: problem.code === 3006 ? 'unknown' : 'rejected',
      filledSize: asDecimal('0'),
      avgFillPrice: null,
      builder: { attached: false },
      problem,
    }
  }

  // ───────────── 撤单 ─────────────

  /**
   * 撤单：clientOid 先净化；本实例知道是计划单就直接走计划撤单；否则先 cancel-order，
   * 上游说订单不存在时改走计划撤单（覆盖触发 / 保护单）。
   */
  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = []
    for (const target of targets) {
      let symbol: string
      try {
        symbol = symbolOf(target.instrumentId)
      } catch (e) {
        out.push({ target, ok: false, problem: this.problemOf(e) })
        continue
      }
      if ((target.venueOrderId === undefined || target.venueOrderId === '') && (target.clientOrderId === undefined || target.clientOrderId === '')) {
        out.push({ target, ok: false, problem: makeProblem('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId') })
        continue
      }
      const clientOid = target.clientOrderId !== undefined && target.clientOrderId !== '' ? sanitizeClientOid(String(target.clientOrderId)) : undefined
      const known = this.d.accounts.known(target.venueOrderId) ?? this.d.accounts.known(clientOid)
      if (known?.kind === 'plan') {
        out.push(await this.cancelByPlan(symbol, target, clientOid, ctx, null))
        continue
      }
      const body: Record<string, string> = { symbol, productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN }
      if (target.venueOrderId !== undefined && target.venueOrderId !== '') body['orderId'] = String(target.venueOrderId)
      else body['clientOid'] = clientOid!
      const opts = { body, order: true as const, kind: 'trade' as const, ...(ctx.signal ? { signal: ctx.signal } : {}) }
      try {
        await this.d.http.signed<unknown>('POST', '/api/v2/mix/order/cancel-order', opts)
        out.push({ target, ok: true })
        continue
      } catch (e) {
        const problem = this.problemOf(e)
        if (!isUnknownOrderError(problem)) {
          out.push({ target, ok: false, problem })
          continue
        }
        // 计划委托不在普通撤单范围：按挂单行改走 cancel-plan-order。
        out.push(await this.cancelByPlan(symbol, target, clientOid, ctx, problem))
      }
    }
    return out
  }

  /** 在计划挂单列表里找到对应行，再逐单撤（找不到行就失败，不盲目撤整标的）。 */
  private async cancelByPlan(
    symbol: string,
    target: CancelTarget,
    clientOid: string | undefined,
    ctx: TradeContext,
    fallback: Problem | null,
  ): Promise<CancelAck> {
    let rows: RawEntrusted[]
    try {
      rows = await this.d.accounts.pendingPlanRows(symbol)
    } catch (e) {
      return { target, ok: false, problem: this.problemOf(e) }
    }
    const row = rows.find((r) =>
      (target.venueOrderId !== undefined && target.venueOrderId !== '' && String(r.orderId ?? '') === String(target.venueOrderId))
      || (clientOid !== undefined && String(r.clientOid ?? '') === clientOid))
    if (row === undefined) {
      const problem = fallback ?? makeProblem('VENUE_REJECTED', 'no pending Bitget plan order matches this id', {
        venue: { id: 'bitget', message: 'not in orders-plan-pending' },
      })
      return { target, ok: false, problem }
    }
    const problem = await this.cancelPlanRow(symbol, row, ctx)
    return problem === null ? { target, ok: true } : { target, ok: false, problem }
  }

  /**
   * 撤一张计划单并逐单核结果。
   * 官方 v2（QD 未调用）：按单撤必须带 orderIdList；缺它是整标的全撤——本连接器永远不发不带 orderIdList 的 cancel-plan-order。
   */
  private async cancelPlanRow(symbol: string, row: RawEntrusted, ctx: TradeContext): Promise<Problem | null> {
    const orderId = String(row.orderId ?? '')
    const body = {
      orderIdList: [{ orderId }],
      symbol,
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      planType: String(row.planType ?? 'normal_plan'),
    }
    let data: { successList?: unknown; failureList?: unknown } | undefined
    try {
      data = await this.d.http.signed<{ successList?: unknown; failureList?: unknown } | undefined>('POST', '/api/v2/mix/order/cancel-plan-order', {
        body: body as unknown as Record<string, string>,
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    } catch (e) {
      return this.problemOf(e)
    }
    const success = Array.isArray(data?.successList) ? data.successList : []
    const failure = Array.isArray(data?.failureList) ? data.failureList : []
    if (success.some((r) => isRecord(r) && String(r['orderId'] ?? '') === orderId)) return null
    if (failure.length > 0) {
      const hit = failure.find((r) => isRecord(r) && String(r['orderId'] ?? '') === orderId) ?? failure[0]
      const errorMsg = String((isRecord(hit) ? hit['errorMsg'] : undefined) ?? 'cancel failed')
      const errorCode = isRecord(hit) ? hit['errorCode'] : undefined
      return makeProblem('VENUE_REJECTED', errorMsg, {
        venue: { id: 'bitget', ...(errorCode !== undefined && errorCode !== null && errorCode !== '' ? { code: String(errorCode) } : {}), message: errorMsg },
      })
    }
    return makeProblem('VENUE_OUTCOME_UNKNOWN', 'cancel response carried no per-order result; query the order before retrying')
  }

  /**
   * 全撤：给 instrumentId → 按标的模拟（orders-pending + cancel-order 逐张，计划单逐张）；
   * 不给 → 先读全部挂单，再按标的逐个全撤。
   */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    if (instrumentId !== undefined) return [await this.cancelAllFor(instrumentId, ctx)]
    let open: VenueOpenOrder[]
    try {
      open = await this.d.accounts.openOrders(ctx.account)
    } catch (e) {
      return [{ target: { instrumentId: '' }, ok: false, problem: this.problemOf(e) }]
    }
    const instruments = [...new Set(open.map((o) => o.instrumentId))]
    const out: CancelAck[] = []
    for (const id of instruments) out.push(await this.cancelAllFor(id, ctx))
    return out
  }

  private async cancelAllFor(instrumentId: string, ctx: TradeContext): Promise<CancelAck> {
    const target: CancelTarget = { instrumentId }
    let symbol: string
    try {
      symbol = symbolOf(instrumentId)
    } catch (e) {
      return { target, ok: false, problem: this.problemOf(e) }
    }
    // 先把两类挂单都读完：任一读失败就不发任何撤单（避免「只看了一半就当全撤完」）。
    let normal: VenueOpenOrder[]
    let plans: RawEntrusted[]
    try {
      normal = await this.d.accounts.normalOpenOrders(symbol)
      plans = await this.d.accounts.pendingPlanRows(symbol)
    } catch (e) {
      return { target, ok: false, problem: this.problemOf(e) }
    }
    const total = normal.length + plans.length
    const failures: Problem[] = []
    const signal = ctx.signal ? { signal: ctx.signal } : {}
    for (const order of normal) {
      try {
        await this.d.http.signed<unknown>('POST', '/api/v2/mix/order/cancel-order', {
          body: { symbol, productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN, orderId: order.venueOrderId },
          order: true,
          kind: 'trade',
          ...signal,
        })
      } catch (e) {
        failures.push(this.problemOf(e))
      }
    }
    for (const row of plans) {
      const problem = await this.cancelPlanRow(symbol, row, ctx)
      if (problem !== null) failures.push(problem)
    }
    if (failures.length === 0) return { target, ok: true }
    const first = failures[0]!
    return { target, ok: false, problem: { ...first, message: `${failures.length} of ${total} cancels failed; ${first.message}` } }
  }

  // ───────────── 改单 ─────────────

  /**
   * 改单一律 1004，不发请求（能力位 amend = 'none'）。
   *
   * 裁定：Bitget v2 的 modify-order 是「撤旧单、异步新建一张」——新单换新的 orderId / clientOid
   * （官方必填 newClientOid，QD 从未调用该端点）。内核改单后仍按**原** clientOrderId 追踪并查单，
   * 新单的成交与撤单都接不上，场上会留下内核不知道的挂单。做不到的声明 none 并回 1004（教训 9）。
   */
  async amend(_ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    const target = req.clientOrderId !== undefined && req.clientOrderId !== '' ? sanitizeClientOid(String(req.clientOrderId)) : undefined
    const requested = req.order.clientOrderId !== undefined && req.order.clientOrderId !== '' ? sanitizeClientOid(String(req.order.clientOrderId)) : undefined
    const problem = makeProblem('ORDER_TYPE_UNSUPPORTED', 'Bitget modify-order cancels the order and re-creates it with a new orderId / clientOid; the kernel tracks amends by the original clientOrderId, so this connector does not amend: cancel and re-submit')
    return { acks: [this.rejectedAck(0, target ?? requested ?? newClientOrderId(), problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
  }

  // ───────────── 杠杆 ─────────────

  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    const err = await this.ensureLeverage(instrumentId, leverage, marginMode, ctx.signal)
    if (err !== null) throw new ProblemError(err)
  }

  /** 只在变化时发请求；返回 null = 成功，否则返回 Problem（供 submit 把单张打回）。 */
  private async ensureLeverage(instrumentId: string, leverage: number, marginMode: 'cross' | 'isolated', signal?: AbortSignal): Promise<Problem | null> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      return makeProblem('INVALID_PARAMS', 'leverage must be an integer from 1 to 125')
    }
    const key = `${marginMode}|${leverage}`
    if (this.leverage.get(instrumentId) === key) return null
    let symbol: string
    try {
      symbol = symbolOf(instrumentId)
    } catch (e) {
      return this.problemOf(e)
    }
    const record = this.d.market.getRecord(instrumentId)
    const maxLeverage = record?.maxLeverage
    if (maxLeverage !== undefined && leverage > maxLeverage) {
      return makeProblem('INVALID_PARAMS', `leverage ${leverage}x exceeds the ${symbol} maximum ${maxLeverage}x`)
    }
    try {
      // QD bitget.py:739-772：set-leverage 带 marginMode / holdSide，并核对返回的实际杠杆。
      const raw = await this.d.http.signed<{ longLeverage?: unknown; shortLeverage?: unknown; leverage?: unknown } | undefined>(
        'POST',
        '/api/v2/mix/account/set-leverage',
        {
          body: {
            symbol,
            productType: PRODUCT_TYPE,
            marginCoin: MARGIN_COIN,
            marginMode: marginMode === 'isolated' ? 'isolated' : 'crossed',
            leverage: String(leverage),
          },
          weight: BITGET_WEIGHTS.setLeverage,
          kind: 'trade',
          ...(signal ? { signal } : {}),
        },
      )
      const effective: number[] = []
      for (const value of [raw?.longLeverage, raw?.shortLeverage, raw?.leverage]) {
        if (value === undefined || value === null || value === '') continue
        const n = Number(value)
        if (Number.isFinite(n)) effective.push(n)
      }
      if (effective.length > 0 && effective.some((n) => n !== leverage)) {
        return makeProblem('VENUE_REJECTED', `venue applied ${effective.join('/')}x instead of the requested ${leverage}x`, {
          venue: { id: 'bitget', message: `effective leverage ${effective.join(',')}` },
        })
      }
      this.leverage.set(instrumentId, key)
      return null
    } catch (e) {
      return this.problemOf(e)
    }
  }

  /** 已设置的杠杆（诊断）。 */
  leverageState(): LeverageState[] {
    return [...this.leverage.entries()].map(([instrumentId, value]) => {
      const [mode, lev] = value.split('|')
      return { instrumentId, leverage: Number(lev), marginMode: mode === 'isolated' ? 'isolated' : 'cross' }
    })
  }

  // ───────────── 位置级保护单 ─────────────

  /**
   * 成交后补挂位置级 TP / SL / 追踪（POST /api/v2/mix/order/place-tpsl-order）。
   * 内核在成交回执之后调用；构造失败照旧抛，之后逐条都发、不中途抛：成功带 ok / venueOrderId，失败带 ok:false / problem。
   */
  async placeProtection(ctx: TradeContext, req: ProtectionRequest): Promise<ProtectionOrder[]> {
    const record = this.d.market.getRecord(instrumentIdOf(req.symbol))
    let orders: ProtectionOrder[]
    try {
      orders = buildProtectionOrders(req, record)
    } catch (e) {
      throw e instanceof OrderBuildError ? new ProblemError(e.problem) : e
    }
    const sent: ProtectionOrder[] = []
    for (const order of orders) {
      try {
        const data = await this.d.http.signed<{ orderId?: unknown } | undefined>('POST', '/api/v2/mix/order/place-tpsl-order', {
          body: order.body,
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        const venueOrderId = data?.orderId !== undefined && data.orderId !== null && data.orderId !== '' ? String(data.orderId) : undefined
        this.d.accounts.remember([order.body['clientOid'], venueOrderId], {
          symbol: order.body['symbol'] ?? req.symbol,
          kind: 'plan',
          ...(order.body['planType'] !== undefined ? { planType: order.body['planType'] } : {}),
        })
        sent.push({ ...order, ok: true, ...(venueOrderId !== undefined ? { venueOrderId } : {}) })
      } catch (e) {
        sent.push({ ...order, ok: false, problem: this.problemOf(e) })
      }
    }
    return sent
  }

  // ───────────── 场所级死人开关 ─────────────

  /** Bitget v2 mix 没有「到点全撤」的定时端点：不假装支持，抛 5002 由内核的撤单循环兜。 */
  async scheduleCancel(_ctx: TradeContext, _atMs: number | null): Promise<void> {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Bitget v2 mix has no scheduled cancel-all endpoint; keep the cancel loop in the kernel'))
  }

  // ───────────── 状态映射（诊断） ─────────────

  /** 原生状态 → 内部状态（导出给测试断言全表）。 */
  mapStatus(raw: string | undefined): ReturnType<typeof mapOrderStatus> {
    return mapOrderStatus(raw)
  }

  /** 诊断：预算占用。 */
  budgetUsage(): ReturnType<BitgetHttp['usage']> {
    return this.d.http.usage()
  }

  /** 诊断：当前时刻（注入时钟）。 */
  now(): number {
    return this.clock()
  }

  /** 已给账户引用（诊断）。 */
  static refOf(ref: AccountRef): AccountRef {
    return ref
  }

  /** 单张订单状态（透传 account）。 */
  status(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; symbol?: string }): Promise<VenueOrderStatus> {
    return this.d.accounts.orderStatus(ref, key)
  }
}
