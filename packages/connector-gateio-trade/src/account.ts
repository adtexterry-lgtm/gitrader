// SPDX-License-Identifier: CPAL-1.0
// 账户读取：余额 / 保证金、持仓、挂单（含触发单）、成交、单张订单状态、启动对账、资金费。只读：本文件不发任何下单 / 撤单请求。
//     · 余额：GET /api/v4/futures/usdt/accounts（QD gate.py:820-821）；
//     · 持仓：GET /api/v4/futures/usdt/positions —— **持仓专用端点**（QD :860-870，带 X-Gate-Size-Decimal），
//       不从账户汇总里取残缺字段；QD 特别注明 `dual_comp/positions` 不是集合端点，走它会 404；
//     · 挂单：GET /api/v4/futures/usdt/orders?status=open（QD :1019-1026）+ GET /api/v4/futures/usdt/price_orders
//       （QD quick_trade/position_activity.py:121-136）；
//     · 成交：GET /api/v4/futures/usdt/my_trades（QD :1028-1044，翻页只用 offset），去重键 = 成交号 `id`；
//     · 单张：GET /api/v4/futures/usdt/orders/{order_id}（QD :1014-1017）；`po:` 前缀的触发单号走
//       GET /api/v4/futures/usdt/price_orders/{id}；
//     · 列表一律 limit / offset 翻页读全：满页但没有新行（上游不认 offset）或到页数上限就报错，不交半张清单。
//       Gate 没有「按客户端订单号查单」的端点：clientOrderId 查询是**有界扫描**（挂单 + 有限页已结束订单的 text 匹配），
//       触发单只看本进程备忘（README 写明）；对账要精确时传 venueOrderId。
// 数量单位一律「币数量」（venueSizeUnit = base）：changelog 里不把张数当币数；张币乘数拿不到就报错。
import { makeProblem } from '@gitrader/protocol'
import type { AccountId, Decimal, InstrumentId, Ms, Position } from '@gitrader/protocol'
import { asDecimal } from '@gitrader/protocol'
import type {
  AccountRef, AccountSnapshot, StartupSnapshot, VenueFill, VenueOpenOrder, VenueOrderStatus,
} from '@gitrader/protocol/connector'
import { GATE_WEIGHTS } from './budget'
import { asProblem, GateHttpError, ProblemError } from './errors'
import { encodeClientOrderId, PRICE_ORDERS_PATH } from './orders'
import type { TriggerFingerprint } from './orders'
import {
  API_PREFIX, decimalOf, fillTsOf, marginOfPositionRow, msOfSeconds, parseAccount, parseFills, parseFundingRows, parseOpenOrders,
  parseOrderDetail, parsePositions, parsePriceOrders, priceOrderIdOf, priceOrderStatusWord, requireMultiplier, signedDecimalOf,
  symbolOf,
} from './parse'
import type { FundingRow, RawPriceOrder } from './parse'
import type { MultiplierOf } from './parse'
import type { GateHttp } from './rest'

/** my_trades 单页上限（Gate 官方 limit ≤ 1000；QD gate.py:1035 用 100/页翻）。 */
export const FILLS_PAGE_LIMIT = 100
/** my_trades 翻页硬上限（防上游 offset 不前进时死循环）。 */
export const FILLS_MAX_PAGES = 10
/** 客户端订单号扫描的页数上限（每页 100）。 */
export const CLIENT_ID_SCAN_PAGES = 3
/** 列表（订单 / 持仓 / 触发单）单页上限。 */
export const LIST_PAGE_LIMIT = 100
/** 列表翻页硬上限（1000 行）；超过就报错，不交半张清单。 */
export const LIST_MAX_PAGES = 10
/** 本进程备忘（触发单指纹 / 普通单下单合约）的容量上限，超出删最早插入的一条。 */
export const MEMO_LIMIT = 10_000

/** market 侧提供乘数的最小接口（缓存外合约由它按 /contracts/{contract} 补拉）。 */
export interface MultiplierSource {
  ensureMultipliers(contracts: Iterable<string>): Promise<Map<string, Decimal>>
}

/** 触发单备忘（price_orders 没有客户端单号；只在本进程内有效，README 写明）。 */
export interface TriggerMemo extends TriggerFingerprint { at: Ms; venueOrderId?: string }

