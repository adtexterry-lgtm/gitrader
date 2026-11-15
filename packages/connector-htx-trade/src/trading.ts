// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 撤单 / 全撤 / 杠杆 / 止盈止损委托。
// 连接器自己不会主动下单——所有方法都在内核发起的 TradeContext 窗口里执行（契约 §3.6）。
// 端点与 HTTP 方法（教训 1 / 2，照 QD htx.py 的当前实现 + 官方方法）：
//   · POST /v5/trade/order                                建单（v5：side + type + time_in_force + position_side）；
//   · POST /linear-swap-api/v1/swap_cross_order           建单（v1：direction + offset + order_price_type + lever_rate）；
//   · POST /v5/trade/cancel_order                         撤单（**POST**）；
//   · POST /linear-swap-api/v1/swap_cross_cancel           撤单（v1，**POST**）；
//   · POST /v5/trade/cancel_all_orders                     全撤（v5 官方端点，data 是逐单 {code,message}）；
//   · POST /linear-swap-api/v1/swap_cross_cancelall        全撤（v1，逐单失败在 data.errors）；
//   · POST /v5/position/lever、POST /linear-swap-api/v1/swap_cross_switch_lever_rate   调杠杆；
//   · POST /linear-swap-api/v1/swap_cross_tpsl_order       止盈止损委托（仅 v1；仓位级保护）。
// 读接口：v1 全是 POST（业务参数在 body），v5 是 GET（见 rest.ts）。
// 本包**不调用** v5 的两个「市价全平」端点和 v1 的触发单端点。
// 其它口径：
//   · 签名是 HMAC（apiKey / apiSecret 从构造参数进），不是签名器句柄：ctx.signer 在 HTX 上没有对应物，
//     本模块**不使用**它，也不回调 ctx.onSigned（没有载荷摘要可写账本；README 写明）；
//   · tpsl：submit 不自动挂保护单（带 tpsl 的意图回 1004），成交后走 buildTpslBody() + setTpsl()；
//     v5 联合保证金账户不能用 v1 的止盈止损端点 → setTpsl 回 1004；
//   · 改单：HTX 没有改单端点（官方只有撤 + 下），amend 一律 1004，由内核撤旧挂新；
//   · scheduleCancel：HTX v5 有场所级 cancel-after（本包**未实现**，只改文档说法）→ CAPABILITY_UNSUPPORTED；
//   · 回执 receiptHash = sha256(原始响应数组的 JSON)；requestWeight 按 HTX 口径（下单请求权重 0 + 下单计数桶）；
//   · 「结果未知」（3006）一律回 status 'unknown'，等内核按 clientOrderId 对账，绝不盲目重发；
//   · 持仓模式不匹配（1499 / 1500）：**只重发一次**、只翻 position_side / offset（QD htx_v5.py:224-237 的两种码），
//     不猜账户模式；第二次仍失败就把上游原文交回内核。
import { createHash } from 'node:crypto'
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type { Instrument, InstrumentId, OrderIntent, Problem } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, OrderAck, SubmitResult, TradeContext, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import type { HtxAccounts } from './account'
import { HTX_WEIGHTS } from './budget'
import { asProblem, ProblemError, redactSecret } from './errors'
import {
  buildCancelAllBody, buildCancelBody, buildLeverBody, buildOrderBody, buildTpslBody, OrderBuildError, numericClientOrderId,
} from './orders'
import type { BuildOptions, BuiltOrder, OrderFamily, TpslSpec } from './orders'
import { symbolOf } from './parse'
import { ENDPOINTS } from './rest'
import type { HtxHttp } from './rest'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

/** 撤单时「已不在场上」的官方错误码（v1: 1051/1061/1063/1071；v5: 1061）；文案正则只作兜底。 */
const GONE_CODES = new Set([1051, 1061, 1063, 1071])
const GONE_RE = /order\s*(not\s*exist|does\s*not\s*exist|is\s*(already\s*)?(filled|cancel)|completed)|已成交|已撤销|不存在/i
const isGone = (p: Problem): boolean => {
  const code = Number(p.venue?.code)
  return (Number.isFinite(code) && GONE_CODES.has(code)) || GONE_RE.test(p.venue?.message ?? '')
}

