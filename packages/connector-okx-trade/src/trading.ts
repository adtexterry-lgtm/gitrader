// SPDX-License-Identifier: CPAL-1.0
// 交易：下单 / 撤单 / 全撤 / 改单 / 杠杆 / 场所级死人开关。连接器自己不会主动下单——所有方法都在内核发起的
// TradeContext 窗口里执行（契约 §3.6）。
//   · 签名是 HMAC（apiKey / apiSecret / passphrase 从构造参数进），不是签名器句柄：本模块**不使用** ctx.signer，
//     也不回调 ctx.onSigned（没有载荷摘要可写账本；README 里写明）。
//   · tpsl：OKX 没有 attach 式父子单，submit 对带 tpsl 的意图返回 1004，成交后补挂走 orders.buildProtectionOrders()
//     （两腿合成一条 OCO 算法单）。
//   · amend：只有普通 limit 单走 /trade/amend-order；算法单 / 市价单 1004。
//   · cancelAll：OKX 没有「一次撤掉我全部挂单」的端点 → 先枚举挂单，再 /trade/cancel-batch-orders（普通单，≤20 / 批）
//     与 /trade/cancel-algos（算法单，≤10 / 批）；能力位因此写 emulated。
//   · scheduleCancel：/trade/cancel-all-after 的 timeOut 是**场所级死人开关**（到点全撤，持仓不动），
//     atMs = null 时发 timeOut=0 清除；只接受 10–120 秒，不夹取。这是 OKX 原生能力，不是模拟。
//   · 回执 receiptHash = sha256(原始响应数组的 JSON)。
//   · 撤单 / 全撤逐行判 sCode：没有逐单结果或任一行失败都不得报成功。
import { createHash } from 'node:crypto'
import { makeProblem } from '@gitrader/protocol'
import type { InstrumentId, OrderIntent, Problem } from '@gitrader/protocol'
import type {
  AccountRef, AmendRequest, CancelAck, CancelTarget, OrderAck, StampedQuote, SubmitResult, TradeContext, VenueOpenOrder,
  VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { OKX_ENDPOINT_COSTS } from './budget'
import { asProblem, OkxHttpError, ProblemError } from './errors'
import type { OkxEnvelope } from './rest'
import { isUnknownOutcomeCode } from './venue-errors'
import { buildOrderParams, OrderBuildError, sanitizeClientOrderId } from './orders'
import type { BuiltOrderParams } from './orders'
import { decimalOf, symbolOf } from './parse'
import type { PendingRef } from './parse'
import type { InstrumentRecord } from './parse'
import type { OkxHttp } from './rest'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const jsonSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

/** 批量端点一次最多处理的单数（OKX：cancel-batch-orders 20，cancel-algos 10）。 */
export const CANCEL_BATCH_MAX = 20
export const CANCEL_ALGO_BATCH_MAX = 10
/** 死人开关的 timeOut 允许范围（秒）；OKX cancel-all-after 只收 10–120。 */
export const CANCEL_AFTER_MIN_SEC = 10
export const CANCEL_AFTER_MAX_SEC = 120

export type { PendingRef }

export interface TradingDeps {
  http: OkxHttp
  /** 标的记录（下单要用 ctVal / lotSz）。 */
  recordOf: (instrumentId: string) => InstrumentRecord | undefined
  clock?: () => number
  /** oneWay（缺省，= net_mode）/ hedge（= long_short_mode）。 */
  positionMode?: 'oneWay' | 'hedge'
  /** 密钥（脱敏用）。 */
  secrets?: readonly string[]
  /** 挂单读取（由 account.ts 提供，避免两处解析）。 */
  openOrders: (ref: AccountRef, instrumentId?: InstrumentId) => Promise<VenueOpenOrder[]>
  /** 撤单候选（由 account.ts 提供：普通单与算法单分开，批量端点要分开调）。 */
  pendingRefs: (instrumentId?: string) => Promise<{ orders: PendingRef[]; algos: PendingRef[] }>
  /** 单张订单状态（由 account.ts 提供）。 */
  orderStatus: (
    ref: AccountRef,
    key: { clientOrderId?: string; venueOrderId?: string },
    opts: { symbol: string; channel: 'order' | 'algo' },
  ) => Promise<VenueOrderStatus>
  /** 行情报价（市价带价用；由 connector 注入）。 */
  quoteOf?: (instrumentId: string) => StampedQuote | undefined
}

export interface RawOrderRow {
  ordId?: string
  clOrdId?: string
  algoId?: string
  algoClOrdId?: string
  sCode?: string
  sMsg?: string
  ts?: string
  tag?: string
}

interface PlacedRecord {
  instId: string
  channel: 'order' | 'algo'
  clientOrderId: string
  venueOrderId?: string
}

/** 逐行判 sCode；非 0 行转成 Problem（3006 仅对结果未知码）。 */
export function rowOutcomes(
  envelope: OkxEnvelope<RawOrderRow>,
  secrets: readonly string[],
): Array<{ row: RawOrderRow; problem: Problem | null }> {
  const rows = Array.isArray(envelope.data) ? envelope.data : []
  return rows.map((row) => {
    const sCode = row.sCode === undefined ? '0' : String(row.sCode)
    if (sCode === '0') return { row, problem: null }
    const problem = asProblem(
      new OkxHttpError(
        200, JSON.stringify(envelope), 'signed', envelope.code, sCode, row.sMsg,
        undefined, isUnknownOutcomeCode(sCode),
      ),
      { secrets, endpoint: 'signed' },
    )
    return { row, problem }
  })
}

export interface LeverageState {
  instrumentId: string
  leverage: number
  marginMode: 'cross' | 'isolated'
}

export class OkxTrading {
  #d: TradingDeps
  #positionMode: 'oneWay' | 'hedge'
  #secrets: readonly string[]
  #leverage = new Map<string, string>()
  // ponytail: 进程内 Map，重启后需调用方给 symbol；持久化等内核接入再做
  #placed = new Map<string, PlacedRecord>()

  constructor(d: TradingDeps) {
    this.#d = d
    this.#positionMode = d.positionMode ?? 'oneWay'
    this.#secrets = d.secrets ?? []
  }

  private remember(key: string, record: PlacedRecord): void {
    this.#placed.set(key, record)
    if (this.#placed.size > 10_000) {
      const oldest = this.#placed.keys().next().value
      if (oldest !== undefined) this.#placed.delete(oldest)
    }
  }

  private recordPlaced(clientOrderId: string, record: PlacedRecord): void {
    this.remember(`c:${clientOrderId}`, record)
    if (record.venueOrderId !== undefined && record.venueOrderId !== '') {
      this.remember(`v:${record.venueOrderId}`, record)
    }
  }

  private placedOf(key: { clientOrderId?: string; venueOrderId?: string }): PlacedRecord | undefined {
    if (key.venueOrderId !== undefined) {
      const hit = this.#placed.get(`v:${key.venueOrderId}`)
      if (hit !== undefined) return hit
    }
    if (key.clientOrderId !== undefined) return this.#placed.get(`c:${key.clientOrderId}`)
    return undefined
  }

  // ───────────── 下单 ─────────────

  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const raws: unknown[] = []
    let cost = 0

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!
      const clientOrderId = intent.clientOrderId !== undefined ? String(intent.clientOrderId) : undefined

      // OKX 没有 attach 式父子单：带 tpsl 的意图一律 1004（由内核在成交后调 buildProtectionOrders）
      if (intent.tpsl !== undefined) {
        acks.push(this.rejectedAck(i, clientOrderId ?? sanitizeClientOrderId(`gtrej${i}`), makeProblem(
          'ORDER_TYPE_UNSUPPORTED',
          'OKX has no attach-style parent-child orders; submit the parent alone and call buildProtectionOrders() after the fill',
        )))
        continue
      }
      if (intent.ocoGroupId !== undefined) {
        acks.push(this.rejectedAck(i, clientOrderId ?? sanitizeClientOrderId(`gtrej${i}`), makeProblem(
          'ORDER_TYPE_UNSUPPORTED',
          'ocoGroupId is not supported by submit; use buildProtectionOrders() for a native OCO pair',
        )))
        continue
      }

      let built: BuiltOrderParams
      try {
        const quote = this.#d.quoteOf?.(intent.instrumentId)
        const ref = quote === undefined
          ? undefined
          : { bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2, stale: quote.stale }
        built = buildOrderParams(intent, this.#d.recordOf(intent.instrumentId), {
          positionMode: this.#positionMode,
          ...(ref !== undefined ? { ref } : {}),
        })
      } catch (e) {
        if (!(e instanceof OrderBuildError)) throw e
        acks.push(this.rejectedAck(i, clientOrderId ?? `gtrej${i}`, e.problem))
        continue
      }

      // 发请求前就记：3006 也能按 clientOrderId 查到
      this.recordPlaced(built.clientOrderId, {
        instId: built.body.instId ?? '',
        channel: built.kind,
        clientOrderId: built.clientOrderId,
      })

      // 杠杆是仓位级设置：给了就先设（失败则单张不发出）
      if (intent.leverage !== undefined) {
        const mode = intent.marginMode === 'isolated' || intent.marginMode === 'strictIsolated' || intent.marginMode === 'noCross'
          ? 'isolated'
          : 'cross'
        const err = await this.ensureLeverage(intent.instrumentId, intent.leverage, mode)
        if (err !== null) {
          acks.push(this.rejectedAck(i, built.clientOrderId, err))
          continue
        }
      }

      try {
        const envelope = await this.#d.http.signed<RawOrderRow>('POST', built.path, {
          body: built.body,
          request: { order: true, kind: 'trade', cost: OKX_ENDPOINT_COSTS.order, ...(ctx.signal ? { signal: ctx.signal } : {}) },
        })
        raws.push(envelope)
        const outcomes = rowOutcomes(envelope, this.#secrets)
        const first = outcomes[0]
        if (first === undefined) {
          acks.push(this.problemAck(i, built.clientOrderId, makeProblem(
            'VENUE_OUTCOME_UNKNOWN',
            'order response carried no per-order result; reconcile by clientOrderId',
          )))
        } else if (first.problem === null) {
          this.rememberVenueId(built, first.row)
          acks.push(this.ackFrom(i, built, first.row))
        } else if (String(first.row.sCode ?? '') === '51016') {
          acks.push(await this.reconcile51016(ctx, i, built, first.row))
        } else {
          acks.push(this.problemAck(i, this.clientIdOf(built, first.row), first.problem))
        }
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        raws.push({ error: problem.name })
        acks.push(this.problemAck(i, built.clientOrderId, problem))
      }
      cost += OKX_ENDPOINT_COSTS.order
    }

    return { acks, receiptHash: sha256(JSON.stringify(raws, jsonSafe)), requestWeight: cost }
  }

  private rememberVenueId(built: BuiltOrderParams, row: RawOrderRow): void {
    const venueOrderId = built.kind === 'algo'
      ? (row.algoId !== undefined && row.algoId !== '' ? String(row.algoId) : undefined)
      : (row.ordId !== undefined && row.ordId !== '' ? String(row.ordId) : undefined)
    if (venueOrderId === undefined) return
    this.recordPlaced(built.clientOrderId, {
      instId: built.body.instId ?? '',
      channel: built.kind,
      clientOrderId: built.clientOrderId,
      venueOrderId,
    })
  }

  private clientIdOf(built: BuiltOrderParams, row: RawOrderRow | undefined): string {
    if (built.kind === 'algo') {
      return row?.algoClOrdId !== undefined && row.algoClOrdId !== ''
        ? row.algoClOrdId
        : row?.clOrdId !== undefined && row.clOrdId !== '' ? row.clOrdId : built.clientOrderId
    }
    return row?.clOrdId !== undefined && row.clOrdId !== '' ? row.clOrdId : built.clientOrderId
  }

  private async reconcile51016(ctx: TradeContext, index: number, built: BuiltOrderParams, row: RawOrderRow): Promise<OrderAck> {
    const clientOrderId = this.clientIdOf(built, row)
    const sMsg = row.sMsg ?? 'clOrdId already exists at the venue'
    try {
      const status = await this.status(ctx.account, { clientOrderId })
      if (status.found) {
        const state = status.status ?? ''
        const venueOrderId = status.venueOrderId ?? null
        const filledSize = status.filledSize ?? decimalOf('0')
        if (built.kind === 'algo' && (state === 'live' || state === 'pause')) {
          return {
            intentIndex: index, clientOrderId, venueOrderId, status: 'untriggered', filledSize, avgFillPrice: null, builder: { attached: false },
          }
        }
        if (built.kind === 'order' && (state === 'live' || state === 'partially_filled')) {
          return {
            intentIndex: index, clientOrderId, venueOrderId, status: 'open', filledSize, avgFillPrice: null, builder: { attached: false },
          }
        }
        if (built.kind === 'order' && state === 'filled') {
          return {
            intentIndex: index, clientOrderId, venueOrderId, status: 'filled', filledSize, avgFillPrice: null, builder: { attached: false },
          }
        }
      }
    } catch {
      // 查不到就按结果未知回，不盲目重发
    }
    const problem = makeProblem(
      'VENUE_OUTCOME_UNKNOWN',
      'clOrdId already exists at the venue (51016); reconcile by clientOrderId',
      { venue: { id: 'okx', code: '51016', message: sMsg } },
    )
    return this.problemAck(index, clientOrderId, problem)
  }

  private ackFrom(index: number, built: BuiltOrderParams, row: RawOrderRow | undefined): OrderAck {
    const venueOrderId = built.kind === 'algo'
      ? (row?.algoId !== undefined && row.algoId !== '' ? String(row.algoId) : null)
      : (row?.ordId !== undefined && row.ordId !== '' ? String(row.ordId) : null)
    return {
      intentIndex: index,
      clientOrderId: this.clientIdOf(built, row),
      venueOrderId,
      // 下单响应不带成交信息（QD okx.py:837-839 同样只能给 0）；触发类单在 OKX 里是「已挂、未触发」
      status: built.kind === 'algo' ? 'untriggered' : 'open',
      filledSize: decimalOf('0'),
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

  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const out: CancelAck[] = []
    for (const target of targets) {
      let instId: string
      try {
        instId = symbolOf(target.instrumentId)
      } catch (e) {
        out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) })
        continue
      }
      const record = this.placedOf(target)
      if (record?.channel === 'algo') {
        const algoId = target.venueOrderId ?? record.venueOrderId
        if (algoId === undefined || algoId === '') {
          out.push({
            target,
            ok: false,
            problem: makeProblem('INVALID_PARAMS', 'algo orders are cancelled by algoId; venueOrderId unknown'),
          })
          continue
        }
        try {
          const envelope = await this.#d.http.signed<RawOrderRow>('POST', '/api/v5/trade/cancel-algos', {
            body: [{ instId, algoId }],
            request: { order: true, kind: 'trade', cost: OKX_ENDPOINT_COSTS.cancelAlgos, ...(ctx.signal ? { signal: ctx.signal } : {}) },
          })
          out.push(this.cancelOutcome(target, rowOutcomes(envelope, this.#secrets)))
        } catch (e) {
          out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }) })
        }
        continue
      }
      const body: Record<string, string> = { instId }
      if (target.venueOrderId !== undefined) body.ordId = target.venueOrderId
      else if (target.clientOrderId !== undefined) body.clOrdId = String(target.clientOrderId)
      else {
        out.push({ target, ok: false, problem: makeProblem('INVALID_PARAMS', 'cancel needs venueOrderId or clientOrderId') })
        continue
      }
      try {
        const envelope = await this.#d.http.signed<RawOrderRow>('POST', '/api/v5/trade/cancel-order', {
          body,
          request: { order: true, kind: 'trade', cost: OKX_ENDPOINT_COSTS.cancelOrder, ...(ctx.signal ? { signal: ctx.signal } : {}) },
        })
        out.push(this.cancelOutcome(target, rowOutcomes(envelope, this.#secrets)))
      } catch (e) {
        out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }) })
      }
    }
    return out
  }

  private cancelOutcome(target: CancelTarget, outcomes: Array<{ problem: Problem | null }>): CancelAck {
    if (outcomes.length === 0) {
      return {
        target,
        ok: false,
        problem: makeProblem('VENUE_OUTCOME_UNKNOWN', 'cancel response carried no per-order result; query the order before retrying'),
      }
    }
    const failed = outcomes.find((o) => o.problem !== null)
    if (failed !== undefined && failed.problem !== null) return { target, ok: false, problem: failed.problem }
    return { target, ok: true }
  }

  /**
   * 全撤：给 instrumentId → 只撤这个标的；不给 → 撤账户下所有挂单。
   * OKX 没有「全撤」端点，所以先枚举（普通单 + 算法单），再分别走批量撤单端点。
   * 返回每个标的一条 ack（ok = 该标的的两批都成功）。
   */
  async cancelAll(ctx: TradeContext, instrumentId?: InstrumentId): Promise<CancelAck[]> {
    let instId: string | undefined
    if (instrumentId !== undefined) {
      try {
        instId = symbolOf(instrumentId)
      } catch (e) {
        return [{ target: { instrumentId: instrumentId ?? '' }, ok: false, problem: asProblem(e, { secrets: this.#secrets }) }]
      }
    }
    let refs: { orders: PendingRef[]; algos: PendingRef[] }
    try {
      refs = await this.#d.pendingRefs(instId)
      // 场所若不按 instId 过滤（或实现方传了空），这里再兜一次：只撤指定标的
      if (instId !== undefined) {
        refs = { orders: refs.orders.filter((r) => r.instId === instId), algos: refs.algos.filter((r) => r.instId === instId) }
      }
    } catch (e) {
      const target: CancelTarget = { instrumentId: instrumentId ?? '' }
      return [{ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) }]
    }
    const instIds = [...new Set([...refs.orders, ...refs.algos].map((r) => r.instId))]
    if (instIds.length === 0 && instId !== undefined) instIds.push(instId)

    const out: CancelAck[] = []
    for (const id of instIds) {
      const target: CancelTarget = { instrumentId: instrumentId ?? `okx:${id}` }
      const orders = refs.orders.filter((r) => r.instId === id)
      const algos = refs.algos.filter((r) => r.instId === id)
      let problem: Problem | null = null
      const apply = (outcomes: Array<{ problem: Problem | null }>, expected: number): void => {
        if (problem !== null) return
        if (outcomes.length < expected) {
          problem = makeProblem('VENUE_OUTCOME_UNKNOWN', 'cancel response carried no per-order result; query the order before retrying')
          return
        }
        const failures = outcomes.flatMap((o) => (o.problem === null ? [] : [o.problem]))
        if (failures.length > 0) {
          const first = failures[0]!
          problem = { ...first, message: `${failures.length} of ${expected} failed; ${first.message}` }
        }
      }
      for (const chunk of chunks(orders, CANCEL_BATCH_MAX)) {
        try {
          const envelope = await this.#d.http.signed<RawOrderRow>('POST', '/api/v5/trade/cancel-batch-orders', {
            body: chunk.map((r) => ({ instId: r.instId, ordId: r.venueOrderId })),
            request: { order: true, kind: 'trade', cost: OKX_ENDPOINT_COSTS.cancelBatch, ...(ctx.signal ? { signal: ctx.signal } : {}) },
          })
          apply(rowOutcomes(envelope, this.#secrets), chunk.length)
        } catch (e) {
          problem ??= asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        }
      }
      for (const chunk of chunks(algos, CANCEL_ALGO_BATCH_MAX)) {
        try {
          const envelope = await this.#d.http.signed<RawOrderRow>('POST', '/api/v5/trade/cancel-algos', {
            body: chunk.map((r) => ({ instId: r.instId, algoId: r.venueOrderId })),
            request: { order: true, kind: 'trade', cost: OKX_ENDPOINT_COSTS.cancelAlgos, ...(ctx.signal ? { signal: ctx.signal } : {}) },
          })
          apply(rowOutcomes(envelope, this.#secrets), chunk.length)
        } catch (e) {
          problem ??= asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
        }
      }
      out.push(problem === null ? { target, ok: true } : { target, ok: false, problem })
    }
    return out
  }

  // ───────────── 改单 ─────────────

  /**
   * 改单：只有普通 limit 单走 /trade/amend-order（改价 / 改量）。
   * 其它类型（含算法单、市价单）→ 1004，由内核撤旧挂新。
   */
  private amendIds(req: AmendRequest, row?: RawOrderRow): { clientOrderId: string; venueOrderId: string | null } {
    const cid = row?.clOrdId !== undefined && row.clOrdId !== ''
      ? row.clOrdId
      : (req.clientOrderId !== undefined
        ? String(req.clientOrderId)
        : (req.order.clientOrderId !== undefined ? String(req.order.clientOrderId) : ''))
    const vid = row?.ordId !== undefined && row.ordId !== ''
      ? String(row.ordId)
      : (req.venueOrderId ?? null)
    return { clientOrderId: cid, venueOrderId: vid }
  }

  async amend(ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    const baseIds = this.amendIds(req)
    if (req.order.type !== 'limit') {
      const problem = makeProblem(
        'ORDER_TYPE_UNSUPPORTED',
        `OKX only amends plain limit orders natively; ${req.order.type} must be canceled and re-submitted`,
      )
      return {
        acks: [this.rejectedAck(0, baseIds.clientOrderId, problem)],
        receiptHash: sha256(problem.message),
        requestWeight: 0,
      }
    }
    if (req.venueOrderId === undefined && req.clientOrderId === undefined) {
      const problem = makeProblem('INVALID_PARAMS', 'amend needs venueOrderId or clientOrderId')
      return { acks: [this.rejectedAck(0, baseIds.clientOrderId, problem)], receiptHash: sha256(problem.message), requestWeight: 0 }
    }
    let built: BuiltOrderParams
    try {
      built = buildOrderParams({ ...req.order, type: 'limit' }, this.#d.recordOf(req.instrumentId), { positionMode: this.#positionMode })
    } catch (e) {
      if (!(e instanceof OrderBuildError)) throw e
      return {
        acks: [this.rejectedAck(0, baseIds.clientOrderId, e.problem)],
        receiptHash: sha256(e.problem.message),
        requestWeight: 0,
      }
    }
    const body: Record<string, string> = { instId: built.body.instId ?? '' }
    if (req.venueOrderId !== undefined) body.ordId = req.venueOrderId
    else body.clOrdId = String(req.clientOrderId)
    body.newSz = built.body.sz ?? ''
    if (built.body.px !== undefined) body.newPx = built.body.px
    try {
      const envelope = await this.#d.http.signed<RawOrderRow>('POST', '/api/v5/trade/amend-order', {
        body,
        request: { kind: 'trade', cost: OKX_ENDPOINT_COSTS.amendOrder, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      })
      const outcomes = rowOutcomes(envelope, this.#secrets)
      const first = outcomes[0]
      if (first === undefined) {
        const ids = this.amendIds(req)
        return {
          acks: [this.problemAck(0, ids.clientOrderId, makeProblem(
            'VENUE_OUTCOME_UNKNOWN',
            'amend response carried no per-order result; query the order before retrying',
          ))],
          receiptHash: sha256(JSON.stringify(envelope, jsonSafe)),
          requestWeight: OKX_ENDPOINT_COSTS.amendOrder,
        }
      }
      if (first.problem !== null) {
        const ids = this.amendIds(req, first.row)
        return {
          acks: [this.problemAck(0, ids.clientOrderId, first.problem)],
          receiptHash: sha256(JSON.stringify(envelope, jsonSafe)),
          requestWeight: OKX_ENDPOINT_COSTS.amendOrder,
        }
      }
      const ids = this.amendIds(req, first.row)
      const ack: OrderAck = {
        intentIndex: 0,
        clientOrderId: ids.clientOrderId,
        venueOrderId: ids.venueOrderId,
        status: 'open',
        filledSize: decimalOf('0'),
        avgFillPrice: null,
        builder: { attached: false },
      }
      return { acks: [ack], receiptHash: sha256(JSON.stringify(envelope, jsonSafe)), requestWeight: OKX_ENDPOINT_COSTS.amendOrder }
    } catch (e) {
      const problem = asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
      return {
        acks: [this.problemAck(0, baseIds.clientOrderId, problem)],
        receiptHash: sha256(problem.venue?.message ?? problem.message),
        requestWeight: OKX_ENDPOINT_COSTS.amendOrder,
      }
    }
  }

  // ───────────── 查询 ─────────────

  openOrders(ref: AccountRef, instrumentId?: InstrumentId): Promise<VenueOpenOrder[]> {
    return this.#d.openOrders(ref, instrumentId)
  }

  async status(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }, opts: { symbol?: string } = {}): Promise<VenueOrderStatus> {
    const record = this.placedOf(key)
    if (record !== undefined) {
      return this.#d.orderStatus(ref, key, { symbol: record.instId, channel: record.channel })
    }
    if (opts.symbol !== undefined && opts.symbol !== '') {
      const order = await this.#d.orderStatus(ref, key, { symbol: opts.symbol, channel: 'order' })
      if (order.found) return order
      return this.#d.orderStatus(ref, key, { symbol: opts.symbol, channel: 'algo' })
    }
    throw new ProblemError(makeProblem(
      'INVALID_PARAMS',
      'orderStatus cannot locate this order (not submitted through this connector instance); pass opts.symbol',
    ))
  }

  // ───────────── 杠杆 / 保证金模式 ─────────────

  async setLeverage(ctx: TradeContext, instrumentId: InstrumentId, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    const err = await this.ensureLeverage(instrumentId, leverage, marginMode, ctx.signal)
    if (err !== null) throw new ProblemError(err)
  }

  /**
   * 杠杆是仓位级设置（QD okx.py:567-718 的 set-leverage）：POST /api/v5/account/set-leverage。
   * OKX 没有独立的「保证金模式」端点——tdMode 是随单发的，所以这里只设杠杆，mgnMode 一并带上。
   * 返回 null = 成功，否则返回 Problem（供 submit 把单张打回）。
   */
  private async ensureLeverage(instrumentId: string, leverage: number, marginMode: 'cross' | 'isolated', signal?: AbortSignal): Promise<Problem | null> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
      return makeProblem('INVALID_PARAMS', 'leverage must be an integer from 1 to 125')
    }
    const key = `${marginMode}|${leverage}`
    if (this.#leverage.get(instrumentId) === key) return null
    let instId: string
    try {
      instId = symbolOf(instrumentId)
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets })
    }
    const body: Record<string, string> = { instId, lever: String(leverage), mgnMode: marginMode }
    if (this.#positionMode === 'hedge') {
      // long_short_mode 下 OKX 要求 posSide；net_mode 下必须不带（QD okx.py:626-628 同口径）
      body.posSide = 'long'
    }
    try {
      await this.#d.http.signed<unknown>('POST', '/api/v5/account/set-leverage', {
        body,
        request: { kind: 'trade', cost: OKX_ENDPOINT_COSTS.setLeverage, ...(signal ? { signal } : {}) },
      })
      this.#leverage.set(instrumentId, key)
      return null
    } catch (e) {
      return asProblem(e, { secrets: this.#secrets, endpoint: 'signed' })
    }
  }

  /** 已设置的杠杆（诊断）。 */
  leverageState(): LeverageState[] {
    return [...this.#leverage.entries()].map(([instrumentId, value]) => {
      const [mode, lev] = value.split('|')
      return { instrumentId, leverage: Number(lev), marginMode: mode === 'isolated' ? 'isolated' : 'cross' }
    })
  }

  // ───────────── 场所级死人开关 ─────────────

  /**
   * /api/v5/trade/cancel-all-after 的 timeOut：秒数（0 = 清除）。
   * atMs = null → timeOut=0（解除）；否则只接受 10–120 秒，不夹取、不发请求。
   */
  async scheduleCancel(ctx: TradeContext, atMs: number | null): Promise<void> {
    const now = (this.#d.clock ?? (() => Date.now()))()
    const body: Record<string, string> = {}
    if (atMs === null) {
      body.timeOut = '0'
    } else {
      const seconds = Math.ceil((atMs - now) / 1000)
      if (seconds < CANCEL_AFTER_MIN_SEC || seconds > CANCEL_AFTER_MAX_SEC) {
        throw new ProblemError(makeProblem(
          'INVALID_PARAMS',
          'OKX cancel-all-after accepts 10-120 s from now (null disarms)',
        ))
      }
      body.timeOut = String(seconds)
    }
    try {
      await this.#d.http.signed<unknown>('POST', '/api/v5/trade/cancel-all-after', {
        body,
        request: { kind: 'trade', cost: OKX_ENDPOINT_COSTS.cancelAllAfter, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets, endpoint: 'signed' }))
    }
  }

  /** 诊断：预算占用（含下单计数）。 */
  budgetUsage(): ReturnType<OkxHttp['usage']> {
    return this.#d.http.usage()
  }

  /** 诊断：当前持仓模式（下单参数的 posSide 口径）。 */
  mode(): 'oneWay' | 'hedge' {
    return this.#positionMode
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