export interface AccountsOptions {
  /** 协议只有 standard / unified / portfolio：Gate USDT 永续账户落 `standard`。 */
  accountModel?: 'standard' | 'unified' | 'portfolio'
  /** 覆盖 my_trades 的每页条数（测试用）。 */
  fillsPageLimit?: number
  /** positions 的持仓模式校验：true = 只允许单向持仓（本连接器只建模单向）。 */
  requireSingleMode?: boolean
  /** position_mode 缓存时长（QD gate.py:823-858 是 30 s）。 */
  posModeTtlMs?: number
}

interface Cache<T> { value: T; at: Ms }

export class GateAccounts {
  readonly #options: AccountsOptions
  private posModeCache: Cache<string> | null = null
  // ponytail: 只记本进程最近 10000 张，超出删最早；重启即失忆（README 写明）
  private readonly triggers = new Map<string, TriggerMemo>()
  private readonly orderContracts = new Map<string, string>()
  private readonly clock: () => number

  constructor(
    private readonly http: GateHttp,
    clock: () => number = () => Date.now(),
    options: AccountsOptions = {},
    private readonly market: MultiplierSource,
  ) {
    this.clock = clock
    this.#options = options
  }

  private secrets(): readonly string[] {
    return this.http.secretsForRedaction()
  }

  private problemOf(e: unknown) {
    return asProblem(e, { secrets: this.secrets(), endpoint: 'signed' })
  }

  /** contract → quanto_multiplier（缓存外合约由 market 补拉；仍拿不到就报错）。 */
  private async multiplierOf(contracts: Iterable<string>): Promise<MultiplierOf> {
    try {
      const map = await this.market.ensureMultipliers(contracts)
      return (c) => map.get(c)
    } catch (e) {
      throw new ProblemError(this.problemOf(e))
    }
  }

  /**
   * limit / offset 翻页读全；满页但没有新行（上游不认 offset）或到页数上限 → 报错，不交半张清单。
   */
  private async listAll(path: string, base: Record<string, string | number>, keyOf: (row: Record<string, unknown>) => string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      let data: unknown
      try {
        data = await this.http.signed<unknown>('GET', path, { params: { ...base, limit: LIST_PAGE_LIMIT, offset: page * LIST_PAGE_LIMIT }, weight: 1, kind: 'query' })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      const rows = (Array.isArray(data) ? data : []).filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      let added = 0
      for (const row of rows) {
        const key = keyOf(row)
        if (key !== '' && seen.has(key)) continue
        if (key !== '') seen.add(key)
        out.push(row)
        added += 1
      }
      if (rows.length < LIST_PAGE_LIMIT) return out
      if (added === 0) break
    }
    throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', `gateio ${path} spans more than ${LIST_MAX_PAGES * LIST_PAGE_LIMIT} rows or does not page; refusing a partial snapshot`, { retryable: false }))
  }

  // ---- 账户 / 持仓 ----------------------------------------------------------

  /** 持仓专用端点 → Position[]（QD gate.py:860-870）。`holding=true` 拿全量，contract 只在本地过滤。 */
  async positions(ref: AccountRef, contract?: string): Promise<Position[]> {
    const rows = await this.listAll(`${API_PREFIX}/positions`, { holding: 'true' }, positionKey)
    const filtered = contract === undefined || contract === '' ? rows : rows.filter((row) => String(row['contract'] ?? '') === contract)
    const of = await this.multiplierOf(contractsIn(filtered, true))
    return parsePositions(filtered, { accountId: ref.accountId, now: this.clock() }, of)
  }

