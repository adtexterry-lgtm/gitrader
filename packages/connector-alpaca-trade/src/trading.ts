// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 改单（PATCH）/ 撤单（DELETE 单张）/ 全撤（官方 DELETE /v2/orders）/ 位置级保护（OCO）。
// 连接器自己不会主动下单——所有方法都在内核发起的 TradeContext 窗口里执行（契约 §3.6）。
// 端点出处（Trading API v2 官方 Orders 文档）：
//   POST   /v2/orders                      建单（body 见 orders.ts）
//   PATCH  /v2/orders/{order_id}           改单（只接受 qty / time_in_force / limit_price / stop_price / trail）
//   DELETE /v2/orders/{order_id}           撤单（204）
//   DELETE /v2/orders                      全撤（207 多状态，body = [{id, status}]）
//   GET    /v2/orders/{order_id}          查单（account.ts）
//   GET    /v2/orders:by_client_order_id  按客户端单号查（3006 对账的入口）
// 十二条教训落到本文件：
//   #2 全撤用官方 DELETE（不是逐张 POST 模拟）；假服务器按方法表回 405；
//   #3 非 GET 无响应 / 5xx / 上游含糊文本 → 3006，**只发一次**，ack.status='unknown'，交内核按 client_order_id 对账；
//   #9 做不到的（改带腿的单、改市价价带单、定时全撤）回 1004 / 5002，不假装；
//   #10 私有流保留执行 id（stream.ts），REST 成交保留活动 id（account.ts）。
import { createHash } from 'node:crypto'
import { makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type { InstrumentId, Ms, OrderIntent, Problem } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, OrderAck, SubmitResult, TradeContext, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import type { AlpacaAccounts } from './account'
import { orderWeight } from './budget'
import type { AlpacaAssets } from './catalog'
import { VENUE } from './constants'
import { ProblemError, asProblem, redactSecret } from './errors'
import { OrderBuildError, buildAmendBody, buildOrder, buildProtectionOrder } from './orders'
import type { BuiltOrder, ProtectionOrder, ProtectionRequest } from './orders'
import { ackStatusOf, mapOrderStatus, parseOrder } from './parse'
import { symbolOf } from './assets'
import type { OrderRow } from './parse'
import type { QuoteSource } from './quotes'
import type { AlpacaHttp } from './rest'
import { sessionStateAt } from './sessions'
import type { TradingCalendar } from './sessions'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

export interface TradingDeps {
  http: AlpacaHttp
  accounts: AlpacaAccounts
  assets: AlpacaAssets
  quotes?: QuoteSource
  /** 交易日历（启动时拉一次；空日历 = 任何时刻都按休市处理）。 */
  calendar: () => TradingCalendar
  clock?: () => number
  /** 盘前盘后是否允许（显式声明；协议 OrderIntent 没有该字段，见 REPORT）。 */
  extendedHours?: boolean
  refPriceMaxAgeMs?: number
  onWarn?: (message: string) => void
}

/** 位置级保护单的结果（逐条回报，不与其它腿互相掩盖）。 */
export interface ProtectionResult {
  ok: boolean
  clientOrderId: string
  venueOrderId?: string
  problem?: Problem
}

export class AlpacaTrading {
  readonly #secrets: readonly string[]
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
    const now = this.clock()
    const session = sessionStateAt(now, this.d.calendar())

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!
      const presetClientOrderId = intent.clientOrderId !== undefined && String(intent.clientOrderId) !== ''
        ? String(intent.clientOrderId)
        : `alpaca-rejected-${i}`
      // 请求发出后、响应解析前的任何异常（parseOrder 的 TypeError 等）都意味着「单已发出但回执读不懂」= 3006。
      let responded = false
      try {
        const symbol = symbolOf(intent.instrumentId)
        const asset = await this.d.assets.ensure(intent.instrumentId, ctx.signal ? { signal: ctx.signal } : {})
        // 八条 #6：账户限制先读（冻结就整批拒，不发任何单）。
        const restrictions = await this.d.accounts.restrictions(ctx.account)
        let heldLongQty: string | null = null
        if (intent.side === 'sell') {
          try {
            heldLongQty = await this.d.accounts.heldLongQty(ctx.account, intent.instrumentId)
          } catch {
            // 持仓读不到 → null，orders.ts 会因为「无法确认归属」拒掉卖单（fail closed）。
            heldLongQty = null
          }
        }
        const ref = intent.type === 'market' || intent.notional !== undefined
          ? await this.d.quotes?.latest(symbol, ctx.signal ? { signal: ctx.signal } : {})
          : undefined
        const built = buildOrder(intent, {
          asset,
          session,
          ...(ref !== undefined ? { ref } : {}),
          heldLongQty,
          shortingEnabled: restrictions.shortingEnabled,
          extendedHoursAllowed: this.d.extendedHours ?? false,
          accountBlocked: restrictions.tradingBlocked || restrictions.accountBlocked,
          ...(this.d.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: this.d.refPriceMaxAgeMs } : {}),
          now,
        })
        for (const warning of built.warnings) this.warn(warning)
        // 发请求之前先记住：即便 3006，查单时也知道这张单的 order_class。
        this.d.accounts.remember([built.clientOrderId], { symbol, orderClass: built.orderClass, source: 'submit' })
        const payload = await this.d.http.request<unknown>('POST', '/v2/orders', {
          body: built.body,
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        weight += orderWeight()
        responded = true
        const row = parseOrder(payload)
        raws.push(row.raw)
        this.d.accounts.remember([row.id, row.clientOrderId], { symbol: row.symbol, orderClass: row.orderClass, source: 'submit' })
        acks.push(this.ackFromRow(i, row, built))
      } catch (e) {
        // 请求已发出且场所回了 2xx，但回执读不出订单号（parseOrder 的 TypeError）：这不是「拒单」，是「结果未知」。
        // 报 rejected 会让内核重发 → 重复开仓；必须 3006，交内核按 client_order_id 对账。
        const problem = e instanceof OrderBuildError
          ? e.problem
          : responded
            ? makeProblem('VENUE_OUTCOME_UNKNOWN',
              'alpaca answered the order request but the response could not be read; query by client_order_id before retrying',
              { venue: { id: VENUE, message: redactSecret(e instanceof Error ? e.message : String(e), this.#secrets).slice(0, 200) } })
            : this.problemOf(e)
        raws.push({ error: problem.name })
        acks.push(this.problemAck(i, presetClientOrderId, problem))
      }
    }
    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: weight }
  }

  private ackFromRow(index: number, row: OrderRow, built: BuiltOrder): OrderAck {
    const role: OrderAck['role'] = built.orderClass === 'bracket' || built.orderClass === 'oto' ? 'parent' : undefined
    return {
      intentIndex: index,
      clientOrderId: row.clientOrderId === '' ? built.clientOrderId : row.clientOrderId,
      venueOrderId: row.id,
      status: ackStatusOf(row.status),
      filledSize: normalizeDecimal(row.filledQty),
      avgFillPrice: row.filledAvgPrice === null ? null : normalizeDecimal(row.filledAvgPrice),
      builder: { attached: false },
      ...(role !== undefined ? { role } : {}),
    }
  }

  private rejectedAck(index: number, clientOrderId: string, problem: Problem, status: OrderAck['status'] = 'rejected'): OrderAck {
    return {
      intentIndex: index,
      clientOrderId,
      venueOrderId: null,
      status,
      filledSize: normalizeDecimal('0'),
      avgFillPrice: null,
      builder: { attached: false },
      problem,
    }
  }

  private problemAck(index: number, clientOrderId: string, problem: Problem): OrderAck {
    // 3006：请求已发出，结果未知——不得重发，交内核按 clientOrderId 查。
    return this.rejectedAck(index, clientOrderId, problem, problem.code === 3006 ? 'unknown' : 'rejected')
  }

  // ───────────── 撤单 ─────────────

  /** 撤单：有 venueOrderId 直接 DELETE；只有 clientOrderId 就先按官方端点查到 id。 */
  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = []
    for (const target of targets) {
      const venueOrderId = target.venueOrderId !== undefined && String(target.venueOrderId) !== '' ? String(target.venueOrderId) : undefined
      const clientOrderId = target.clientOrderId !== undefined && String(target.clientOrderId) !== '' ? String(target.clientOrderId) : undefined
      if (venueOrderId === undefined && clientOrderId === undefined) {
        out.push({ target, ok: false, problem: makeProblem('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId') })
        continue
      }
      let id = venueOrderId
      if (id === undefined) {
        try {
          const status = await this.d.accounts.orderStatus(ctx.account, { clientOrderId: clientOrderId! })
          if (!status.found || status.venueOrderId === undefined) {
            out.push({
              target,
              ok: false,
              problem: makeProblem('VENUE_REJECTED', `no order with client_order_id ${clientOrderId} at the venue`, {
                venue: { id: VENUE, message: 'order not found for client_order_id' },
              }),
            })
            continue
          }
          id = status.venueOrderId
        } catch (e) {
          out.push({ target, ok: false, problem: this.problemOf(e) })
          continue
        }
      }
      try {
        await this.d.http.request<unknown>('DELETE', `/v2/orders/${encodeURIComponent(id)}`, {
          order: true,
          kind: 'trade',
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        out.push({ target, ok: true })
      } catch (e) {
        out.push({ target, ok: false, problem: this.problemOf(e) })
      }
    }
    return out
  }

  /**
   * 全撤：官方 `DELETE /v2/orders`（教训 2：不逐张 POST 模拟）。
   * 给了 instrumentId：先按标的列挂单，再逐张 DELETE（官方该端点没有标的过滤参数，不假装有）；
   * 不给：直接全撤，按 207 多状态逐行核结果。
   */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    if (instrumentId !== undefined) {
      const target: CancelTarget = { instrumentId }
      let open
      try {
        open = await this.d.accounts.openOrders(ctx.account, instrumentId)
      } catch (e) {
        return [{ target, ok: false, problem: this.problemOf(e) }]
      }
      const failures: Problem[] = []
      for (const order of open) {
        try {
          await this.d.http.request<unknown>('DELETE', `/v2/orders/${encodeURIComponent(order.venueOrderId)}`, {
            order: true, kind: 'trade', ...(ctx.signal ? { signal: ctx.signal } : {}),
          })
        } catch (e) {
          failures.push(this.problemOf(e))
        }
      }
      if (failures.length === 0) return [{ target, ok: true }]
      const first = failures[0]!
      return [{ target, ok: false, problem: { ...first, message: `${failures.length} of ${open.length} cancels failed; ${first.message}` } }]
    }

    const target: CancelTarget = { instrumentId: '' }
    let payload: unknown
    try {
      payload = await this.d.http.request<unknown>('DELETE', '/v2/orders', {
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    } catch (e) {
      return [{ target, ok: false, problem: this.problemOf(e) }]
    }
    if (!Array.isArray(payload)) return [{ target, ok: true }]
    const rows = payload.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row))
    const failed = rows.filter((row) => Number(row['status'] ?? 0) !== 200 && Number(row['status'] ?? 0) !== 204)
    if (failed.length === 0) return [{ target, ok: true }]
    const first = failed[0]!
    return [{
      target,
      ok: false,
      problem: makeProblem('VENUE_REJECTED', `${failed.length} of ${rows.length} cancels failed on DELETE /v2/orders`, {
        venue: { id: VENUE, code: String(first['status'] ?? ''), message: `order ${String(first['id'] ?? '')} could not be canceled` },
      }),
    }]
  }

  // ───────────── 改单 ─────────────

  /** 改单（PATCH /v2/orders/{order_id}）：带腿的单与市价价带单一律 1004（见 orders.ts 的裁定）。 */
  async amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    const venueOrderId = req.venueOrderId !== undefined && String(req.venueOrderId) !== '' ? String(req.venueOrderId) : undefined
    const clientOrderId = req.clientOrderId !== undefined && String(req.clientOrderId) !== '' ? String(req.clientOrderId) : undefined
    const fallbackId = clientOrderId ?? String(req.order.clientOrderId ?? 'alpaca-amend')
    const rejected = (problem: Problem): SubmitResult => ({
      // 3006：PATCH 已发出、结果未知 —— 不重发，交内核按 clientOrderId 对账。
      acks: [this.rejectedAck(0, fallbackId, problem, problem.code === 3006 ? 'unknown' : 'rejected')],
      receiptHash: sha256(problem.message),
      requestWeight: 0,
    })
    if (venueOrderId === undefined && clientOrderId === undefined) {
      return rejected(makeProblem('INVALID_PARAMS', 'amend needs venueOrderId or clientOrderId'))
    }
    const known = this.d.accounts.known(venueOrderId) ?? this.d.accounts.known(clientOrderId)
    let orderClass = known?.orderClass ?? 'simple'
    let id = venueOrderId
    if (id === undefined || known === undefined) {
      try {
        const status = await this.d.accounts.orderStatus(ctx.account, {
          ...(venueOrderId !== undefined ? { venueOrderId } : {}),
          ...(clientOrderId !== undefined ? { clientOrderId } : {}),
        })
        if (!status.found || status.venueOrderId === undefined) {
          return rejected(makeProblem('VENUE_REJECTED', 'no order with this id at the venue; nothing to amend', {
            venue: { id: VENUE, message: 'order not found' },
          }))
        }
        id = status.venueOrderId
        const raw = status.raw
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          orderClass = String((raw as Record<string, unknown>)['order_class'] ?? orderClass)
        }
      } catch (e) {
        return rejected(this.problemOf(e))
      }
    }
    try {
      const asset = await this.d.assets.ensure(req.instrumentId, ctx.signal ? { signal: ctx.signal } : {})
      const restrictions = await this.d.accounts.restrictions(ctx.account)
      let heldLongQty: string | null = null
      if (req.order.side === 'sell') {
        try {
          heldLongQty = await this.d.accounts.heldLongQty(ctx.account, req.instrumentId)
        } catch {
          heldLongQty = null
        }
      }
      const ref = req.order.notional !== undefined
        ? await this.d.quotes?.latest(asset.symbol, ctx.signal ? { signal: ctx.signal } : {})
        : undefined
      const built = buildAmendBody(req.order, {
        asset,
        orderClass,
        heldLongQty,
        shortingEnabled: restrictions.shortingEnabled,
        session: sessionStateAt(this.clock(), this.d.calendar()),
        accountBlocked: restrictions.tradingBlocked || restrictions.accountBlocked,
        ...(ref !== undefined ? { ref } : {}),
        ...(this.d.refPriceMaxAgeMs !== undefined ? { refPriceMaxAgeMs: this.d.refPriceMaxAgeMs } : {}),
      })
      for (const warning of built.warnings) this.warn(warning)
      const payload = await this.d.http.request<unknown>('PATCH', `/v2/orders/${encodeURIComponent(id)}`, {
        body: built.body,
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      const row = parseOrder(payload)
      this.d.accounts.remember([row.id, row.clientOrderId], { symbol: row.symbol, orderClass: row.orderClass, source: 'submit' })
      // Alpaca replace 返回新订单：把新 id / 新 client id 映回原 client id，内核的追踪键不变。
      const originalClientOrderId = this.d.accounts.originalClientOrderId(clientOrderId) ?? clientOrderId ?? fallbackId
      this.d.accounts.alias([row.id, row.clientOrderId], originalClientOrderId)
      return {
        acks: [{
          intentIndex: 0,
          clientOrderId: originalClientOrderId,
          venueOrderId: row.id,
          status: ackStatusOf(row.status),
          filledSize: normalizeDecimal(row.filledQty),
          avgFillPrice: row.filledAvgPrice === null ? null : normalizeDecimal(row.filledAvgPrice),
          builder: { attached: false },
        }],
        receiptHash: sha256(JSON.stringify(row.raw, jsonSafe)),
        requestWeight: orderWeight(),
      }
    } catch (e) {
      const problem = e instanceof OrderBuildError ? e.problem : this.problemOf(e)
      return rejected(problem)
    }
  }

  // ───────────── 位置级保护（OCO）─────────────

  /**
   * 成交后补挂位置级 TP / SL：Alpaca 的原生形式是 `order_class=oco` 的两条平仓单（官方 Orders 文档）。
   * 只平多（side=sell）；融券空头的保护单不在本批次范围（README 写明）。
   */
  async placeProtection(ctx: TradeContext, req: ProtectionRequest): Promise<ProtectionResult[]> {
    let built: ProtectionOrder
    try {
      built = buildProtectionOrder(req)
    } catch (e) {
      throw e instanceof OrderBuildError ? new ProblemError(e.problem) : e
    }
    try {
      const payload = await this.d.http.request<unknown>('POST', '/v2/orders', {
        body: built.body,
        order: true,
        kind: 'trade',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      const row = parseOrder(payload)
      this.d.accounts.remember([row.id, row.clientOrderId], { symbol: row.symbol, orderClass: row.orderClass, source: 'protection' })
      return [{ ok: true, clientOrderId: row.clientOrderId === '' ? built.clientOrderId : row.clientOrderId, venueOrderId: row.id }]
    } catch (e) {
      return [{ ok: false, clientOrderId: built.clientOrderId, problem: this.problemOf(e) }]
    }
  }

  // ───────────── 对账 / 诊断 ─────────────

  /** 3006 之后的唯一正确动作：按 client_order_id 查真实状态（不重发）。 */
  reconcile(ctx: TradeContext, clientOrderId: string): Promise<VenueOrderStatus> {
    return this.d.accounts.orderStatus(ctx.account, { clientOrderId })
  }

  /** 原生状态 → 协议状态（导出给测试断言全表）。 */
  mapStatus(raw: string | undefined): ReturnType<typeof mapOrderStatus> {
    return mapOrderStatus(raw)
  }

  /** 诊断：当前时段（注入时钟）。 */
  session(): ReturnType<typeof sessionStateAt> {
    return sessionStateAt(this.clock(), this.d.calendar())
  }

  /** 诊断：当前时刻。 */
  now(): Ms {
    return this.clock()
  }

  /** Alpaca 没有「到点全撤」的端点：不假装支持，抛 5002 由内核的撤单循环兜（八条 #8）。 */
  async scheduleCancel(_ctx: TradeContext, _atMs: Ms | null): Promise<void> {
    throw new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', 'Alpaca Trading API has no scheduled cancel-all endpoint; keep the cancel loop in the kernel'))
  }

  /** 账户引用透传（诊断）。 */
  static refOf(ref: AccountRef): AccountRef {
    return ref
  }
}
