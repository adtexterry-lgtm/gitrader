// SPDX-License-Identifier: CPAL-1.0
// 本包自带的**最小**公共行情：合约规格（下单精度的前置）、参考价 / 盘口 / K 线 / 市场上下文。
// 为什么交易包里也有一份：下单要 contract_size / price_tick，市价意图还要一个新鲜的参考价，
// 这两件事不能等行情包；完整行情（订阅、翻页、K 线缓存）在 packages/connector-htx-data（另行施工），
// 本文件不复制它的实现，只覆盖「交易必需」的四个公开端点（全部在 rest.ts 的 ENDPOINTS 表里）：
//   GET /linear-swap-api/v1/swap_contract_info      合约信息（contract_size / price_tick / contract_status）
//   GET /linear-swap-ex/market/detail/merged        聚合行情（bid / ask / close；QD htx.py:506-514 同一个端点）
//   GET /linear-swap-ex/market/depth                盘口（type=step0）
//   GET /linear-swap-ex/market/history/kline        K 线（period / size）
// 公共请求**不带任何密钥**（独立 fetch，不碰签名路径）。
import { asDecimal, makeProblem, normalizeDecimal } from '@gitrader/protocol'
import type { Book, Candle, CandleInterval, Instrument, InstrumentId, MarketContext, Ms } from '@gitrader/protocol'
import type { BookLevel } from '@gitrader/protocol'
import type { MarketStatus, StampedQuote, SubscriptionSpec, Unsubscribe, VenueEvent } from '@gitrader/protocol/connector'
import { createWeightBudget } from './budget'
import { asProblem, HtxHttpError, HtxNetworkError, ProblemError } from './errors'
import { ENDPOINTS, codeOf, envelopeOk, resolveBaseUrl, retryAfterOf } from './rest'
import type { Environment } from './rest'
import { instrumentIdOf, num, symbolOf, upper, VENUE } from './parse'
import { decimalsOf } from './precision'

/**
 * 协议 K 线周期 → HTX period 文本。官方枚举只有：1min / 5min / 15min / 30min / 60min / 4hour / 1day / 1mon。
 * 其余周期本包不猜：candles() 直接 INVALID_PARAMS、不发请求。
 */
export const PERIOD_MAP: Partial<Record<CandleInterval, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '60min',
  '4h': '4hour',
  '1d': '1day',
  '1M': '1mon',
}

/** 单次 K 线上限（官方 size 上限 2000，本包按 1000 取，与历史能力声明一致）。 */
export const MAX_CANDLES = 1_000

export interface MarketOptions {
  environment?: Environment
  baseUrl?: string
  fetchImpl?: typeof fetch
  clock?: () => number
  /** 报价轮询间隔（refreshQuote 的最小间隔），缺省 1000 ms。 */
  pollMs?: number
  /** 报价陈旧阈值（quote 的 stale），缺省 10 s。 */
  staleMs?: number
  httpTimeoutMs?: number
}

export interface MarketDeps {
  baseUrl: string
  fetchImpl: typeof fetch
  clock: () => number
  staleMs: number
  pollMs: number
  timeoutMs: number
  budget?: ReturnType<typeof createWeightBudget>
}

/** 合约规格行（官方“合约信息”字段的一个子集，字段名照官方）。 */
export interface RawContract {
  contract_code?: string
  contract_size?: number | string
  price_tick?: number | string
  contract_status?: number
  symbol?: string
  max_leverage?: number
  max_lever_rate?: number
  delivery_time?: string
}

/** 一行合约 → Instrument（contract_status 1 = 可交易；其余按 halted，delisted 由调用方判断）。
 * 对内核口径：数量已是币（venueSizeUnit 'base'），所以 contractSize 一律 '1'（内核名义额 = size × 价 × 1）；
 * 真实面值另存在 HtxTradeMarket 的私有表里，供张→币换算与 size.step / min / decimals 使用。
 * contract_size 缺失或 ≤ 0 的合约不进标的表（返回 null）。 */
