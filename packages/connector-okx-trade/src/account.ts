// SPDX-License-Identifier: CPAL-1.0
// 账户读取：/api/v5/account/balance、/account/positions、/trade/fills，加挂单 / 单状态 / 启动对账。
// **数量单位一律币数量**（venueSizeUnit = base）：OKX 的 pos / sz / accFillSz 都是**张**，
// 本文件用标的的 ctVal 折算（QD okx.py:1144-1162 对 accFillSz 就是这么做的）；ctVal 缺失时抛
// 1001 INSTRUMENT_UNKNOWN，绝不把张当币。
// 口径来源：QD live_trading/okx.py:439-443（balance）、:464-483（positions）、:936-951（algo pending）、
//   :1081-1102（order / fills）、:720-741（account config）。
// 只读：本文件不发任何下单 / 撤单请求。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import { cmpDec, div, fx, mulDec, str, subDec } from '@gitrader/protocol/decimal'
import type { AccountId, Balance, Decimal, InstrumentId, MarginSnapshot, Ms, Position } from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { OKX_ENDPOINT_COSTS } from './budget'
import { asProblem, ProblemError } from './errors'
import { baseOf } from './precision'
import { decimalOf, instrumentIdOf, mapOpenOrderType, num, symbolOf } from './parse'
import type { InstrumentRecord, PendingRef } from './parse'
import type { OkxHttp } from './rest'

/** fills 单页上限（OKX fills / fills-history 的 limit ≤ 100）。 */
export const FILLS_LIMIT = 100
/** 算法单类型：挂单视图要把它们一起收进来（QD okx.py:1009 的列表去掉 twap / iceberg / chase）。 */
export const ALGO_TYPES = ['conditional', 'oco', 'move_order_stop'] as const

export interface AccountsOptions {
  /** 账户模型标签：OKX 统一账户在协议里落 `unified`。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
}

export interface ReaderDeps {
  http: OkxHttp
  clock: () => number
  /** 脱敏用密钥；不保留任何单独的可枚举密钥字段。 */
  secrets: readonly string[]
  options?: AccountsOptions
  /** 已知标的记录（用于 ctVal 折算与 instId → symbol 校验）。 */
  records: () => InstrumentRecord[]
}

function ctValProblem(instId: string): ProblemError {
  return new ProblemError(makeProblem(
    'INSTRUMENT_UNKNOWN',
    `okx ${instId}: contract value (ctVal) unknown - not in the loaded USDT/USDC SWAP catalogue or start() not called; refusing to report contracts as coins`,
  ))
}

function requireCtValOf(instId: string, ctVal: string | Decimal | undefined): Decimal {
  if (ctVal === undefined) throw ctValProblem(instId)
  return typeof ctVal === 'string' ? asDecimal(ctVal) : ctVal
}

// ---- 原始形状 ---------------------------------------------------------------

export interface RawBalanceDetail {
  ccy?: string
  eq?: string
  cashBal?: string
  availBal?: string
  frozenBal?: string
  upl?: string
}

export interface RawBalance {
  totalEq?: string
  imr?: string
  mmr?: string
  mgnRatio?: string
  uTime?: string
  details?: RawBalanceDetail[]
}

export interface RawPosition {
  instId?: string
  posSide?: string
  pos?: string
  avgPx?: string
  markPx?: string
  upl?: string
  lever?: string
  liqPx?: string
  imr?: string
  mmr?: string
  mgnMode?: string
  cTime?: string
  uTime?: string
  notionalUsd?: string
  realizedPnl?: string
}

export interface RawFill {
  instId?: string
  tradeId?: string
  ordId?: string
  clOrdId?: string
  side?: string
  posSide?: string
  fillSz?: string
  fillPx?: string
  fee?: string
  feeCcy?: string
  fillPnl?: string
  fillTime?: string
  execType?: string
  ts?: string
}

export interface RawPendingOrder {
  instId?: string
  ordId?: string
  clOrdId?: string
  algoId?: string
  algoClOrdId?: string
  side?: string
  posSide?: string
  ordType?: string
  sz?: string
  px?: string
  accFillSz?: string
  avgPx?: string
  state?: string
  cTime?: string
  uTime?: string
  reduceOnly?: string
  slTriggerPx?: string
  tpTriggerPx?: string
  actualSz?: string
}

// ---- 解析 -------------------------------------------------------------------

