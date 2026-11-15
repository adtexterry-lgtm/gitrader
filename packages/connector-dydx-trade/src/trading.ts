// SPDX-License-Identifier: CPAL-1.0
// dYdX v4 永续交易连接器：能力声明 + 链上签名下单 / 撤单 + Indexer 私有读。
// 交易流程（每一步都有离线测试，不打真网）：
//   1. intent → 订单计划（类型 / 方向 / 数量 quantums / 价格 subticks / 到期语义 / order_flags）
//   2. 计划 → dydxprotocol.clob.Order → MsgPlaceOrder → Any
//   3. 取账户 account_number / sequence / 当前块高 → TxBody / AuthInfo / SignDoc → sha256 → secp256k1 签名 → TxRaw
//   4. POST /cosmos/tx/v1beta1/txs（一律 BROADCAST_MODE_SYNC；cosmos-sdk v0.50 只支持 sync/async）；code=0 才算收单
//   5. 失败分两类：链上明确拒绝（code≠0）→ rejected；没拿到结果（网络 / 5xx / 超时）→ unknown(3006)，按 clientOrderId 对账
// 设计参照（只借「下单计划 / 短单与长单分流 / 序列号与块高管理」的结构，代码从零写）：
//   nautilus_trader crates/adapters/dydx/src/execution/{order_builder,tx_manager,broadcaster}.rs@55c0e820。
import { createHash } from 'node:crypto'
import type {
  Book, Candle, CandleInterval, Instrument, MarketContext, Ms, OrderIntent, Problem, VenueCapabilities,
} from '@gitrader/protocol'
import { asDecimal, makeProblem } from '@gitrader/protocol'
import { fx, str } from '@gitrader/protocol/decimal'
import type {
  AccountRef, AccountSnapshot, CancelAck, CancelTarget, Environment, MarketStatus, StartupSnapshot,
  SubmitResult, SubscriptionSpec, TradeContext, Unsubscribe, VenueConnector, VenueEvent, VenueFill, VenueOpenOrder,
  VenueOrderStatus, OrderAck,
} from '@gitrader/protocol/connector'
import {
  ACCOUNT_PATH, BROADCAST_PATH, CHAIN_ID, DEFAULT_STATEFUL_DAYS, INDEXER_PAGE_LIMIT, LATEST_BLOCK_PATH, ORDER_FLAGS,
  SHORT_BLOCK_WINDOW,
} from './constants'
import {
  NOT_FOUND, indexerOrderId, parseAccount, parseFills, parseOrders, parsePositions, statusOfOrder, tickerOf,
  decOr, intOf, type RawFill, type RawOrder, type RawSubaccount,
} from './account'
import { dydxTradeCapabilities } from './capabilities'
import { DydxHttp } from './client'
import type { BudgetLike, FetchLike } from './client'
import {
  DydxHttpError, DydxNetworkError, DydxTxError, ProblemError, asProblem, capabilityUnsupported, invalidParams, redactSecret, unsupported, throwAsProblem,
} from './errors'
import { DydxSigner } from './keys'
import { anyOf, msgCancelOrder, msgPlaceOrder, type OrderMessage, type OrderIdParts } from './msgs'
import { TYPE_URL } from './constants'
import { priceBand, quantumsFor, subticksFor, type MarketParams, type RoundingMode } from './precision'
import { broadcastRequestBody, sha256Hex, signTransaction, type FeeConfig, type SignedTx } from './tx'

export interface MarketSnapshot extends MarketParams {
  oraclePrice: string
  tickSize: string
  stepSize: string
  status: string
}

export interface DydxMarketSource {
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[]
  getInstrument(id: string): Instrument | undefined
  quote(id: string): unknown
  book(id: string, depth?: number): Promise<Book>
  candles(id: string, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]>
  context(id: string): Promise<MarketContext>
  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe
  status(): MarketStatus
  close?(): Promise<void>
}

export interface DydxTradeConnectorOptions {
  /** 链上账户私钥（32 字节 hex）。不给则连接器只能读账户 / 行情，任何签名调用回 1005/1004。 */
  privateKey?: string
  environment?: Environment
  /** 子账户号（default 0）。 */
  subaccountNumber?: number
  /** 已缓存 account_number / sequence（不给则首次签名时从链上取）。 */
  accountNumber?: number
  sequence?: number
  /** 长单 / 条件单的手续费（short-term 单不需要；未配置时长单会拒绝，见 README）。 */
  fee?: FeeConfig
  indexerBaseUrl?: string
  nodeBaseUrl?: string
  fetchImpl?: FetchLike
  budget?: BudgetLike
  now?: () => Ms
  timeoutMs?: number
  /** 只读行情源（通常注入 @gitrader/connector-dydx-data 的 DydxDataConnector；不注入则行情方法回 1004）。 */
  market?: DydxMarketSource
  /** gtc / 长单缺省有效期（天）。 */
  statefulDays?: number
}

/** 订单计划：进可单测、退可直接看字段。 */
export interface OrderPlan {
  order: OrderMessage
  shortTerm: boolean
  /** 本计划是否需要链上 sequence / 手续费。 */
  stateful: boolean
  clientId: number
  clobPairId: number
  orderFlags: number
  briefing: { ticker: string; side: 'buy' | 'sell'; type: OrderIntent['type'] }
}

export class ClientIdAllocator {
  /** clientOrderId（hex128）→ 已分配的 clientId / flags / clobPairId。 */
  readonly #byHex = new Map<string, { clientId: number; clobPairId: number; orderFlags: number }>()
  readonly #used = new Set<number>()

  /** 由 32 位十六进制 clientOrderId 派生 client_id；碰撞时向上找空位（dYdX 要求同账户 client_id 唯一）。 */
  allocate(clientOrderId: string, clobPairId: number, orderFlags: number): number {
    const known = this.#byHex.get(clientOrderId)
    if (known !== undefined) return known.clientId
    const base = clientIdBaseOf(clientOrderId)
    let candidate = base
    let guard = 0
    while (this.#used.has(candidate)) {
      candidate = (candidate + 1) % 2 ** 32
      guard += 1
      if (guard > 4096) throw new Error('could not allocate a free dYdX client id')
    }
    this.#used.add(candidate)
    this.#byHex.set(clientOrderId, { clientId: candidate, clobPairId, orderFlags })
    return candidate
  }

