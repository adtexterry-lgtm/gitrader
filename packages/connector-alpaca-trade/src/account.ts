// SPDX-License-Identifier: CPAL-1.0
// 账户读取：账户 / 保证金、持仓、挂单、成交、单张订单状态、启动对账、账户限制。
// **只读**：本文件不发任何下单 / 撤单请求。
//   端点出处（Trading API v2 官方文档；QD 走 alpaca-py，除 activities 外未手写路径）：
//   · 账户：`GET /v2/account`（QD client.py:647-699 的字段清单即此）；
//   · 持仓：`GET /v2/positions`——**持仓专用端点**（教训 5），不从账户汇总里取残缺字段；
//   · 挂单：`GET /v2/orders?status=open`（按订单 id 翻页用 `after_order_id`；`after` 是时间戳）；
//   · 成交：`GET /v2/account/activities?activity_types=FILL`（QD client.py:592-643：page_size ≤ 100、page_token = 上一页最后一行的 id）；
//   · 单张：`GET /v2/orders/{order_id}` 与 `GET /v2/orders:by_client_order_id?client_order_id=`（官方「按客户端单号查」端点）。
// 数量单位一律「股」（venueSizeUnit = base）：不把美元金额当数量，也不做隐式换算。
import { makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type { AccountId, Ms, Position } from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { ACTIVITIES_MAX_PAGES, ACTIVITIES_PAGE_SIZE, PREFLIGHT_TTL_MS, VENUE } from './constants'
import { ProblemError, asProblem } from './errors'
import {
  availableLongQty, isoOf, parseAccount, parseActivityFills, parseOpenOrders, parseOrderStatus,
  parsePositions,
} from './parse'
import { symbolOf } from './assets'
import type { AccountRestrictions, ParsedAccount } from './parse'
import type { AlpacaHttp } from './rest'
import { ALPACA_WEIGHTS } from './budget'
import { isUnknownOrderError } from './venue-errors'

/** 本实例提交过的订单（Alpaca 查单不需要 symbol，但改单要判断它是不是 bracket 腿）。 */
export interface KnownOrder {
  symbol: string
  orderClass: string
  /** 建单方式：simple / bracket / oto / oco。 */
  source: 'submit' | 'protection'
}
const KNOWN_MAX = 5_000

export interface AccountsOptions {
  /** 账户模型（协议只有 standard / unified / portfolio）：Alpaca 是 standard。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
  /** 账户限制 / 持仓缓存时长（毫秒），缺省 PREFLIGHT_TTL_MS。 */
  preflightTtlMs?: number
  /** 挂单翻页上限。 */
  maxOrderPages?: number
}

interface Cache<T> { value: T; at: Ms }

export class AlpacaAccounts {
  readonly #options: AccountsOptions
  readonly #known = new Map<string, KnownOrder>()
  /** Alpaca PATCH 返回新订单：新 id / 新 client id → 原 client id（链路最多 5 跳）。 */
  readonly #aliases = new Map<string, string>()
  private accountCache: Cache<ParsedAccount> | undefined
  private positionsCache: Cache<Position[]> | undefined
  private readonly clock: () => number

  constructor(private readonly http: AlpacaHttp, clock: () => number = () => Date.now(), options: AccountsOptions = {}) {
    this.clock = clock
    this.#options = options
  }

  private secrets(): readonly string[] {
    return this.http.secretsForRedaction()
  }

  private problemOf(e: unknown) {
    return asProblem(e, { secrets: this.secrets(), endpoint: 'signed' })
  }

  private get ttl(): number {
    return this.#options.preflightTtlMs ?? PREFLIGHT_TTL_MS
  }

  /** 记住本实例提交过的订单（改单时据此判断能不能 PATCH）。 */
  remember(ids: ReadonlyArray<string | null | undefined>, info: KnownOrder): void {
    for (const id of ids) {
      if (id === undefined || id === null || id === '') continue
      this.#known.delete(id)
      this.#known.set(id, info)
      if (this.#known.size > KNOWN_MAX) this.#known.delete(this.#known.keys().next().value as string)
    }
  }

  known(id: string | null | undefined): KnownOrder | undefined {
    return id ? this.#known.get(id) : undefined
  }

  /** 记住「replace 后的新单 id / 新 client id → 原 client id」；容量与 KNOWN_MAX 一致。 */
  alias(ids: ReadonlyArray<string | null | undefined>, originalClientOrderId: string): void {
    const original = originalClientOrderId.trim()
    if (original === '') return
    for (const id of ids) {
      if (id === undefined || id === null || id === '') continue
      this.#aliases.delete(id)
      this.#aliases.set(id, original)
      if (this.#aliases.size > KNOWN_MAX) this.#aliases.delete(this.#aliases.keys().next().value as string)
    }
  }

  /** 新单 id / client id → 原 client id（链式解析，最多 5 跳）。 */
  originalClientOrderId(id: string | null | undefined): string | undefined {
    if (id === undefined || id === null || id === '') return undefined
    let current = id
    let original: string | undefined
    for (let hop = 0; hop < 5; hop++) {
      const next = this.#aliases.get(current)
      if (next === undefined || next === current) break
      original = next
      current = next
    }
    return original
  }

  // ---- 账户 / 限制 ----------------------------------------------------------

  /** `GET /v2/account` → 解析结果（带 TTL 缓存；下单前的预检走它）。 */
  async account(ref: AccountRef, opts: { fresh?: boolean } = {}): Promise<ParsedAccount> {
    void ref
    const now = this.clock()
    if (opts.fresh !== true && this.accountCache !== undefined && now - this.accountCache.at <= this.ttl) return this.accountCache.value
    try {
      const payload = await this.http.request<unknown>('GET', '/v2/account', { weight: ALPACA_WEIGHTS.account, kind: 'query' })
      const parsed = parseAccount(payload, { accountId: ref.accountId, now })
      this.accountCache = { value: parsed, at: now }
      return parsed
    } catch (e) {
      throw new ProblemError(this.problemOf(e))
    }
  }

  /** 账户限制标志（八条 #6）：协议 AccountSnapshot 没有这些字段，单独取（见 REPORT 的协议缺口）。 */
  async restrictions(ref: AccountRef, opts: { fresh?: boolean } = {}): Promise<AccountRestrictions> {
    return (await this.account(ref, opts)).restrictions
  }

  /** 账户快照（余额 + 保证金 + 持仓）；持仓来自持仓专用端点。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const now = this.clock()
    const [parsed, positions] = await Promise.all([this.account(ref), this.positions(ref)])
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
      // buying_power 是否已扣挂单：Alpaca 的 buying_power 已计入未成交买单占用，但我们不据此断言，
      // 一律写 false（内核按「可用要再扣挂单」的口径算，宁可少下）。
      availableDeductsOpenOrders: false,
    }
  }

  // ---- 持仓 ----------------------------------------------------------------

  /** `GET /v2/positions`（持仓专用端点）。 */
  async positions(ref: AccountRef, opts: { fresh?: boolean } = {}): Promise<Position[]> {
    const now = this.clock()
    if (opts.fresh !== true && this.positionsCache !== undefined && now - this.positionsCache.at <= this.ttl) return this.positionsCache.value
    try {
      const payload = await this.http.request<unknown>('GET', '/v2/positions', { weight: ALPACA_WEIGHTS.positions, kind: 'query' })
      const parsed = parsePositions(payload, { accountId: ref.accountId, now })
      this.positionsCache = { value: parsed, at: now }
      return parsed
    } catch (e) {
      // 清掉旧缓存：宁可让调用方 fail closed，也不拿过期持仓去判断能不能卖。
      this.positionsCache = undefined
      throw new ProblemError(this.problemOf(e))
    }
  }

  /**
   * 该标的现在可卖的多头股数：**强制新拉** `GET /v2/positions`（不用 TTL 缓存），
   * 取多头行的 `qty_available`（缺该字段退回 `qty`）。查不到（上游失败）就抛，调用方据此拒卖单。
   */
  async heldLongQty(ref: AccountRef, instrumentId: string): Promise<string> {
    void ref
    const symbol = symbolOf(instrumentId)
    try {
      const payload = await this.http.request<unknown>('GET', '/v2/positions', { weight: ALPACA_WEIGHTS.positions, kind: 'query' })
      return availableLongQty(payload, symbol)
    } catch (e) {
      // 宁可让调用方 fail closed，也不拿过期持仓去判断能不能卖。
      this.positionsCache = undefined
      throw new ProblemError(this.problemOf(e))
    }
  }

  // ---- 挂单 ----------------------------------------------------------------

  /** 挂单（可按标的过滤）；按订单 id 用 `after_order_id` 翻页，最多 maxOrderPages 页。 */
  async openOrders(ref: AccountRef, instrumentId?: string): Promise<VenueOpenOrder[]> {
    void ref
    const now = this.clock()
    const symbol = instrumentId === undefined ? undefined : symbolOf(instrumentId)
    const limit = 500
    const maxPages = this.#options.maxOrderPages ?? 20
    const out: VenueOpenOrder[] = []
    let after: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string | number> = { status: 'open', direction: 'asc', limit, nested: 'false' }
      if (symbol !== undefined) params['symbols'] = symbol
      if (after !== null) params['after_order_id'] = after
      let payload: unknown
      try {
        payload = await this.http.request<unknown>('GET', '/v2/orders', { params, weight: ALPACA_WEIGHTS.openOrders, kind: 'query' })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      let rows: VenueOpenOrder[]
      try {
        rows = parseOpenOrders(payload, now)
      } catch (e) {
        // 挂单行解析不了 → fail closed（不把「读不全」当成「没有挂单」）。
        throw new ProblemError(this.problemOf(e))
      }
      out.push(...rows)
      if (rows.length < limit || rows.length === 0) return out
      const cursor = rows[rows.length - 1]?.venueOrderId
      if (cursor === undefined || cursor === after) return out
      after = cursor
    }
    return out
  }

  // ---- 成交 ----------------------------------------------------------------

  /**
   * 成交（自 sinceMs 起，按 venueFillId = order_id + cum_qty 去重）。
   * 翻页用 `page_token` = 上一页最后一行的 id（QD client.py:637-642 同口径）。
   */
  async fills(ref: AccountRef, sinceMs: Ms): Promise<VenueFill[]> {
    void ref
    const out = new Map<string, VenueFill>()
    const now = this.clock()
    let pageToken: string | null = null
    for (let page = 0; page < ACTIVITIES_MAX_PAGES; page++) {
      const params: Record<string, string | number> = {
        activity_types: 'FILL',
        direction: 'asc',
        page_size: ACTIVITIES_PAGE_SIZE,
        // 官方 activities 的 after 只到秒：向下取整到秒、不带毫秒。
        after: isoOf(Math.floor(Math.max(0, sinceMs) / 1000) * 1000).replace(/\.\d{3}Z$/, 'Z'),
      }
      if (pageToken !== null) params['page_token'] = pageToken
      let payload: unknown
      try {
        payload = await this.http.request<unknown>('GET', '/v2/account/activities', { params, weight: ALPACA_WEIGHTS.activities, kind: 'query' })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      let parsed: ReturnType<typeof parseActivityFills>
      try {
        parsed = parseActivityFills(payload, { now })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      for (const row of parsed) out.set(row.fill.venueFillId, row.fill)
      if (parsed.length < ACTIVITIES_PAGE_SIZE) break
      const last = parsed[parsed.length - 1]
      const token = last === undefined ? '' : last.activityId
      if (token === '' || token === pageToken) break
      pageToken = token
    }
    return [...out.values()].sort((a, b) => a.ts - b.ts)
  }

  // ---- 单张订单状态 ---------------------------------------------------------

  /**
   * 按 venueOrderId 或 clientOrderId 查状态；查不到 → found=false（不抛错）。
   * clientOrderId 走官方 `GET /v2/orders:by_client_order_id`（对账的关键：3006 之后按它确认）。
   */
  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string }): Promise<VenueOrderStatus> {
    void ref
    const venueOrderId = key.venueOrderId !== undefined && key.venueOrderId !== '' ? String(key.venueOrderId) : undefined
    const clientOrderId = key.clientOrderId !== undefined && key.clientOrderId !== '' ? String(key.clientOrderId) : undefined
    if (venueOrderId === undefined && clientOrderId === undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))
    }
    try {
      if (venueOrderId !== undefined) {
        const payload = await this.http.request<unknown>('GET', `/v2/orders/${encodeURIComponent(venueOrderId)}`, {
          weight: ALPACA_WEIGHTS.orderById, kind: 'query',
        })
        try {
          return await this.liveOrderStatus(payload)
        } catch (e) {
          throw new ProblemError(this.problemOf(e))
        }
      }
      const payload = await this.http.request<unknown>('GET', '/v2/orders:by_client_order_id', {
        params: { client_order_id: clientOrderId },
        weight: ALPACA_WEIGHTS.orderByClientId,
        kind: 'query',
      })
      return await this.liveOrderStatus(payload)
    } catch (e) {
      const problem = this.problemOf(e)
      // 「没有这张单」不是故障：按 found=false 交给对账（码表与文本判定统一在 venue-errors）。
      if (isUnknownOrderError(problem)) return { found: false }
      throw new ProblemError(problem)
    }
  }

  /**
   * Alpaca 的 replace 会让旧单进入 replaced 并带 `replaced_by`：沿它追到活单（最多 5 跳）。
   * 断链 / 超过 5 跳 → 3003（不把 replaced 当终态报给内核）。
   */
  private async liveOrderStatus(payload: unknown): Promise<VenueOrderStatus> {
    let current = payload
    for (let hop = 0; ; hop++) {
      const status = parseOrderStatus(current)
      const row = current !== null && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}
      const rawStatus = String(row['status'] ?? '').trim().toLowerCase()
      if (rawStatus !== 'replaced') return status
      const replacedBy = String(row['replaced_by'] ?? '').trim()
      if (replacedBy === '') {
        throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'the order was replaced but the venue gave no replaced_by; refusing to report it as final', {
          retryable: true,
          venue: { id: VENUE, message: 'replaced order without replaced_by' },
        }))
      }
      if (hop >= 5) {
        throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'the order was replaced more than 5 times; refusing to follow the chain further', {
          retryable: true,
          venue: { id: VENUE, message: 'replaced chain too long' },
        }))
      }
      current = await this.http.request<unknown>('GET', `/v2/orders/${encodeURIComponent(replacedBy)}`, {
        weight: ALPACA_WEIGHTS.orderById,
        kind: 'query',
      })
    }
  }

  // ---- 对账 ----------------------------------------------------------------

  /** 启动对账：账户 + 挂单 + 最近成交（同一个 now）。 */
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
      // 命中翻页上限就算可能被截断（调用方据此继续回补）。
      truncated: fills.length >= ACTIVITIES_PAGE_SIZE * ACTIVITIES_MAX_PAGES,
    }
  }

  /** 诊断：清零缓存（测试与「刚下完单要重读」用）。 */
  invalidate(): void {
    this.accountCache = undefined
    this.positionsCache = undefined
  }

  /** 测试 / 诊断：直接写持仓缓存（免一次请求）。 */
  seedPositions(positions: Position[]): void {
    this.positionsCache = { value: positions, at: this.clock() }
  }

  /** 账户 id → 内部对象（诊断）。 */
  static accountIdOf(ref: AccountRef): AccountId {
    return ref.accountId
  }

  /** 协议的 venue 常量（诊断）。 */
  static readonly venue = VENUE

  /** 金额渲染（测试断言用；十进制字符串原样）。 */
  static decimal = (v: string): string => normalizeDecimal(v)
}