/** v1 撤单 / 全撤的 data.errors 一行 → 码与文案。 */
interface OrderErrorRow {
  code?: number
  message: string
}

function orderErrorsOf(raw: unknown): OrderErrorRow[] {
  if (!raw || typeof raw !== 'object') return []
  const errors = (raw as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return []
  return errors.flatMap((row): OrderErrorRow[] => {
    if (!row || typeof row !== 'object') return []
    const r = row as { err_code?: unknown; err_msg?: unknown }
    const code = Number(r.err_code)
    return [{ ...(Number.isFinite(code) ? { code } : {}), message: String(r.err_msg ?? '') }]
  })
}

/** v5 全撤的 data 行（逐单 code / message）。 */
function cancelAllRowsOf(raw: unknown): OrderErrorRow[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row): OrderErrorRow[] => {
    if (!row || typeof row !== 'object') return []
    const r = row as { code?: unknown; message?: unknown }
    const code = Number(r.code)
    return [{ ...(Number.isFinite(code) ? { code } : {}), message: String(r.message ?? '') }]
  })
}

function venueRejected(error: OrderErrorRow): Problem {
  return makeProblem('VENUE_REJECTED', error.message === '' ? 'htx rejected the cancel' : error.message, {
    venue: { id: 'htx', ...(error.code !== undefined ? { code: error.code } : {}), message: error.message },
  })
}
/** 持仓模式不匹配（QD 点名的 1499 / 1500 与官方文案）。 */
const MODE_RE = /hedge\s*mode\s*currently|one-way\s*mode\s*currently|双向持仓|单向持仓/i
const isModeMismatch = (p: Problem): boolean => Number(p.venue?.code) === 1499 || Number(p.venue?.code) === 1500 || MODE_RE.test(p.venue?.message ?? '')

export interface TradingDeps {
  http: HtxHttp
  /** 本地标的记录（精度 + contract_code）。 */
  instrumentOf: (instrumentId: string) => Instrument | undefined
  /** 最新报价（报价缓存；市价意图需要参考价）。 */
  quoteOf: (instrumentId: string) => { bid: number; ask: number; last?: number; stale: boolean } | undefined
  /** 挂单读取（由 account.ts 提供，避免两处解析）。 */
  openOrders: (ref: AccountRef, instrumentId?: InstrumentId) => Promise<VenueOpenOrder[]>
  /** 单张订单状态（由 account.ts 提供）。 */
  orderStatus: (ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId }, opts?: { symbol?: string }) => Promise<VenueOrderStatus>
  /** 一张合约的面值（币）；建单体必填，拿不到 → INSTRUMENT_UNKNOWN。 */
  faceValueOf: (instrumentId: string) => string | undefined
  clock?: () => number
  /** 双向持仓（dual_side）账户。 */
  hedge?: boolean
  family?: OrderFamily
  /** 保证金模式（v5 建单体必填）。 */
  marginMode?: 'cross' | 'isolated'
  /** 缺省标的。 */
  defaultSymbol?: string
  accounts?: HtxAccounts
}

interface RawOrderResponse {
  order_id?: number | string
  order_id_str?: string
  client_order_id?: number | string
  /** 调杠杆的响应会带回生效杠杆（官方字段 lever_rate）。 */
  lever_rate?: number | string
  successes?: unknown
  fails?: unknown
}

export interface LeverageState {
  instrumentId: string
  leverage: number
  marginMode: 'cross' | 'isolated'
}

export class HtxTrading {
  readonly #secrets: readonly string[]
  private readonly hedge: boolean
  private readonly family: OrderFamily
  /** 杠杆缓存：key = instrumentId + marginMode，value = String(leverage)。 */
  private readonly leverage = new Map<string, string>()

  /** secrets 单独传，不放进 this.d：JSON.stringify / inspect 看不到密钥。 */
  constructor(private readonly d: TradingDeps, secrets: readonly string[] = []) {
    this.hedge = d.hedge ?? false
    this.family = d.family ?? 'v5'
    this.#secrets = secrets
  }