  /**
   * 记下 planOrder 实际给出的 order_flags。
   * 分配 clientId 时还看不到真实计划（clientId 是计划的输入），所以先写占位值、拿到计划后再回写，
   * 否则 postOnly + ioc 这类组合会让预判的 flags 与链上实际 flags 不一致，撤单会撤错号。
   */
  setOrderFlags(clientOrderId: string, orderFlags: number): void {
    const known = this.#byHex.get(clientOrderId)
    if (known !== undefined) known.orderFlags = orderFlags
  }

  lookup(clientOrderId: string): { clientId: number; clobPairId: number; orderFlags: number } | undefined {
    return this.#byHex.get(clientOrderId)
  }

  /** 释放（撤单 / 终态后调用；重启后映射丢失，靠 Indexer 的 clientId 字段对账）。 */
  release(clientOrderId: string): void {
    const known = this.#byHex.get(clientOrderId)
    if (known === undefined) return
    this.#used.delete(known.clientId)
    this.#byHex.delete(clientOrderId)
  }

  get size(): number {
    return this.#byHex.size
  }
}

/** 解析 /v4/perpetualMarkets。 */
export function parseMarkets(json: unknown): Map<string, MarketSnapshot> {
  const out = new Map<string, MarketSnapshot>()
  const markets = (json as { markets?: Record<string, Record<string, unknown>> } | null)?.markets
  if (markets === undefined || markets === null) return out
  for (const [ticker, m] of Object.entries(markets)) {
    try {
      out.set(ticker, {
        ticker,
        clobPairId: intOf(m.clobPairId, `${ticker}.clobPairId`),
        atomicResolution: intOf(m.atomicResolution, `${ticker}.atomicResolution`),
        quantumConversionExponent: intOf(m.quantumConversionExponent, `${ticker}.quantumConversionExponent`),
        stepBaseQuantums: intOf(m.stepBaseQuantums, `${ticker}.stepBaseQuantums`),
        subticksPerTick: intOf(m.subticksPerTick, `${ticker}.subticksPerTick`),
        oraclePrice: str(fx(decOr(m.oraclePrice, `${ticker}.oraclePrice`, '0'))),
        tickSize: str(fx(decOr(m.tickSize, `${ticker}.tickSize`, '0'))),
        stepSize: str(fx(decOr(m.stepSize, `${ticker}.stepSize`, '0'))),
        status: String(m.status ?? 'ACTIVE'),
      })
    } catch {
      // 单个市场字段缺失不影响其它市场（Indexer 偶发新增字段 / 停牌市场）
    }
  }
  return out
}

/** 由 32 位十六进制 clientOrderId 的前 8 位推出 client_id 基数（与 ClientIdAllocator 同规则；重启后用它回推）。 */
export function clientIdBaseOf(clientOrderId: string): number {
  const hex = clientOrderId.replace(/^0x/, '')
  let base = 0
  for (const ch of hex.slice(0, 8)) base = (base * 16 + parseInt(ch, 16)) % 2 ** 32
  return base >>> 0
}

export interface PlanOptions {
  market: MarketSnapshot
  owner: string
  subaccountNumber: number
  clientId: number
  /** 短单到期块高。 */
  goodTilBlock: number
  /** 长单 / 条件单到期（unix 秒）。 */
  goodTilBlockTime: number
  /** 长单缺省有效期（秒）。 */
  statefulSeconds?: number
}