/** /api/v5/account/balance → AccountSnapshot（balances + margin；positions 走独立的 positions 端点）。 */
export function parseBalance(
  raw: RawBalance | null | undefined,
  accountId: AccountId,
  now: Ms,
  accountModel: 'standard' | 'unified' | 'portfolio' = 'unified',
): AccountSnapshot {
  const ts = num(raw?.uTime) > 0 ? num(raw?.uTime) : now
  const details = Array.isArray(raw?.details) ? raw.details : []
  const balances: Balance[] = details.flatMap((d) => {
    const asset = typeof d.ccy === 'string' ? d.ccy : ''
    if (asset === '') return []
    const total = decimalOf(d.eq ?? d.cashBal)
    const available = decimalOf(d.availBal ?? '0')
    let hold: Decimal
    if (d.frozenBal !== undefined) hold = decimalOf(d.frozenBal)
    else {
      const derived = subDec(decimalOf(d.cashBal), available)
      hold = cmpDec(derived, '0') < 0 ? asDecimal('0') : derived
    }
    return [{ accountId, asset, total, available, hold, ts }]
  })
  const equity = decimalOf(raw?.totalEq ?? '0')
  const maintenanceMargin = decimalOf(raw?.mmr ?? '0')
  const ratio = Number(raw?.mgnRatio) > 0
    ? decimalOf(raw?.mgnRatio)
    : cmpDec(equity, '0') > 0 ? asDecimal(str(div(fx(String(maintenanceMargin)), fx(String(equity))))) : asDecimal('0')
  const available = balances.find((b) => b.asset === 'USDT')?.available ?? balances[0]?.available ?? asDecimal('0')
  const margin: MarginSnapshot = {
    accountId,
    model: accountModel,
    valuationCcy: 'USDT',
    equity,
    initialMargin: decimalOf(raw?.imr ?? '0'),
    maintenanceMargin,
    available,
    marginRatio: ratio,
    leverage: 0,
    ts,
  }
  return { accountModel, balances, margin, positions: [], ts, source: 'rest', availableDeductsOpenOrders: true }
}

/**
 * /api/v5/account/positions 一行 → Position。
 * `pos` 是张：size = |pos| × ctVal；net 模式下用正负号判方向，long_short 模式用 posSide。
 */
export function parsePosition(raw: RawPosition, accountId: AccountId, ctVal: string | undefined, now: Ms): Position | null {
  const instId = typeof raw.instId === 'string' ? raw.instId : ''
  if (instId === '') return null
  const contracts = typeof raw.pos === 'string' ? raw.pos.trim() : String(raw.pos ?? '0')
  if (contracts === '' || cmpDec(contracts, '0') === 0) return null
  const value = requireCtValOf(instId, ctVal)
  const absContracts = contracts.startsWith('-') ? contracts.slice(1) : contracts
  const size = baseOf(asDecimal(absContracts), value)
  if (cmpDec(size, '0') <= 0) return null
  const posSide = typeof raw.posSide === 'string' ? raw.posSide : ''
  const side = posSide === 'long' ? 'long' : posSide === 'short' ? 'short' : contracts.startsWith('-') ? 'short' : 'long'
  const markPrice = decimalOf(raw.markPx ?? '0')
  const notional = mulDec(size, markPrice)
  const lev = Math.round(num(raw.lever))
  const openedAt = num(raw.cTime)
  const updatedAt = num(raw.uTime)
  return {
    accountId,
    instrumentId: instrumentIdOf(instId),
    side,
    size,
    entryPrice: decimalOf(raw.avgPx ?? '0'),
    markPrice,
    notional,
    unrealizedPnl: decimalOf(raw.upl ?? '0'),
    realizedPnl: decimalOf(raw.realizedPnl ?? '0'),
    leverage: Number.isFinite(lev) && lev > 0 ? lev : 1,
    marginMode: (typeof raw.mgnMode === 'string' ? raw.mgnMode.toLowerCase() : 'cross') === 'isolated' ? 'isolated' : 'cross',
    ...(num(raw.imr) > 0 ? { initialMargin: decimalOf(raw.imr) } : {}),
    ...(num(raw.mmr) > 0 ? { maintenanceMargin: decimalOf(raw.mmr) } : {}),
    liquidationPrice: num(raw.liqPx) > 0 ? decimalOf(raw.liqPx) : null,
    fundingSinceOpen: decimalOf('0'),
    openedAt: Number.isFinite(openedAt) && openedAt > 0 ? openedAt : now,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now,
  }
}

