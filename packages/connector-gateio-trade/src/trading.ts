// SPDX-License-Identifier: CPAL-1.0
// 交易：下单（普通单 / 触发单）/ 撤单 / 全撤 / 改单 / 杠杆 / 死人开关。连接器自己不会主动下单——所有方法都在内核发起的
// TradeContext 窗口里执行（契约 §3.6）。
//   · 签名是 HMAC（apiKey / apiSecret 从构造参数进），没有签名器句柄：ctx.signer 在 Gate.io 上无对应物，
//     本模块**不使用**它，也不回调 ctx.onSigned（没有载荷摘要可写账本；README 写明）。
//   · 下单 → POST /api/v4/futures/usdt/orders（QD gate.py:930-1007），份额化合约带 `X-Gate-Size-Decimal: 1`；
//     触发单 → POST /api/v4/futures/usdt/price_orders（QD native_protection.py:273-322），回执 status = untriggered；
//   · 撤单 → DELETE /api/v4/futures/usdt/orders/{id} 或 /price_orders/{id}（**DELETE**，不是 POST；工单教训 2）；
//     只给 clientOrderId 时先按 text 有界扫描 / 触发单备忘定位；
//   · 全撤 → Gate 按合约原生全撤：DELETE /orders?contract= 与 DELETE /price_orders?contract=；
//   · 改单 → 1004（QD 没有 amend 实现，Gate 的 PUT 改单未纳入本连接器）；
//   · 杠杆 → POST /api/v4/futures/usdt/positions/{contract}/leverage，**参数在 query**（QD :872-910）；
//     下单时绝不切换保证金模式：意图的 marginMode 与持仓现状不一致 → INVALID_PARAMS + hint；
//     只有显式 setLeverage 可以切模式；
//   · 双仓 / 分仓账户（dual / dual_plus）一律 5002：本连接器只建模单向持仓，不猜字段；
//   · 「结果未知」（非 GET 的 408 / 5xx / 服务端错误 label）一律 3006 且不重发，ack.status='unknown'。
//   · 回执 receiptHash = sha256(原始响应数组的 JSON)；requestWeight 按本连接器权重表（下单类 0）。
import { createHash } from 'node:crypto'
import { asDecimal, makeProblem } from '@gitrader/protocol'
import { mulDec, subDec } from '@gitrader/protocol/decimal'
import type { Decimal, InstrumentId, OrderIntent, Problem } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, OrderAck, SubmitResult, TradeContext, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import type { GateAccounts } from './account'
import { GATE_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import type { GateTradeMarket } from './market'
import { buildOrder, newClientOrderId, PRICE_ORDERS_PATH } from './orders'
import type { BuiltOrder } from './orders'
import { API_PREFIX, absDec, decimalOf, instrumentIdOf, priceOrderIdOf, symbolOf } from './parse'
import type { GateHttp } from './rest'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

/** 开仓意图带 leverage / marginMode 但模式不符时的提示语。 */
const MARGIN_HINT = '(hint: set margin mode explicitly first)'
/** Gate 的「这张单已经不在场上」label（撤单时当作成功；内核随后 confirmCancel 核实终态）。 */
const GONE_LABELS = new Set(['ORDER_NOT_FOUND', 'ORDER_FINISHED', 'ORDER_CLOSED', 'ORDER_CANCELLED'])

/** Gate 下单成功回整张 order 对象（id / status / size / left / fill_price / text）。 */
interface RawOrderResponse {
  id?: string | number
  id_string?: string
  text?: string
  contract?: string
  size?: string | number
  left?: string | number
  price?: string
  fill_price?: string
  status?: string
  finish_as?: string
  reduce_only?: boolean
}

export interface TradingDeps {
  http: GateHttp
  market: GateTradeMarket
  accounts: GateAccounts
  clock?: () => number
  onWarn?: (message: string) => void
}

export class GateTrading {
  readonly #secrets: readonly string[]
  private readonly clock: () => number

  constructor(private readonly d: TradingDeps, secrets: readonly string[] = []) {
    this.#secrets = secrets.length > 0 ? secrets : d.http.secretsForRedaction()
    this.clock = d.clock ?? (() => Date.now())
  }

  private problemOf(e: unknown): Problem {
    return asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
  }

  // ───────────── 下单 ─────────────

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const raws: unknown[] = []
    let weight = 0

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!
      const clientOrderId = intent.clientOrderId !== undefined ? String(intent.clientOrderId) : newClientOrderId()
      let sent = false
      let placed = false
      let built: BuiltOrder | undefined
      try {
        built = buildOrder({ ...intent, clientOrderId }, this.d.market.getRecord(intent.instrumentId), this.d.market.refOf(intent.instrumentId) ?? {})
        const mode = await this.d.accounts.positionMode()
        if (mode === '') {
          acks.push(this.rejectedAck(i, clientOrderId, makeProblem('VENUE_UNAVAILABLE', 'could not read the Gate futures position mode; order not sent', { retryable: true })))
          continue
        }
        if (mode === 'dual' || mode === 'dual_plus') {
          // 持仓模式守卫：双仓 / 分仓账户的字段语义与本连接器（单向）不同，宁可拒单也不猜。
          acks.push(this.rejectedAck(i, clientOrderId, makeProblem(
            'CAPABILITY_UNSUPPORTED',
            `Gate.io account is in ${mode} position mode; this connector models one-way positions only`,
          )))
          continue
        }
        if (intent.reduceOnly !== true && (intent.leverage !== undefined || intent.marginMode !== undefined)) {
          const err = await this.applyIntentMargin(intent, built, ctx.signal)
          if (err !== null) {
            acks.push(this.rejectedAck(i, clientOrderId, err))
            continue
          }
        }
        sent = true
        if (built.kind === 'order') this.d.accounts.rememberOrderContract(clientOrderId, built.contract)
        const raw = await this.d.http.signed<unknown>('POST', built.path, {
          body: built.body,
          headers: built.headers,
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        placed = true
        raws.push(raw ?? null)
        acks.push(built.kind === 'price_order' ? this.ackFromTrigger(i, built, raw) : this.ackFromPlace(i, built, raw as RawOrderResponse | undefined))
      } catch (e) {
        const problem = this.problemOf(e)
        raws.push({ error: problem.name })
        if (placed) {
          acks.push(this.unknownAck(i, clientOrderId, makeProblem('VENUE_OUTCOME_UNKNOWN', 'venue accepted the request but the response could not be read; query by clientOrderId before retrying')))
        } else if (sent && problem.code === 3006) {
          // 3006 = 结果未知：不得重发，先把触发单指纹记下，等核对时按 clientOrderId 找回。
          if (built?.fingerprint !== undefined) this.d.accounts.rememberTrigger(clientOrderId, { ...built.fingerprint, at: this.clock() })
          acks.push(this.unknownAck(i, clientOrderId, problem))
        } else {
          acks.push(this.rejectedAck(i, clientOrderId, problem))
        }
      }
    }

    weight += GATE_WEIGHTS.order * intents.length
    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: weight }
  }

  /** 受理回执：成交量按 built.contractSize 算（不按响应里的 contract 查表），状态落成内核认得的词。 */
  private ackFromPlace(index: number, built: BuiltOrder, raw: RawOrderResponse | undefined): OrderAck {
    const venueOrderId = raw?.id_string ?? raw?.id
    if (venueOrderId === undefined || venueOrderId === '') {
      return this.unknownAck(index, built.clientOrderId, makeProblem('VENUE_OUTCOME_UNKNOWN', 'venue accepted the order without an id; query by clientOrderId before retrying'))
    }
    const sizeContracts = absDec(decimalOf(raw?.size ?? built.sizeContracts))
    const leftContracts = absDec(decimalOf(raw?.left ?? sizeContracts))
    const filledContracts = subDec(sizeContracts, leftContracts)
    const filledSize = filledContracts.startsWith('-') ? asDecimal('0') : mulDec(filledContracts, built.contractSize)
    const statusRaw = String(raw?.status ?? 'open').toLowerCase()
    const fillPrice = decimalOf(raw?.fill_price)
    const finishAs = String(raw?.finish_as ?? statusRaw)
    // finished / cancelled 且有成交 → filled；一手没成 → rejected（带 venue.code = finish_as）；
    // 其余（含 open + 部分成交）一律 open（内核按 filledSize 自己算部分成交）。
    const status: OrderAck['status'] = statusRaw === 'finished' || statusRaw === 'cancelled' || statusRaw === 'canceled'
      ? (filledSize !== '0' ? 'filled' : 'rejected')
      : 'open'
    return {
      intentIndex: index,
      clientOrderId: built.clientOrderId,
      venueOrderId: String(venueOrderId),
      status,
      filledSize,
      avgFillPrice: fillPrice === '0' ? null : fillPrice,
      builder: { attached: false },
      ...(status === 'rejected'
        ? { problem: makeProblem('VENUE_REJECTED', `order finished without a fill (finish_as=${finishAs})`, { venue: { id: 'gateio', code: finishAs, message: `finish_as=${finishAs}` } }) }
        : {}),
    }
  }

  /** 触发单回执：记下备忘，status = untriggered；响应没给号 → unknown（按 clientOrderId 对账）。 */
  private ackFromTrigger(index: number, built: BuiltOrder, raw: unknown): OrderAck {
    const venueOrderId = priceOrderIdOf((raw ?? {}) as { id?: unknown; id_string?: unknown })
    const fingerprint = built.fingerprint
    if (venueOrderId === undefined) {
      if (fingerprint !== undefined) this.d.accounts.rememberTrigger(built.clientOrderId, { ...fingerprint, at: this.clock() })
      return this.unknownAck(index, built.clientOrderId, makeProblem('VENUE_OUTCOME_UNKNOWN', 'price order accepted without an id; query by clientOrderId before retrying'))
    }
    if (fingerprint !== undefined) this.d.accounts.rememberTrigger(built.clientOrderId, { ...fingerprint, at: this.clock(), venueOrderId })
    return {
      intentIndex: index,
      clientOrderId: built.clientOrderId,
      venueOrderId,
      status: 'untriggered',
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

  /** 结果未知（3006）：不得重发，必须先按 clientOrderId 对账（工单教训 3）。 */
  private unknownAck(index: number, clientOrderId: string, problem: Problem): OrderAck {
    return {
      intentIndex: index,
      clientOrderId,
      venueOrderId: null,
      status: 'unknown',
      filledSize: asDecimal('0'),
      avgFillPrice: null,
      builder: { attached: false },
      problem,
    }
  }

  // ───────────── 撤单 ─────────────

  /**
   * 撤单：**DELETE** /api/v4/futures/usdt/orders/{venueOrderId}；`po:` 前缀的触发单号走 /price_orders/{id}。
   * 只有 clientOrderId 时先按 text 扫描 / 触发单备忘定位（Gate 没有按 text 撤单的端点）；定位不到 → ok:false
   * （找不到就是找不到，不当成成功，也不重发）。已不在场上的单（ORDER_NOT_FOUND / ORDER_FINISHED …）按 ok:true。
   */
  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = []
    for (const target of targets) {
      if (target.venueOrderId === undefined && target.clientOrderId === undefined) {
        out.push({ target, ok: false, problem: makeProblem('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId') })
        continue
      }
      let venueOrderId = target.venueOrderId
      if (venueOrderId === undefined || venueOrderId === '') {
        let found: VenueOrderStatus
        try {
          found = await this.d.accounts.orderStatus(ctx.account, {
            clientOrderId: String(target.clientOrderId),
            instrumentId: target.instrumentId,
          })
        } catch (e) {
          out.push({ target, ok: false, problem: this.problemOf(e) })
          continue
        }
        if (!found.found || found.venueOrderId === undefined) {
          out.push({
            target,
            ok: false,
            problem: makeProblem('VENUE_REJECTED', 'no open or recent order matches this clientOrderId; nothing to cancel', {
              venue: { id: 'gateio', message: `text=${String(target.clientOrderId)} not found` },
            }),
          })
          continue
        }
        venueOrderId = found.venueOrderId
      }
      const path = venueOrderId.startsWith('po:')
        ? `${PRICE_ORDERS_PATH}/${encodeURIComponent(venueOrderId.slice('po:'.length))}`
        : `${API_PREFIX}/orders/${encodeURIComponent(venueOrderId)}`
      try {
        await this.d.http.signed<unknown>('DELETE', path, {
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        out.push({ target, ok: true })
      } catch (e) {
        const problem = this.problemOf(e)
        // 单已不在场上（label 判定，不做文本匹配）：撤单目标已经不存在，算成功；内核随后 confirmCancel 核实终态。
        if (GONE_LABELS.has(String(problem.venue?.code ?? '').toUpperCase())) out.push({ target, ok: true })
        else out.push({ target, ok: false, problem })
      }
    }
    return out
  }

  /**
   * 全撤（原生）：Gate 按合约全撤 —— DELETE /futures/usdt/orders?contract= 与 DELETE /futures/usdt/price_orders?contract=。
   * 给 instrumentId 只撤该合约；不给就先读挂单（普通单 + 触发单）汇总出涉及的合约。
   * 每个合约两条 ack（普通单、触发单）。没有挂单时一条 ok:true（幂等语义）。
   */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    let contracts: string[]
    if (instrumentId !== undefined) contracts = [this.d.market.symbolOf(instrumentId)]
    else {
      let open: VenueOpenOrder[]
      try { open = await this.d.accounts.openOrders(ctx.account) } catch (e) { return [{ target: { instrumentId: '' }, ok: false, problem: this.problemOf(e) }] }
      contracts = [...new Set(open.map((o) => symbolOf(o.instrumentId)))]
      if (contracts.length === 0) return [{ target: { instrumentId: '' }, ok: true }]
    }
    const acks: CancelAck[] = []
    for (const contract of contracts) {
      const target: CancelTarget = { instrumentId: instrumentIdOf(contract) as InstrumentId }
      for (const path of [`${API_PREFIX}/orders`, PRICE_ORDERS_PATH]) {
        try {
          await this.d.http.signed<unknown>('DELETE', path, {
            params: { contract },
            order: true,
            kind: 'trade',
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          })
          acks.push({ target, ok: true })
        } catch (e) {
          acks.push({ target, ok: false, problem: this.problemOf(e) })
        }
      }
    }
    return acks
  }

  // ───────────── 改单 ─────────────

  /**
   * 改单：本连接器**不实现**（QD gate.py 没有 amend 实现，Gate 的 PUT /orders/{id} 未纳入；
   * 能力位 amend = 'none'）。一律 1004，由内核撤旧挂新。
   */
  async amend(_ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    const clientOrderId = String(req.clientOrderId ?? req.order.clientOrderId ?? newClientOrderId())
    const problem = makeProblem('ORDER_TYPE_UNSUPPORTED', 'Gate.io perpetual amend is not implemented in this connector; cancel and re-submit')
    return { acks: [this.rejectedAck(0, clientOrderId, problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
  }

  // ───────────── 保证金 / 杠杆 ─────────────

  /** 显式设杠杆（也用于切保证金模式：这是唯一允许切模式的地方）。 */
  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    const bad = this.checkLeverage(instrumentId, leverage)
    if (bad !== null) throw new ProblemError(bad)
    const mode = await this.d.accounts.positionMode()
    if (mode === '') {
      throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'could not read the Gate futures position mode; leverage not set', { retryable: true }))
    }
    if (mode === 'dual' || mode === 'dual_plus') {
      throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', `Gate.io account is in ${mode} position mode; this connector models one-way positions only`))
    }
    const problem = await this.postLeverage(this.d.market.symbolOf(instrumentId), leverage, marginMode, ctx.signal)
    if (problem !== null) throw new ProblemError(problem)
  }

  /** 杠杆取值检查（整数 1..125 且不超过合约 leverage_max；QD gate.py:884-892）。 */
  private checkLeverage(instrumentId: string, leverage: number): Problem | null {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      return makeProblem('INVALID_PARAMS', 'leverage must be an integer from 1 to 125')
    }
    const record = this.d.market.getRecord(instrumentId)
    const maxLeverage = record?.maxLeverage
    if (maxLeverage !== undefined && leverage > maxLeverage) {
      const contract = record?.symbol ?? symbolOf(instrumentId)
      return makeProblem('INVALID_PARAMS', `leverage ${leverage}x exceeds the ${contract} maximum ${maxLeverage}x`)
    }
    return null
  }

  /**
   * 开仓意图带了 leverage / marginMode：读现状、绝不切模式；模式不符 → INVALID_PARAMS + hint；
   * 只在杠杆不同时按现有模式改杠杆。
   */
  private async applyIntentMargin(intent: OrderIntent, built: BuiltOrder, signal?: AbortSignal): Promise<Problem | null> {
    if (intent.marginMode !== undefined && intent.marginMode !== 'cross' && intent.marginMode !== 'isolated') {
      return makeProblem('CAPABILITY_UNSUPPORTED', `margin mode ${intent.marginMode} is not available on Gate.io futures`)
    }
    if (intent.leverage !== undefined) {
      const bad = this.checkLeverage(intent.instrumentId, intent.leverage)
      if (bad !== null) return bad
    }
    let current: { mode: 'cross' | 'isolated'; leverage: number } | null
    try { current = await this.d.accounts.marginSetting(built.contract) } catch (e) { return this.problemOf(e) }
    if (current === null) {
      return makeProblem('INVALID_PARAMS', `${built.contract} has no margin setting on the venue yet; call setLeverage(instrumentId, leverage, marginMode) before sending orders with leverage / marginMode ${MARGIN_HINT}`)
    }
    if (intent.marginMode !== undefined && intent.marginMode !== current.mode) {
      return makeProblem('INVALID_PARAMS', `intent marginMode ${intent.marginMode} does not match the ${built.contract} position margin mode ${current.mode}; orders never switch margin mode ${MARGIN_HINT}`)
    }
    if (intent.leverage !== undefined && intent.leverage !== current.leverage) {
      return this.postLeverage(built.contract, intent.leverage, current.mode, signal)
    }
    return null
  }

  /**
   * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/gate.py:872-910; adapted.
   * POST /positions/{contract}/leverage，参数在 query：全仓 leverage=0 + cross_leverage_limit，逐仓 leverage=N；
   * 有效杠杆按模式取字段核对（QD gate.py:899-925）。返回 null = 成功，否则返回 Problem。
   */
  private async postLeverage(contract: string, leverage: number, mode: 'cross' | 'isolated', signal?: AbortSignal): Promise<Problem | null> {
    const params = mode === 'cross' ? { leverage: '0', cross_leverage_limit: String(leverage) } : { leverage: String(leverage) }
    try {
      const raw = await this.d.http.signed<{ cross_leverage_limit?: unknown; leverage?: unknown } | undefined>(
        'POST',
        `${API_PREFIX}/positions/${encodeURIComponent(contract)}/leverage`,
        {
          params,
          order: true,
          kind: 'trade',
          ...(signal ? { signal } : {}),
        },
      )
      const effectiveRaw = mode === 'cross' ? raw?.cross_leverage_limit : raw?.leverage
      if (effectiveRaw !== undefined && effectiveRaw !== null && String(effectiveRaw) !== '') {
        const effective = Number(effectiveRaw)
        if (!Number.isFinite(effective)) {
          return makeProblem('VENUE_REJECTED', `venue returned an invalid effective leverage: ${String(effectiveRaw)}`)
        }
        if (Math.round(effective) !== leverage) {
          return makeProblem('VENUE_REJECTED', `venue applied ${String(effective)}x instead of the requested ${leverage}x`, {
            venue: { id: 'gateio', message: `effective leverage ${String(effectiveRaw)}` },
          })
        }
      }
      return null
    } catch (e) {
      return this.problemOf(e)
    }
  }

  // ───────────── 场所级死人开关 ─────────────

  /** Gate 有 POST /futures/{settle}/countdown_cancel_all，本包未实现（QD 未用）：不假装支持，抛 5002 由内核的撤单循环兜。 */
  async scheduleCancel(_ctx: TradeContext, _atMs: number | null): Promise<void> {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Gate.io countdown cancel-all (POST /futures/{settle}/countdown_cancel_all) is not implemented in this connector (QD does not use it); keep the cancel loop in the kernel'))
  }

  // ───────────── 诊断 ─────────────

  /** 诊断：预算占用。 */
  budgetUsage(): ReturnType<GateHttp['usage']> {
    return this.d.http.usage()
  }

  /** 诊断：当前时刻（注入时钟）。 */
  now(): number {
    return this.clock()
  }

  /** 单张订单状态（透传 account）。 */
  status(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: string }): Promise<VenueOrderStatus> {
    return this.d.accounts.orderStatus(ref, key)
  }

  /** 诊断：Decimal 归一（测试断言用）。 */
  static decimalOf = decimalOf

  /** 诊断：一张订单的成交币数换算（测试断言用）。 */
  static toBase(contracts: string, contractSize: string): Decimal {
    return mulDec(absDec(decimalOf(contracts)), contractSize)
  }
}