/** intent → 订单计划（纯函数，不联网、不签名）。所有拒绝都给协议 Problem。 */
export function planOrder(intent: OrderIntent, opts: PlanOptions): OrderPlan {
  const type = intent.type
  if (type === 'trailing_stop' || type === 'twap') {
    throw unsupported(`dydx does not support ${type} in this connector`)
  }
  if (intent.tpsl !== undefined) {
    throw unsupported('dydx has no attached take-profit/stop-loss in this connector; submit conditional orders separately')
  }
  if (intent.tif === 'fok') {
    throw unsupported('FILL_OR_KILL is deprecated in the dYdX order proto and is not declared by this connector')
  }
  if (intent.maxSlippageBps !== undefined && (!Number.isFinite(intent.maxSlippageBps) || intent.maxSlippageBps < 0)) {
    throw invalidParams(`maxSlippageBps must be a non-negative number, got ${String(intent.maxSlippageBps)}`)
  }
  if (intent.postOnly === true && intent.tif === 'ioc') {
    throw invalidParams('postOnly and tif=ioc cannot be combined: a post-only order never takes liquidity')
  }

  const m = opts.market
  const rounding: RoundingMode = intent.rounding === 'passive' ? 'passive' : 'reject'
  const refPrice = priceRef(intent, m)
  const size = sizeOf(intent, refPrice, m)
  // 按 notional 折出来的数量本来就不是精确值：一律向下截到 step（< 一个 step 仍拒）
  const fromNotional = intent.size === undefined && intent.notional !== undefined
  const quantums = asInvalid(() => quantumsFor(size, m, fromNotional ? 'passive' : rounding))
  const isConditional = type === 'stop_market' || type === 'stop_limit' || type === 'take_market' || type === 'take_limit'
  const isMarket = type === 'market' || type === 'stop_market' || type === 'take_market'
  const side = intent.side

  // ---- 价格与到期语义 ----
  let price: string
  if (isMarket) {
    const bps = intent.maxSlippageBps
    if (bps === undefined) throw invalidParams(`market intent for ${intent.instrumentId} needs maxSlippageBps (no default slippage)`)
    price = priceBand(refPrice, bps, side)
  } else {
    if (intent.price === undefined) throw invalidParams(`limit intent for ${intent.instrumentId} needs a price`)
    price = String(intent.price)
  }
  const subticks = asInvalid(() => subticksFor(price, m, side, isMarket ? 'band' : rounding))

  let orderFlags: number
  let goodTilBlock: number | undefined
  let goodTilBlockTime: number | undefined
  let tif: OrderMessage['tif']
  if (isConditional) {
    orderFlags = ORDER_FLAGS.conditional
    goodTilBlockTime = intent.expiresAt === undefined ? opts.goodTilBlockTime : Math.floor(intent.expiresAt / 1000)
    tif = isMarket ? 'ioc' : intent.postOnly === true ? 'postOnly' : 'gtc'
  } else if (isMarket) {
    orderFlags = ORDER_FLAGS.shortTerm
    goodTilBlock = opts.goodTilBlock
    tif = 'ioc'
  } else if (intent.postOnly === true || intent.tif === 'alo') {
    orderFlags = ORDER_FLAGS.longTerm
    goodTilBlockTime = intent.expiresAt === undefined ? opts.goodTilBlockTime : Math.floor(intent.expiresAt / 1000)
    tif = 'postOnly'
  } else if (intent.tif === 'ioc') {
    orderFlags = ORDER_FLAGS.shortTerm
    goodTilBlock = opts.goodTilBlock
    tif = 'ioc'
  } else if (intent.tif === 'gtd') {
    if (intent.expiresAt === undefined) throw invalidParams('gtd intent needs expiresAt')
    orderFlags = ORDER_FLAGS.longTerm
    goodTilBlockTime = Math.floor(intent.expiresAt / 1000)
    tif = 'gtc'
  } else {
    orderFlags = ORDER_FLAGS.longTerm
    goodTilBlockTime = opts.goodTilBlockTime
    tif = 'gtc'
  }

  const orderId: OrderIdParts = {
    owner: opts.owner,
    subaccountNumber: opts.subaccountNumber,
    clientId: opts.clientId,
    clobPairId: m.clobPairId,
    orderFlags,
  }

  const conditionType = type === 'stop_market' || type === 'stop_limit' ? 'stopLoss' as const
    : type === 'take_market' || type === 'take_limit' ? 'takeProfit' as const : undefined
  let triggerSubticks: number | bigint | undefined
  if (isConditional) {
    if (intent.triggerPrice === undefined) throw invalidParams(`${type} intent for ${intent.instrumentId} needs triggerPrice`)
    if (intent.triggerType !== undefined && intent.triggerType !== 'mark') {
      throw unsupported(`dydx conditional orders trigger on the oracle price only; got triggerType=${intent.triggerType}`)
    }
    triggerSubticks = asInvalid(() => subticksFor(String(intent.triggerPrice), m, side, rounding))
  }

  const order: OrderMessage = {
    orderId,
    side,
    quantums,
    subticks,
    ...(goodTilBlock === undefined ? {} : { goodTilBlock }),
    ...(goodTilBlockTime === undefined ? {} : { goodTilBlockTime }),
    tif,
    reduceOnly: intent.reduceOnly === true,
    clientMetadata: 0,
    ...(conditionType === undefined ? {} : { conditionType }),
    ...(triggerSubticks === undefined ? {} : { conditionalTriggerSubticks: triggerSubticks }),
  }
  return {
    order,
    shortTerm: orderFlags === ORDER_FLAGS.shortTerm,
    stateful: orderFlags !== ORDER_FLAGS.shortTerm,
    clientId: opts.clientId,
    clobPairId: m.clobPairId,
    orderFlags,
    briefing: { ticker: m.ticker, side, type },
  }
}

/** 取整 / 精度拒绝统一成协议 INVALID_PARAMS（保留原始消息，含 step / tick 大小）。 */
function asInvalid<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) throw invalidParams(e.message)
    throw e
  }
}

function priceRef(intent: OrderIntent, m: MarketSnapshot): string {
  if (intent.price !== undefined) return String(intent.price)
  if (intent.triggerPrice !== undefined) return String(intent.triggerPrice)
  if (m.oraclePrice === '0') throw invalidParams(`market ${m.ticker} has no oracle price; cannot size or band the order`)
  return m.oraclePrice
}

function sizeOf(intent: OrderIntent, refPrice: string, m: MarketSnapshot): string {
  if (intent.size !== undefined) {
    if (fx(String(intent.size)) <= 0n) throw invalidParams(`size must be positive, got ${String(intent.size)}`)
    return String(intent.size)
  }
  if (intent.notional !== undefined) {
    const notional = fx(String(intent.notional))
    if (notional <= 0n) throw invalidParams(`notional must be positive, got ${String(intent.notional)}`)
    const ref = fx(refPrice)
    if (ref <= 0n) throw invalidParams(`cannot convert notional without a positive reference price on ${m.ticker}`)
    return str((notional * fx('1')) / ref)
  }
  throw invalidParams(`intent for ${intent.instrumentId} needs size or notional`)
}

interface TxResponse {
  tx_response?: { code?: number; codespace?: string; raw_log?: string; txhash?: string; height?: string | number }
}

/** 广播回执里能读出结论的部分；读不出（缺 tx_response / code 不是数字 / code=0 却缺 txhash）返回 undefined。 */
interface TxOutcome {
  code: number
  codespace: string
  rawLog: string
  txhash: string
}

/**
 * 铁律（fail-closed）：HTTP 200 不等于链上受理。`tx_response` 缺失、`code` 不是有限数字、
 * 或 `code === 0` 但 `txhash` 缺失，都说明「回执不可读」= 结果未知，必须 3006，绝不许 `?? 0` 当初 success。
 */