/** /api/v5/trade/fills 一行 → VenueFill。`fillSz` 是张，按 ctVal 折成币。 */
export function parseFill(raw: RawFill, ctVal: string | undefined, now: Ms): VenueFill | null {
  const instId = typeof raw.instId === 'string' ? raw.instId : ''
  if (instId === '') return null
  const contracts = typeof raw.fillSz === 'string' ? raw.fillSz.trim() : String(raw.fillSz ?? '0')
  if (contracts === '' || cmpDec(contracts, '0') <= 0) return null
  const value = requireCtValOf(instId, ctVal)
  const ts = num(raw.fillTime ?? raw.ts)
  // OKX 的 fee 是「扣款为负、返佣为正」；协议 Fill.fee 约定「正 = 付出」
  const fee = subDec('0', decimalOf(raw.fee ?? '0'))
  const id = String(raw.tradeId ?? `${raw.ordId ?? ''}-${raw.fillTime ?? ''}`)
  return {
    venueFillId: id === '' ? '' : `${instId}:${id}`,
    venueOrderId: String(raw.ordId ?? ''),
    clientOrderId: typeof raw.clOrdId === 'string' && raw.clOrdId !== '' ? raw.clOrdId : null,
    instrumentId: instrumentIdOf(instId),
    side: typeof raw.side === 'string' && raw.side.toLowerCase() === 'sell' ? 'sell' : 'buy',
    price: decimalOf(raw.fillPx ?? '0'),
    size: baseOf(asDecimal(contracts), value),
    fee,
    feeCcy: typeof raw.feeCcy === 'string' && raw.feeCcy !== '' ? raw.feeCcy : 'USDT',
    liquidity: raw.execType === 'M' ? 'maker' : 'taker',
    realizedPnl: decimalOf(raw.fillPnl ?? '0'),
    ts: Number.isFinite(ts) && ts > 0 ? ts : now,
  }
}

function isReduceOnly(raw: RawPendingOrder): boolean {
  const posSide = typeof raw.posSide === 'string' ? raw.posSide : ''
  const side = typeof raw.side === 'string' ? raw.side.toLowerCase() : ''
  return raw.reduceOnly === 'true' || (posSide === 'long' && side === 'sell') || (posSide === 'short' && side === 'buy')
}

/**
 * /trade/orders-pending 一行 → VenueOpenOrder。
 * OKX 的 sz 是总张数、accFillSz 是已成交张数；协议要的是「剩余数量」（base）。
 */
export function parseOpenOrder(raw: RawPendingOrder, ctVal: string | undefined, now: Ms): VenueOpenOrder | null {
  const instId = typeof raw.instId === 'string' ? raw.instId : ''
  if (instId === '') return null
  const totalText = typeof raw.sz === 'string' ? raw.sz.trim() : String(raw.sz ?? '0')
  if (totalText === '' || cmpDec(totalText, '0') <= 0) return null
  const value = requireCtValOf(instId, ctVal)
  const filledText = typeof raw.accFillSz === 'string' ? raw.accFillSz.trim() : String(raw.accFillSz ?? '0')
  const filled = filledText === '' ? asDecimal('0') : asDecimal(filledText)
  const derived = subDec(asDecimal(totalText), filled)
  const remaining = cmpDec(derived, '0') < 0 ? asDecimal('0') : derived
  const px = num(raw.px)
  const type = mapOpenOrderType(raw.ordType)
  const created = num(raw.cTime)
  return {
    instrumentId: instrumentIdOf(instId),
    venueOrderId: String(raw.ordId ?? ''),
    clientOrderId: typeof raw.clOrdId === 'string' && raw.clOrdId !== '' ? raw.clOrdId : null,
    side: typeof raw.side === 'string' && raw.side.toLowerCase() === 'sell' ? 'sell' : 'buy',
    type,
    price: Number.isFinite(px) && px > 0 ? decimalOf(raw.px) : null,
    triggerPrice: null,
    size: baseOf(remaining, value),
    origSize: baseOf(asDecimal(totalText), value),
    reduceOnly: isReduceOnly(raw),
    isTrigger: false,
    createdAt: Number.isFinite(created) && created > 0 ? created : now,
  }
}

/**
 * /trade/orders-algo-pending 一行 → VenueOpenOrder。
 * 算法单没有 accFillSz：用 sz 当剩余量；触发价取 sl / tp 里有的那个；move_order_stop 在协议里只记 unknown 类型。
 */