  /** 账户快照：余额 + 保证金 + 持仓（持仓来自持仓端点，保证金汇总由持仓折算）。 */
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    const now = this.clock()
    const [accountsResult, positionsResult] = await Promise.allSettled([
      this.http.signed<unknown>('GET', `${API_PREFIX}/accounts`, { weight: GATE_WEIGHTS.accounts, kind: 'query' }),
      this.listAll(`${API_PREFIX}/positions`, { holding: 'true' }, positionKey),
    ])
    if (accountsResult.status === 'rejected') throw new ProblemError(this.problemOf(accountsResult.reason))
    if (positionsResult.status === 'rejected') throw new ProblemError(this.problemOf(positionsResult.reason))
    const rows = positionsResult.value
    const of = await this.multiplierOf(contractsIn(rows, true))
    const positions = parsePositions(rows, { accountId: ref.accountId, now }, of)
    const parsed = parseAccount(accountsResult.value, { accountId: ref.accountId, now }, positions)
    if (parsed.positionMode !== '') this.posModeCache = { value: parsed.positionMode, at: now }
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
      // Gate 的 available 已经扣掉挂单占用（order_margin），所以是「已扣挂单」口径。
      availableDeductsOpenOrders: true,
    }
  }

  // ---- 挂单 -----------------------------------------------------------------

  /** 看全部挂单（普通单 + 触发单，可按合约过滤）；两类都翻页读全。 */
  async openOrders(ref: AccountRef, instrumentId?: string): Promise<VenueOpenOrder[]> {
    void ref
    const contract = instrumentId === undefined || instrumentId === '' ? undefined : symbolOf(instrumentId)
    const base: Record<string, string | number> = { status: 'open', ...(contract !== undefined ? { contract } : {}) }
    const orders = await this.listAll(`${API_PREFIX}/orders`, base, idKey)
    const triggers = await this.listAll(PRICE_ORDERS_PATH, base, idKey)
    const of = await this.multiplierOf([...contractsIn(orders), ...contractsIn(triggers)])
    const now = this.clock()
    return [
      ...parseOpenOrders(orders, now, of),
      ...parsePriceOrders(triggers, now, of, (id) => this.clientIdOfTrigger(id)),
    ].sort((a, b) => a.createdAt - b.createdAt)
  }

  // ---- 成交 -----------------------------------------------------------------

  /** 成交（从 sinceMs 起，本地过滤）。翻页只用 limit / offset（不发 from），最多 FILLS_MAX_PAGES 页。 */
  async fills(ref: AccountRef, sinceMs: Ms, opts?: { instrumentId?: InstrumentId }): Promise<VenueFill[]> {
    void ref
    const requestedInstrumentId = opts?.instrumentId
    if (requestedInstrumentId !== undefined) symbolOf(requestedInstrumentId)
    return (await this.collectFills(sinceMs)).fills
      .filter((fill) => requestedInstrumentId === undefined || fill.instrumentId === requestedInstrumentId)
  }

  /** 读成交：每页只发 limit / offset；早于 sinceMs 的行先丢掉（旧成交的合约可能已下市，不去查乘数），看清是否还有更早的。 */
  private async collectFills(sinceMs: Ms): Promise<{ fills: VenueFill[]; truncated: boolean }> {
    const out = new Map<string, VenueFill>()
    const now = this.clock()
    const limit = this.#options.fillsPageLimit ?? FILLS_PAGE_LIMIT
    let lastFull = false
    let sawOlder = false
    for (let page = 0; page < FILLS_MAX_PAGES; page++) {
      let data: unknown
      try {
        data = await this.http.signed<unknown>('GET', `${API_PREFIX}/my_trades`, {
          params: { limit, offset: page * limit },
          weight: GATE_WEIGHTS.myTrades,
          kind: 'query',
        })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      const rows = (Array.isArray(data) ? data : []).filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      const fresh = rows.filter((r) => fillTsOf(r, now) >= sinceMs)
      if (fresh.length < rows.length) sawOlder = true
      const of = await this.multiplierOf(contractsIn(fresh))
      for (const fill of parseFills(fresh, now, of)) {
        if (fill.venueFillId !== '') out.set(fill.venueFillId, fill)
      }
      lastFull = rows.length >= limit
      if (!lastFull || sawOlder) break
    }
    return { fills: [...out.values()].sort((a, b) => a.ts - b.ts), truncated: lastFull && !sawOlder }
  }

  // ---- 单张订单状态 ---------------------------------------------------------

  /**
   * 按 venueOrderId 查详情（`po:` 前缀走 price_orders）；只有 clientOrderId 时先看触发单备忘，
   * 再做普通单的**有界扫描**（有限页已结束订单的 `text` 匹配）。
   * 上游查不到时 found=false（不抛错）；Gate 的 404 + `ORDER_NOT_FOUND` 也算 found=false。
   */
  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: string }): Promise<VenueOrderStatus> {
    void ref
    if (key.venueOrderId !== undefined && key.venueOrderId !== '') {
      if (key.venueOrderId.startsWith('po:')) return this.priceOrderStatus(key.venueOrderId)
      let data: unknown
      try {
        data = await this.http.signed<unknown>('GET', `${API_PREFIX}/orders/${encodeURIComponent(key.venueOrderId)}`, {
          weight: GATE_WEIGHTS.orderDetail,
          kind: 'query',
        })
      } catch (e) {
        const problem = this.problemOf(e)
        if (isNotFound(problem.venue?.code, problem.venue?.message ?? problem.message)) return { found: false }
        throw new ProblemError(problem)
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return { found: false }
      const contract = String((data as { contract?: unknown }).contract ?? '')
      const of = await this.multiplierOf([contract])
      return parseOrderDetail(data, requireMultiplier(of, contract))
    }
    if (key.clientOrderId === undefined || key.clientOrderId === '') {
      throw new ProblemError(makeProblem('INVALID_PARAMS', 'orderStatus needs venueOrderId or clientOrderId'))
    }
    const wanted = String(key.clientOrderId)
    const memo = this.triggers.get(wanted)
    if (memo !== undefined) {
      if (memo.venueOrderId !== undefined) return this.priceOrderStatus(memo.venueOrderId)
      const foundId = await this.findTrigger(memo)
      if (foundId === undefined) return { found: false }
      this.rememberTrigger(wanted, { ...memo, venueOrderId: foundId })
      return this.priceOrderStatus(foundId)
    }
    const contract = key.instrumentId !== undefined ? symbolOf(key.instrumentId) : this.orderContracts.get(wanted)
    const text = encodeClientOrderId(wanted)
    for (const status of ['open', 'finished'] as const) {
      for (let page = 0; page < CLIENT_ID_SCAN_PAGES; page++) {
        const params: Record<string, string | number | undefined> = { status, limit: 100, offset: page * 100 }
        if (contract !== undefined) params['contract'] = contract
        let data: unknown
        try {
          data = await this.http.signed<unknown>('GET', `${API_PREFIX}/orders`, { params, weight: GATE_WEIGHTS.openOrders, kind: 'query' })
        } catch (e) {
          throw new ProblemError(this.problemOf(e))
        }
        const rows = Array.isArray(data) ? data : []
        for (const row of rows) {
          if (row === null || typeof row !== 'object') continue
          const item = row as { text?: unknown; id?: unknown; id_string?: unknown; status?: unknown; contract?: unknown; size?: unknown; left?: unknown }
          if (String(item.text ?? '') !== text) continue
          const rowContract = String(item.contract ?? '')
          const of = await this.multiplierOf([rowContract])
          return parseOrderDetail({ ...item, status: item.status ?? status }, requireMultiplier(of, rowContract))
        }
        if (rows.length < 100) break
      }
    }
    return { found: false }
  }

  /** 触发单详情：GET /api/v4/futures/usdt/price_orders/{id}（状态落成内核认得的词）。 */
  private async priceOrderStatus(venueOrderId: string): Promise<VenueOrderStatus> {
    const id = venueOrderId.slice('po:'.length)
    try {
      const row = await this.http.signed<unknown>('GET', `${PRICE_ORDERS_PATH}/${encodeURIComponent(id)}`, {
        weight: GATE_WEIGHTS.orderDetail,
        kind: 'query',
      })
      const data = row !== null && typeof row === 'object' && !Array.isArray(row) ? (row as { status?: unknown; finish_as?: unknown }) : {}
      return {
        found: true,
        status: priceOrderStatusWord(data.status, data.finish_as),
        venueOrderId,
        filledSize: asDecimal('0'),
        raw: row,
      }
    } catch (e) {
      const problem = this.problemOf(e)
      if ((e instanceof GateHttpError && e.status === 404) || isNotFound(problem.venue?.code, problem.venue?.message ?? problem.message)) {
        return { found: false }
      }
      throw new ProblemError(problem)
    }
  }

  // ---- 触发单备忘（本进程内） ------------------------------------------------

  /** 记下 clientOrderId → 触发单指纹 / 号（重启即失忆，README 写明）。 */
  rememberTrigger(clientOrderId: string, memo: TriggerMemo): void {
    this.triggers.set(clientOrderId, memo)
    trimMemo(this.triggers)
  }

  /** 记下普通单的 clientOrderId → 原生合约名（内核查单只给 clientOrderId 时靠它缩小扫描；重启即失忆，README 写明）。 */
  rememberOrderContract(clientOrderId: string, contract: string): void {
    this.orderContracts.set(clientOrderId, contract)
    trimMemo(this.orderContracts)
  }

  /** 触发单号 → 提交时的客户端订单号（挂单列表回填用）。 */
  clientIdOfTrigger(venueOrderId: string): string | null {
    for (const [id, m] of this.triggers) if (m.venueOrderId === venueOrderId) return id
    return null
  }

  /** 3006 后按指纹找回触发单：同合约、同 rule、同触发价、同有符号张数、创建时间不早于提交前 60 s，且没被别的备忘认领。 */
  private async findTrigger(memo: TriggerMemo): Promise<string | undefined> {
    const claimed = new Set<string>()
    for (const m of this.triggers.values()) if (m.venueOrderId !== undefined) claimed.add(m.venueOrderId)
    for (const status of ['open', 'finished'] as const) {
      let data: unknown
      try {
        data = await this.http.signed<unknown>('GET', PRICE_ORDERS_PATH, {
          params: { status, contract: memo.contract, limit: LIST_PAGE_LIMIT, offset: 0 },
          weight: GATE_WEIGHTS.openOrders,
          kind: 'query',
        })
      } catch (e) {
        throw new ProblemError(this.problemOf(e))
      }
      for (const entry of Array.isArray(data) ? data : []) {
        if (entry === null || typeof entry !== 'object') continue
        const row = entry as RawPriceOrder
        const initial = row.initial ?? {}
        const trigger = row.trigger ?? {}
        if (initial.contract !== memo.contract) continue
        if (Number(trigger.rule) !== memo.rule) continue
        if (decimalOf(trigger.price) !== memo.triggerPrice) continue
        if (decimalOf(initial.size ?? initial.amount) !== decimalOf(memo.size)) continue
        if (msOfSeconds(row.create_time, memo.at) < memo.at - 60_000) continue
        const id = priceOrderIdOf(row)
        if (id === undefined || claimed.has(id)) continue
        return id
      }
    }
    return undefined
  }

  // ---- 保证金现状 -----------------------------------------------------------

  /** 单个合约的保证金设置（GET /futures/usdt/positions/{contract}：leverage 0 = 全仓）；上游 404 = 该合约还没有设置 → null。 */
  async marginSetting(contract: string): Promise<{ mode: 'cross' | 'isolated'; leverage: number } | null> {
    try {
      const data = await this.http.signed<unknown>('GET', `${API_PREFIX}/positions/${encodeURIComponent(contract)}`, {
        weight: GATE_WEIGHTS.positions,
        kind: 'trade',
      })
      const row = Array.isArray(data) ? data[0] : data
      if (row === null || typeof row !== 'object' || row === undefined) return null
      return marginOfPositionRow(row as { leverage?: unknown; cross_leverage_limit?: unknown })
    } catch (e) {
      if (e instanceof GateHttpError && e.status === 404) return null
      throw new ProblemError(this.problemOf(e))
    }
  }

  // ---- 对账 -----------------------------------------------------------------

  /** 启动对账：账户 + 挂单 + 最近成交（一次同一个 now）。 */
  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    const [account, openOrders, collected] = await Promise.all([
      this.accountState(ref),
      this.openOrders(ref),
      this.collectFills(fillsSinceMs),
    ])
    return {
      account,
      openOrders,
      fills: collected.fills,
      fillsSince: fillsSinceMs,
      truncated: collected.truncated,
    }
  }

  // ---- 资金费 ---------------------------------------------------------------

  /** 资金费流水（GET /api/v4/futures/usdt/account_book?type=fund，QD gate.py:673-694）。 */
  async fundingPayments(fromMs: Ms, toMs: Ms, contract?: string): Promise<FundingRow[]> {
    const params: Record<string, string | number | undefined> = {
      type: 'fund',
      from: Math.max(0, Math.floor(fromMs / 1000)),
      to: Math.max(0, Math.floor(toMs / 1000)),
      limit: 1000,
    }
    if (contract !== undefined && contract !== '') params['contract'] = contract
    try {
      const data = await this.http.signed<unknown>('GET', `${API_PREFIX}/account_book`, {
        params,
        weight: GATE_WEIGHTS.accountBook,
        kind: 'query',
      })
      return parseFundingRows(data, contract ?? '')
    } catch (e) {
      throw new ProblemError(this.problemOf(e))
    }
  }

  // ---- 持仓模式 -------------------------------------------------------------

  /**
   * 账户持仓模式：`single` / `dual` / `dual_plus`（QD gate.py:823-858，含 in_dual_mode 回落；缓存 30 s）。
   * 取不到返回空串——调用方按「未知」处理，不猜成单向。
   */
  async positionMode(): Promise<string> {
    const now = this.clock()
    if (this.posModeCache !== null && now - this.posModeCache.at <= (this.#options.posModeTtlMs ?? 30_000)) {
      return this.posModeCache.value
    }
    let account: unknown
    try {
      account = await this.http.signed<unknown>('GET', `${API_PREFIX}/accounts`, { weight: GATE_WEIGHTS.accounts, kind: 'query' })
    } catch {
      return ''
    }
    if (account === null || typeof account !== 'object' || Array.isArray(account)) return ''
    const row = account as { position_mode?: unknown; in_dual_mode?: unknown }
    let mode = String(row.position_mode ?? '').trim().toLowerCase()
    if (mode !== 'single' && mode !== 'dual' && mode !== 'dual_plus') {
      mode = row.in_dual_mode === true ? 'dual' : row.in_dual_mode === false ? 'single' : ''
    }
    if (mode !== '') this.posModeCache = { value: mode, at: now }
    return mode
  }

  /** 诊断 / 测试：直接写模式缓存（省掉一次请求）。 */
  seedPositionMode(mode: string): void {
    this.posModeCache = { value: mode, at: this.clock() }
  }

  /** 诊断：金额 / 数量的原始文本（测试断言用）。 */
  static decimal = decimalOf

  /** 账户 id（诊断）。 */
  static accountIdOf(ref: AccountRef): AccountId {
    return ref.accountId
  }
}

