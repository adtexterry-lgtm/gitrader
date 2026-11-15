// SPDX-License-Identifier: CPAL-1.0
// 账户读取：账户摘要、持仓、挂单、成交与佣金、单状态、启动对账。
// 参照 ib_async client.py / decoder.py（BSD-2-Clause）的字段语义；未复制源码。
// IB 账户摘要没有冻结标志（ib_async 标签表无此项）；受限账户由 IB 以 201 拒单，原文照传。
// 对账：IB 没有「按 clientOrderId 查单」的请求，只能用 orderRef 在 REQ_ALL_OPEN_ORDERS + REQ_EXECUTIONS 里找。
import { asDecimal, normalizeDecimal } from '@gitrader/protocol'
import type { AccountId, Balance, Decimal, MarginSnapshot, Ms, Position, VenueRules } from '@gitrader/protocol'
import type { AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus } from '@gitrader/protocol/connector'
import { addDec, cmpDec, mulDec, str, subDec } from '@gitrader/protocol/decimal'
import { fx } from '@gitrader/protocol/decimal'
import type { InstrumentBook } from './contracts'
import { VENUE } from './ids'
import * as M from './messages'
import type { IbCommissionReport, IbExecution, IbOpenOrder, IbPosition } from './messages'
import type { IbSession } from './session'

/** IB 账户摘要里本包读的标签（REQ_ACCOUNT_SUMMARY 的 tags 参数同源，见 messages.reqAccountSummary）。 */
export interface AccountRestrictions {
  /** 日内交易剩余次数（IB tag DayTradesRemaining；-1 = 不限或未知，原样保留）。 */
  dayTradesRemaining: string | undefined
  buyingPower: string | undefined
  availableFunds: string | undefined
  cushion: string | undefined
  accountType: string | undefined
  /** IB 账户摘要没有冻结标志（ib_async 标签表无此项）→ 恒 false。 */
  tradingBlocked: boolean
  /** IB 账户摘要没有冻结标志（ib_async 标签表无此项）→ 恒 false。 */
  accountBlocked: boolean
  /** 原始标签全表（原样，不翻译）。 */
  raw: Record<string, string>
}

export interface QuoteLike {
  referencePrice(instrumentId: string): number | undefined
  quote(instrumentId: string): { last?: number } | undefined
}

export interface IbkrAccountsOptions {
  session: IbSession
  book: InstrumentBook
  market?: QuoteLike
  clock?: () => number
  account?: string
  /** 老格式成交时间不带时区时按它换算（TWS 设置里的时区，如 America/New_York）。 */
  twsTimeZone?: string
  onWarn?: (message: string) => void
}

/** 本进程提交过的单（orderRef ↔ orderId）：3006 对账与本进程查单的索引。 */
export interface LedgerEntry {
  ref: string
  orderId: number
  instrumentId: string
  ts: number
  side: 'buy' | 'sell'
  size: Decimal
  role?: 'parent' | 'tp' | 'sl'
}

export class OrderLedger {
  readonly #byRef = new Map<string, LedgerEntry>()
  readonly #byOrderId = new Map<number, LedgerEntry>()

  note(ref: string, orderId: number, instrumentId: string, ts: number, side: 'buy' | 'sell', size: Decimal, role?: 'parent' | 'tp' | 'sl'): void {
    const entry: LedgerEntry = { ref, orderId, instrumentId, ts, side, size, ...(role !== undefined ? { role } : {}) }
    this.#byRef.set(ref, entry)
    this.#byOrderId.set(orderId, entry)
  }

  get(ref: string): LedgerEntry | undefined {
    return this.#byRef.get(ref)
  }

  /** 按 IB 本地 orderId 反查（成交消息里只有 orderId / permId）。 */
  getByOrderId(orderId: number): LedgerEntry | undefined {
    return this.#byOrderId.get(orderId)
  }

  remove(ref: string): void {
    const e = this.#byRef.get(ref)
    if (e !== undefined) this.#byOrderId.delete(e.orderId)
    this.#byRef.delete(ref)
  }