  private buildOptions(instrumentId: string, over: BuildOptions = {}): BuildOptions {
    const q = this.d.quoteOf(instrumentId)
    const faceValue = this.d.faceValueOf(instrumentId)
    return {
      family: this.family,
      hedge: this.hedge,
      ...(this.d.marginMode !== undefined ? { marginMode: this.d.marginMode } : {}),
      ...(faceValue !== undefined ? { faceValue } : {}),
      ...(q
        ? { ref: { bid: q.bid, ask: q.ask, ...(q.last !== undefined ? { last: q.last } : {}), mid: (q.bid + q.ask) / 2, stale: q.stale } }
        : {}),
      ...over,
    }
  }

  // ───────────── 下单 ─────────────

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const raws: unknown[] = []

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!
      const fallbackId = intent.clientOrderId !== undefined ? String(intent.clientOrderId) : numericClientOrderId(`rejected-${i}`)

      // 本包 submit 不挂保护单：带 tpsl 的意图一律 1004（由内核成交后调 buildTpslBody / setTpsl）。
      if (intent.tpsl !== undefined) {
        acks.push(this.rejectedAck(i, fallbackId, makeProblem(
          'ORDER_TYPE_UNSUPPORTED',
          'this connector does not attach protective orders on submit; send the parent alone and call setTpsl() after the fill',
        )))
        continue
      }

      let built: BuiltOrder
      try {
        // 杠杆与建单的保证金模式必须同一口径（不能一个按 intent、一个按连接器缺省）。
        const marginMode = this.marginModeOf(intent)
        const leverage = intent.leverage ?? this.cachedLeverage(intent.instrumentId, marginMode)
        built = buildOrderBody(
          intent,
          this.d.instrumentOf(intent.instrumentId),
          this.buildOptions(intent.instrumentId, { marginMode, ...(leverage !== undefined ? { leverage } : {}) }),
        )
      } catch (e) {
        if (!(e instanceof OrderBuildError)) throw e
        acks.push(this.rejectedAck(i, fallbackId, e.problem))
        continue
      }

      // 杠杆是账户 / 仓位级设置：给了就先设（失败则单张不发出）。reduce-only 只是平仓，不做账户配置。
      if (intent.leverage !== undefined && intent.reduceOnly !== true) {
        const err = await this.ensureLeverage(intent.instrumentId, intent.leverage, this.marginModeOf(intent))
        if (err !== null) {
          acks.push(this.rejectedAck(i, built.clientOrderId, err))
          continue
        }
      }