export function parseAlgoOrder(raw: RawPendingOrder, ctVal: string | undefined, now: Ms): VenueOpenOrder | null {
  const instId = typeof raw.instId === 'string' ? raw.instId : ''
  if (instId === '') return null
  const totalText = typeof raw.sz === 'string' ? raw.sz : typeof raw.actualSz === 'string' ? raw.actualSz : String(raw.sz ?? raw.actualSz ?? '0')
  if (totalText.trim() === '' || cmpDec(totalText, '0') <= 0) return null
  const value = requireCtValOf(instId, ctVal)
  const total = asDecimal(totalText)
  const trigger = num(raw.slTriggerPx) > 0 ? raw.slTriggerPx : num(raw.tpTriggerPx) > 0 ? raw.tpTriggerPx : undefined
  const created = num(raw.cTime)
  const ordType = typeof raw.ordType === 'string' ? raw.ordType : ''
  const type = ordType === 'move_order_stop'
    ? 'unknown'
    : ordType === 'oco'
      ? 'stop_market'
      : num(raw.tpTriggerPx) > 0 ? 'take_market' : 'stop_market'
  return {
    instrumentId: instrumentIdOf(instId),
    venueOrderId: String(raw.algoId ?? ''),
    clientOrderId: typeof raw.algoClOrdId === 'string' && raw.algoClOrdId !== ''
      ? raw.algoClOrdId
      : (typeof raw.clOrdId === 'string' && raw.clOrdId !== '' ? raw.clOrdId : null),
    side: typeof raw.side === 'string' && raw.side.toLowerCase() === 'sell' ? 'sell' : 'buy',
    type,
    price: num(raw.px) > 0 ? decimalOf(raw.px) : null,
    triggerPrice: trigger === undefined ? null : decimalOf(trigger),
    size: baseOf(total, value),
    origSize: baseOf(total, value),
    reduceOnly: isReduceOnly(raw),
    isTrigger: true,
    createdAt: Number.isFinite(created) && created > 0 ? created : now,
  }
}

// ---- 读取器 -----------------------------------------------------------------

export class OkxAccounts {
  #d: ReaderDeps
  #secrets: readonly string[]
  #options: AccountsOptions

  constructor(d: ReaderDeps) {
    this.#d = d
    this.#secrets = d.secrets
    this.#options = d.options ?? {}
  }

  private ctx(): { secrets: readonly string[] } {
    return { secrets: this.#secrets }
  }

  private ctValOf(instId: string): Decimal | undefined {
    return this.#d.records().find((r) => r.symbol === instId)?.ctVal
  }

  private requireCtVal(instId: string): Decimal {
    return requireCtValOf(instId, this.ctValOf(instId))
  }

  async rawBalance(): Promise<RawBalance> {
    try {
      const envelope = await this.#d.http.signed<RawBalance>('GET', '/api/v5/account/balance', {
        request: { kind: 'query', cost: OKX_ENDPOINT_COSTS.accountBalance },
      })
      return (envelope.data?.[0] ?? {}) as RawBalance
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 账户配置（posMode = net_mode / long_short_mode）。 */
  async accountConfig(): Promise<{ posMode?: string; acctLv?: string; uid?: string }> {
    try {
      const envelope = await this.#d.http.signed<{ posMode?: string; acctLv?: string; uid?: string }>('GET', '/api/v5/account/config', {
        request: { kind: 'query', cost: OKX_ENDPOINT_COSTS.accountConfig },
      })
      return envelope.data?.[0] ?? {}
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 持仓（/account/positions，只留非零仓位）。 */
  async positions(ref: AccountRef, instrumentId?: string): Promise<Position[]> {
    const params: Record<string, string> = { instType: 'SWAP' }
    if (instrumentId !== undefined) params.instId = symbolOf(instrumentId)
    try {
      const envelope = await this.#d.http.signed<RawPosition>('GET', '/api/v5/account/positions', {
        params,
        request: { kind: 'query', cost: OKX_ENDPOINT_COSTS.accountPositions },
      })
      const rows = Array.isArray(envelope.data) ? envelope.data : []
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const ctVal = typeof row.instId === 'string' ? this.ctValOf(row.instId) : undefined
        const parsed = parsePosition(row, ref.accountId, ctVal, this.#d.clock())
        return parsed ? [parsed] : []
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 账户快照（balance + positions 两次读取）。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const raw = await this.rawBalance()
    const snapshot = parseBalance(raw, ref.accountId, this.#d.clock(), this.#options.accountModel ?? 'unified')
    const positions = await this.positions(ref)
    return { ...snapshot, positions }
  }

  /** 一页 100 行就翻页；最多 50 页，超出按 INTERNAL 拒（不静默截断）。 */
  private async fetchPendingPage(
    path: string,
    base: Record<string, string>,
    idField: 'ordId' | 'algoId',
    cost: number,
  ): Promise<RawPendingOrder[]> {
    const rows: RawPendingOrder[] = []
    let after: string | undefined
    for (let page = 0; page < 50; page++) {
      const params: Record<string, string> = { ...base, limit: '100', ...(after !== undefined ? { after } : {}) }
      const envelope = await this.#d.http.signed<RawPendingOrder>('GET', path, {
        params,
        request: { kind: 'query', cost },
      })
      const data = Array.isArray(envelope.data) ? envelope.data : []
      rows.push(...data)
      if (data.length < 100) return rows
      const last = data[data.length - 1]
      const id = last?.[idField]
      if (id === undefined || String(id) === '') return rows
      after = String(id)
    }
    throw new ProblemError(makeProblem('INTERNAL', 'okx pending-order pagination exceeded 50 pages'))
  }