export function txOutcomeOf(raw: TxResponse | undefined): TxOutcome | undefined {
  const tx = raw?.tx_response
  if (tx === undefined || tx === null || typeof tx !== 'object') return undefined
  const code = typeof tx.code === 'number' && Number.isFinite(tx.code) ? tx.code : undefined
  if (code === undefined) return undefined
  const txhash = typeof tx.txhash === 'string' ? tx.txhash : ''
  if (code === 0 && txhash === '') return undefined
  return {
    code,
    codespace: typeof tx.codespace === 'string' ? tx.codespace : '',
    rawLog: typeof tx.raw_log === 'string' ? tx.raw_log : '',
    txhash,
  }
}

export class DydxTradeConnector implements VenueConnector {
  readonly venue = 'dydx' as const
  readonly environment: Environment
  readonly http: DydxHttp
  readonly subaccountNumber: number
  readonly signer?: DydxSigner
  readonly market?: DydxMarketSource
  readonly clientIds = new ClientIdAllocator()
  readonly #statefulDays: number
  readonly #fee?: FeeConfig
  /** 私钥等敏感串：错误文本里出现就替换（不放在 DydxHttp 上，不给 HTTP 层多一条读出私钥的路）。 */
  readonly #secrets: readonly string[]
  /** Indexer 订单 UUID → 本进程下的 clientOrderId / clientId / clobPairId / orderFlags（重启后为空）。 */
  readonly #orders = new Map<string, { clientOrderId: string; clientId: number; clobPairId: number; orderFlags: number }>()
  /** Indexer 订单 UUID → clientOrderId；未知（重启后 / 外来单）返回 null。 */
  readonly #clientOrderIdOf = (indexerId: string): string | null => this.#orders.get(indexerId)?.clientOrderId ?? null
  #markets = new Map<string, MarketSnapshot>()
  #marketsAt = 0
  #accountNumber?: number
  #sequence?: number
  #height = 0
  #heightAt = 0

  constructor(o: DydxTradeConnectorOptions = {}) {
    this.environment = o.environment ?? 'mainnet'
    this.#secrets = o.privateKey === undefined ? [] : [o.privateKey]
    this.http = new DydxHttp({
      ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
      ...(o.indexerBaseUrl === undefined ? {} : { indexerBaseUrl: o.indexerBaseUrl }),
      ...(o.nodeBaseUrl === undefined ? {} : { nodeBaseUrl: o.nodeBaseUrl }),
      ...(o.budget === undefined ? {} : { budget: o.budget }),
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
      environment: this.environment,
    })
    this.subaccountNumber = o.subaccountNumber ?? 0
    this.signer = o.privateKey === undefined ? undefined : new DydxSigner(o.privateKey)
    this.market = o.market
    this.#statefulDays = o.statefulDays ?? DEFAULT_STATEFUL_DAYS
    if (o.fee !== undefined) this.#fee = o.fee
    if (o.accountNumber !== undefined) this.#accountNumber = o.accountNumber
    if (o.sequence !== undefined) this.#sequence = o.sequence
  }

  describe(): VenueCapabilities {
    return dydxTradeCapabilities()
  }

  /** 签名者地址（只读连接器为 undefined）。 */
  get address(): string | undefined {
    return this.signer?.info.address
  }

  // ---- 行情：委托给注入的只读行情源（通常就是已入库的 DydxDataConnector） ----
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[] {
    return this.market === undefined ? [] : this.market.listInstruments(opts)
  }

  getInstrument(id: string): Instrument | undefined {
    return this.market?.getInstrument(id)
  }

  quote(id: string): never | undefined {
    if (this.market === undefined) return undefined
    return this.market.quote(id) as never
  }

  book(id: string, depth?: number): Promise<Book> {
    if (this.market === undefined) return Promise.reject(capabilityUnsupported('no market source injected; pass @gitrader/connector-dydx-data as `market`'))
    return this.market.book(id, depth)
  }

  candles(id: string, interval: CandleInterval, opts?: { n?: number; from?: Ms; to?: Ms }): Promise<Candle[]> {
    if (this.market === undefined) return Promise.reject(capabilityUnsupported('no market source injected'))
    return this.market.candles(id, interval, opts)
  }

  context(id: string): Promise<MarketContext> {
    if (this.market === undefined) return Promise.reject(capabilityUnsupported('no market source injected'))
    return this.market.context(id)
  }

  subscribe(spec: SubscriptionSpec, cb: (e: VenueEvent) => void): Unsubscribe {
    if (this.market === undefined) return () => {}
    return this.market.subscribe(spec, cb)
  }

  status(): MarketStatus {
    if (this.market === undefined) {
      return { stale: true, source: 'none', lastMessageTs: 0 } as MarketStatus
    }
    return this.market.status()
  }

  async close(): Promise<void> {
    await this.market?.close?.()
  }