      try {
        const raw = await this.postOrder(built, ctx)
        raws.push(raw ?? null)
        acks.push(this.ackFromOrder(i, built, raw))
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        raws.push({ error: problem.name })
        acks.push(this.problemAck(i, built.clientOrderId, problem))
      }
    }

    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: HTX_WEIGHTS.order * intents.length }
  }

  /**
   * 发一张单。持仓模式不匹配（1499 / 1500）时只重发一���、只翻 position_side（v5）/ offset（v1）。
   * 第二次仍失败就抛原错（不无限重试、不偷偷改账户模式）。
   */
  private async postOrder(built: BuiltOrder, ctx: TradeContext): Promise<RawOrderResponse | undefined> {
    const endpoint = built.family === 'v5' ? ENDPOINTS.v5Order : ENDPOINTS.crossOrder
    const post = (body: Record<string, unknown>): Promise<RawOrderResponse | undefined> =>
      this.d.http.signed<RawOrderResponse>(endpoint.method as 'POST', endpoint.path, { body }, {
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    try {
      return await post(built.body)
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      if (!isModeMismatch(problem)) throw e
      const flipped = flipPositionMode(built)
      if (flipped === undefined) throw e
      return post(flipped)
    }
  }

  /**
   * 建单响应只有订单号（没有成交回报）：触发单不存在（本包不发），所以拿到号一律记 'open'。
   * IOC 也可能立刻成交——成交量由成交记录或内核回查补上（README 写明）。
   * 拿不到订单号 → 3006 结果未知（不许报 open：内核会以为单已进场，也无法按 id 对账）。
   */
  private ackFromOrder(index: number, built: BuiltOrder, raw: RawOrderResponse | undefined): OrderAck {
    const idRaw = raw?.order_id_str ?? raw?.order_id
    const venueOrderId = idRaw !== undefined && idRaw !== null && String(idRaw) !== '' && String(idRaw) !== '0' ? String(idRaw) : null
    if (venueOrderId === null) {
      return this.problemAck(index, built.clientOrderId, makeProblem(
        'VENUE_OUTCOME_UNKNOWN',
        'htx accepted the order request but returned no order_id; query by clientOrderId before retrying',
        { venue: { id: 'htx', message: redactSecret(raw === undefined ? 'empty response body' : JSON.stringify(raw, jsonSafe), this.#secrets).slice(0, 200) } },
      ))
    }
    return {
      intentIndex: index,
      clientOrderId: built.clientOrderId,
      venueOrderId,
      status: 'open',
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

  /** 撤单：v5 POST /v5/trade/cancel_order；v1 POST /linear-swap-api/v1/swap_cross_cancel。
   * v1 的逐单失败在 data.errors（信封仍是 ok）；只有「已不在场上」的码才算撤单目的达成。 */
  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = []
    for (const target of targets) {
      let code: string
      try {
        code = symbolOf(target.instrumentId)
      } catch (e) {
        out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) })
        continue
      }
      let body: Record<string, unknown>
      try {
        body = buildCancelBody(code, {
          ...(target.venueOrderId !== undefined ? { venueOrderId: String(target.venueOrderId) } : {}),
          ...(target.clientOrderId !== undefined ? { clientOrderId: String(target.clientOrderId) } : {}),
        })
      } catch (e) {
        out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) })
        continue
      }
      const endpoint = this.family === 'v5' ? ENDPOINTS.v5Cancel : ENDPOINTS.crossCancel
      try {
        const raw = await this.d.http.signed<unknown>(endpoint.method as 'POST', endpoint.path, { body }, {
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        // v1：逐单失败在 data.errors；已不在场上的码当作 ok。
        if (this.family === 'v1') {
          const failed = orderErrorsOf(raw).find((e) => !(e.code !== undefined && GONE_CODES.has(e.code)))
          if (failed !== undefined) out.push({ target, ok: false, problem: venueRejected(failed) })
          else out.push({ target, ok: true })
        } else {
          out.push({ target, ok: true })
        }
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        // 已经不在场上了：撤单目的已达成，按 ok 回报（上游原文留在 problem 里给对账看）。
        if (isGone(problem)) out.push({ target, ok: true })
        else out.push({ target, ok: false, problem })
      }
    }
    return out
  }

  /**
   * 全撤：v5 → POST /v5/trade/cancel_all_orders（逐单 code）；v1 → POST swap_cross_cancelall（data.errors）。
   * v1 未给 instrumentId 时先读 v1 当前委托，按合约逐个 cancelall（不再“失败后逐张撤”）。
   */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    const target: CancelTarget = instrumentId !== undefined ? { instrumentId } : { instrumentId: 'htx:USDT' as InstrumentId }
    let code: string | undefined
    if (instrumentId !== undefined) {
      try {
        code = symbolOf(instrumentId)
      } catch (e) {
        return [{ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) }]
      }
    }
    if (this.family === 'v5') {
      try {
        const raw = await this.d.http.signed<unknown>(ENDPOINTS.v5CancelAll.method, ENDPOINTS.v5CancelAll.path, {
          body: buildCancelAllBody(code),
        }, { order: true, kind: 'trade', ...(ctx.signal ? { signal: ctx.signal } : {}) })
        const rows = cancelAllRowsOf(raw)
        const failed = rows.find((row) => row.code !== 200)
        if (failed !== undefined) return [{ target, ok: false, problem: venueRejected(failed) }]
        return [{ target, ok: true }]
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        if (isGone(problem)) return [{ target, ok: true }]
        return [{ target, ok: false, problem }]
      }
    }

    // v1：确定要全撤的合约列表（给了 instrumentId 就只撤那一个）。
    let codes: string[]
    if (code !== undefined) {
      codes = [code]
    } else {
      let open: VenueOpenOrder[]
      try {
        open = await this.d.openOrders(ctx.account)
      } catch (e) {
        return [{ target, ok: false, problem: asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }) }]
      }
      codes = [...new Set(open.map((o) => symbolOf(o.instrumentId)))]
    }
    if (codes.length === 0) return [{ target, ok: true }]
    for (const contractCode of codes) {
      try {
        const raw = await this.d.http.signed<unknown>(ENDPOINTS.crossCancelAll.method, ENDPOINTS.crossCancelAll.path, {
          body: buildCancelAllBody(contractCode),
        }, { order: true, kind: 'trade', ...(ctx.signal ? { signal: ctx.signal } : {}) })
        const failed = orderErrorsOf(raw).find((e) => !(e.code !== undefined && GONE_CODES.has(e.code)))
        if (failed !== undefined) return [{ target, ok: false, problem: venueRejected(failed) }]
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        if (isGone(problem)) continue
        return [{ target, ok: false, problem }]
      }
    }
    return [{ target, ok: true }]
  }

  // ───────────── 改单 ─────────────

  /** HTX 没有改单端点：一律 1004，由内核撤旧挂新（不伪装成 emulation）。 */
  async amend(_ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    const clientOrderId = String(req.clientOrderId ?? req.order.clientOrderId ?? numericClientOrderId(`amend-${req.instrumentId}`))
    const problem = makeProblem(
      'ORDER_TYPE_UNSUPPORTED',
      'HTX has no amend endpoint; cancel the order and submit a new one (the kernel keeps the cancel-then-place loop)',
    )
    return { acks: [this.rejectedAck(0, clientOrderId, problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
  }

  // ───────────── 查询 ─────────────

  openOrders(ref: AccountRef, instrumentId?: InstrumentId): Promise<VenueOpenOrder[]> {
    return this.d.openOrders(ref, instrumentId)
  }

  status(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId }): Promise<VenueOrderStatus> {
    return this.d.orderStatus(ref, key, {})
  }

  // ───────────── 杠杆 ─────────────

  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    const err = await this.ensureLeverage(instrumentId, leverage, marginMode, ctx.signal)
    if (err !== null) throw new ProblemError(err)
  }

  /** 只在变化时发请求。返回 null = 成功，否则返回 Problem（供 submit 把单张打回）。 */
  private async ensureLeverage(
    instrumentId: string,
    leverage: number,
    marginMode: 'cross' | 'isolated',
    signal?: AbortSignal,
  ): Promise<Problem | null> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      return makeProblem('INVALID_PARAMS', 'leverage must be an integer from 1 to 125')
    }
    const cacheKey = `${instrumentId}|${marginMode}`
    if (this.leverage.get(cacheKey) === String(leverage)) return null
    let code: string
    try {
      code = symbolOf(instrumentId)
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets })
    }
    const max = this.d.instrumentOf(instrumentId)?.maxLeverage
    if (max !== undefined && Number.isFinite(max) && leverage > max) {
      return makeProblem('INVALID_PARAMS', `leverage ${leverage}x exceeds the contract maximum ${max}x for ${code}`)
    }
    let body: Record<string, unknown>
    try {
      body = buildLeverBody(code, leverage, marginMode, this.family)
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets })
    }
    const endpoint = this.family === 'v5' ? ENDPOINTS.v5Lever : ENDPOINTS.crossSwitchLever
    try {
      const raw = await this.d.http.signed<RawOrderResponse>(endpoint.method as 'POST', endpoint.path, { body }, {
        kind: 'trade',
        weight: HTX_WEIGHTS.setLeverage,
        ...(signal ? { signal } : {}),
      })
      // 上游回带生效杠杆就核一遍（QD htx.py:597-611 同口径：不相等就报错，不静默接受）。
      const effective = Number(raw?.lever_rate)
      if (Number.isFinite(effective) && effective > 0 && effective !== leverage) {
        return makeProblem('VENUE_REJECTED', `HTX applied ${effective}x instead of the requested ${leverage}x`, {
          venue: { id: 'htx', message: JSON.stringify(raw) },
        })
      }
      this.leverage.set(cacheKey, String(leverage))
      return null
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
    }
  }

  /** 意图的保证金模式（协议类型更宽：noCross → cross，strictIsolated → isolated），缺省用连接器设置。 */
  private marginModeOf(intent: OrderIntent): 'cross' | 'isolated' {
    if (intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated') return 'isolated'
    if (intent.marginMode !== undefined) return 'cross'
    return this.d.marginMode ?? 'cross'
  }

  private cachedLeverage(instrumentId: string, marginMode: 'cross' | 'isolated' = this.d.marginMode ?? 'cross'): number | undefined {
    const hit = this.leverage.get(`${instrumentId}|${marginMode}`)
    return hit === undefined ? undefined : Number(hit)
  }

  /** 已设置的杠杆（诊断）。 */
  leverageState(): LeverageState[] {
    return [...this.leverage.entries()].map(([key, value]) => {
      const [instrumentId, mode] = key.split('|')
      return { instrumentId: instrumentId ?? '', leverage: Number(value), marginMode: mode === 'isolated' ? 'isolated' : 'cross' }
    })
  }

  // ───────────── 止盈止损委托（仓位级）─────────────

  /** POST /linear-swap-api/v1/swap_cross_tpsl_order：**仅 v1**；v5 联合保证金账户不能用它。 */
  async setTpsl(ctx: TradeContext, spec: TpslSpec): Promise<Record<string, unknown>> {
    if (this.family === 'v5') {
      throw new ProblemError(makeProblem(
        'ORDER_TYPE_UNSUPPORTED',
        'v5 accounts cannot use the v1 cross TP/SL endpoint; not implemented',
      ))
    }
    let body: Record<string, unknown>
    try {
      body = buildTpslBody(spec)
    } catch (e) {
      if (e instanceof OrderBuildError) throw e
      throw new ProblemError(asProblem(e, { secrets: this.#secrets }))
    }
    try {
      const raw = await this.d.http.signed<Record<string, unknown>>(ENDPOINTS.crossTpslOrder.method, ENDPOINTS.crossTpslOrder.path, { body }, {
        kind: 'trade',
        weight: HTX_WEIGHTS.tpsl,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      return raw ?? {}
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }))
    }
  }

  // ───────────── 场所级定时撤单 ─────────────

  /** HTX v5 有场所级 cancel-after（本包未实现，仅文档层面）：本包不伪装，直接 5002。 */
  async scheduleCancel(_ctx: TradeContext, _atMs: number | null): Promise<void> {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'cancel-after is not implemented by this connector; keep the cancel loop in the kernel'))
  }

  /** 诊断：本连接器的持仓模式。 */
  mode(): { hedge: boolean; family: OrderFamily } {
    return { hedge: this.hedge, family: this.family }
  }

  /** 诊断：预算占用（含下单计数桶）。 */
  budgetUsage(): ReturnType<HtxHttp['usage']> {
    return this.d.http.usage()
  }

  /** 诊断：已登记的默认标的。 */
  defaultSymbol(): string | undefined {
    return this.d.defaultSymbol
  }
}

/** 1499 / 1500 的重发形态：v5 翻 position_side（both ↔ long/short），v1 翻 offset（both ↔ open/close）。 */
export function flipPositionMode(built: BuiltOrder): Record<string, unknown> | undefined {
  const body = { ...built.body }
  if (typeof body.position_side === 'string') {
    if (body.position_side === 'both') {
      const side = String(body.side)
      body.position_side = body.reduce_only === 1 ? (side === 'sell' ? 'long' : 'short') : side === 'buy' ? 'long' : 'short'
      return body
    }
    // long/short → both：保留 reduce_only（否则平仓单会变成反向开仓单）。
    body.position_side = 'both'
    return body
  }
  if (typeof body.offset === 'string') {
    const original = body.offset
    if (original === 'both') {
      body.offset = body.reduce_only === 1 ? 'close' : 'open'
      delete body.reduce_only
      return body
    }
    // open/close → both：原开仓单不带 reduce_only，原平仓单带 reduce_only=1。
    body.offset = 'both'
    if (original === 'close') body.reduce_only = 1
    else delete body.reduce_only
    return body
  }
  return undefined
}
