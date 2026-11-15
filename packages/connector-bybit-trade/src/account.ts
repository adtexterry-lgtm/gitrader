// SPDX-License-Identifier: CPAL-1.0
// 账户读取：/v5/account/wallet-balance、/v5/position/list、/v5/order/realtime|history、/v5/execution/list，
// 加挂单 / 单状态 / 启动对账。只读：本文件不发任何下单 / 撤单请求。
// 口径来源：QD live_trading/bybit.py:494-495（wallet-balance）、:763-778（realtime → history 回退）、
//   :780-808（execution/list 游标翻页）、:924-947（position/list：symbol 或 settleCoin 二选一）。
// 数量单位一律「标的币数量」（venueSizeUnit = base）。
// 两个必须守住的细节：
//   1) 可用余额用统一账户的 `totalAvailableBalance`（不是逐币 availableToWithdraw）；
//   2) 成交只把 Funding 排除（Trade / AdlTrade / BustTrade / Delivery 都改变仓位），去重键是 execId（`bybit|<execId>`）——见 parse.ts。
import { makeProblem } from '@gitrader/protocol'
import type { AccountId, Instrument, InstrumentId, Ms, Position } from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { BYBIT_WEIGHTS } from './budget'
import { asProblem, ProblemError } from './errors'
import {
  decimalOf, fillDedupeKey, instrumentIdOf, parseAccountSnapshot, parseExecutions, parseOpenOrder, parseOrderStatusResult,
  parsePositions, symbolOf, upper,
} from './parse'
import type { RawExecutionPage, RawOrder, RawOrderPage, RawPositionPage, RawWallet, RawWalletPage } from './parse'
import type { BybitHttp } from './rest'

/** /v5/execution/list 单页上限（官方 limit ≤ 100）。 */
export const EXECUTION_PAGE_LIMIT = 100
/** 游标翻页硬上限（QD get_executions 也是 10 页），防上游游标不前进时死循环。 */
export const MAX_EXECUTION_PAGES = 10
/** 统一账户类型（Bybit v5 目前只有 UNIFIED 有完整字段）。 */
export const ACCOUNT_TYPE = 'UNIFIED'
/** 列表端点（挂单 / 持仓）的翻页硬上限：超过仍游标就拒绝，不交半张清单。 */
export const MAX_LIST_PAGES = 20
/** v5 execution/list 单次只接受 7 天窗口。 */
export const FILL_WINDOW_MS = 7 * 86_400_000
/** 成交回看最多 13 个 7 天窗口（13 周）。 */
export const MAX_FILL_WINDOWS = 13

export interface AccountsOptions {
  /** 账户模型标签：Bybit 统一账户在协议里落 `unified`（standard / portfolio 只在老账户上出现）。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
  /** 没给 symbol 时的结算币口径（linear 的 position/list 与 order/realtime 都要 symbol 或 settleCoin）。 */
  defaultSettleCoin?: string
  /** orderStatus 这类必须 symbol 的接口用的缺省标的。 */
  defaultSymbol?: string
}

export interface ReaderDeps {
  http: BybitHttp
  clock: () => number
  options?: AccountsOptions
  /** 本地标的记录（把 symbol 变回 instrumentId 与取精度）。 */
  instrumentOf: (instrumentId: string) => Instrument | undefined
}

export class BybitAccounts {
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

  private get settleCoin(): string {
    return upper(this.options.defaultSettleCoin ?? 'USDT')
  }

  // ───────────── 原始读取 ─────────────

  async rawWallet(accountType = ACCOUNT_TYPE): Promise<RawWallet> {
    try {
      const page = await this.d.http.signed<RawWalletPage>('GET', '/v5/account/wallet-balance', {
        params: { accountType, ...(accountType === ACCOUNT_TYPE ? {} : { coin: 'USDT' }) },
      }, { kind: 'query', weight: BYBIT_WEIGHTS.walletBalance })
      const first = Array.isArray(page?.list) ? page.list[0] : undefined
      return first ?? {}
    } catch (e) {
      throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
    }
  }