/** Gate 的「查不到这张单」判定（label 或文本）。 */
function isNotFound(label: string | number | undefined, text: string): boolean {
  const hay = `${label === undefined ? '' : String(label)} ${text}`.toLowerCase()
  return /order_not_found|order not found|order does not exist|order_closed|order_cancelled|order_finished|unknown order/.test(hay)
}

/** 备忘超容量时删最早插入的一条（Map 迭代顺序即插入顺序）。 */
function trimMemo<V>(map: Map<string, V>): void {
  while (map.size > MEMO_LIMIT) {
    const oldest = map.keys().next()
    if (oldest.done === true) return
    map.delete(oldest.value)
  }
}

/** 列表行的去重键：普通单 / 触发单都是 id_string ?? id。 */
function idKey(row: Record<string, unknown>): string {
  return String(row['id_string'] ?? row['id'] ?? '')
}

/** 持仓行的去重键：contract + mode（双仓下同合约可能两行）。 */
function positionKey(row: Record<string, unknown>): string {
  return `${String(row['contract'] ?? '')}|${String(row['mode'] ?? '')}`
}

/** 取一批行的 contract（触发单行取 initial.contract）；skipZeroSize 时跳过 size 为 0 的行。 */
function contractsIn(rows: unknown[], skipZeroSize = false): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const r = row as { contract?: unknown; initial?: { contract?: unknown } | undefined; size?: unknown }
    const contract = typeof r.contract === 'string' && r.contract !== ''
      ? r.contract
      : typeof r.initial?.contract === 'string' ? r.initial.contract : ''
    if (contract === '') continue
    if (skipZeroSize && signedDecimalOf(r.size) === '0') continue
    out.push(contract)
  }
  return out
}
