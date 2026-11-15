// SPDX-License-Identifier: CPAL-1.0
// 账户读取：余额（v5 GET /v5/account/balance 或 v1 POST swap_cross_account_info）、
// 持仓（v5 只读 GET /v5/trade/position/opens，失败照抛；v1 POST swap_cross_position_info）、
// 当前委托（v5 GET /v5/trade/order/opens 按 id 翻页；v1 POST swap_cross_openorders 按 page_index）、
// 单张订单（v5 GET /v5/trade/order；v1 POST swap_cross_order_info）、
// 成交记录（v5 GET /v5/trade/order/details 回看 3 天；v1 POST swap_cross_matchresults_exact 按 next_id 翻页），加启动对账。
// 只读：本文件不发任何下单 / 撤单 / 平仓请求（官方 v5 的两个“市价平仓”端点在 ENDPOINTS 表里也不存在）。
// 口径来源：HTX 官方《合约账户信息》《合约持仓信息》《合约当前委托》《成交记录》《V5 订单 / 成交明细》字段表；
//   QD 只作流程参照（其 position 回退与 v5 type 映射与官方相反，本包不照抄）。
// 两套 API 的取舍（QD 的真实痛点，写进 README）：v1 拒绝联合保证金账户，v5 拒绝单币种保证金账户；
// 本包按 family 选项选一套，遇到「账户模式不匹配」的错直接回 3001 并保留上游原文，不偷偷切换账户资产模式。
import { makeProblem } from '@gitrader/protocol'
import type { AccountId, Decimal, InstrumentId, Ms, Position } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { HTX_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import { numericClientOrderId } from './orders'
import type { OrderFamily } from './orders'
import {
  fillDedupeKey, firstOrderRow, parseAccountSnapshot, parseOpenOrder, parseOrderStatusResult, parsePositions, parseTrades,
  symbolOf, upper,
} from './parse'
import type { ContractSizeOf, RawBalanceEnvelope, RawOrder, RawPosition, RawTrade, RawTradesEnvelope } from './parse'
import { ENDPOINTS } from './rest'
import type { HtxHttp } from './rest'

/** v1 委托 / 持仓分页：官方 page_size 上限 50。 */
export const PAGE_SIZE = 50
/** v5 挂单 / 成交明细分页：官方 limit 上限 100。 */
export const V5_PAGE_LIMIT = 100
/** 翻页硬上限（防上游分页不前进时死循环）。 */
export const MAX_PAGES = 40
/** v1 成交记录单次时间跨度：官方 90 天内，本包按 7 天切窗。 */
export const FILL_WINDOW_MS = 7 * 86_400_000
/** v1 最多回看 12 个窗口（84 天，官方只给 90 天内）。 */
export const MAX_FILL_WINDOWS = 12
/** v5 order/details 单次窗口 2 天；官方标题「last 3 days」，参数表写 90 天，取较小的回看口径。 */
export const V5_FILL_WINDOW_MS = 2 * 86_400_000
export const V5_MAX_FILL_LOOKBACK_MS = 3 * 86_400_000

export interface AccountsOptions {
  /** 账户模型标签：HTX 联合保证金账户在协议里落 `unified`，逐仓交叉保证金账户落 `standard`。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
  /** v5（缺省）或 v1。 */
  family?: OrderFamily
  /** 缺省标的（orderStatus 这类不强制的接口用）。 */
  defaultSymbol?: string
  /** v5 查单时可选带的 margin_mode。 */
  marginMode?: 'cross' | 'isolated'
}

export interface ReaderDeps {
  http: HtxHttp
  clock: () => number
  options?: AccountsOptions
  contractSizeOf: ContractSizeOf
}

export class HtxAccounts {
  private readonly options: AccountsOptions
  private readonly family: OrderFamily
  readonly #secrets: readonly string[]

  /** secrets 单独传，不放进 this.d：JSON.stringify / inspect 看不到密钥。 */
  constructor(private readonly d: ReaderDeps, secrets: readonly string[] = []) {
    this.options = d.options ?? {}
    this.family = this.options.family ?? 'v5'
    this.#secrets = secrets
  }

  private ctx(): { secrets: string[] } {
    return { secrets: [...this.#secrets] }
  }

  // ───────────── 原始读取 ─────────────

  /** 余额原文：v5 → GET /v5/account/balance；v1 → POST /linear-swap-api/v1/swap_cross_account_info。 */
  async rawBalance(): Promise<unknown> {
    try {
      if (this.family === 'v5') {
        return await this.d.http.signed<RawBalanceEnvelope>(ENDPOINTS.v5Balance.method, ENDPOINTS.v5Balance.path, {}, {
          kind: 'query',
          weight: HTX_WEIGHTS.balance,
        })
      }
      return await this.d.http.signed<unknown>(ENDPOINTS.crossAccountInfo.method, ENDPOINTS.crossAccountInfo.path, { body: {} }, {
        kind: 'query',
        weight: HTX_WEIGHTS.balance,
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 持仓原文：v5 只打 GET /v5/trade/position/opens（失败照抛）；v1 打 POST swap_cross_position_info。 */
  async rawPositions(instrumentId?: string): Promise<unknown> {
    const params: Record<string, string> = {}
    if (instrumentId !== undefined) params.contract_code = symbolOf(instrumentId)
    try {
      if (this.family === 'v5') {
        return await this.d.http.signed<RawPosition[]>(ENDPOINTS.v5Positions.method, ENDPOINTS.v5Positions.path, { params }, {
          kind: 'query',
          weight: HTX_WEIGHTS.positions,
        })
      }
      return await this.d.http.signed<unknown>(ENDPOINTS.crossPositionInfo.method, ENDPOINTS.crossPositionInfo.path, { body: params }, {
        kind: 'query',
        weight: HTX_WEIGHTS.positions,
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  // ───────────── 账户快照 ─────────────

  /** 账户快照（balances + margin + positions）。持仓来自持仓端点，余额来自余额端点。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const now = this.d.clock()
    const raw = await this.rawBalance()
    const model = this.options.accountModel ?? (this.family === 'v5' ? 'unified' : 'standard')
    const snapshot = parseAccountSnapshot(raw, ref.accountId, now, model)
    const positions = await this.positions(ref)
    return { ...snapshot, positions }
  }

  /** 持仓（volume = 0 的槽位丢弃；数量换成币）。 */
  async positions(ref: AccountRef, instrumentId?: string): Promise<Position[]> {
    const raw = await this.rawPositions(instrumentId)
    return parsePositions(raw, ref.accountId, this.d.clock(), this.d.contractSizeOf)
  }

  // ───────────── 挂单 / 单状态 ─────────────

  /**
   * 当前委托：
   *   · v5 → GET /v5/trade/order/opens，params {contract_code?, limit:100, direct:'next', from?}；
   *     首页不带 from，下一页 from = 上一页最后一行的 id，本页行数 < 100 即停；
   *   · v1 → POST /linear-swap-api/v1/swap_cross_openorders，body 带 page_index / page_size（≤50）。
   * 给了 instrumentId 就按 contract_code 过滤，否则拉全部合约的当前委托。
   * // ponytail: v5 的 from 分页口径（from = 上一页最后一行 id）按官方参数表写，未经真网核实。
   */
  async openOrders(_ref: AccountRef, instrumentId?: InstrumentId): Promise<VenueOpenOrder[]> {
    const base = instrumentId === undefined ? {} : { contract_code: symbolOf(instrumentId) }
    const seen = new Set<string>()
    const out: VenueOpenOrder[] = []
    if (this.family === 'v5') {
      let from: string | undefined
      for (let page = 1; page <= MAX_PAGES; page++) {
        let rows: RawOrder[]
        try {
          const result = await this.d.http.signed<unknown>(ENDPOINTS.v5OpenOrders.method, ENDPOINTS.v5OpenOrders.path, {
            params: { ...base, limit: V5_PAGE_LIMIT, direct: 'next', ...(from !== undefined ? { from } : {}) },
          }, { kind: 'query', weight: HTX_WEIGHTS.openOrders })
          rows = Array.isArray(result) ? (result as RawOrder[]) : []
        } catch (e) {
          throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
        }
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          const parsed = parseOpenOrder(row, this.d.contractSizeOf, 'v5')
          if (!parsed) continue
          if (seen.has(parsed.venueOrderId)) continue
          seen.add(parsed.venueOrderId)
          out.push(parsed)
        }
        if (rows.length < V5_PAGE_LIMIT) return out
        const last = rows[rows.length - 1] as { id?: unknown } | undefined
        if (last?.id === undefined || last.id === null || String(last.id) === '') return out
        from = String(last.id)
      }
      throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'htx open orders span more than 40 pages; refusing a partial snapshot'))
    }

    for (let page = 1; page <= MAX_PAGES; page++) {
      let result: { orders?: RawOrder[]; total_page?: number; current_page?: number }
      try {
        result = await this.d.http.signed<{ orders?: RawOrder[]; total_page?: number; current_page?: number }>(
          ENDPOINTS.crossOpenOrders.method,
          ENDPOINTS.crossOpenOrders.path,
          { body: { ...base, page_index: page, page_size: PAGE_SIZE } },
          { kind: 'query', weight: HTX_WEIGHTS.openOrders },
        )
      } catch (e) {
        throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
      }
      const rows = Array.isArray(result?.orders) ? result.orders : []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const parsed = parseOpenOrder(row, this.d.contractSizeOf, 'v1')
        if (!parsed) continue
        if (seen.has(parsed.venueOrderId)) continue
        seen.add(parsed.venueOrderId)
        out.push(parsed)
      }
      const total = Number(result?.total_page)
      if (!Number.isFinite(total) || page >= total || rows.length === 0) return out
    }
    throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'htx open orders span more than 40 pages; refusing a partial snapshot'))
  }

  /**
   * 单张订单状态：v5 GET /v5/trade/order（params contract_code + order_id|client_order_id + margin_mode）；
   * v1 POST swap_cross_order_info（业务参数在 body）。
   * 只有场所明确「不存在」（v5 / v1 code 1061，或 data 为空 / 空数组）才回 found:false；
   * 其它任何错误（含 3001 / 3003 / 3006）都抛 ProblemError —— 查不到与查失败必须分清。
   */
  async orderStatus(
    _ref: AccountRef,
    key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId },
    opts: { symbol?: string } = {},
  ): Promise<VenueOrderStatus> {
    const code = key.instrumentId !== undefined
      ? symbolOf(key.instrumentId)
      : opts.symbol !== undefined
        ? upper(opts.symbol)
        : this.options.defaultSymbol !== undefined
          ? upper(this.options.defaultSymbol)
          : undefined
    if (code === undefined) throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs instrumentId or a default symbol'))
    if (key.venueOrderId === undefined && key.clientOrderId === undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))
    }
    const keyParams: Record<string, string> = { contract_code: code }
    if (key.venueOrderId !== undefined) keyParams.order_id = String(key.venueOrderId)
    else {
      const raw = String(key.clientOrderId)
      // 内核字符串 → 场所 int64（确定性映射，见 orders.numericClientOrderId）
      keyParams.client_order_id = /^\d+$/.test(raw) ? raw : numericClientOrderId(raw)
    }
    if (this.options.marginMode !== undefined) keyParams.margin_mode = this.options.marginMode
    const endpoint = this.family === 'v5' ? ENDPOINTS.v5OrderInfo : ENDPOINTS.crossOrderInfo
    let raw: unknown
    try {
      raw = await this.d.http.signed(
        endpoint.method as 'GET' | 'POST',
        endpoint.path,
        this.family === 'v5' ? { params: keyParams } : { body: keyParams },
        { kind: 'query', weight: HTX_WEIGHTS.orderInfo },
      )
    } catch (e) {
      const problem = asProblem(e, { ...this.ctx(), endpoint: 'signed' })
      if (Number(problem.venue?.code) === 1061) return { found: false }
      throw new ProblemError(problem)
    }
    const row = firstOrderRow(raw)
    if (!row) return { found: false }
    const status = parseOrderStatusResult(row, this.d.contractSizeOf)
    return status.found ? status : { found: false }
  }

  // ───────────── 成交 ─────────────

  /**
   * 成交回补：
   *   · v1 POST swap_cross_matchresults_exact：body {contract_code, trade_type:0, start_time, end_time, size:50, direct:'next', from_id?}；
   *     `next_id` 非空 → 下一页 from_id = next_id；空即停。按 7 天窗口切开，最多 12 窗（84 天，官方只给 90 天内）。
   *   · v5 GET /v5/trade/order/details：params {contract_code, start_time, end_time, limit:100, direct:'next', from?}；
   *     下一页 from = 最后一行 id，行数 < 100 即停；窗口 2 天、最多回看 3 天。
   * 去重键是场所成交号（窗口边界 / 翻页重叠都靠它）。
   * // ponytail: 官方标题写「last 3 days」、参数表写 90 天，取较短的 3 天；分页口径未经真网核实。
   */
  private async collectFills(
    sinceMs: Ms,
    opts: { symbol: string; limit?: number; toMs?: number },
  ): Promise<{ fills: VenueFill[]; truncated: boolean; clamped: boolean }> {
    const now = this.d.clock()
    const end = opts.toMs !== undefined ? Math.round(opts.toMs) : now
    const windowMs = this.family === 'v5' ? V5_FILL_WINDOW_MS : FILL_WINDOW_MS
    const maxLookback = this.family === 'v5' ? V5_MAX_FILL_LOOKBACK_MS : MAX_FILL_WINDOWS * FILL_WINDOW_MS
    let start = sinceMs > 0 ? Math.round(sinceMs) : end - windowMs
    const earliest = end - maxLookback
    let clamped = false
    if (start < earliest) {
      start = earliest
      clamped = true
    }
    const pageLimit = this.family === 'v5'
      ? Math.min(opts.limit ?? V5_PAGE_LIMIT, V5_PAGE_LIMIT)
      : Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE)
    const seen = new Set<string>()
    const out: VenueFill[] = []
    let truncated = false
    for (let windowStart = start; windowStart < end; windowStart += windowMs) {
      const windowEnd = Math.min(windowStart + windowMs, end)
      let from: string | undefined
      for (let page = 1; page <= MAX_PAGES; page++) {
        let rows: RawTrade[]
        try {
          if (this.family === 'v1') {
            const result = await this.d.http.signed<RawTradesEnvelope>(
              ENDPOINTS.crossMatchResults.method,
              ENDPOINTS.crossMatchResults.path,
              {
                body: {
                  contract_code: opts.symbol,
                  trade_type: 0,
                  start_time: windowStart,
                  end_time: windowEnd,
                  size: pageLimit,
                  direct: 'next',
                  ...(from !== undefined ? { from_id: from } : {}),
                },
              },
              { kind: 'background', weight: HTX_WEIGHTS.matchResults },
            )
            rows = Array.isArray(result?.trades) ? result.trades : []
            const next = result?.next_id
            for (const fill of parseTrades({ trades: rows }, now, this.d.contractSizeOf, 'v1')) {
              const dedupe = fillDedupeKey(fill)
              if (seen.has(dedupe)) continue
              seen.add(dedupe)
              out.push(fill)
            }
            if (rows.length === 0 || next === undefined || next === null || String(next) === '') break
            from = String(next)
          } else {
            const result = await this.d.http.signed<unknown>(
              ENDPOINTS.v5OrderDetails.method,
              ENDPOINTS.v5OrderDetails.path,
              {
                params: {
                  contract_code: opts.symbol,
                  start_time: windowStart,
                  end_time: windowEnd,
                  limit: pageLimit,
                  direct: 'next',
                  ...(from !== undefined ? { from } : {}),
                },
              },
              { kind: 'background', weight: HTX_WEIGHTS.matchResults },
            )
            rows = Array.isArray(result) ? (result as RawTrade[]) : []
            for (const fill of parseTrades(rows, now, this.d.contractSizeOf, 'v5')) {
              const dedupe = fillDedupeKey(fill)
              if (seen.has(dedupe)) continue
              seen.add(dedupe)
              out.push(fill)
            }
            if (rows.length < pageLimit) break
            const last = rows[rows.length - 1] as { id?: unknown } | undefined
            if (last?.id === undefined || last.id === null || String(last.id) === '') break
            from = String(last.id)
          }
        } catch (e) {
          throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
        }
        if (page === MAX_PAGES) truncated = true
      }
    }
    return { fills: out.sort((a, b) => a.ts - b.ts), truncated, clamped }
  }

  /** 成交：给了 instrumentId 就只拉那个合约；否则用 defaultSymbol（HTX 的成交端点必须给合约）。 */
  async fills(
    _ref: AccountRef,
    sinceMs: Ms,
    opts: { instrumentId?: InstrumentId; limit?: number; toMs?: number } = {},
  ): Promise<VenueFill[]> {
    const symbol = opts.instrumentId !== undefined
      ? symbolOf(opts.instrumentId)
      : this.options.defaultSymbol !== undefined
        ? upper(this.options.defaultSymbol)
        : undefined
    if (symbol === undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'htx match results need a contract: pass instrumentId or configure defaultSymbol'))
    }
    const collected = await this.collectFills(sinceMs, {
      symbol,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.toMs !== undefined ? { toMs: opts.toMs } : {}),
    })
    if (collected.clamped) {
      throw new ProblemError(makeProblem(
        'INVALID_PARAMS',
        this.family === 'v5'
          ? 'htx v5 order details cover the last 3 days; sinceMs is further back'
          : 'htx match results are read in 7-day windows up to 12 windows; sinceMs is more than 84 days back',
      ))
    }
    return collected.fills
  }

  // ───────────── 启动对账 ─────────────

  /** 启动对账：账户快照 + 挂单 + 最近成交（持仓 ∪ 挂单的合约逐个拉，到上限时 truncated = true）。 */
  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms, opts: { symbol?: string } = {}): Promise<StartupSnapshot> {
    const account = await this.accountState(ref)
    const openOrders = await this.openOrders(ref)
    const symbols = new Set<string>()
    for (const p of account.positions) symbols.add(symbolOf(p.instrumentId))
    for (const o of openOrders) symbols.add(symbolOf(o.instrumentId))
    if (opts.symbol !== undefined) symbols.add(upper(opts.symbol))
    else if (this.options.defaultSymbol !== undefined) symbols.add(upper(this.options.defaultSymbol))
    const seen = new Set<string>()
    const fills: VenueFill[] = []
    let truncated = false
    for (const symbol of symbols) {
      const collected = await this.collectFills(fillsSinceMs, { symbol })
      truncated = truncated || collected.truncated || collected.clamped
      for (const fill of collected.fills) {
        const key = fillDedupeKey(fill)
        if (seen.has(key)) continue
        seen.add(key)
        fills.push(fill)
      }
    }
    fills.sort((a, b) => a.ts - b.ts)
    return { account, openOrders, fills, fillsSince: fillsSinceMs, truncated }
  }

  /** 只读诊断：账户权益（不发请求，用已解析快照）。 */
  static equityOf(snapshot: AccountSnapshot): string {
    return String(snapshot.margin.equity)
  }

  /** 只读诊断：可用余额。 */
  static availableOf(snapshot: AccountSnapshot): string {
    return String(snapshot.margin.available)
  }

  /** 单笔成交的数量（诊断 / 断言用）。 */
  static sizeOf(fill: VenueFill): string {
    return String(asDecimal(String(fill.size)))
  }

  /** 账户 id（诊断 / 测试用）。 */
  static accountOf(ref: AccountRef): AccountId {
    return ref.accountId
  }

  /** 成交的空 Decimal（诊断用）。 */
  static zero(): Decimal {
    return asDecimal('0')
  }
}