export function parseContract(row: RawContract, now: Ms): Instrument | null {
  const code = upper(String(row.contract_code ?? ''))
  if (code === '') return null
  const rawSize = String(row.contract_size ?? '').trim()
  if (rawSize === '') return null
  let face: string
  try {
    face = normalizeDecimal(rawSize)
  } catch {
    return null
  }
  if (!(Number(face) > 0)) return null
  let tick: string
  try {
    tick = normalizeDecimal(String(row.price_tick))
  } catch {
    return null
  }
  if (!(Number(tick) > 0)) return null
  const base = code.split('-')[0] ?? code
  const status = Number(row.contract_status)
  return {
    instrumentId: instrumentIdOf(code),
    venue: VENUE,
    symbol: code,
    displaySymbol: code,
    kind: 'perp',
    base,
    quote: 'USDT',
    settle: 'USDT',
    settlement: 'linear',
    contractSize: asDecimal('1'),
    venueSizeUnit: 'base',
    assetClass: 'crypto',
    status: status === 1 ? 'trading' : 'halted',
    price: { tick: asDecimal(tick) },
    // 协议数量是币：step / min = 一张的面值（0.001 → 3 位小数；10 → 0 位）。
    size: { step: asDecimal(face), decimals: decimalsOf(face), min: asDecimal(face) },
    ...(row.max_leverage !== undefined || row.max_lever_rate !== undefined
      ? { maxLeverage: Number(row.max_leverage ?? row.max_lever_rate) }
      : {}),
    orderTypes: ['market', 'limit'],
    tif: ['gtc', 'ioc', 'fok', 'alo'],
    triggerPriceTypes: ['last'],
    updatedAt: now,
  }
}

/** 从合约信息行取面值（parseContract 的同一口径）；拿不到返回 undefined。 */
export function faceValueOfContractRow(row: RawContract): string | undefined {
  const raw = String(row.contract_size ?? '').trim()
  if (raw === '') return undefined
  try {
    const face = normalizeDecimal(raw)
    return Number(face) > 0 ? face : undefined
  } catch {
    return undefined
  }
}

export class HtxTradeMarket {
  readonly data: MarketDeps
  private readonly instruments = new Map<string, Instrument>()
  /** contract_code → 一张的面值（币）；只在内存里，不进 Instrument.contractSize。 */
  private readonly faceValues = new Map<string, string>()
  private readonly quotes = new Map<string, { quote: StampedQuote; at: Ms }>()
  private lastMessageTs = 0
  private started = false

  constructor(o: MarketOptions = {}) {
    const environment: Environment = o.environment ?? 'mainnet'
    this.data = {
      baseUrl: resolveBaseUrl(environment, o.baseUrl),
      fetchImpl: o.fetchImpl ?? ((...args) => fetch(...args)),
      clock: o.clock ?? (() => Date.now()),
      staleMs: o.staleMs ?? 10_000,
      pollMs: o.pollMs ?? 1_000,
      timeoutMs: o.httpTimeoutMs ?? 10_000,
      budget: createWeightBudget(o.clock ? { clock: o.clock } : {}),
    }
  }

