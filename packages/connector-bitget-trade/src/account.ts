// SPDX-License-Identifier: CPAL-1.0
// 账户读取：余额 / 保证金、持仓、挂单、成交、单张订单状态、启动对账。只读：本文件不发任何下单 / 撤单请求。
//     · 余额：GET /api/v2/mix/account/accounts（QD bitget.py:633-637）；
//     · 持仓：GET /api/v2/mix/position/all-position —— **持仓专用端点**（QD :639-666），不从账户汇总里取残缺字段；
//     · 挂单：GET /api/v2/mix/order/orders-pending（`data.entrustedList` + `endId`，QD open_orders.py:63-70,110-125），
//       另并上 GET /api/v2/mix/order/orders-plan-pending（planType 必填，三族 normal_plan / track_plan / profit_loss；
//       QD 未用，见 README「端点出处」）；缺 `entrustedList` 时整体报错（不当作空表）；
//     · 成交：GET /api/v2/mix/order/fills，按 idLessThan 翻页（QD :939-963），去重键 = tradeId；
//     · 单张：GET /api/v2/mix/order/detail（QD :919-937）——**必须带 symbol**，本实例提交过的单自己记（KnownOrder）。
// 数量单位一律「币数量」（venueSizeUnit = base）：不把张数当币数，也不做隐式换算。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type { AccountId, InstrumentId, Ms, Position } from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { BITGET_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import { sanitizeClientOid } from './orders'
import {
  MARGIN_COIN, PRODUCT_TYPE, decimalOf, parseAccount, parseEntrustedPage, parseFills, parseOpenOrder, parseOrderDetail,
  parsePositions, symbolOf,
} from './parse'
import type { RawEntrusted } from './parse'
import type { BitgetHttp } from './rest'
import { isUnknownOrderError } from './venue-errors'

/** fills 单页上限（官方 limit ≤ 100，QD bitget.py:953）。 */
export const FILLS_PAGE_LIMIT = 100
/** fills 翻页硬上限（QD 10 页；本连接器保留同一上限，防上游游标不前进时死循环）。 */
export const FILLS_MAX_PAGES = 10
/** 计划委托端点的 planType 三族（官方 v2：normal_plan / track_plan / profit_loss）。 */
export const PLAN_FAMILIES = ['normal_plan', 'track_plan', 'profit_loss'] as const

/** 本实例提交过的订单：clientOid / orderId → 标的 + 通道。Bitget 查单必须带 symbol，内核 lookup 不给。 */
export interface KnownOrder { symbol: string; kind: 'order' | 'plan'; planType?: string }
const KNOWN_MAX = 10_000

export interface AccountsOptions {
  /** 协议只有 standard / unified / portfolio：Bitget v2 mix 经典账户落 `standard`。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
  productType?: string
  marginCoin?: string
  /** 挂单是否并上计划委托端点（缺省 true；关掉就只看普通挂单）。 */
  includePlanOrders?: boolean
  /** posMode 缓存时长（QD :82-84 是 60 s）。 */
  posModeTtlMs?: number
}

interface Cache<T> { value: T; at: Ms }

export class BitgetAccounts {
  readonly #options: AccountsOptions
  /** 本实例提交过的订单：clientOid / orderId → 标的 + 通道。 */
  readonly #orders = new Map<string, KnownOrder>()
  private posModeCache = new Map<string, Cache<string>>()
  private readonly clock: () => number

  constructor(private readonly http: BitgetHttp, clock: () => number = () => Date.now(), options: AccountsOptions = {}) {
    this.clock = clock
    this.#options = options
  }

  private get productType(): string {
    return this.#options.productType ?? PRODUCT_TYPE
  }

  private get marginCoin(): string {
    return this.#options.marginCoin ?? MARGIN_COIN
  }

  private secrets(): readonly string[] {
    return this.http.secretsForRedaction()
  }

  private problemOf(e: unknown) {
    return asProblem(e, { secrets: this.secrets(), endpoint: 'signed' })
  }

