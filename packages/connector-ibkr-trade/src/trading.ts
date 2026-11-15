// SPDX-License-Identifier: CPAL-1.0
// 交易：submit / cancel / cancelAll / amend + 「结果未知」对账。
// 参照 ib_async client.py / decoder.py（BSD-2-Clause）的字段语义；未复制源码。
// 硬规矩：
//   · 单号发号只用会话的 nextValidId（IB 服务端发号）；orderRef 用确定性映射（orders.orderRefOf）；
//   · 每张意图构建前取本账户持仓 + 本账户挂单，算可卖量；不用缓存；
//   · 等回执 = 该 orderId 的第一条 orderStatus（任何状态）或 openOrder；只有非警告错误才算拒；
//   · 下单后没收到任何回执就断线 / 超时 → 3006 VENUE_OUTCOME_UNKNOWN（不可重试），恢复后按 orderRef 对账；
//   · amend 一律 1004（IB 无原生改单）；
//   · 全撤逐张走 cancel()，不调用 reqGlobalCancel。
import { createHash, randomBytes } from 'node:crypto'
import { asDecimal } from '@gitrader/protocol'
import type { Decimal, Ms, OrderIntent } from '@gitrader/protocol'
import { makeProblem } from '@gitrader/protocol'
import type { Problem } from '@gitrader/protocol'
import { cmpDec, subDec } from '@gitrader/protocol/decimal'
import type { AccountRef, AmendRequest, CancelAck, CancelTarget, SubmitResult, TradeContext, OrderAck } from '@gitrader/protocol/connector'
import type { IbkrAccounts } from './account'
import { isTerminalState } from './account'
import type { InstrumentBook } from './contracts'
import { IbError, problemForIbError } from './errors'
import { VENUE } from './ids'
import * as M from './messages'
import type { IbOpenOrder, IbOrderStatus } from './messages'
import { buildOrders, clientOrderIdFromOrderRef, orderRefOf } from './orders'
import type { BuiltLeg } from './orders'
import type { IbSession } from './session'

export interface IbkrTradingOptions {
  session: IbSession
  book: InstrumentBook
  accounts: IbkrAccounts
  clock?: () => number
  /** 等单回执的超时（ms，缺省 5000）。超时 = 结果未知（3006）。 */
  ackTimeoutMs?: number
  referencePrice?: (instrumentId: string) => number | undefined
  marketErrorCode?: () => number | undefined
  allowExtendedHours?: boolean
  onWarn?: (message: string) => void
}

export interface UnknownOrder {
  clientOrderId: string
  orderRef: string
  orderId: number
  instrumentId: string
  ts: number
  problem: Problem
}

interface AckResult {
  status?: IbOrderStatus
  open?: IbOpenOrder
  error?: { code: number; message: string }
}

interface GateSnapshot {
  available: Map<string, Decimal>
  short: Map<string, Decimal>
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** IB 的订单状态 → 协议 ack 状态（不翻译成内核状态，只做 ack 归并）。 */
export function ackStatusOf(ibStatus: string): OrderAck['status'] {
  switch (ibStatus.toLowerCase()) {
    case 'filled':
      return 'filled'
    case 'apicancelled':
    case 'cancelled':
    case 'inactive':
      return 'rejected'
    default:
      return 'open'
  }
}

export class IbkrTrading {
  readonly #session: IbSession
  readonly #book: InstrumentBook
  readonly #accounts: IbkrAccounts
  readonly #clock: () => number
  readonly #ackTimeoutMs: number
  readonly #referencePrice: ((id: string) => number | undefined) | undefined
  readonly #marketErrorCode: (() => number | undefined) | undefined
  readonly #allowExtendedHours: boolean
  readonly #onWarn: (m: string) => void
  readonly #unknown = new Map<string, UnknownOrder>()
  readonly #statuses = new Map<number, IbOrderStatus>()
  readonly #openOrders = new Map<number, IbOpenOrder>()
  readonly #errors = new Map<number, { code: number; message: string }>()
  readonly #cancelling = new Set<number>()