  get size(): number {
    return this.#byRef.size
  }
}

const DEC_ZERO = asDecimal('0')

/** number → 规范十进制（IB 的 double 字段只有数值语义；这里只做 8 位内取整，避免 "2250.00" 这种非规范串）。 */
function dec(n: number): Decimal {
  if (!Number.isFinite(n)) return DEC_ZERO
  return asDecimal(str(fx(n.toFixed(8))))
}

/** IB 数值标签是原样文本（如 "100000.00"）：规范化后再用；缺失或不是数字 → 0。 */
function normalizedDecimalOrZero(text: string | undefined): Decimal {
  if (text === undefined) return DEC_ZERO
  try {
    return normalizeDecimal(text)
  } catch {
    return DEC_ZERO
  }
}

export class IbkrAccounts {
  readonly ledger = new OrderLedger()
  readonly #session: IbSession
  readonly #market: QuoteLike | undefined
  readonly #clock: () => number
  readonly #account: string
  readonly #twsTimeZone: string | undefined
  readonly #onWarn: (m: string) => void
  #warnedNaiveTime = false
  #summaryCurrency = 'USD'
  #restrictions: AccountRestrictions = {
    dayTradesRemaining: undefined,
    buyingPower: undefined,
    availableFunds: undefined,
    cushion: undefined,
    accountType: undefined,
    tradingBlocked: false,
    accountBlocked: false,
    raw: {},
  }

  readonly #chains: Record<'openOrders' | 'positions' | 'executions', Promise<void>> = {
    openOrders: Promise.resolve(),
    positions: Promise.resolve(),
    executions: Promise.resolve(),
  }

  /** 同类请求串行化：IB 的部分回包没有 reqId，重入会吃到别人的尾巴。 */
  #enqueue<T>(kind: 'openOrders' | 'positions' | 'executions', task: () => Promise<T>): Promise<T> {
    const run = this.#chains[kind].then(task, task)
    this.#chains[kind] = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  constructor(o: IbkrAccountsOptions) {
    this.#session = o.session
    void o.book
    this.#market = o.market
    this.#clock = o.clock ?? (() => Date.now())
    this.#account = o.account ?? ''
    this.#twsTimeZone = o.twsTimeZone
    this.#onWarn = o.onWarn ?? (() => {})
    // 已成交量只从 orderStatus 消息来（OPEN_ORDER 不带 filled）；查不到就是 0，不猜。
    this.#session.on({
      orderStatus: (s) => {
        this.#filledByOrder.set(s.orderId, s.filled)
        this.#statusByOrder.set(s.orderId, s.status)
      },
    })
  }

  readonly #filledByOrder = new Map<number, Decimal>()
  readonly #statusByOrder = new Map<number, string>()

  filledOf(orderId: number, totalQuantity: string): Decimal {
    const f = this.#filledByOrder.get(orderId) ?? DEC_ZERO
    if (cmpDec(f, '0') <= 0) return DEC_ZERO
    return cmpDec(f, totalQuantity) > 0 ? asDecimal(totalQuantity) : f
  }

  /** orderStatus 里见过的状态（对账时优先于 openOrder 的 status）。 */
  statusOf(orderId: number): string | undefined {
    return this.#statusByOrder.get(orderId)
  }

  get accountId(): string {
    return this.#account !== '' ? this.#account : (this.#session.accounts[0] ?? '')
  }

  /** 最近一次账户摘要的限制标志（原样；冻结标志恒 false）。 */
  accountRestrictions(): AccountRestrictions {
    return this.#restrictions
  }

  /** 账户摘要：REQ_ACCOUNT_SUMMARY → ACCOUNT_SUMMARY*，到 ACCOUNT_SUMMARY_END 收齐后撤订阅。 */
  async summary(): Promise<Record<string, string>> {
    const reqId = this.#session.allocateReqId()
    const tags: Record<string, string> = {}
    const accountId = this.accountId
    await this.#session.request<Record<string, string>>({
      label: 'accountSummary',
      build: M.reqAccountSummary(reqId),
      initial: tags,
      matchError: (id) => id === reqId,
      onFrame: (fields, acc) => {
        const msgId = Number(fields[0])
        if (msgId === M.IN.ACCOUNT_SUMMARY) {
          const row = M.decodeAccountSummary(fields)
          if (row.reqId !== reqId) return false
          if (accountId !== '' && row.account !== accountId) return false
          acc[row.tag] = row.value
          if (row.tag === 'NetLiquidation' && row.currency !== '') this.#summaryCurrency = row.currency
          return false
        }
        if (msgId === M.IN.ACCOUNT_SUMMARY_END) return Number(fields[2] ?? '') === reqId
        return false
      },
    })
    await this.#session.send(M.cancelAccountSummary(reqId)).catch((e: unknown) => {
      this.#onWarn(`cancelAccountSummary failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    this.#restrictions = {
      dayTradesRemaining: tags.DayTradesRemaining,
      buyingPower: tags.BuyingPower,
      availableFunds: tags.AvailableFunds,
      cushion: tags.Cushion,
      accountType: tags.AccountType,
      // IB 账户摘要没有冻结标志（ib_async 标签表无此项）；受限账户由 IB 以 201 拒单，原文照传。
      tradingBlocked: false,
      accountBlocked: false,
      raw: { ...tags },
    }
    return tags
  }

  /** 持仓：REQ_POSITIONS → POSITION*；收齐后 cancelPositions。只保留本账户。 */
  async positions(account = this.accountId): Promise<Position[]> {
    return this.#enqueue('positions', async () => {
      const rows: IbPosition[] = []
      await this.#session.request<IbPosition[]>({
        label: 'positions',
        build: M.reqPositions(),
        initial: rows,
        onFrame: (fields, acc) => {
          const msgId = Number(fields[0])
          if (msgId === M.IN.POSITION) {
            acc.push(M.decodePosition(fields))
            return false
          }
          if (msgId === M.IN.POSITION_END) return true
          return false
        },
      })
      await this.#session.send(M.cancelPositions()).catch((e: unknown) => {
        this.#onWarn(`cancelPositions failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      return rows
        .filter((p) => (account === '' || p.account === account) && cmpDec(p.position, '0') !== 0)
        .map((p) => this.#toPosition(p))
    })
  }

  #toPosition(p: IbPosition): Position {
    const id = `${VENUE}:${p.contract.symbol.toUpperCase()}`
    const positionFx = fx(p.position)
    const size = asDecimal(str(positionFx < 0n ? -positionFx : positionFx))
    const sizeNumber = Number(size)
    const side: 'long' | 'short' = positionFx >= 0n ? 'long' : 'short'
    const avgCost = Number(p.avgCost)
    const mark = this.#market?.referencePrice(id) ?? avgCost
    const notional = sizeNumber * mark
    const diff = mark - avgCost
    const unrealized = side === 'long' ? diff * sizeNumber : -diff * sizeNumber
    const now = this.#clock()
    return {
      accountId: this.accountId as AccountId,
      instrumentId: id,
      side,
      size,
      // IB 的 avgCost 是成本（股票即均价；本包只做股票，没有乘数换算）。
      entryPrice: p.avgCost,
      markPrice: dec(mark),
      notional: dec(notional),
      unrealizedPnl: dec(unrealized),
      realizedPnl: DEC_ZERO,
      leverage: 1,
      marginMode: 'cross',
      liquidationPrice: null,
      fundingSinceOpen: DEC_ZERO,
      openedAt: now,
      updatedAt: now,
    }
  }

  /** 全量挂单：REQ_ALL_OPEN_ORDERS → OPEN_ORDER* → OPEN_ORDER_END。 */
  async openOrderRows(): Promise<IbOpenOrder[]> {
    return this.#enqueue('openOrders', async () => {
      const rows: IbOpenOrder[] = []
      await this.#session.request<IbOpenOrder[]>({
        label: 'openOrders',
        build: M.reqAllOpenOrders(),
        initial: rows,
        onFrame: (fields, acc) => {
          const msgId = Number(fields[0])
          if (msgId === M.IN.OPEN_ORDER) {
            acc.push(M.decodeOpenOrder(fields))
            return false
          }
          if (msgId === M.IN.OPEN_ORDER_END) return true
          return false
        },
      })
      return rows
    })
  }

  /** 挂单（协议形状）：只看本账户。 */
  async openOrders(_ref: AccountRef): Promise<VenueOpenOrder[]> {
    const accountId = this.accountId
    const rows = await this.openOrderRows()
    return rows.filter((o) => (accountId === '' || o.account === accountId) && !isTerminalState(this.statusOf(o.orderId) ?? o.status)).map((o) => this.#toOpenOrder(o))
  }

  #toOpenOrder(o: IbOpenOrder): VenueOpenOrder {
    const symbol = o.contract.symbol.toUpperCase()
    const filled = this.filledOf(o.orderId, o.totalQuantity)
    const type = openOrderType(o.orderType)
    const tracked = this.ledger.get(o.orderRef)
    return {
      instrumentId: `${VENUE}:${symbol}`,
      venueOrderId: String(o.permId !== 0 ? o.permId : o.orderId),
      // 子腿 orderRef 带 #tp / #sl：不把子单记到父单号上 → null。
      clientOrderId: o.orderRef === '' || /#(tp|sl)$/.test(o.orderRef) ? null : o.orderRef,
      side: o.action === 'SELL' ? 'sell' : 'buy',
      type,
      price: type === 'stop_market' ? null : (o.lmtPrice ?? null),
      triggerPrice: type === 'stop_market' || type === 'stop_limit' || o.orderType === 'TRAIL' ? (o.auxPrice ?? o.trailStopPrice ?? null) : null,
      size: subDec(o.totalQuantity, filled),
      origSize: o.totalQuantity,
      // 挂单 reduceOnly 一律 false：IB 股票没有原生 reduce-only，openClose 永远发空。
      reduceOnly: false,
      isTrigger: o.orderType === 'STP' || o.orderType === 'STP LMT' || o.orderType === 'TRAIL',
      createdAt: tracked?.ts ?? this.#clock(),
    }
  }

  /** 成交 + 佣金：REQ_EXECUTIONS → EXECUTION_DATA* / COMMISSION_REPORT* → EXECUTION_DATA_END。 */
  async executionRows(): Promise<{ executions: IbExecution[]; commissions: Map<string, IbCommissionReport> }> {
    return this.#enqueue('executions', async () => {
      const reqId = this.#session.allocateReqId()
      const state = { executions: [] as IbExecution[], commissions: new Map<string, IbCommissionReport>() }
      await this.#session.request<typeof state>({
        label: 'executions',
        build: M.reqExecutions(reqId, this.#session.clientId, this.accountId, ''),
        initial: state,
        matchError: (id) => id === reqId,
        onFrame: (fields, acc) => {
          const msgId = Number(fields[0])
          if (msgId === M.IN.EXECUTION_DATA) {
            const execution = M.decodeExecDetails(fields)
            if (execution.reqId === reqId) acc.executions.push(execution)
            return false
          }
          if (msgId === M.IN.COMMISSION_REPORT) {
            const report = M.decodeCommissionReport(fields)
            acc.commissions.set(report.execId, report)
            return false
          }
          if (msgId === M.IN.EXECUTION_DATA_END) return Number(fields[2] ?? '') === reqId
          return false
        },
      })
      return state
    })
  }

  /** 成交（协议形状）：先按账户过滤，再按时间过滤；时间为 NaN 的成交不丢。 */
  async fills(_ref: AccountRef, sinceMs: Ms): Promise<VenueFill[]> {
    const { executions, commissions } = await this.executionRows()
    const accountId = this.accountId
    const out: VenueFill[] = []
    for (const ed of executions) {
      if (accountId !== '' && ed.acctNumber !== accountId) continue
      const ms = ed.time === '' ? Number.NaN : ibTimeToMs(ed.time, this.#twsTimeZone)
      if (!Number.isNaN(ms) && ms < sinceMs) continue
      out.push(this.#toFill(ed, commissions.get(ed.execId), ms))
    }
    return out
  }

  #toFill(ed: IbExecution, commission: IbCommissionReport | undefined, ms: number): VenueFill {
    const symbol = ed.contract.symbol.toUpperCase()
    const tracked = this.ledger.getByOrderId(ed.orderId)
    const naive = Number.isNaN(ms)
    if (naive && !this.#warnedNaiveTime) {
      this.#warnedNaiveTime = true
      this.#onWarn(`execution ${ed.execId} has no timezone in its time ${JSON.stringify(ed.time)}; using the local clock and skipping the since filter`)
    }
    const childRef = /#(tp|sl)$/.test(ed.orderRef)
    const clientOrderId = childRef ? null : ed.orderRef !== '' ? ed.orderRef : (tracked?.ref ?? null)
    return {
      venueFillId: ed.execId,
      venueOrderId: String(ed.permId !== 0 ? ed.permId : ed.orderId),
      clientOrderId,
      instrumentId: `${VENUE}:${symbol}`,
      side: ed.side.toUpperCase() === 'SLD' ? 'sell' : 'buy',
      price: ed.price,
      size: asDecimal(str(fx(ed.shares) < 0n ? -fx(ed.shares) : fx(ed.shares))),
      fee: commission?.commission ?? DEC_ZERO,
      feeCcy: commission?.currency !== undefined && commission.currency !== '' ? commission.currency : 'USD',
      liquidity: ed.lastLiquidity === 1 ? 'maker' : 'taker',
      realizedPnl: commission?.realizedPnl ?? DEC_ZERO,
      ...(ed.liquidation !== 0 ? { liquidation: true } : {}),
      ts: naive ? this.#clock() : ms,
    }
  }

  /**
   * 单状态：先在挂单与成交里按 orderRef / permId 找；重启后 ledger 为空也能对上。
   * 找不到 → found:false（不编状态）。
   */
  async orderStatus(_ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> {
    const ref = key.clientOrderId
    const perm = key.venueOrderId
    const accountId = this.accountId
    const openRows = (await this.openOrderRows()).filter((o) => accountId === '' || o.account === accountId)
    const matchOpen = openRows.find((o) => (ref !== undefined && o.orderRef === ref) || (perm !== undefined && String(o.permId) === perm))
    if (matchOpen !== undefined) {
      return {
        found: true,
        status: this.statusOf(matchOpen.orderId) ?? matchOpen.status,
        venueOrderId: String(matchOpen.permId !== 0 ? matchOpen.permId : matchOpen.orderId),
        filledSize: this.filledOf(matchOpen.orderId, matchOpen.totalQuantity),
        raw: matchOpen,
      }
    }
    const { executions } = await this.executionRows()
    const ownExecutions = accountId === '' ? executions : executions.filter((e) => e.acctNumber === accountId)
    let ex: IbExecution | undefined
    for (const candidate of ownExecutions) {
      const matched =
        (perm !== undefined && String(candidate.permId) === perm) ||
        (ref !== undefined && ref !== '' && candidate.orderRef === ref)
      if (!matched) continue
      if (ex === undefined || cmpDec(candidate.cumQty, ex.cumQty) > 0) ex = candidate
    }
    if (ex !== undefined) {
      return {
        found: true,
        status: 'Filled',
        venueOrderId: String(ex.permId !== 0 ? ex.permId : ex.orderId),
        filledSize: ex.cumQty,
        raw: ex,
      }
    }
    return { found: false, raw: { orderRef: ref ?? null, permId: perm ?? null, note: 'not in open orders nor executions for this session' } }
  }

  /** 启动对账快照：账户 + 挂单 + 最近成交（成交按 sinceMs 过滤）。 */
  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    const [account, openOrders, fills] = await Promise.all([this.accountState(ref), this.openOrders(ref), this.fills(ref, fillsSinceMs)])
    return { account, openOrders, fills, fillsSince: fillsSinceMs, truncated: fills.length >= 2000 }
  }

  /** 协议账户快照。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const tags = await this.summary()
    const positions = await this.positions()
    const now = this.#clock()
    const equity = normalizedDecimalOrZero(tags.NetLiquidation)
    const available = normalizedDecimalOrZero(tags.AvailableFunds)
    const initMargin = normalizedDecimalOrZero(tags.InitMarginReq)
    const maintMargin = normalizedDecimalOrZero(tags.MaintMarginReq)
    const hold = subDec(equity, available)
    const currency = this.#summaryCurrency !== '' ? this.#summaryCurrency : 'USD'
    const balance: Balance = {
      accountId: ref.accountId,
      asset: currency,
      total: equity,
      available,
      hold,
      ts: now,
    }
    const ratio = cmpDec(equity, '0') > 0 ? asDecimal(str((fx(maintMargin) * 10n ** 18n) / fx(equity))) : DEC_ZERO
    const margin: MarginSnapshot = {
      accountId: ref.accountId,
      model: 'standard',
      valuationCcy: currency,
      equity,
      initialMargin: initMargin,
      maintenanceMargin: maintMargin,
      available,
      marginRatio: ratio,
      leverage: Number(normalizedDecimalOrZero(tags.Leverage)) || 1,
      ts: now,
    }
    const rules: VenueRules = { marketPriceBandBps: 50 }
    return {
      accountModel: 'standard',
      balances: [balance],
      margin,
      positions,
      ts: now,
      source: 'rest',
      availableDeductsOpenOrders: false,
      rules,
    }
  }
}

/** IB 终态：已成交 / 已撤 / 非活跃（IB 文档的订单状态取值）。 */
export function isTerminalState(status: string): boolean {
  const s = status.toLowerCase()
  return s === 'filled' || s === 'cancelled' || s === 'apicancelled' || s === 'inactive'
}

/** 下单状态 → 协议 openOrder.type。TRAIL 映射 unknown（协议没有跟踪止损类型），不假装成 stop_market。 */
export function openOrderType(orderType: string): VenueOpenOrder['type'] {
  switch (orderType.toUpperCase()) {
    case 'LMT':
      return 'limit'
    case 'STP':
      return 'stop_market'
    case 'STP LMT':
      return 'stop_limit'
    default:
      return 'unknown'
  }
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = fmt.formatToParts(new Date(utcMs))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  const asUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')) % 24,
    Number(get('minute')),
    Number(get('second')),
  )
  return asUtc - utcMs
}

/**
 * IB 成交时间串 → ms：
 *   · 纯数字（秒）→ ×1000；
 *   · `YYYYMMDD HH:MM:SS <IANA 时区>` → 按该时区换成 UTC 毫秒（Intl 偏移校正一次）；
 *   · `YYYYMMDD  HH:MM:SS` / 无时区 → 用 twsTimeZone；没给或时区非法 → NaN。
 */
export function ibTimeToMs(text: string, twsTimeZone?: string): number {
  const trimmed = text.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?$/.exec(trimmed)
  if (m === null) return Number.NaN
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  const s = Number(m[6])
  const zone = m[7] ?? twsTimeZone
  if (zone === undefined || zone === '') return Number.NaN
  let offset: number
  try {
    offset = tzOffsetMs(Date.UTC(y, mo - 1, d, h, mi, s), zone)
  } catch {
    return Number.NaN
  }
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  let ms = guess - offset
  const corrected = tzOffsetMs(ms, zone)
  if (corrected !== offset) ms = guess - corrected
  return ms
}

export function formatIbTime(ms: number): string {
  const dt = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${String(dt.getUTCFullYear())}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`
}

export { addDec, mulDec }