  /** 仓单一律走 /v5/position/list（不是 wallet-balance 的残缺字段）；按游标翻完全部页再返回。 */
  async rawPositions(instrumentId?: string): Promise<RawPositionPage> {
    const base = instrumentId === undefined
      ? { category: 'linear', settleCoin: this.settleCoin }
      : { category: 'linear', symbol: symbolOf(instrumentId) }
    const rows: NonNullable<RawPositionPage['list']> = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = { ...base, limit: 200, ...(cursor !== undefined ? { cursor } : {}) }
      try {
        const result = await this.d.http.signed<RawPositionPage>('GET', '/v5/position/list', { params }, {
          kind: 'query',
          weight: BYBIT_WEIGHTS.positionList,
        })
        if (Array.isArray(result?.list)) rows.push(...result.list)
        const next = typeof result?.nextPageCursor === 'string' ? result.nextPageCursor : ''
        if (next === '' || next === cursor) return { ...(result ?? {}), list: rows }
        cursor = next
      } catch (e) {
        throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
      }
    }
    throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'bybit /v5/position/list spans more than 20 pages; refusing a partial snapshot', { retryable: false }))
  }

  // ───────────── 账户快照 ─────────────

  /** 账户快照（balances + margin + positions）。持仓来自 position/list，余额来自 wallet-balance。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const now = this.d.clock()
    const wallet = await this.rawWallet()
    const snapshot = parseAccountSnapshot(wallet, ref.accountId, now, this.options.accountModel ?? 'unified')
    const positions = await this.positions(ref)
    return { ...snapshot, positions }
  }

  /** 持仓（单独打 /v5/position/list；size = 0 的槽位丢弃）。 */
  async positions(ref: AccountRef, instrumentId?: string): Promise<Position[]> {
    const page = await this.rawPositions(instrumentId)
    return parsePositions(page, ref.accountId, this.d.clock())
  }

  // ───────────── 挂单 / 单状态 ─────────────

  /**
   * 挂单：GET /v5/order/realtime（category=linear），按游标翻完全部页。
   * 给了 instrumentId 就按 symbol，否则按 settleCoin=USDT 拉全量——Bybit 两者必须给其一。
   */
  async openOrders(_ref: AccountRef, instrumentId?: string): Promise<VenueOpenOrder[]> {
    const base = instrumentId === undefined
      ? { category: 'linear', settleCoin: this.settleCoin }
      : { category: 'linear', symbol: symbolOf(instrumentId) }
    const rows: RawOrder[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = { ...base, limit: 50, ...(cursor !== undefined ? { cursor } : {}) }
      try {
        const result = await this.d.http.signed<RawOrderPage>('GET', '/v5/order/realtime', { params }, {
          kind: 'query',
          weight: BYBIT_WEIGHTS.orderRealtime,
        })
        if (Array.isArray(result?.list)) rows.push(...result.list)
        const next = typeof result?.nextPageCursor === 'string' ? result.nextPageCursor : ''
        if (next === '' || next === cursor) {
          // 同一 orderId 只留第一行（游标可能重复吐同一页）；没有 orderId 的行照旧交给 parseOpenOrder。
          const seen = new Set<string>()
          const unique: RawOrder[] = []
          for (const row of rows) {
            const id = row && typeof row === 'object' && row.orderId !== undefined ? String(row.orderId) : ''
            if (id !== '') {
              if (seen.has(id)) continue
              seen.add(id)
            }
            unique.push(row)
          }
          const out: VenueOpenOrder[] = []
          for (const row of unique) {
            if (!row || typeof row !== 'object') continue
            const parsed = parseOpenOrder(row)
            if (parsed) out.push(parsed)
          }
          return out
        }
        cursor = next
      } catch (e) {
        throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
      }
    }
    throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'bybit /v5/order/realtime spans more than 20 pages; refusing a partial snapshot', { retryable: false }))
  }

  /**
   * 单张订单状态：先 GET /v5/order/realtime，空结果再 GET /v5/order/history（照 QD bybit.py:772-776）。
   * 两处都空 → found: false（不是错误）。
   */
  async orderStatus(
    _ref: AccountRef,
    key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: InstrumentId },
    opts: { symbol?: string } = {},
  ): Promise<VenueOrderStatus> {
    const symbol = key.instrumentId !== undefined ? symbolOf(key.instrumentId) : (opts.symbol !== undefined ? upper(opts.symbol) : undefined)
    const params: Record<string, string | number | undefined> = {
      category: 'linear',
      ...(symbol !== undefined ? { symbol } : { settleCoin: this.settleCoin }),
    }
    if (key.venueOrderId !== undefined) params.orderId = key.venueOrderId
    else if (key.clientOrderId !== undefined) params.orderLinkId = String(key.clientOrderId)
    else throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))

    for (const [path, weight] of [['/v5/order/realtime', BYBIT_WEIGHTS.orderRealtime], ['/v5/order/history', BYBIT_WEIGHTS.orderHistory]] as const) {
      try {
        const page = await this.d.http.signed<RawOrderPage>('GET', path, { params }, { kind: 'query', weight })
        const rows = Array.isArray(page?.list) ? page.list : []
        if (rows.length > 0) {
          const status = parseOrderStatusResult(rows[0] as RawOrder)
          if (status.found) return status
        }
      } catch (e) {
        const problem = asProblem(e, { ...this.ctx(), endpoint: 'signed' })
        // 只有 realtime 端点可能因为「无此单」报错；history 端点失败是真空错，往上抛。
        if (path === '/v5/order/realtime' && /110001|order not exist|order does not exist/i.test(problem.venue?.message ?? '')) continue
        throw new ProblemError(problem)
      }
    }
    return { found: false }
  }

  // ───────────── 成交 ─────────────

  /**
   * 成交回补：v5 的 execution/list 单次只接受 7 天窗口，所以按窗口切开逐段翻页。
   * 不给 symbol 就按 settleCoin 拉全量；按 execId 去重（翻页重叠 / 窗口边界都靠它）。
   */
  private async collectFills(
    sinceMs: Ms,
    opts: { symbol?: string; limit?: number; toMs?: number } = {},
  ): Promise<{ fills: VenueFill[]; truncated: boolean; clamped: boolean }> {
    const now = this.d.clock()
    const end = opts.toMs !== undefined ? Math.round(opts.toMs) : now
    let start = sinceMs > 0 ? Math.round(sinceMs) : end - FILL_WINDOW_MS
    const earliest = end - MAX_FILL_WINDOWS * FILL_WINDOW_MS
    let clamped = false
    if (start < earliest) {
      start = earliest
      clamped = true
    }
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? EXECUTION_PAGE_LIMIT)), EXECUTION_PAGE_LIMIT)
    const base: Record<string, string | number | undefined> = {
      category: 'linear',
      ...(opts.symbol !== undefined ? { symbol: upper(opts.symbol) } : { settleCoin: this.settleCoin }),
      limit,
    }
    const seen = new Set<string>()
    const out: VenueFill[] = []
    let truncated = false
    for (let windowStart = start; windowStart < end; windowStart += FILL_WINDOW_MS) {
      const windowEnd = Math.min(windowStart + FILL_WINDOW_MS, end)
      let cursor: string | undefined
      for (let page = 0; page < MAX_EXECUTION_PAGES; page++) {
        let result: RawExecutionPage
        try {
          result = await this.d.http.signed<RawExecutionPage>('GET', '/v5/execution/list', {
            params: {
              ...base,
              startTime: windowStart,
              endTime: windowEnd,
              ...(cursor !== undefined ? { cursor } : {}),
            },
          }, { kind: 'background', weight: BYBIT_WEIGHTS.executionList })
        } catch (e) {
          throw new ProblemError(asProblem(e, { ...this.ctx(), endpoint: 'signed' }))
        }
        for (const fill of parseExecutions(result, now)) {
          const key = fillDedupeKey(fill)
          if (seen.has(key)) continue
          seen.add(key)
          out.push(fill)
        }
        const next = typeof result?.nextPageCursor === 'string' ? result.nextPageCursor : ''
        if (next === '' || next === cursor) break
        cursor = next
        if (page === MAX_EXECUTION_PAGES - 1) truncated = true
      }
    }
    return { fills: out.sort((a, b) => a.ts - b.ts), truncated, clamped }
  }

  async fills(
    _ref: AccountRef,
    sinceMs: Ms,
    opts: { instrumentId?: InstrumentId; symbol?: string; limit?: number; toMs?: number } = {},
  ): Promise<VenueFill[]> {
    const collected = await this.collectFills(sinceMs, {
      ...opts,
      ...(opts.instrumentId !== undefined ? { symbol: symbolOf(opts.instrumentId) } : {}),
    })
    if (collected.clamped) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'Bybit execution history is read in 7-day windows; sinceMs is more than 13 weeks back'))
    }
    return collected.fills
  }

  // ───────────── 启动对账 ─────────────

  /**
   * 启动对账：账户快照 + 挂单 + 最近成交（到上限时 truncated = true）。
   * 成交按「持仓 ∪ 挂单」的 symbol 集合逐个拉，不只 defaultSymbol（照 Binance 包的做法）。
   */
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

  /** 本地标的记录（诊断 / 测试用，不发请求）。 */
  instrument(instrumentId: string): Instrument | undefined {
    return this.d.instrumentOf(instrumentId)
  }

  /** 是否知道某个 instrumentId（不发请求）。 */
  knows(instrumentId: string): boolean {
    return this.d.instrumentOf(instrumentId) !== undefined
  }

  /** 把持仓行变成 instrumentId 列表（诊断用）。 */
  instrumentIds(page: RawPositionPage | null | undefined): string[] {
    const rows = Array.isArray(page?.list) ? page.list : []
    return rows.flatMap((row) => (typeof row?.symbol === 'string' && row.symbol !== '' ? [instrumentIdOf(upper(row.symbol))] : []))
  }

  /** 只读诊断：账户权益的 Decimal 字符串（不发请求，用已解析快照）。 */
  static equityOf(snapshot: AccountSnapshot): string {
    return String(snapshot.margin.equity)
  }

  /** 只读诊断：可用余额（统一账户 totalAvailableBalance 的口径）。 */
  static availableOf(snapshot: AccountSnapshot): string {
    return String(snapshot.margin.available)
  }

  /** 单笔成交的数量（诊断 / 断言用）。 */
  static sizeOf(fill: VenueFill): string {
    return String(decimalOf(fill.size))
  }

  /** 账户 id 便于测试断言（不发请求）。 */
  static accountOf(ref: AccountRef): AccountId {
    return ref.accountId
  }
}