  constructor(o: IbkrTradingOptions) {
    this.#session = o.session
    this.#book = o.book
    this.#accounts = o.accounts
    this.#clock = o.clock ?? (() => Date.now())
    this.#ackTimeoutMs = o.ackTimeoutMs ?? 5000
    this.#referencePrice = o.referencePrice
    this.#marketErrorCode = o.marketErrorCode
    this.#allowExtendedHours = o.allowExtendedHours ?? false
    this.#onWarn = o.onWarn ?? (() => {})
    this.#session.on({
      orderStatus: (s) => {
        this.#statuses.set(s.orderId, s)
        const ref = this.#accounts.ledger.getByOrderId(s.orderId)?.ref
        if (ref !== undefined && this.#unknown.has(ref)) this.#unknown.delete(ref)
      },
      openOrder: (o) => {
        this.#openOrders.set(o.orderId, o)
      },
      error: (e) => {
        if (!e.info) this.#errors.set(e.reqId, { code: e.code, message: e.message })
      },
    })
  }

  /** 结果未知的单（3006 待对账）。 */
  unknownOrders(): UnknownOrder[] {
    return [...this.#unknown.values()]
  }

  /** 已见到的最新状态（按 IB orderId）。 */
  statusOf(orderId: number): IbOrderStatus | undefined {
    return this.#statuses.get(orderId)
  }

  /** 本进程正在撤这张单（202 撤单确认不是告警）。 */
  isCancelling(orderId: number): boolean {
    return this.#cancelling.has(orderId)
  }

  /** 本账户持仓 + 挂单 → 可卖量 / 空头量（每次 submit 重新取，不用缓存）。 */
  async #loadGate(): Promise<GateSnapshot> {
    const available = new Map<string, Decimal>()
    const short = new Map<string, Decimal>()
    const accountId = this.#accounts.accountId
    for (const p of await this.#accounts.positions()) {
      const signed = p.side === 'long' ? p.size : asDecimal(String(-Number(p.size)))
      available.set(p.instrumentId, (available.get(p.instrumentId) ?? asDecimal('0')))
      if (p.side === 'long') available.set(p.instrumentId, signed)
      else short.set(p.instrumentId, p.size)
    }
    for (const o of await this.#accounts.openOrderRows()) {
      if (accountId !== '' && o.account !== accountId) continue
      if (isTerminalState(this.#statuses.get(o.orderId)?.status ?? o.status)) continue
      if (o.action !== 'SELL') continue
      const instrumentId = `${VENUE}:${o.contract.symbol.toUpperCase()}`
      const filled = this.#statuses.get(o.orderId)?.filled
      const remaining = subDec(o.totalQuantity, filled ?? '0')
      const prev = available.get(instrumentId) ?? asDecimal('0')
      available.set(instrumentId, subDec(prev, remaining))
    }
    return { available, short }
  }

  async submit(_ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const acks: OrderAck[] = []
    const sent: string[] = []
    const gate = await this.#loadGate()
    for (let i = 0; i < intents.length; i += 1) {
      const intent = intents[i]!
      const record = this.#book.require(intent.instrumentId)
      const instrumentId = record.instrument.instrumentId
      let built
      try {
        let next = this.#session.nextOrderId
        built = buildOrders(intent, {
          record,
          now: this.#clock(),
          account: this.#accounts.accountId,
          clientId: this.#session.clientId,
          referencePrice: this.#referencePrice?.(instrumentId),
          marketErrorCode: this.#marketErrorCode?.(),
          positionSize: gate.available.get(instrumentId) ?? asDecimal('0'),
          shortPositionSize: gate.short.get(instrumentId) ?? asDecimal('0'),
          allowExtendedHours: this.#allowExtendedHours,
          restrictions: this.#accounts.accountRestrictions(),
          nextOrderId: () => {
            if (next <= 0) {
              throw IbError.of(
                'VENUE_UNAVAILABLE',
                'IBKR session has not issued a valid order id yet (nextValidId)',
                '等连接完成（nextValidId 到达）再下单；本包不自己编 orderId',
              )
            }
            return next++
          },
          newClientOrderId: () => randomBytes(16).toString('hex'),
        })
        // 本次意图用掉的号一次性登记（同一 submit 里的下一张意图从这里继续）。
        this.#session.reserveOrderId(next - 1)
      } catch (e) {
        const problem = problemOf(e)
        acks.push({
          intentIndex: i,
          clientOrderId: intent.clientOrderId ?? '',
          venueOrderId: null,
          status: 'rejected',
          filledSize: asDecimal('0'),
          avgFillPrice: null,
          builder: { attached: false },
          problem,
        })
        continue
      }
      for (const leg of built.legs) {
        this.#accounts.ledger.note(leg.order.orderRef, leg.order.orderId, instrumentId, this.#clock(), intent.side, leg.order.totalQuantity, leg.role)
      }
      const wire = built.legs.map((leg) => M.placeOrder(record.contractDetails.contract, leg.order))
      try {
        for (const buf of wire) {
          sent.push(buf.toString('base64'))
          await this.#session.send(buf)
        }
        // bracket：先等父单的第一条回执，再在同一超时内等各子单的第一条回执。
        const ackDeadline = Date.now() + this.#ackTimeoutMs
        const results: AckResult[] = []
        results.push(await this.#awaitAck(built.legs[0]!.order.orderId, ackDeadline))
        for (const leg of built.legs.slice(1)) {
          try {
            results.push(await this.#awaitAck(leg.order.orderId, ackDeadline))
          } catch {
            // 只有父单没回执才 3006；子单等不到 → untriggered + venueOrderId null。
            results.push({})
          }
        }
        acks.push(...this.#toAcks(i, built.legs, instrumentId, results))
        // 本次已发出的 SELL 占用可卖量（bracket 父单为 BUY 时，它的子单不计）。
        if (built.legs[0]!.order.action === 'SELL') {
          const prev = gate.available.get(instrumentId) ?? asDecimal('0')
          gate.available.set(instrumentId, subDec(prev, built.legs[0]!.order.totalQuantity))
        }
      } catch (e) {
        const problem = unknownProblem(instrumentId, built.clientOrderId, e)
        for (const leg of built.legs) {
          this.#unknown.set(leg.order.orderRef, {
            clientOrderId: built.clientOrderId,
            orderRef: leg.order.orderRef,
            orderId: leg.order.orderId,
            instrumentId,
            ts: this.#clock(),
            problem,
          })
        }
        acks.push({
          intentIndex: i,
          clientOrderId: built.clientOrderId,
          venueOrderId: null,
          status: 'unknown',
          filledSize: asDecimal('0'),
          avgFillPrice: null,
          builder: { attached: false },
          role: built.legs.length > 1 ? 'parent' : undefined,
          problem,
        })
      }
    }
    return { acks, receiptHash: sha256(JSON.stringify({ venue: VENUE, frames: sent })), requestWeight: sent.length }
  }

  /** 等某张单的第一条回执：orderStatus（任何状态）或 openOrder；超时 / 断线抛（submit 转 3006）。 */
  async #awaitAck(orderId: number, deadline = Date.now() + this.#ackTimeoutMs): Promise<AckResult> {
    let openAt: number | undefined
    for (;;) {
      const status = this.#statuses.get(orderId)
      const open = this.#openOrders.get(orderId)
      const error = this.#errors.get(orderId)
      if (status !== undefined) {
        return { status, ...(open !== undefined ? { open } : {}), ...(error !== undefined ? { error } : {}) }
      }
      if (open !== undefined) {
        if (openAt === undefined) openAt = Date.now()
        // openOrder 与 orderStatus 通常成对到达；给 status 一点时间以带上 filled / permId。
        if (Date.now() - openAt >= 20) return { open, ...(error !== undefined ? { error } : {}) }
      }
      // 只有没有任何 orderStatus / openOrder 时，错误才用来判拒。
      if (error !== undefined) return { error }
      if (Date.now() >= deadline) {
        throw IbError.of(
          'VENUE_UNAVAILABLE',
          `IBKR order ${String(orderId)} produced no ack within ${String(this.#ackTimeoutMs)} ms`,
          '不要重发订单；先按 orderRef 查挂单与成交',
        )
      }
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  #toAcks(intentIndex: number, legs: BuiltLeg[], instrumentId: string, results: AckResult[]): OrderAck[] {
    const parent = legs[0]!
    const parentResult = results[0] ?? {}
    const parentStatus = parentResult.status
    const parentOpen = parentResult.open
    const statusText = parentStatus?.status ?? parentOpen?.status ?? ''
    const filledText = parentStatus?.filled ?? '0'
    const hasFill = cmpDec(filledText, '0') > 0
    let mapped: OrderAck['status'] = ackStatusOf(statusText)
    if (parentResult.error !== undefined && statusText === '') mapped = 'rejected'
    if (['cancelled', 'apicancelled', 'inactive'].includes(statusText.toLowerCase()) && hasFill) mapped = 'open'
    const permId = parentStatus?.permId ?? parentOpen?.permId ?? 0
    const problem =
      mapped === 'rejected'
        ? parentResult.error !== undefined
          ? problemForIbError(parentResult.error.code, parentResult.error.message).problem
          : cancelledProblem(instrumentId, parent.order.orderId, statusText, parentStatus)
        : undefined
    const out: OrderAck[] = [
      {
        intentIndex,
        clientOrderId: parent.clientOrderId,
        venueOrderId: permId !== 0 ? String(permId) : null,
        status: mapped,
        filledSize: asDecimal(filledText),
        avgFillPrice: hasFill ? (parentStatus?.avgFillPrice ?? null) : null,
        builder: { attached: false },
        ...(legs.length > 1 ? { role: 'parent' as const } : {}),
        ...(problem !== undefined ? { problem } : {}),
      },
    ]
    for (let i = 1; i < legs.length; i += 1) {
      const leg = legs[i]!
      const result = results[i] ?? {}
      const childStatus = result.status?.status ?? result.open?.status ?? 'PreSubmitted'
      const childPerm = result.status?.permId ?? result.open?.permId ?? 0
      const rejected = result.error !== undefined || childStatus.toLowerCase() === 'inactive'
      out.push({
        intentIndex,
        clientOrderId: leg.clientOrderId,
        venueOrderId: childPerm !== 0 ? String(childPerm) : null,
        status: rejected ? 'rejected' : 'untriggered',
        filledSize: asDecimal('0'),
        avgFillPrice: null,
        builder: { attached: false },
        role: leg.role === 'tp' ? 'tp' : 'sl',
        ...(rejected
          ? {
              problem:
                result.error !== undefined
                  ? problemForIbError(result.error.code, result.error.message).problem
                  : cancelledProblem(instrumentId, leg.order.orderId, childStatus, result.status),
            }
          : {}),
      })
    }
    return out
  }

  async cancel(_ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    const acks: CancelAck[] = []
    for (const target of targets) {
      try {
        const orderId = await this.#resolveOrderId(target)
        if (orderId === undefined) {
          acks.push({
            target,
            ok: false,
            problem: makeProblem('VENUE_REJECTED', 'IBKR: order not found in this session (open orders / submitted ledger)', {
              venue: { id: VENUE, message: `clientOrderId=${String(target.clientOrderId ?? '')} venueOrderId=${String(target.venueOrderId ?? '')}` },
            }),
          })
          continue
        }
        acks.push(await this.#cancelOrderId(orderId, target))
      } catch (e) {
        acks.push({ target, ok: false, problem: problemOf(e) })
      }
    }
    return acks
  }

  async #cancelOrderId(orderId: number, target: CancelTarget): Promise<CancelAck> {
    this.#cancelling.add(orderId)
    try {
      await this.#session.send(M.cancelOrder(orderId))
      const outcome = await this.#awaitCancel(orderId)
      if (outcome.timeout === true) {
        return {
          target,
          ok: false,
          problem: makeProblem('VENUE_UNAVAILABLE', `IBKR: no cancel confirmation within ${String(this.#ackTimeoutMs)} ms; query the order status before retrying`, {
            venue: { id: VENUE, message: `orderId ${String(orderId)}` },
          }),
        }
      }
      if (outcome.code !== undefined) {
        const ok = outcome.code === 202 || outcome.code === 135 || outcome.code === 10148
        return {
          target,
          ok,
          ...(ok ? {} : { problem: problemForIbError(outcome.code, outcome.message ?? '', orderId).problem }),
        }
      }
      const cancelled = outcome.status
      const ok = cancelled !== undefined && isTerminalState(cancelled.status)
      return {
        target,
        ok,
        ...(ok ? {} : { problem: cancelledProblem(target.instrumentId, orderId, cancelled?.status ?? 'Unknown', cancelled) }),
      }
    } catch (e) {
      return { target, ok: false, problem: problemOf(e) }
    } finally {
      this.#cancelling.delete(orderId)
    }
  }

  async #resolveOrderId(target: CancelTarget): Promise<number | undefined> {
    const rows = await this.#accounts.openOrderRows()
    if (target.venueOrderId !== undefined) {
      const hit = rows.find((o) => String(o.permId) === target.venueOrderId || String(o.orderId) === target.venueOrderId)
      if (hit !== undefined) return hit.orderId
    }
    if (target.clientOrderId !== undefined) {
      const entry = this.#accounts.ledger.get(target.clientOrderId)
      if (entry !== undefined) return entry.orderId
      const hit = rows.find((o) => o.orderRef !== '' && clientOrderIdFromOrderRef(o.orderRef) === target.clientOrderId)
      if (hit !== undefined) return hit.orderId
    }
    return undefined
  }

  async #awaitCancel(orderId: number): Promise<{ status?: IbOrderStatus; code?: number; message?: string; timeout?: boolean }> {
    const first = this.#statuses.get(orderId)
    if (first !== undefined && isTerminalState(first.status)) return { status: first }
    try {
      const box: { status?: IbOrderStatus } = {}
      const got = await this.#session.request<{ status?: IbOrderStatus }>({
        label: `cancelStatus(${String(orderId)})`,
        build: Buffer.alloc(0),
        initial: box,
        timeoutMs: this.#ackTimeoutMs,
        matchError: (reqId) => reqId === orderId,
        onFrame: (fields, acc) => {
          if (Number(fields[0]) !== M.IN.ORDER_STATUS) return false
          const s = M.decodeOrderStatus(fields)
          if (s.orderId !== orderId) return false
          this.#statuses.set(s.orderId, s)
          acc.status = s
          return isTerminalState(s.status)
        },
      })
      const cached = got.status ?? this.#statuses.get(orderId)
      return cached !== undefined && isTerminalState(cached.status) ? { status: cached } : { timeout: true }
    } catch (e) {
      if (e instanceof IbError && e.ibCode !== undefined) return { code: e.ibCode, message: e.problem.venue?.message ?? e.message }
      return { timeout: true }
    }
  }

  /**
   * 全撤：读本账户挂单；本连接下的单按各自 orderId 直接撤，其它 clientId 的单不能代撤。
   */
  async cancelAll(_ctx: TradeContext, instrumentId?: string): Promise<CancelAck[]> {
    const accountId = this.#accounts.accountId
    const rows = (await this.#accounts.openOrderRows()).filter((o) => accountId === '' || o.account === accountId)
    const scoped = instrumentId === undefined ? rows : rows.filter((o) => `${VENUE}:${o.contract.symbol.toUpperCase()}` === instrumentId)
    if (scoped.length === 0) return [{ target: { instrumentId: instrumentId ?? '' }, ok: true }]
    const out: CancelAck[] = []
    for (const o of scoped) {
      const target: CancelTarget = {
        instrumentId: `${VENUE}:${o.contract.symbol.toUpperCase()}`,
        ...(o.orderRef !== '' ? { clientOrderId: clientOrderIdFromOrderRef(o.orderRef) } : {}),
        ...(o.permId !== 0 ? { venueOrderId: String(o.permId) } : {}),
      }
      if (o.clientId === this.#session.clientId) {
        out.push(await this.#cancelOrderId(o.orderId, target))
      } else {
        out.push({
          target,
          ok: false,
          problem: makeProblem(
            'VENUE_REJECTED',
            `order placed by clientId ${String(o.clientId)}; IB only lets the placing client (or TWS for clientId 0) cancel it`,
            { venue: { id: VENUE, message: `orderId ${String(o.orderId)}` } },
          ),
        })
      }
    }
    return out
  }

  /** 改单：IB 无原生改单 → 1004（撤旧挂新会换 orderId）。 */
  amend(_ctx: TradeContext, req: AmendRequest): Promise<SubmitResult> {
    const problem = makeProblem('ORDER_TYPE_UNSUPPORTED', 'IBKR has no native order amend in this connector (cancel + replace changes the order id)', {
      venue: { id: VENUE, message: `amend ${req.instrumentId}` },
    })
    return Promise.resolve({
      acks: [
        {
          intentIndex: 0,
          clientOrderId: req.clientOrderId ?? req.order.clientOrderId ?? '',
          venueOrderId: req.venueOrderId ?? null,
          status: 'rejected' as const,
          filledSize: asDecimal('0'),
          avgFillPrice: null,
          builder: { attached: false },
          problem,
        },
      ],
      receiptHash: sha256('amend-unsupported'),
      requestWeight: 0,
    })
  }

  /**
   * 3006 对账：按 orderRef 查挂单 + 成交（IB 没有按客户端单号查单的请求）。
   * 不重发、不改单；只回答「这笔单在场所是否存在 / 是什么状态 / 成交多少」。
   */
  async reconcile(clientOrderId: string, ref: AccountRef): Promise<{ found: boolean; status?: string; filledSize?: Decimal; venueOrderId?: string }> {
    const status = await this.#accounts.orderStatus(ref, { clientOrderId: orderRefOf(clientOrderId) })
    if (!status.found) return { found: false }
    for (const [ref2, entry] of [...this.#unknown.entries()]) {
      if (entry.clientOrderId === clientOrderId) this.#unknown.delete(ref2)
    }
    return {
      found: true,
      ...(status.status !== undefined ? { status: status.status } : {}),
      ...(status.filledSize !== undefined ? { filledSize: status.filledSize } : {}),
      ...(status.venueOrderId !== undefined ? { venueOrderId: status.venueOrderId } : {}),
    }
  }

  /** 把所有 unknown 单跑一遍对账（重连后调用）。 */
  async reconcileUnknown(ref: AccountRef): Promise<Array<{ clientOrderId: string; found: boolean; status?: string }>> {
    const out: Array<{ clientOrderId: string; found: boolean; status?: string }> = []
    const seen = new Set<string>()
    for (const entry of [...this.#unknown.values()]) {
      if (seen.has(entry.clientOrderId)) continue
      seen.add(entry.clientOrderId)
      try {
        const r = await this.reconcile(entry.clientOrderId, ref)
        out.push({ clientOrderId: entry.clientOrderId, found: r.found, ...(r.status !== undefined ? { status: r.status } : {}) })
      } catch (e) {
        this.#onWarn(`reconcile failed for ${entry.clientOrderId}: ${e instanceof Error ? e.message : String(e)}`)
        out.push({ clientOrderId: entry.clientOrderId, found: false })
      }
    }
    return out
  }
}

/** 3006：发出了但没拿到任何回执。不可重试；必须按 orderRef 对账。 */
export function unknownProblem(instrumentId: string, clientOrderId: string, cause: unknown): Problem {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return makeProblem(
    'VENUE_OUTCOME_UNKNOWN',
    `${VENUE}: order outcome unknown for ${instrumentId} (orderRef ${orderRefOf(clientOrderId)}): ${detail}. 处理：不要重发，重连后按 orderRef 经挂单 + 成交查询对账（IB 没有按客户端单号查单的请求）`,
    { venue: { id: VENUE, message: detail } },
  )
}

function cancelledProblem(instrumentId: string, orderId: number, status: string, raw: IbOrderStatus | undefined): Problem {
  return makeProblem('VENUE_REJECTED', `${VENUE}: order ${String(orderId)} ended as ${status} for ${instrumentId}`, {
    venue: { id: VENUE, code: status, message: raw === undefined ? status : `orderStatus=${status} filled=${raw.filled} remaining=${raw.remaining}` },
  })
}

function problemOf(e: unknown): Problem {
  if (e instanceof IbError) return e.problem
  if (e instanceof Error) {
    return makeProblem('INTERNAL', `${VENUE}: ${e.message}`, { venue: { id: VENUE, message: e.message } })
  }
  return makeProblem('INTERNAL', `${VENUE}: ${String(e)}`, { venue: { id: VENUE, message: String(e) } })
}

export type { Ms }