  /**
   * 记住本实例提交过的订单（clientOid / orderId → 标的 + 通道）。
   * Bitget 的 /order/detail 必须带 symbol，而内核 lookup 只给 { clientOrderId, venueOrderId? }。
   */
  remember(ids: ReadonlyArray<string | null | undefined>, info: KnownOrder): void {
    for (const id of ids) {
      if (id === undefined || id === null || id === '') continue
      this.#orders.delete(id)
      this.#orders.set(id, info)
      if (this.#orders.size > KNOWN_MAX) this.#orders.delete(this.#orders.keys().next().value as string)
    }
  }

  known(id: string | null | undefined): KnownOrder | undefined {
    return id ? this.#orders.get(id) : undefined
  }

  // ---- 账户 / 持仓 ----------------------------------------------------------

  /** 持仓专用端点 → Position[]（QD bitget.py:639-666）。 */
  async positions(ref: AccountRef, symbol?: string): Promise<Position[]> {
    const params: Record<string, string | number | undefined> = { productType: this.productType }
    if (symbol !== undefined && symbol !== '') params['symbol'] = symbol
    try {
      const data = await this.http.signed<unknown>('GET', '/api/v2/mix/position/all-position', {
        params,
        weight: BITGET_WEIGHTS.positions,
        kind: 'query',
      })
      return parsePositions(data, { accountId: ref.accountId, now: this.clock() })
    } catch (e) {
      throw new ProblemError(this.problemOf(e))
    }
  }

  /** 账户快照：余额 + 保证金 + 持仓（持仓来自持仓端点，保证金汇总由持仓折算）。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const now = this.clock()
    const [accountsResult, positionsResult] = await Promise.allSettled([
      this.http.signed<unknown>('GET', '/api/v2/mix/account/accounts', {
        params: { productType: this.productType },
        weight: BITGET_WEIGHTS.accounts,
        kind: 'query',
      }),
      this.http.signed<unknown>('GET', '/api/v2/mix/position/all-position', {
        params: { productType: this.productType },
        weight: BITGET_WEIGHTS.positions,
        kind: 'query',
      }),
    ])
    if (accountsResult.status === 'rejected') throw new ProblemError(this.problemOf(accountsResult.reason))
    if (positionsResult.status === 'rejected') throw new ProblemError(this.problemOf(positionsResult.reason))
    const positions = parsePositions(positionsResult.value, { accountId: ref.accountId, now })
    const parsed = parseAccount(accountsResult.value, { accountId: ref.accountId, now }, positions)
    return {
      accountModel: this.#options.accountModel ?? 'standard',
      balances: parsed.balances,
      margin: parsed.margin,
      positions,
      ts: now,
      asOf: now,
      confirmedAt: now,
      stale: false,
      source: 'rest',
      availableDeductsOpenOrders: false,
    }
  }

  // ---- 挂单 -----------------------------------------------------------------

  /** 普通挂单 + （可选）计划委托。普通挂单按 endId 分页，计划委托逐族读。 */
  async openOrders(ref: AccountRef, instrumentId?: string): Promise<VenueOpenOrder[]> {
    void ref
    const symbol = instrumentId === undefined ? undefined : symbolOf(instrumentId)
    const out = await this.normalOpenOrders(symbol)
    if (this.#options.includePlanOrders !== false) {
      const now = this.clock()
      for (const row of await this.pendingPlanRows(symbol)) {
        const order = parseOpenOrder(row, now)
        if (order) out.push(order)
      }
    }
    return out
  }

  /** 普通挂单（GET /orders-pending，QD open_orders.py:63-70）。 */
  async normalOpenOrders(symbol?: string): Promise<VenueOpenOrder[]> {
    const base: Record<string, string | number | undefined> = { productType: this.productType, limit: 100 }
    if (symbol !== undefined) base['symbol'] = symbol
    const rows = await this.pagedEntrusted('/api/v2/mix/order/orders-pending', base, BITGET_WEIGHTS.ordersPending)
    const now = this.clock()
    const out: VenueOpenOrder[] = []
    for (const row of rows) {
      const order = parseOpenOrder(row, now)
      if (order) out.push(order)
    }
    return out
  }

  /**
   * 计划委托逐族读（官方 v2：planType 必填，三族 normal_plan / track_plan / profit_loss）。
   * 行缺 planType 时补成该族名；任一族读失败整体抛（不吞）。
   */
  async pendingPlanRows(symbol?: string): Promise<RawEntrusted[]> {
    const out: RawEntrusted[] = []
    for (const family of PLAN_FAMILIES) {
      const base: Record<string, string | number | undefined> = { productType: this.productType, planType: family, limit: 100 }
      if (symbol !== undefined) base['symbol'] = symbol
      const rows = await this.pagedEntrusted('/api/v2/mix/order/orders-plan-pending', base, BITGET_WEIGHTS.ordersPlanPending)
      for (const row of rows) out.push(row.planType === undefined || row.planType === '' ? { ...row, planType: family } : row)
    }
    return out
  }

  private async pagedEntrusted(path: string, base: Record<string, string | number | undefined>, weight: number): Promise<RawEntrusted[]> {
    const out: RawEntrusted[] = []
    let idLessThan: string | null = null
    for (let page = 0; page < 20; page++) {
      const params: Record<string, string | number | undefined> = { ...base }
      if (idLessThan !== null) params['idLessThan'] = idLessThan
      let data: unknown
      try {
        data = await this.http.signed<unknown>('GET', path, { params, weight, kind: 'query' })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      const parsed = parseEntrustedPage(data, this.clock())
      out.push(...parsed.rows)
      if (parsed.endId === null || parsed.endId === idLessThan || parsed.rows.length < Number(base['limit'] ?? 100)) return out
      idLessThan = parsed.endId
    }
    return out
  }

  // ---- 成交 -----------------------------------------------------------------

  /**
   * 成交（从 sinceMs 起）。按 idLessThan 翻页（QD bitget.py:951-963），最多 FILLS_MAX_PAGES 页；
   * 去重键是含 symbol 的 venueFillId（parse.ts:parseFill），因此同一笔不会因翻页重叠而重复入账。
   */
  async fills(ref: AccountRef, sinceMs: Ms, opts?: { instrumentId?: InstrumentId }): Promise<VenueFill[]> {
    void ref
    const requestedInstrumentId = opts?.instrumentId
    if (requestedInstrumentId !== undefined) symbolOf(requestedInstrumentId)
    const out = new Map<string, VenueFill>()
    const now = this.clock()
    let idLessThan: string | null = null
    for (let page = 0; page < FILLS_MAX_PAGES; page++) {
      const params: Record<string, string | number | undefined> = {
        productType: this.productType,
        startTime: Math.max(0, Math.round(sinceMs)),
        endTime: now,
        limit: FILLS_PAGE_LIMIT,
      }
      if (idLessThan !== null) params['idLessThan'] = idLessThan
      let data: unknown
      try {
        data = await this.http.signed<unknown>('GET', '/api/v2/mix/order/fills', { params, weight: BITGET_WEIGHTS.fills, kind: 'query' })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      const pageFills = parseFills(data, now)
      for (const fill of pageFills) if (fill.venueFillId !== '') out.set(fill.venueFillId, fill)
      const container = data && typeof data === 'object' ? (data as { endId?: unknown; fillList?: unknown }) : {}
      const listLength = Array.isArray(container.fillList) ? container.fillList.length : pageFills.length
      const lastFillId = pageFills[pageFills.length - 1]?.venueFillId ?? ''
      const cursor = container.endId === undefined || container.endId === null || container.endId === ''
        ? lastFillId.slice(lastFillId.indexOf(':') + 1)
        : String(container.endId)
      if (listLength < FILLS_PAGE_LIMIT || cursor === '' || cursor === idLessThan) break
      idLessThan = cursor
    }
    return [...out.values()]
      .filter((fill) => requestedInstrumentId === undefined || fill.instrumentId === requestedInstrumentId)
      .sort((a, b) => a.ts - b.ts)
  }

  // ---- 单张订单状态 ---------------------------------------------------------

  /**
   * 按 venueOrderId 或 clientOrderId 查详情；上游查不到时 found=false（不抛错）。
   * Bitget 的 /order/detail 必须带 symbol（QD bitget.py:927-930）：本实例提交过的单自动记住标的，
   * 否则调用方必须传 key.symbol，否则不发请求直接 INVALID_PARAMS。
   */
  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId; symbol?: string }): Promise<VenueOrderStatus> {
    void ref
    if ((key.venueOrderId === undefined || key.venueOrderId === '') && (key.clientOrderId === undefined || key.clientOrderId === '')) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))
    }
    const clientOid = key.clientOrderId !== undefined && key.clientOrderId !== '' ? sanitizeClientOid(String(key.clientOrderId)) : undefined
    const known = this.known(key.venueOrderId) ?? this.known(clientOid)
    let symbol: string | undefined
    if (key.instrumentId !== undefined) symbol = symbolOf(key.instrumentId)
    else if (key.symbol !== undefined && key.symbol !== '') symbol = key.symbol.includes(':') ? symbolOf(key.symbol) : key.symbol
    else symbol = known?.symbol
    if (symbol === undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'Bitget order lookup needs the symbol: this order was not submitted through this connector instance (pass key.symbol)'))
    }
    if (known?.kind === 'plan') {
      const rows = await this.pendingPlanRows(symbol)
      const row = rows.find((r) =>
        (key.venueOrderId !== undefined && key.venueOrderId !== '' && String(r.orderId ?? '') === String(key.venueOrderId))
        || (clientOid !== undefined && String(r.clientOid ?? '') === clientOid))
      if (row === undefined) return { found: false }
      return {
        found: true,
        status: String(row.planStatus ?? row.status ?? ''),
        venueOrderId: String(row.orderId),
        filledSize: asDecimal('0'),
        raw: row,
      }
    }
    const params: Record<string, string | number | undefined> = { productType: this.productType, symbol }
    if (key.venueOrderId !== undefined && key.venueOrderId !== '') params['orderId'] = key.venueOrderId
    else params['clientOid'] = clientOid
    try {
      const data = await this.http.signed<unknown>('GET', '/api/v2/mix/order/detail', { params, weight: BITGET_WEIGHTS.detail, kind: 'query' })
      return parseOrderDetail(data)
    } catch (e) {
      const problem = asProblem(e, { secrets: this.secrets(), endpoint: 'signed' })
      // 「找不到这张单」不是故障：按 found=false 交给对账（码表与文本判定统一在 venue-errors）。
      if (isUnknownOrderError(problem)) return { found: false }
      throw new ProblemError(problem)
    }
  }

  // ---- 对账 -----------------------------------------------------------------

  /** 启动对账：账户 + 挂单 + 最近成交（一次同一个 now）。 */
  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    const [account, openOrders, fills] = await Promise.all([
      this.accountState(ref),
      this.openOrders(ref),
      this.fills(ref, fillsSinceMs),
    ])
    return {
      account,
      openOrders,
      fills,
      fillsSince: fillsSinceMs,
      // fills 命中翻页上限就算可能被截断（调用方据此决定要不要继续回补）。
      truncated: fills.length >= FILLS_PAGE_LIMIT * FILLS_MAX_PAGES,
    }
  }

  // ---- posMode --------------------------------------------------------------

  /**
   * 合约账户的持仓模式：`hedge_mode` / `one_way_mode`（QD bitget.py:360-402）。
   * 下单用哪套字段由它决定；取不到时回落 one_way（与 QD 的 hedge 判定一致：只有明确 hedge_mode 才走对冲字段）。
   */
  async posMode(symbol: string): Promise<'hedge_mode' | 'one_way_mode' | ''> {
    const key = `${this.productType}:${symbol}:${this.marginCoin}`
    const now = this.clock()
    const cached = this.posModeCache.get(key)
    if (cached && now - cached.at <= (this.#options.posModeTtlMs ?? 60_000)) return cached.value as 'hedge_mode' | 'one_way_mode' | ''
    try {
      const data = await this.http.signed<{ posMode?: unknown } | undefined>('GET', '/api/v2/mix/account/account', {
        params: { symbol: symbol.toLowerCase(), productType: this.productType, marginCoin: this.marginCoin.toLowerCase() },
        weight: BITGET_WEIGHTS.account,
        kind: 'query',
      })
      const mode = String(data?.posMode ?? '').trim().toLowerCase()
      this.posModeCache.set(key, { value: mode, at: now })
      return mode as 'hedge_mode' | 'one_way_mode' | ''
    } catch {
      return ''
    }
  }

  /** 诊断 / 测试：直接写 posMode 缓存（省掉一次请求）。 */
  seedPosMode(symbol: string, mode: 'hedge_mode' | 'one_way_mode'): void {
    this.posModeCache.set(`${this.productType}:${symbol}:${this.marginCoin}`, { value: mode, at: this.clock() })
  }

  /** 诊断：金额 / 数量的原始文本（测试断言用）。 */
  static decimal = decimalOf

  /** 账户 id → 内部对象（诊断）。 */
  static accountIdOf(ref: AccountRef): AccountId {
    return ref.accountId
  }
}