  /**
   * 读失败归一（批 11 主题二 ①）：账户读方法不许把 DydxHttpError / DydxNetworkError 裸抛给内核
   * （内核只认 ProblemError.problem.code）——一律走 asProblem 分类，并做两层脱敏：
   *   · path 模板：client.ts 的 pathOf 已把 `/v4/addresses/<addr>/…`、`?address=` 换成 `***`；
   *   · 上游回显：body 里也可能带地址，这里把本次 ref.address 与私钥一起按字面替换成 `<redacted>`。
   * 端点模板保留在 message 里（形如 `(GET /v4/addresses/<masked>/subaccountNumber/0)`），定位用，不含账户。
   */
  #readProblem(e: unknown, ref?: AccountRef): Problem {
    const address = ref?.address
    const secrets = address === undefined ? this.#secrets : [...this.#secrets, address]
    const base = asProblem(e, { secrets })
    if (!(e instanceof DydxHttpError) && !(e instanceof DydxNetworkError)) return base
    return { ...base, message: `${base.message} (${e.method} ${e.path})` }
  }

  /** 读方法统一出口：ProblemError 原样上抛（避免二次包裹），其余一律归一成 ProblemError。 */
  async #read<T>(ref: AccountRef | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ProblemError) throw e
      throw new ProblemError(this.#readProblem(e, ref))
    }
  }

  // ---- 市场参数 ----
  /** 拉一次 /v4/perpetualMarkets（60 s 内复用缓存）。读失败归一成 ProblemError（3003 / 3006 按方法判定）。 */
  async loadMarkets(force = false): Promise<Map<string, MarketSnapshot>> {
    const now = this.http.now()
    if (!force && this.#markets.size > 0 && now - this.#marketsAt < 60_000) return this.#markets
    return this.#read(undefined, async () => {
      const res = await this.http.indexerGet<unknown>('/v4/perpetualMarkets')
      this.#markets = parseMarkets(res.data)
      this.#marketsAt = now
      return this.#markets
    })
  }

  // ---- 账户读 ----
  async accountState(ref: AccountRef): Promise<AccountSnapshot> {
    return this.#read(ref, async () => {
      let res: { data: { subaccount?: RawSubaccount } }
      try {
        res = await this.http.indexerGet<{ subaccount?: RawSubaccount }>(
          `/v4/addresses/${ref.address}/subaccountNumber/${this.subaccountNumber}`,
        )
      } catch (e) {
        // Indexer 对未知子账户回 404；这是「账户没绑定」，不是场所拒绝
        if (e instanceof DydxHttpError && e.status === 404) {
          throw new ProblemError(makeProblem('ACCOUNT_NOT_BOUND', `dYdX indexer has no subaccount ${this.subaccountNumber} for this address`))
        }
        throw e
      }
      if (res.data.subaccount === undefined) {
        throw new ProblemError(makeProblem('ACCOUNT_NOT_BOUND', `dYdX indexer has no subaccount ${this.subaccountNumber} for this address`))
      }
      return parseAccount(res.data.subaccount, { accountId: ref.accountId, ts: this.http.now() }).snapshot
    })
  }

  async openOrders(ref: AccountRef): Promise<VenueOpenOrder[]> {
    return this.#read(ref, async () => {
      // 官方 GET /v4/orders 返回裸数组；条件单是 UNTRIGGERED，必须单独拉一次才能进对账与全撤。
      const [open, untriggered] = await Promise.all([
        this.http.indexerGet<RawOrder[]>('/v4/orders', {
          address: ref.address, subaccountNumber: this.subaccountNumber, status: 'OPEN', limit: INDEXER_PAGE_LIMIT,
        }),
        this.http.indexerGet<RawOrder[]>('/v4/orders', {
          address: ref.address, subaccountNumber: this.subaccountNumber, status: 'UNTRIGGERED', limit: INDEXER_PAGE_LIMIT,
        }),
      ])
      const seen = new Set<string>()
      const rows: RawOrder[] = []
      for (const row of [...asRows(open.data), ...asRows(untriggered.data)]) {
        if (row.id !== undefined) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
        }
        rows.push(row)
      }
      return parseOrders(rows, this.#clientOrderIdOf)
    })
  }

  async fills(ref: AccountRef, sinceMs: Ms, opts?: { instrumentId?: string }): Promise<VenueFill[]> {
    return this.#read(ref, async () => {
      const res = await this.http.indexerGet<{ fills?: RawFill[] }>('/v4/fills', {
        address: ref.address, subaccountNumber: this.subaccountNumber, limit: INDEXER_PAGE_LIMIT,
        ...(opts?.instrumentId === undefined ? {} : { market: tickerOf(opts.instrumentId), marketType: 'PERPETUAL' }),
      })
      const all = parseFills(res.data.fills ?? [], this.#clientOrderIdOf)
      const filtered = sinceMs <= 0 ? all : all.filter((f) => f.ts >= sinceMs)
      // 按 venueFillId 去重（同一成交多次到达时只留第一条；保留最新价量）
      const seen = new Set<string>()
      return filtered.filter((f) => (seen.has(f.venueFillId) ? false : (seen.add(f.venueFillId), true)))
    })
  }

  async orderStatus(ref: AccountRef, key: { clientOrderId?: string; venueOrderId?: string; instrumentId?: string }): Promise<VenueOrderStatus> {
    return this.#read(ref, async () => {
      // 1) 直接给 Indexer 订单 UUID：GET /v4/orders/{id}（不存在回 404）
      if (key.venueOrderId !== undefined) {
        const row = await this.#orderById(key.venueOrderId)
        return row === undefined ? NOT_FOUND : statusOfOrder(row)
      }
      if (key.clientOrderId === undefined) return NOT_FOUND
      // 2) 映射已知（同进程下过单）：用同一个 UUID 公式拼出订单 id 再 GET
      const known = this.clientIds.lookup(key.clientOrderId)
      if (known !== undefined) {
        const id = indexerOrderId(ref.address, this.subaccountNumber, known.clientId, known.clobPairId, known.orderFlags)
        const row = await this.#orderById(id)
        if (row !== undefined) return statusOfOrder(row)
      }
      // ponytail: 重启后分配器映射为空，无法还原「碰撞顺延」，只能按 client_id 在挂单列表里找（碰撞时可能认错单）。
      const clientId = clientIdBaseOf(key.clientOrderId)
      const res = await this.http.indexerGet<RawOrder[]>('/v4/orders', {
        address: ref.address, subaccountNumber: this.subaccountNumber, limit: INDEXER_PAGE_LIMIT,
      })
      const hit = asRows(res.data).find((o) => String(o.clientId ?? '') === String(clientId))
      return hit === undefined ? NOT_FOUND : statusOfOrder(hit)
    })
  }

  /** 单行订单（GET /v4/orders/{id}）：404 视为不存在。 */
  async #orderById(id: string): Promise<RawOrder | undefined> {
    try {
      const res = await this.http.indexerGet<RawOrder | RawOrder[]>(`/v4/orders/${id}`)
      const data = res.data
      if (Array.isArray(data)) return data[0]
      return data
    } catch (e) {
      if (e instanceof DydxHttpError && e.status === 404) return undefined
      throw e
    }
  }

  async startupSnapshot(ref: AccountRef, fillsSinceMs: Ms): Promise<StartupSnapshot> {
    return this.#read(ref, async () => {
      const [account, orders, fills] = await Promise.all([
        this.accountState(ref),
        this.openOrders(ref),
        this.fills(ref, fillsSinceMs),
      ])
      const positions = await this.#positions(ref, account)
      return {
        account: { ...account, positions },
        openOrders: orders,
        fills,
        fillsSince: fillsSinceMs,
        truncated: fills.length >= 100,
      }
    })
  }

  async #positions(ref: AccountRef, fallback: AccountSnapshot): Promise<AccountSnapshot['positions']> {
    // 教训 5：持仓从持仓专用端点取；端点失败时才退回 subaccount 里的聚合字段（并保留 fallback 的位置）。
    try {
      const res = await this.http.indexerGet<{ positions?: unknown[] }>('/v4/perpetualPositions', {
        address: ref.address, subaccountNumber: this.subaccountNumber, status: 'OPEN',
      })
      if (!Array.isArray(res.data.positions)) return fallback.positions
      return parsePositions(res.data.positions as never)
    } catch {
      return fallback.positions
    }
  }

  // ---- 交易 ----
  async submit(ctx: TradeContext, intents: OrderIntent[]): Promise<SubmitResult> {
    const signer = this.#requireSigner()
    if (intents.length === 0) throw invalidParams('submit needs at least one intent')
    if (intents.length > 1) throw invalidParams('this connector sends one order per transaction (capabilities.batch.maxOrders = 1)')
    // 铁律：下单前的每一次读（市场参数 / 块高）都必须在 try 里，失败统一归成带 code 的 Problem，
    // 不许把 DydxHttpError / 裸 Error 抛给内核（内核只认 ProblemError.problem.code）。
    let markets: Map<string, MarketSnapshot>
    let height: number
    let statefulSeconds: number
    try {
      markets = await this.loadMarkets()
      height = await this.#currentHeight()
      statefulSeconds = this.#statefulSeconds()
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.#secrets }))
    }
    const acks: OrderAck[] = []
    let receipts = ''
    let weight = 0

    for (let i = 0; i < intents.length; i += 1) {
      const intent = intents[i]!
      const ticker = tickerOf(intent.instrumentId)
      // 市价价带的参考价是预言机价，超过 5 s 就重取市场参数（不拿一分钟前的价带下单）
      const stale = this.#markets.size > 0 && this.http.now() - this.#marketsAt > 5_000
      let marketsNow = markets
      if (intent.type === 'market' && stale) {
        try {
          marketsNow = await this.loadMarkets(true)
        } catch (e) {
          throw new ProblemError(asProblem(e, { secrets: this.#secrets }))
        }
      }
      const market = marketsNow.get(ticker)
      if (market === undefined) throw new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', `dydx market ${ticker} not found`))
      const clientOrderId = intent.clientOrderId ?? randomClientOrderId()
      try {
        const plan = await this.#plan(intent, market, clientOrderId, height, statefulSeconds)
        const venueOrderId = indexerOrderId(
          signer.address, this.subaccountNumber, plan.clientId, plan.clobPairId, plan.orderFlags,
        )
        // 签名前登记：之后 Indexer 的挂单 / 成交行（给的是同一个 UUID）才能对回 clientOrderId
        this.#orders.set(venueOrderId, {
          clientOrderId, clientId: plan.clientId, clobPairId: plan.clobPairId, orderFlags: plan.orderFlags,
        })
        const signed = await this.#sign(anyOf(TYPE_URL.msgPlaceOrder, msgPlaceOrder(plan.order)), plan.stateful)
        ctx.onSigned?.({
          purpose: plan.shortTerm ? 'dydx.place_order.short_term' : 'dydx.place_order.stateful',
          digest: signed.signDocHash,
          signer: signer.address as never,
          ts: this.http.now(),
        })
        const res = await this.#broadcast(signed, plan.stateful)
        receipts += res.raw
        weight += res.weight
        const outcome = txOutcomeOf(res.response)
        if (outcome === undefined) {
          // 广播回了 200 但没有可读的 tx_response（网关改写 / 版本漂移）：链上结果未知。
          // 不许 `?? 0` 当成功（会报 open），也不许当拒单（会让内核重发）。
          acks.push({
            intentIndex: i,
            clientOrderId: clientOrderId as never,
            venueOrderId: null,
            status: 'unknown',
            filledSize: asDecimal('0'),
            avgFillPrice: null,
            builder: { attached: false },
            problem: makeProblem(
              'VENUE_OUTCOME_UNKNOWN',
              'dydx broadcast returned no readable tx_response; query by clientOrderId before retrying',
              { venue: { id: 'dydx', message: redactSecret(res.raw, this.#secrets).slice(0, 200) } },
            ),
          })
          break
        }
        const code = outcome.code
        if (code === 0) {
          this.#noteTxSuccess(plan.stateful)
          acks.push({
            intentIndex: i,
            clientOrderId: clientOrderId as never,
            venueOrderId,
            status: 'open',
            filledSize: asDecimal('0'),
            avgFillPrice: null,
            builder: { attached: false },
          })
        } else {
          this.#noteTxFailure(code, outcome.rawLog)
          acks.push({
            intentIndex: i,
            clientOrderId: clientOrderId as never,
            venueOrderId: null,
            status: 'rejected',
            filledSize: asDecimal('0'),
            avgFillPrice: null,
            builder: { attached: false },
            problem: asProblem(new DydxTxError(
              code,
              outcome.codespace,
              outcome.rawLog,
              outcome.txhash !== '' ? outcome.txhash : signed.txHash,
            ), { secrets: this.#secrets }),
          })
        }
      } catch (e) {
        const problem = asProblem(e, { secrets: this.#secrets })
        const unknown = problem.code === 3006
        acks.push({
          intentIndex: i,
          clientOrderId: clientOrderId as never,
          venueOrderId: null,
          status: unknown ? 'unknown' : 'rejected',
          filledSize: asDecimal('0'),
          avgFillPrice: null,
          builder: { attached: false },
          problem,
        })
        if (unknown) {
          // 结果未知：不放行后续意图（内核按 clientOrderId 对账后再决定），也不重发
          break
        }
      }
    }
    return {
      acks,
      receiptHash: sha256Hex(new TextEncoder().encode(receipts)),
      requestWeight: weight,
    }
  }

  async cancel(ctx: TradeContext, targets: CancelTarget[]): Promise<CancelAck[]> {
    this.#requireSigner()
    const out: CancelAck[] = []
    for (const target of targets) {
      try {
        const parts = await this.#resolveOrderId(target)
        const height = await this.#currentHeight()
        const shortTerm = parts.orderFlags === ORDER_FLAGS.shortTerm
        const msg = msgCancelOrder(parts, shortTerm ? { block: height + SHORT_BLOCK_WINDOW } : { blockTime: this.#statefulSeconds() })
        const signed = await this.#sign(anyOf(TYPE_URL.msgCancelOrder, msg), !shortTerm)
        ctx.onSigned?.({
          purpose: 'dydx.cancel_order',
          digest: signed.signDocHash,
          signer: this.signer!.address as never,
          ts: this.http.now(),
        })
        const res = await this.#broadcast(signed, !shortTerm)
        const outcome = txOutcomeOf(res.response)
        if (outcome === undefined) {
          // 撤单广播 200 但回执读不懂：撤没撤掉未知 → 3006，按 clientOrderId 对账（不得当成功）。
          out.push({
            target,
            ok: false,
            problem: makeProblem(
              'VENUE_OUTCOME_UNKNOWN',
              'dydx broadcast returned no readable tx_response for the cancel; query the order before retrying',
              { venue: { id: 'dydx', message: redactSecret(res.raw, this.#secrets).slice(0, 200) } },
            ),
          })
          continue
        }
        const code = outcome.code
        if (code === 0) {
          this.#noteTxSuccess(!shortTerm)
          out.push({ target, ok: true })
        } else {
          this.#noteTxFailure(code, outcome.rawLog)
          out.push({ target, ok: false, problem: asProblem(new ProblemError(makeProblem('VENUE_REJECTED',
            `chain rejected the cancel: code ${code} ${outcome.rawLog}`))) })
        }
      } catch (e) {
        out.push({ target, ok: false, problem: asProblem(e, { secrets: this.#secrets }) })
      }
    }
    return out
  }

  async cancelAll(ctx: TradeContext, instrumentId?: string): Promise<CancelAck[]> {
    const ref = ctx.account
    const orders = await this.openOrders(ref)
    const wanted = instrumentId === undefined ? orders : orders.filter((o) => o.instrumentId === instrumentId)
    if (wanted.length === 0) return []
    return this.cancel(ctx, wanted.map((o) => ({
      instrumentId: o.instrumentId,
      venueOrderId: o.venueOrderId,
      ...(o.clientOrderId === null ? {} : { clientOrderId: o.clientOrderId }),
    })))
  }

  /** dYdX 没有改单消息：撤单 + 重下，由内核决定（能力位 amend = none）。 */
  async amend(): Promise<SubmitResult> {
    throw unsupported('dYdX has no amend message; cancel and submit a new order (capabilities.amend = none)')
  }

  async setLeverage(): Promise<void> {
    throw unsupported('leverage changes are not wired (chain MsgUpdateLeverage); set it in the dYdX UI')
  }

  async scheduleCancel(): Promise<void> {
    throw unsupported('dYdX has no venue-level deadman switch in this connector')
  }

  // ---- 内部 ----
  #requireSigner(): DydxSigner {
    if (this.signer === undefined) {
      throw new ProblemError(makeProblem('ACCOUNT_NOT_BOUND', 'this dYdX connector was created without a private key'))
    }
    return this.signer
  }

  async #plan(intent: OrderIntent, market: MarketSnapshot, clientOrderId: string, height: number, statefulSeconds: number): Promise<OrderPlan> {
    const owner = this.#requireSigner().info.address
    // clientId 是计划的输入，此时还看不到真实 order_flags：先分配、拿到计划后再回写（撤单 / 对账要用真值）。
    const clientId = this.clientIds.allocate(clientOrderId, market.clobPairId, ORDER_FLAGS.shortTerm)
    const plan = planOrder(intent, {
      market,
      owner,
      subaccountNumber: this.subaccountNumber,
      clientId,
      goodTilBlock: height + SHORT_BLOCK_WINDOW,
      goodTilBlockTime: statefulSeconds,
      statefulSeconds,
    })
    this.clientIds.setOrderFlags(clientOrderId, plan.orderFlags)
    return plan
  }

  #statefulSeconds(): number {
    return Math.floor(this.http.now() / 1000) + this.#statefulDays * 86_400
  }

  async #currentHeight(): Promise<number> {
    const now = this.http.now()
    if (this.#height > 0 && now - this.#heightAt < 5_000) return this.#height
    const res = await this.http.nodeGet<{ block?: { header?: { height?: string } } }>(LATEST_BLOCK_PATH)
    const h = Number(res.data.block?.header?.height ?? 0)
    // 块高读不出来 = 场所暂时拿不到数据（可重试），不是编程错误：必须是带 code 的 Problem（3003）。
    if (!Number.isFinite(h) || h <= 0) {
      throw new ProblemError(makeProblem('VENUE_UNAVAILABLE', 'could not read the latest dYdX block height', { retryable: true }))
    }
    this.#height = h
    this.#heightAt = now
    return h
  }

  async #accountInfo(): Promise<{ accountNumber: number; sequence: number }> {
    if (this.#accountNumber !== undefined && this.#sequence !== undefined) {
      return { accountNumber: this.#accountNumber, sequence: this.#sequence }
    }
    const address = this.#requireSigner().info.address
    const res = await this.http.nodeGet<{ account?: ChainAccount }>(ACCOUNT_PATH(address))
    // Cosmos SDK 对 BaseAccount 的 JSON 是平铺（account.account_number / account.sequence）；
    // ModuleAccount 与 vesting 账户多包一层，才回退到 base_account.*。
    const account = res.data.account
    const flat = account !== undefined && (account.account_number !== undefined || account.sequence !== undefined)
    const base = flat
      ? account
      : account?.base_account ?? account?.base_vesting_account?.base_account
    const accountNumber = Number(base?.account_number ?? NaN)
    const sequence = Number(base?.sequence ?? NaN)
    if (!Number.isFinite(accountNumber) || !Number.isFinite(sequence)) {
      throw new Error('could not read account_number / sequence from the chain')
    }
    this.#accountNumber = accountNumber
    this.#sequence = sequence
    return { accountNumber, sequence }
  }

  async #sign(messageAny: Uint8Array, stateful: boolean): Promise<SignedTx> {
    const signer = this.#requireSigner()
    const info = await this.#accountInfo()
    if (stateful && this.#fee === undefined) {
      throw invalidParams('stateful dYdX orders (gtc / post-only / stop / take) need an explicit `fee` config; short-term orders use an empty fee')
    }
    const fee: FeeConfig = this.#fee ?? { amount: [], gasLimit: 0 }
    const signed = signTransaction(signer, [messageAny], {
      chainId: CHAIN_ID[this.environment],
      accountNumber: info.accountNumber,
      sequence: stateful ? info.sequence : info.sequence,
      fee,
    })
    return signed
  }

  async #broadcast(signed: SignedTx, stateful: boolean): Promise<{ response: TxResponse; raw: string; weight: number }> {
    // 一律 SYNC：cosmos-sdk v0.50（dYdX protocol/go.mod 是 v0.50.11）的 client/broadcast.go 只支持 sync / async
    const body = broadcastRequestBody(signed, 'BROADCAST_MODE_SYNC')
    try {
      const res = await this.http.nodePost<TxResponse>(BROADCAST_PATH, body)
      return { response: res.data, raw: res.raw, weight: res.weight }
    } catch (e) {
      // 没拿到结果（超时 / 断连 / 5xx）：不知道链有没有收，缓存的 sequence 不可信，作废
      if (stateful) this.#sequence = undefined
      throw e
    }
  }

  /** 只有 code === 0 才消耗 sequence（CheckTx 失败不消耗）。 */
  #noteTxSuccess(stateful: boolean): void {
    if (stateful) this.#sequence = (this.#sequence ?? 0) + 1
  }

  #noteTxFailure(code: number, rawLog: string): void {
    if (code === 3 || code === 32 || /account sequence mismatch/i.test(rawLog)) {
      // 序列号漂移：把缓存作废，下一次签名重新从链上取
      this.#sequence = undefined
    }
  }

  async #resolveOrderId(target: CancelTarget): Promise<OrderIdParts> {
    const owner = this.#requireSigner().info.address
    // 1) 本进程下过单：映射里有（venueOrderId 或 clientOrderId 任一命中）就不必问 Indexer
    if (target.venueOrderId !== undefined) {
      const known = this.#orders.get(target.venueOrderId)
      if (known !== undefined) {
        return {
          owner, subaccountNumber: this.subaccountNumber,
          clientId: known.clientId, clobPairId: known.clobPairId, orderFlags: known.orderFlags,
        }
      }
    }
    if (target.clientOrderId !== undefined) {
      const known = this.clientIds.lookup(target.clientOrderId)
      if (known !== undefined) {
        return { owner, subaccountNumber: this.subaccountNumber, clientId: known.clientId, clobPairId: known.clobPairId, orderFlags: known.orderFlags }
      }
    }
    // 2) 重启后 / 映射丢失：用 Indexer 的订单行（GET /v4/orders/{id}）里的 clientId / clobPairId / orderFlags
    if (target.venueOrderId !== undefined) {
      const hit = await this.#orderById(target.venueOrderId)
      if (hit !== undefined && hit.clientId !== undefined) {
        return {
          owner,
          subaccountNumber: this.subaccountNumber,
          clientId: intOf(hit.clientId, 'order.clientId'),
          clobPairId: hit.clobPairId === undefined ? await this.#clobPairOf(target.instrumentId) : intOf(hit.clobPairId, 'order.clobPairId'),
          orderFlags: hit.orderFlags === undefined ? ORDER_FLAGS.shortTerm : intOf(hit.orderFlags, 'order.orderFlags'),
        }
      }
    }
    if (target.clientOrderId !== undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS',
        'unknown clientOrderId for this process; pass venueOrderId from openOrders so the order can be identified after a restart'))
    }
    throw invalidParams('cancel target needs venueOrderId or clientOrderId')
  }

  async #clobPairOf(instrumentId: string): Promise<number> {
    const markets = await this.loadMarkets()
    const m = markets.get(tickerOf(instrumentId))
    if (m === undefined) throw new ProblemError(makeProblem('INSTRUMENT_UNKNOWN', `dydx market ${tickerOf(instrumentId)} not found`))
    return m.clobPairId
  }
}

/** Cosmos 账户 JSON（BaseAccount 平铺；ModuleAccount / vesting 多包一层）。 */
interface ChainAccount {
  account_number?: string
  sequence?: string
  base_account?: { account_number?: string; sequence?: string }
  base_vesting_account?: { base_account?: { account_number?: string; sequence?: string } }
}

/** 官方 GET /v4/orders 返回裸数组（comlink orders-controller：Promise<OrderResponseObject[]>），其它形状当空。 */
function asRows(data: RawOrder[] | null | undefined): RawOrder[] {
  return Array.isArray(data) ? data : []
}

/** 生成 32 位十六进制 clientOrderId（内核通常自己给；调用方没给时用）。 */
export function randomClientOrderId(): string {
  const b = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256)
  return Buffer.from(b).toString('hex')
}

/** 内部工具（测试用）：从响应文本取 sha256 十六进制。 */
export function receiptHashOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export { throwAsProblem }
