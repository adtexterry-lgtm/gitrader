// SPDX-License-Identifier: CPAL-1.0
// 账户读取：/fapi/v2/account、/fapi/v2/positionRisk、/fapi/v1/userTrades，加挂单 / 单状态 / 启动对账。
// 数量单位一律「币数量」（venueSizeUnit = base）：positionAmt / executedQty / qty 都是基础资产数量，不做张数换算。
// 口径来源：QD live_trading/binance.py:435-520（get_account / get_open_orders / get_user_trades）、:1065-1085（positionRisk）。
// 只读：本文件不发任何下单 / 撤单请求。
import { makeProblem } from '@gitrader/protocol'
import type { AccountId, Decimal, InstrumentId, MarginSnapshot, Ms, Position } from '@gitrader/protocol'
import { cmpDec, mulDec } from '@gitrader/protocol/decimal'
import type {
  AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { BINANCE_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import { mapOpenOrderType, absDecimal, decimalOf, holdOf, instrumentIdOf, num, parseInstrumentRecords, symbolOf } from './parse'
import type { InstrumentRecord } from './parse'
import type { BinanceHttp } from './rest'

/** userTrades 单页上限（官方 limit ≤ 1000）。 */
export const USER_TRADES_LIMIT = 1_000

export interface AccountsOptions {
  /** 账户模型标签：Binance USDⓈ-M 在协议里落 `standard`（协议枚举只有 standard / unified / portfolio）。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
  /** 没给 symbol 时用的缺省标的（userTrades / orderStatus 都强制要 symbol）。 */
  defaultSymbol?: string
}

export interface ReaderDeps {
  http: BinanceHttp
  clock: () => number
  options?: AccountsOptions
  /** 已知标的记录（用于把 symbol 变回 instrumentId 与过滤）。 */
  records: () => InstrumentRecord[]
}

function requireSymbol(explicit: string | undefined, fallback: string | undefined, what: string): string {
  const symbol = explicit ?? fallback
  if (symbol === undefined || symbol === '') {
    throw new ProblemError(makeProblem('INVALID_PARAMS', `${what} needs an explicit symbol in this connector (Binance requires symbol)`))
  }
  return symbol
}

function isOrderRow(value: unknown, idField: 'orderId' | 'algoId'): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const symbol = row.symbol
  const id = row[idField]
  return typeof symbol === 'string' && symbol !== ''
    && ((typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isSafeInteger(id)))
}

function dataUnavailable(): ProblemError {
  return new ProblemError(makeProblem('DATA_UNAVAILABLE', 'open orders response was incomplete'))
}

// ---- 响应解析 ---------------------------------------------------------------

export interface RawAccountAsset {
  asset?: string
  walletBalance?: string
  availableBalance?: string
  unrealizedProfit?: string
  marginBalance?: string
}

export interface RawAccountPosition {
  symbol?: string
  positionSide?: string
  positionAmt?: string
  entryPrice?: string
  markPrice?: string
  unRealizedProfit?: string
  liquidationPrice?: string
  leverage?: string
  marginType?: string
  isolatedMargin?: string
  updateTime?: number
}

export interface RawAccount {
  totalWalletBalance?: string
  totalUnrealizedProfit?: string
  totalMarginBalance?: string
  totalInitialMargin?: string
  totalMaintMargin?: string
  availableBalance?: string
  maxWithdrawAmount?: string
  assets?: RawAccountAsset[]
  positions?: RawAccountPosition[]
}

export interface RawPositionRisk {
  symbol?: string
  positionAmt?: string
  entryPrice?: string
  markPrice?: string
  unRealizedProfit?: string
  liquidationPrice?: string
  leverage?: string
  marginType?: string
  positionSide?: string
  notional?: string
  updateTime?: number
  isolatedMargin?: string
}

export interface RawUserTrade {
  symbol?: string
  id?: number
  orderId?: number
  side?: string
  price?: string
  qty?: string
  quoteQty?: string
  realizedPnl?: string
  commission?: string
  commissionAsset?: string
  time?: number
  positionSide?: string
  maker?: boolean
}

export interface RawOrder {
  symbol?: string
  orderId?: number
  clientOrderId?: string
  side?: string
  type?: string
  status?: string
  price?: string
  stopPrice?: string
  origQty?: string
  executedQty?: string
  avgPrice?: string
  cumQuote?: string
  reduceOnly?: boolean
  workingType?: string
  time?: number
  updateTime?: number
  timeInForce?: string
}

/** /fapi/v2/account → AccountSnapshot（含 balances / margin / positions）。 */
export function parseAccountSnapshot(
  raw: RawAccount | null | undefined,
  accountId: AccountId,
  now: Ms,
  accountModel: 'standard' | 'unified' | 'portfolio' = 'standard',
): AccountSnapshot {
  const ts = now
  const assets = Array.isArray(raw?.assets) ? raw.assets : []
  const balances = assets.flatMap((a) => {
    const asset = typeof a.asset === 'string' ? a.asset : ''
    if (asset === '') return []
    const total = decimalOf(a.walletBalance)
    const available = decimalOf(a.availableBalance)
    const hold = holdOf(total, available)
    return [{ accountId, asset, total, available, hold, ts }]
  })
  const equity = decimalOf(raw?.totalMarginBalance ?? raw?.totalWalletBalance)
  const maintenanceMargin = decimalOf(raw?.totalMaintMargin)
  const ratio = Number(equity) > 0 ? (Number(maintenanceMargin) / Number(equity)).toFixed(8) : '0'
  const margin: MarginSnapshot = {
    accountId,
    model: accountModel,
    valuationCcy: 'USDT',
    equity,
    initialMargin: decimalOf(raw?.totalInitialMargin),
    maintenanceMargin,
    available: decimalOf(raw?.availableBalance),
    marginRatio: decimalOf(ratio),
    leverage: 0,
    ts,
  }
  // /fapi/v2/account 只取余额 / 可用；持仓一律以 /fapi/v2/positionRisk 为准（由 accountState 合并）。
  return { accountModel, balances, margin, positions: [], ts, source: 'rest', availableDeductsOpenOrders: true }
}

/** /fapi/v2/positionRisk → Position[]（非零仓位）。 */
export function parsePositionRisk(raw: unknown, accountId: AccountId, now: Ms): Position[] {
  if (!Array.isArray(raw)) return []
  const out: Position[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const p = row as RawPositionRisk
    const symbol = typeof p.symbol === 'string' ? p.symbol : ''
    if (symbol === '') continue
    const amount = decimalOf(p.positionAmt ?? '0')
    if (cmpDec(amount, '0') === 0) continue
    const size = absDecimal(amount)
    const markPrice = decimalOf(p.markPrice)
    const notional = typeof p.notional === 'string' && p.notional !== ''
      ? absDecimal(p.notional)
      : absDecimal(mulDec(size, markPrice))
    out.push({
      accountId,
      instrumentId: instrumentIdOf(symbol),
      side: cmpDec(amount, '0') < 0 ? 'short' : 'long',
      size,
      entryPrice: decimalOf(p.entryPrice),
      markPrice,
      notional,
      unrealizedPnl: decimalOf(p.unRealizedProfit),
      realizedPnl: decimalOf('0'),
      leverage: Math.max(1, Math.round(num(p.leverage) || 1)),
      marginMode: (typeof p.marginType === 'string' ? p.marginType.toLowerCase() : 'cross') === 'isolated' ? 'isolated' : 'cross',
      liquidationPrice: num(p.liquidationPrice) > 0 ? decimalOf(p.liquidationPrice) : null,
      fundingSinceOpen: decimalOf('0'),
      openedAt: num(p.updateTime) > 0 ? num(p.updateTime) : now,
      updatedAt: now,
    })
  }
  return out
}

/** /fapi/v1/userTrades 一行 → VenueFill。 */
export function parseUserTrade(raw: RawUserTrade, now: Ms): VenueFill | null {
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : ''
  if (symbol === '') return null
  const qty = Number(raw.qty ?? 0)
  if (!Number.isFinite(qty) || qty <= 0) return null
  const ts = num(raw.time)
  const id = String(raw.id ?? `${raw.orderId ?? ''}-${raw.time ?? ''}`)
  return {
    venueFillId: id === '' ? '' : `${symbol}:${id}`,
    venueOrderId: String(raw.orderId ?? ''),
    clientOrderId: null,
    instrumentId: instrumentIdOf(symbol),
    side: typeof raw.side === 'string' && raw.side.toUpperCase() === 'SELL' ? 'sell' : 'buy',
    price: decimalOf(raw.price),
    size: decimalOf(raw.qty),
    fee: decimalOf(raw.commission ?? '0'),
    feeCcy: typeof raw.commissionAsset === 'string' && raw.commissionAsset !== '' ? raw.commissionAsset : 'USDT',
    liquidity: raw.maker === true ? 'maker' : 'taker',
    realizedPnl: decimalOf(raw.realizedPnl ?? '0'),
    ts: Number.isFinite(ts) && ts > 0 ? ts : now,
  }
}

/** /fapi/v1/openOrders 一行 → VenueOpenOrder。 */
export function parseOpenOrder(raw: RawOrder): VenueOpenOrder | null {
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : ''
  if (symbol === '') return null
  const origQty = decimalOf(raw.origQty)
  const remaining = holdOf(origQty, decimalOf(raw.executedQty))
  const type = mapOpenOrderType(raw.type)
  const price = num(raw.price)
  const stop = num(raw.stopPrice)
  return {
    instrumentId: instrumentIdOf(symbol),
    venueOrderId: String(raw.orderId ?? ''),
    clientOrderId: typeof raw.clientOrderId === 'string' && raw.clientOrderId !== '' ? raw.clientOrderId : null,
    side: typeof raw.side === 'string' && raw.side.toUpperCase() === 'SELL' ? 'sell' : 'buy',
    type,
    price: Number.isFinite(price) && price > 0 ? decimalOf(raw.price) : null,
    triggerPrice: Number.isFinite(stop) && stop > 0 ? decimalOf(raw.stopPrice) : null,
    size: remaining,
    origSize: origQty,
    reduceOnly: raw.reduceOnly === true,
    isTrigger: type !== 'limit' && type !== 'unknown',
    createdAt: num(raw.time) > 0 ? num(raw.time) : 0,
  }
}

export interface RawAlgoOrder {
  symbol?: string
  algoId?: number
  clientAlgoId?: string
  side?: string
  orderType?: string
  type?: string
  algoStatus?: string
  status?: string
  price?: string
  triggerPrice?: string
  quantity?: string
  origQty?: string
  executedQty?: string
  reduceOnly?: boolean
  workingType?: string
  createTime?: number
  updateTime?: number
}

/** /fapi/v1/openAlgoOrders 一行 → VenueOpenOrder（字段名与 POST /fapi/v1/algoOrder 一致）。 */
export function parseAlgoOpenOrder(raw: RawAlgoOrder): VenueOpenOrder | null {
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : ''
  if (symbol === '') return null
  const size = decimalOf(raw.quantity ?? raw.origQty)
  const type = mapOpenOrderType(raw.orderType ?? raw.type)
  const price = num(raw.price)
  const trigger = num(raw.triggerPrice)
  return {
    instrumentId: instrumentIdOf(symbol),
    venueOrderId: String(raw.algoId ?? ''),
    clientOrderId: typeof raw.clientAlgoId === 'string' && raw.clientAlgoId !== '' ? raw.clientAlgoId : null,
    side: typeof raw.side === 'string' && raw.side.toUpperCase() === 'SELL' ? 'sell' : 'buy',
    type,
    price: Number.isFinite(price) && price > 0 ? decimalOf(raw.price) : null,
    triggerPrice: Number.isFinite(trigger) && trigger > 0 ? decimalOf(raw.triggerPrice) : null,
    size,
    origSize: size,
    reduceOnly: raw.reduceOnly === true,
    isTrigger: true,
    createdAt: num(raw.createTime ?? raw.updateTime) > 0 ? num(raw.createTime ?? raw.updateTime) : 0,
  }
}

// ---- 读取器 -----------------------------------------------------------------

export class BinanceAccounts {
  private readonly options: AccountsOptions
  readonly #secrets: readonly string[]
  /** secrets 单独传，不放进 this.d：JSON.stringify / inspect 看不到密钥。 */
  constructor(private readonly d: ReaderDeps, secrets: readonly string[] = []) {
    this.options = d.options ?? {}
    this.#secrets = secrets
  }

  private ctx(): { secrets: string[] } {
    return { secrets: [...this.#secrets] }
  }

  async rawAccount(): Promise<RawAccount> {
    try {
      return await this.d.http.signed<RawAccount>('GET', '/fapi/v2/account', {}, { kind: 'query', weight: BINANCE_WEIGHTS.account })
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 账户快照（balances + margin + positions）。持仓取 positionRisk，account 只供余额 / 可用。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const raw = await this.rawAccount()
    const snapshot = parseAccountSnapshot(raw, ref.accountId, this.d.clock(), this.options.accountModel ?? 'standard')
    const positions = await this.positions(ref)
    return { ...snapshot, positions }
  }

  /** 持仓（单独打 /fapi/v2/positionRisk，含 notional 与 liquidationPrice）。 */
  async positions(ref: AccountRef): Promise<Position[]> {
    try {
      const raw = await this.d.http.signed<unknown>('GET', '/fapi/v2/positionRisk', {}, { kind: 'query', weight: BINANCE_WEIGHTS.positionRisk })
      return parsePositionRisk(raw, ref.accountId, this.d.clock())
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 只读查询 Binance 当前标的保证金模式；缺少或冲突的 positionRisk 行不作推断。 */
  async marginMode(_ref: AccountRef, instrumentId: InstrumentId): Promise<'cross' | 'isolated' | undefined> {
    const symbol = symbolOf(instrumentId)
    try {
      const raw = await this.d.http.signed<unknown>('GET', '/fapi/v2/positionRisk', {}, { kind: 'query', weight: BINANCE_WEIGHTS.positionRisk })
      if (!Array.isArray(raw)) return undefined
      const rows = raw.filter((row): row is RawPositionRisk => row !== null && typeof row === 'object'
        && (row as RawPositionRisk).symbol === symbol)
      if (rows.length === 0) return undefined
      const modes = rows.map((row) => {
        const mode = typeof row.marginType === 'string' ? row.marginType.toLowerCase() : ''
        return mode === 'cross' || mode === 'isolated' ? mode : undefined
      })
      const first = modes[0]
      return first !== undefined && modes.every((mode) => mode === first) ? first : undefined
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 挂单；不给 symbol 时按 symbol 维度逐个拉（Binance 全量 openOrders 权重 40）。
   *  普通挂单与 algo 挂单（/fapi/v1/openAlgoOrders）合并返回。
   */
  async openOrders(_ref: AccountRef, instrumentId?: string): Promise<VenueOpenOrder[]> {
    const symbol = instrumentId === undefined ? undefined : symbolOf(instrumentId)
    const weight = symbol === undefined ? BINANCE_WEIGHTS.openOrdersAllSymbols : BINANCE_WEIGHTS.openOrdersWithSymbol
    const params = symbol === undefined ? {} : { symbol }
    try {
      const raw = await this.d.http.signed<unknown>('GET', '/fapi/v1/openOrders', params, { kind: 'query', weight })
      if (!Array.isArray(raw) || !raw.every((row) => isOrderRow(row, 'orderId'))) throw dataUnavailable()
      const out: VenueOpenOrder[] = []
      for (const row of raw as RawOrder[]) {
        const parsed = parseOpenOrder(row)
        if (!parsed) throw dataUnavailable()
        out.push(parsed)
      }
      const algoRaw = await this.d.http.signed<unknown>('GET', '/fapi/v1/openAlgoOrders', params, {
        kind: 'query',
        weight: BINANCE_WEIGHTS.openAlgoOrders,
      })
      if (!Array.isArray(algoRaw) || !algoRaw.every((row) => isOrderRow(row, 'algoId'))) throw dataUnavailable()
      for (const row of algoRaw as RawAlgoOrder[]) {
        const parsed = parseAlgoOpenOrder(row)
        if (!parsed) throw dataUnavailable()
        out.push(parsed)
      }
      return out
    } catch (e) {
      if (e instanceof ProblemError && e.problem.name === 'DATA_UNAVAILABLE') throw e
      throw dataUnavailable()
    }
  }

  /**
   * 成交回补。Binance 的 userTrades 强制要 symbol：没给就用 options.defaultSymbol；
   * 两者都没有 → INVALID_PARAMS（不猜，也不扫全市场）。
   */
  async fills(_ref: AccountRef, sinceMs: Ms, opts: { instrumentId?: InstrumentId; symbol?: string; limit?: number; toMs?: number } = {}): Promise<VenueFill[]> {
    if (!Number.isSafeInteger(sinceMs) || sinceMs < 0 || sinceMs < this.d.clock() - 90 * 86_400_000) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'fills accepts only the most recent 3 months (local 90-day safety window)'))
    }
    const explicitSymbol = opts.instrumentId === undefined ? opts.symbol : symbolOf(opts.instrumentId)
    const symbol = requireSymbol(explicitSymbol, this.options.defaultSymbol, 'fills')
    const limit = Math.min(Math.max(1, opts.limit ?? USER_TRADES_LIMIT), USER_TRADES_LIMIT)
    try {
      const raw = await this.d.http.signed<RawUserTrade[]>('GET', '/fapi/v1/userTrades', {
        symbol,
        ...(sinceMs > 0 ? { startTime: Math.round(sinceMs) } : {}),
        ...(opts.toMs !== undefined ? { endTime: Math.round(opts.toMs) } : {}),
        limit,
      }, { kind: 'background', weight: BINANCE_WEIGHTS.userTrades })
      if (!Array.isArray(raw)) return []
      return raw.flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const parsed = parseUserTrade(row, this.d.clock())
        return parsed ? [parsed] : []
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /**
   * 单张订单状态（原样返回上游 status 字符串，不翻译）。
   * opts.algo = true → GET /fapi/v1/algoOrder（algoId / clientAlgoId），否则先走 /fapi/v1/order；
   * 普通单查不到（-2013）时回退查一次 algo 端点，两边都没有才返回 found: false。
   */
  async orderStatus(
    _ref: AccountRef,
    key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId },
    opts: { symbol?: string; algo?: boolean } = {},
  ): Promise<VenueOrderStatus> {
    const algo = opts.algo === true
    const explicitSymbol = key.instrumentId === undefined ? opts.symbol : symbolOf(key.instrumentId)
    const symbol = algo
      ? (explicitSymbol ?? this.options.defaultSymbol ?? '')
      : requireSymbol(explicitSymbol, this.options.defaultSymbol, 'orderStatus')
    if (key.venueOrderId === undefined && key.clientOrderId === undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))
    }
    if (algo) return (await this.queryOrder(key, explicitSymbol ?? '', true)) ?? { found: false }
    const regular = await this.queryOrder(key, symbol, false)
    if (regular !== null) return regular
    // 普通单不存在：可能是触发单（algoId / clientAlgoId），再查一次
    const fallback = await this.queryOrder(key, explicitSymbol ?? '', true)
    return fallback ?? { found: false }
  }

  /** 查一次订单状态；订单不存在（普通单 -2013，algo 额外认 -2011）返回 null，其它错误抛 ProblemError。 */
  private async queryOrder(
    key: { clientOrderId?: string; venueOrderId?: string },
    symbol: string,
    algo: boolean,
  ): Promise<VenueOrderStatus | null> {
    const params: Record<string, string | number | undefined> = algo ? {} : { symbol }
    if (key.venueOrderId !== undefined) params[algo ? 'algoId' : 'orderId'] = key.venueOrderId
    else if (key.clientOrderId !== undefined) params[algo ? 'clientAlgoId' : 'origClientOrderId'] = key.clientOrderId
    const path = algo ? '/fapi/v1/algoOrder' : '/fapi/v1/order'
    try {
      const raw = await this.d.http.signed<RawOrder & RawAlgoOrder>('GET', path, params, {
        kind: 'query',
        weight: algo ? BINANCE_WEIGHTS.algoOrderQuery : BINANCE_WEIGHTS.orderQuery,
      })
      if (!raw || typeof raw !== 'object') return null
      const status = algo ? raw.algoStatus : raw.status
      const venueOrderId = algo ? raw.algoId : raw.orderId
      return {
        found: true,
        ...(typeof status === 'string' ? { status } : {}),
        ...(venueOrderId !== undefined ? { venueOrderId: String(venueOrderId) } : {}),
        ...(raw.executedQty !== undefined ? { filledSize: decimalOf(raw.executedQty) } : {}),
        raw,
      }
    } catch (e) {
      const problem = asProblem(e, { ...this.ctx(), endpoint: 'signed' })
      // -2013（顺带 algo 的 -2011）：订单不存在 → 交给调用方决定是回退还是 found: false，不是错误
      const text = `${problem.venue?.code ?? ''} ${problem.venue?.message ?? ''}`
      if ((algo ? /-2011(?!\d)|-2013(?!\d)/ : /-2013(?!\d)/).test(text)) return null
      throw new ProblemError(problem)
    }
  }

  /** 启动对账：账户快照 + 挂单 + 最近成交（到上限时 truncated = true）。
   *  成交按「持仓 ∪ 挂单」的 symbol 集合逐个拉，不只 defaultSymbol。
   */
  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms, opts: { symbol?: string } = {}): Promise<StartupSnapshot> {
    const account = await this.accountState(ref)
    const openOrders = await this.openOrders(ref)
    const instrumentIds = new Set<string>()
    for (const p of account.positions) instrumentIds.add(p.instrumentId)
    for (const o of openOrders) instrumentIds.add(o.instrumentId)
    if (opts.symbol !== undefined) instrumentIds.add(instrumentIdOf(opts.symbol))
    else if (this.options.defaultSymbol !== undefined) instrumentIds.add(instrumentIdOf(this.options.defaultSymbol))
    const seen = new Set<string>()
    const fills: VenueFill[] = []
    let truncated = false
    for (const instrumentId of instrumentIds) {
      const page = await this.fills(ref, fillsSinceMs, { symbol: symbolOf(instrumentId) })
      if (page.length >= USER_TRADES_LIMIT) truncated = true
      for (const fill of page) {
        const key = `${fill.instrumentId}|${fill.venueFillId}`
        if (seen.has(key)) continue
        seen.add(key)
        fills.push(fill)
      }
    }
    fills.sort((a, b) => a.ts - b.ts)
    return { account, openOrders, fills, fillsSince: fillsSinceMs, truncated }
  }

  /** 用 exchangeInfo 刷新的标的记录（诊断 / 测试用，不发请求）。 */
  records(): InstrumentRecord[] {
    return this.d.records()
  }

  /** 是否知道某个 instrumentId（不发请求）。 */
  knows(instrumentId: string): boolean {
    return this.d.records().some((r) => r.instrument.instrumentId === instrumentId)
  }

  /** 把 symbol 列表变成 instrumentId（诊断用）。 */
  instrumentIds(raw: RawAccount | null | undefined): string[] {
    return (raw?.positions ?? []).flatMap((p) => (typeof p.symbol === 'string' && p.symbol !== '' ? [instrumentIdOf(p.symbol)] : []))
  }

  /** 由 exchangeInfo 响应刷新的记录（便利入口，测试里直接喂假响应）。 */
  static instrumentsFrom(raw: unknown, now: Ms): InstrumentRecord[] {
    return parseInstrumentRecords(raw, now)
  }

  /** 只读诊断：账户权益的 Decimal 字符串（不发请求，用已解析快照）。 */
  static equityOf(snapshot: AccountSnapshot): Decimal {
    return snapshot.margin.equity
  }
}