  private async rawPending(instId?: string): Promise<{
    orders: RawPendingOrder[]
    algos: Array<RawPendingOrder & { ordType: string }>
  }> {
    const base: Record<string, string> = { instType: 'SWAP' }
    if (instId !== undefined) base.instId = instId
    const orders = await this.fetchPendingPage('/api/v5/trade/orders-pending', base, 'ordId', OKX_ENDPOINT_COSTS.ordersPending)
    const algos: Array<RawPendingOrder & { ordType: string }> = []
    for (const algoType of ALGO_TYPES) {
      const rows = await this.fetchPendingPage(
        '/api/v5/trade/orders-algo-pending', { ...base, ordType: algoType }, 'algoId', OKX_ENDPOINT_COSTS.ordersAlgoPending,
      )
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        algos.push({ ...row, ordType: typeof row.ordType === 'string' ? row.ordType : algoType })
      }
    }
    return { orders, algos }
  }

  /** 挂单：普通挂单 + 算法挂单（conditional / oco / move_order_stop）合并成一列。 */
  async openOrders(_ref: AccountRef, instrumentId?: string): Promise<VenueOpenOrder[]> {
    const instId = instrumentId === undefined ? undefined : symbolOf(instrumentId)
    try {
      const { orders, algos } = await this.rawPending(instId)
      const out: VenueOpenOrder[] = []
      for (const row of orders) {
        if (!row || typeof row !== 'object') continue
        const parsed = parseOpenOrder(row, typeof row.instId === 'string' ? this.ctValOf(row.instId) : undefined, this.#d.clock())
        if (parsed) out.push(parsed)
      }
      for (const row of algos) {
        if (!row || typeof row !== 'object') continue
        const parsed = parseAlgoOrder(row, typeof row.instId === 'string' ? this.ctValOf(row.instId) : undefined, this.#d.clock())
        if (parsed) out.push(parsed)
      }
      return out
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 成交回补：/trade/fills；有 symbol 就按 instId，否则全量 SWAP。 */
  async fills(_ref: AccountRef, sinceMs: Ms, opts: { instrumentId?: InstrumentId; symbol?: string; limit?: number; toMs?: number } = {}): Promise<VenueFill[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? FILLS_LIMIT), FILLS_LIMIT)
    const params: Record<string, string | number> = { instType: 'SWAP', limit }
    const symbol = opts.instrumentId === undefined ? opts.symbol : symbolOf(opts.instrumentId)
    if (symbol !== undefined && symbol !== '') params.instId = symbol
    if (sinceMs > 0) params.begin = Math.round(sinceMs)
    if (opts.toMs !== undefined) params.end = Math.round(opts.toMs)
    try {
      const envelope = await this.#d.http.signed<RawFill>('GET', '/api/v5/trade/fills', {
        params,
        request: { kind: 'background', cost: OKX_ENDPOINT_COSTS.fills },
      })
      return (envelope.data ?? []).flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const ctVal = typeof row.instId === 'string' ? this.ctValOf(row.instId) : undefined
        const parsed = parseFill(row, ctVal, this.#d.clock())
        return parsed ? [parsed] : []
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /**
   * 撤单候选：普通挂单（orders-pending）与算法挂单（conditional / oco / move_order_stop）分开返回，
   * 因为 OKX 的批量撤单端点是两个（cancel-batch-orders / cancel-algos），id 字段也不同（ordId / algoId）。
   */
  async pendingRefs(instrumentId?: string): Promise<{ orders: PendingRef[]; algos: PendingRef[] }> {
    try {
      const { orders: rawOrders, algos: rawAlgos } = await this.rawPending(instrumentId)
      const orders: PendingRef[] = []
      const algos: PendingRef[] = []
      for (const row of rawOrders) {
        const instId = typeof row?.instId === 'string' ? row.instId : ''
        const ordId = row?.ordId === undefined ? '' : String(row.ordId)
        if (instId === '' || ordId === '') continue
        orders.push({
          instId,
          venueOrderId: ordId,
          ...(typeof row.clOrdId === 'string' && row.clOrdId !== '' ? { clOrdId: row.clOrdId } : {}),
        })
      }
      for (const row of rawAlgos) {
        const instId = typeof row?.instId === 'string' ? row.instId : ''
        const algoId = row?.algoId === undefined ? '' : String(row.algoId)
        if (instId === '' || algoId === '') continue
        const clientOrderId = typeof row.algoClOrdId === 'string' && row.algoClOrdId !== ''
          ? row.algoClOrdId
          : (typeof row.clOrdId === 'string' && row.clOrdId !== '' ? row.clOrdId : undefined)
        algos.push({
          instId,
          venueOrderId: algoId,
          ...(clientOrderId !== undefined ? { clOrdId: clientOrderId } : {}),
        })
      }
      return { orders, algos }
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 单张订单状态（原样返回上游 state 字符串，不翻译）。51603 / 空 data = 单不存在 → found: false。 */
  async orderStatus(
    _ref: AccountRef,
    key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId },
    opts: { symbol: string; channel: 'order' | 'algo' },
  ): Promise<VenueOrderStatus> {
    const params: Record<string, string> = {}
    let path: string
    if (opts.channel === 'algo') {
      path = '/api/v5/trade/order-algo'
      if (key.venueOrderId !== undefined) params.algoId = key.venueOrderId
      else if (key.clientOrderId !== undefined) params.algoClOrdId = key.clientOrderId
      else throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))
    } else {
      path = '/api/v5/trade/order'
      params.instId = opts.symbol
      if (key.venueOrderId !== undefined) params.ordId = key.venueOrderId
      else if (key.clientOrderId !== undefined) params.clOrdId = key.clientOrderId
      else throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))
    }
    try {
      const envelope = await this.#d.http.signed<RawPendingOrder>('GET', path, {
        params,
        request: { kind: 'query', cost: OKX_ENDPOINT_COSTS.orderQuery },
      })
      const raw = envelope.data?.[0]
      if (!raw || typeof raw !== 'object') return { found: false }
      const venueOrderId = opts.channel === 'algo'
        ? (raw.algoId !== undefined ? String(raw.algoId) : undefined)
        : (raw.ordId !== undefined ? String(raw.ordId) : undefined)
      const instId = typeof raw.instId === 'string' && raw.instId !== '' ? raw.instId : opts.symbol
      const filled = opts.channel === 'order' && raw.accFillSz !== undefined
        ? baseOf(decimalOf(raw.accFillSz), this.requireCtVal(instId))
        : undefined
      return {
        found: true,
        ...(typeof raw.state === 'string' ? { status: raw.state } : {}),
        ...(venueOrderId !== undefined ? { venueOrderId } : {}),
        ...(filled !== undefined ? { filledSize: filled } : {}),
        raw,
      }
    } catch (e) {
      const problem = asProblem(e, { ...this.ctx(), endpoint: 'signed' })
      const text = problem.venue?.message ?? problem.message
      if (String(problem.venue?.code ?? '') === '51603' || text.includes('51603')) return { found: false }
      throw new ProblemError(problem)
    }
  }

  /** 启动对账：账户快照 + 挂单 + 最近成交（到上限时 truncated = true）。 */
  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    const account = await this.accountState(ref)
    const openOrders = await this.openOrders(ref)
    const fills = await this.fills(ref, fillsSinceMs)
    return { account, openOrders, fills, fillsSince: fillsSinceMs, truncated: fills.length >= FILLS_LIMIT }
  }

  /** 已知标的记录（诊断 / 测试用，不发请求）。 */
  records(): InstrumentRecord[] {
    return this.#d.records()
  }
}