  /** 拉一次合约信息并建本地标的地图（连接器 start() 调它）。 */
  async start(): Promise<void> {
    const env = await this.publicJson(ENDPOINTS.contractInfo.path, {})
    const rows = Array.isArray(env.data) ? env.data : []
    const now = this.data.clock()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const raw = row as RawContract
      const parsed = parseContract(raw, now)
      const face = faceValueOfContractRow(raw)
      if (!parsed || face === undefined) continue
      this.instruments.set(parsed.instrumentId, parsed)
      this.faceValues.set(parsed.symbol, face)
    }
    this.started = true
  }

  async close(): Promise<void> {
    this.quotes.clear()
  }

  get ready(): boolean {
    return this.started
  }

  listInstruments(opts: { includeDelisted?: boolean } = {}): Instrument[] {
    const all = [...this.instruments.values()]
    return opts.includeDelisted === true ? all : all.filter((i) => i.status !== 'delisted')
  }

  getInstrument(id: InstrumentId): Instrument | undefined {
    return this.instruments.get(id)
  }

  /** 合约面值（contract_code → 一张的币数），parse.ts 的 ContractSizeOf 用它；没 start() 就是 undefined。 */
  contractSizeOf = (contractCode: string): string | undefined => {
    return this.faceValues.get(upper(contractCode))
  }

  /** 下单体里的 faceValue（BuildOptions.faceValue）取同一张表。 */
  faceValueOf = (instrumentId: string): string | undefined => {
    return this.contractSizeOf(symbolOf(instrumentId))
  }

  /** 同步缓存的报价（不联网）；没拉过就 undefined。 */
  quote(id: InstrumentId): StampedQuote | undefined {
    const hit = this.quotes.get(id)
    if (!hit) return undefined
    const ageMs = this.data.clock() - hit.at
    return { ...hit.quote, stale: ageMs > this.data.staleMs, ageMs }
  }

  /** 主动刷新一次报价（带最小间隔；同一标的 1 s 内重复调用直接回缓存）。 */
  async refreshQuote(id: InstrumentId): Promise<StampedQuote | undefined> {
    const cached = this.quotes.get(id)
    const now = this.data.clock()
    if (cached && now - cached.at < this.data.pollMs) return this.quote(id)
    const env = await this.publicJson(ENDPOINTS.merged.path, { contract_code: symbolOf(id) })
    const tick = env.tick ?? {}
    const bid = Array.isArray(tick.bid) ? num(tick.bid[0]) : NaN
    const ask = Array.isArray(tick.ask) ? num(tick.ask[0]) : NaN
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return this.quote(id)
    const last = num(tick.close)
    const quote: StampedQuote = {
      instrumentId: id,
      ts: now,
      bid,
      ask,
      ...(Number.isFinite(last) ? { last } : {}),
      stale: false,
      ageMs: 0,
    }
    this.quotes.set(id, { quote, at: now })
    this.lastMessageTs = now
    return quote
  }

  /** 盘口（type=step0 原始档位）：官方数量是**张**，这里 × 面值换成币。 */
  async book(id: InstrumentId, depth = 20): Promise<Book> {
    const env = await this.publicJson(ENDPOINTS.depth.path, { contract_code: symbolOf(id), type: 'step0' })
    const tick = env.tick ?? {}
    const face = Number(this.contractSizeOf(symbolOf(id)) ?? NaN)
    const levels = (rows: unknown): BookLevel[] => {
      if (!Array.isArray(rows)) return []
      return rows
        .slice(0, Math.max(1, depth))
        .flatMap((r) => {
          if (!Array.isArray(r)) return []
          const price = num(r[0])
          const contracts = num(r[1])
          return Number.isFinite(price) && Number.isFinite(contracts) && Number.isFinite(face)
            ? [{ price, size: contracts * face }]
            : []
        })
    }
    return { instrumentId: id, ts: this.data.clock(), bids: levels(tick.bids), asks: levels(tick.asks) }
  }

  /** K 线（升序，与协议一致；HTX 返回倒序，这里翻过来）。
   * 官方字段：open / high / low / close；成交量 `amount` 是币，缺失时用 `vol`（张）× 面值。
   */
  async candles(id: InstrumentId, interval: CandleInterval, opts: { n?: number; from?: Ms; to?: Ms } = {}): Promise<Candle[]> {
    const period = PERIOD_MAP[interval]
    if (period === undefined) {
      throw new ProblemError(makeProblem('INVALID_PARAMS', `HTX has no kline period for ${interval}; supported: ${Object.keys(PERIOD_MAP).join(' / ')}`))
    }
    const size = Math.min(Math.max(1, Math.floor(opts.n ?? 200)), MAX_CANDLES)
    const env = await this.publicJson(ENDPOINTS.kline.path, {
      contract_code: symbolOf(id),
      period,
      size,
    })
    const face = Number(this.contractSizeOf(symbolOf(id)) ?? NaN)
    const rows = Array.isArray(env.data) ? env.data : []
    const out: Candle[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as {
        id?: number | string; open?: number | string; high?: number | string; low?: number | string;
        close?: number | string; vol?: number | string; amount?: number | string
      }
      const t = num(r.id)
      if (!Number.isFinite(t) || t <= 0) continue
      const amount = num(r.amount)
      const volume = Number.isFinite(amount) ? amount : num(r.vol) * face
      const candle: Candle = {
        t: Math.round(t) * 1000,
        o: num(r.open),
        h: num(r.high),
        l: num(r.low),
        c: num(r.close),
        v: volume,
      }
      if (opts.from !== undefined && candle.t < opts.from) continue
      if (opts.to !== undefined && candle.t > opts.to) continue
      out.push(candle)
    }
    return out.sort((a, b) => a.t - b.t)
  }

  /**
   * 市场上下文：用聚合行情 + 合约信息拼。
   * markPrice 取的是聚合行情的**最新成交价**（`tick.close`）；HTX 的该端点没有单独标记价字段。
   * merged 里没有 funding_rate：不填 fundingRate（不编造）。
   */
  async context(id: InstrumentId): Promise<MarketContext> {
    const env = await this.publicJson(ENDPOINTS.merged.path, { contract_code: symbolOf(id) })
    const tick = env.tick ?? {}
    const bid = Array.isArray(tick.bid) ? num(tick.bid[0]) : NaN
    const ask = Array.isArray(tick.ask) ? num(tick.ask[0]) : NaN
    const mark = num(tick.close)
    const volume = num(tick.amount)
    return {
      instrumentId: id,
      ts: this.data.clock(),
      markPrice: Number.isFinite(mark) ? mark : (bid + ask) / 2,
      midPrice: Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : undefined,
      ...(Number.isFinite(volume) ? { dayNotionalVolume: volume } : {}),
    }
  }

  /** 本包没有 WebSocket：订阅返回空退订函数（不伪装成有推送）。 */
  subscribe(_spec: SubscriptionSpec, _cb: (e: VenueEvent) => void): Unsubscribe {
    return () => {}
  }

  status(): MarketStatus {
    const now = this.data.clock()
    return {
      venue: VENUE,
      environment: 'mainnet',
      ts: now,
      wsState: 'disconnected',
      stale: this.lastMessageTs === 0 || now - this.lastMessageTs > this.data.staleMs,
      source: this.lastMessageTs === 0 ? 'none' : 'rest',
      lastMessageTs: this.lastMessageTs,
    }
  }

  /**
   * 公共 GET（不签名）；信封失败抛错，由调用方转 Problem。
   * 返回**整个信封**：公共行情端点的 tick / data 都在顶层（官方形状），由调用方各取所需。
   */
  private async publicJson(path: string, params: Record<string, string | number>): Promise<{ data?: unknown; tick?: Record<string, unknown> }> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString()
    const url = `${this.data.baseUrl}${path}${qs === '' ? '' : `?${qs}`}`
    await this.data.budget?.acquire(1, { priority: 'low' })
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(new Error(`htx ${path} timeout after ${this.data.timeoutMs} ms`)), this.data.timeoutMs)
    try {
      let res: Response
      try {
        res = await this.data.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ctl.signal })
      } catch (e) {
        // 超时 / 断连 / 取消：公开读路径统一成「场所不可用」（3003，可重试），不让裸 Error 逃出公开方法。
        throw new HtxNetworkError(`htx public ${path} failed before a response: ${e instanceof Error ? e.message : String(e)}`, 'public', e, false)
      }
      const text = await res.text()
      // 保留 HTTP 状态：429 → 3002 VENUE_RATE_LIMITED（带 Retry-After），5xx → 3003。
      if (!res.ok) throw new HtxHttpError(res.status, text.slice(0, 200), 'public', retryAfterOf(res, this.data.clock()), codeOf(text), false)
      let parsed: { status?: string; data?: unknown; tick?: Record<string, unknown>; err_msg?: string }
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch (e) {
        // 200 但不是 JSON（网关 HTML）：读路径按「场所没答对」处理（3003 可重试），不是 SyntaxError。
        throw new HtxNetworkError(`htx public ${path} response is not JSON`, 'public', e, false)
      }
      if (!envelopeOk(parsed)) {
        throw new HtxHttpError(res.status, text.slice(0, 200), 'public', undefined, codeOf(text), false)
      }
      return parsed
    } catch (e) {
      // 归一化：公开读方法只抛带 Problem 的错误（内核按 code 分类，不再看到裸 Error / SyntaxError）。
      throw new ProblemError(asProblem(e, { endpoint: 'public' }))
    } finally {
      clearTimeout(timer)
    }
  }
}
