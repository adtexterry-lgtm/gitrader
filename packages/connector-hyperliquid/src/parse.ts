// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid info 响应 → 统一模型（纯函数，无状态；单测用 fixtures/hl/*.json 驱动）。
// 原始响应里的数值全是字符串，个别字段可能为 null。
import { asDecimal, makeProblem } from '@gitrader/protocol'
import type { Book, BookLevel, Candle, Instrument, MarketContext, MarginMode } from '@gitrader/protocol'
import { classify, splitSymbol } from './classify'
import { ProblemError } from './errors'
import { maxPriceDecimals, PERP_PRICE_DECIMALS } from './precision'

export const VENUE = 'hyperliquid'
export const FUNDING_INTERVAL_MS = 3_600_000
/** 官方单笔最小名义额（USDC）。reduceOnly 单不受此限。 */
export const MIN_ORDER_NOTIONAL = '10'
/** 按 Hyperliquid 界面市价单默认滑点上限8%设定，非交易所硬拒绝，可配置。 */
export const MARKET_PRICE_BAND_BPS = 800
/** 基础档费率（taker 0.045% / maker 0.015%）；真实费率随成交量与质押分档，所以 source = assumed。 */
export const BASE_FEES = { maker: asDecimal('0.00015'), taker: asDecimal('0.00045') }

export const instrumentIdOf = (coin: string): string => `${VENUE}:${coin}`
export const coinOf = (instrumentId: string): string => instrumentId.slice(VENUE.length + 1)

// ---- 原始形状 ---------------------------------------------------------------
export interface RawMetaEntry {
  name: string
  szDecimals: number
  maxLeverage: number
  isDelisted?: boolean
  onlyIsolated?: boolean
  /** 较新的 meta 用它表达 strictIsolated / noCross。 */
  marginMode?: string
  marginTableId?: number
}
export interface RawCtx {
  funding?: string | null
  openInterest?: string | null
  prevDayPx?: string | null
  dayNtlVlm?: string | null
  oraclePx?: string | null
  markPx?: string | null
  midPx?: string | null
}
export type RawMetaAndCtxs = [{ universe: RawMetaEntry[]; collateralToken?: number }, RawCtx[]]
export interface RawLevel { px: string; sz: string; n: number }
export interface RawBook { coin: string; time: number; levels: [RawLevel[], RawLevel[]] }
export interface RawCandle { t: number; T?: number; s?: string; i?: string; o: string; h: string; l: string; c: string; v: string; n?: number }

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : NaN
}

function malformed(message: string): never {
  throw new ProblemError(makeProblem('DATA_UNAVAILABLE', message))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validNumeric(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined
  const n = num(value)
  return Number.isFinite(n) ? n : undefined
}

// ---- dex 发现 ---------------------------------------------------------------
export interface PerpDexRef { name: string; index: number; fullName?: string }

/** perpDexs 响应 → 构建者 dex（不含默认 dex）。响应第 0 项为 null（默认 dex）；index = 数组下标，资产 ID 要用它。 */
export function parsePerpDexs(raw: unknown): PerpDexRef[] {
  if (!Array.isArray(raw)) return []
  const out: PerpDexRef[] = []
  raw.forEach((d, index) => {
    const o = d && typeof d === 'object' ? (d as { name?: unknown; fullName?: unknown }) : null
    if (o && typeof o.name === 'string' && o.name !== '') {
      out.push({ name: o.name, index, ...(typeof o.fullName === 'string' ? { fullName: o.fullName } : {}) })
    }
  })
  return out
}

/** 资产 ID：默认 dex = meta 下标；HIP-3 = 100000 + dexIndex x 10000 + 下标（含已下架条目，下标按原始 universe 数）。 */
export function assetIdOf(dexIndex: number, position: number): number {
  return dexIndex === 0 ? position : 100000 + dexIndex * 10000 + position
}

export interface InstrumentRecord {
  instrument: Instrument
  /** 下单用的资产 ID。 */
  assetId: number
  szDecimals: number
  /** 场所原生名（带 dex 前缀）。 */
  coin: string
  dex: string
  maxLeverage: number
}

/** 显示名：非默认 dex 一律带 dex 前缀（`sekaw:BTC-PERP`），默认 dex 不加（`BTC-PERP`）。 */
function dexDisplay(dex: string, base: string): string {
  return dex === '' ? `${base}-PERP` : `${dex}:${base}-PERP`
}

function sizeStep(szDecimals: number): string {
  return szDecimals <= 0 ? '1' : `0.${'0'.repeat(szDecimals - 1)}1`
}

function marginModesOf(e: RawMetaEntry): MarginMode[] {
  if (e.marginMode === 'strictIsolated') return ['strictIsolated']
  if (e.marginMode === 'noCross') return ['noCross']
  if (e.onlyIsolated) return ['isolated']
  return ['cross', 'isolated']
}

/** 一个 dex 的 meta → 标的记录（含已下架，status = delisted，由上层决定是否展示）。 */
export function buildInstrumentRecords(raw: unknown, dex: string, dexIndex: number, now: number): InstrumentRecord[] {
  if (!Array.isArray(raw) || raw.length !== 2 || !isObject(raw[0]) || !Array.isArray(raw[1])) malformed('malformed instrument metadata response')
  const meta = raw[0]
  const ctxs = raw[1]
  if (!Array.isArray(meta.universe) || meta.universe.length !== ctxs.length) malformed('malformed instrument metadata response')
  for (let i = 0; i < meta.universe.length; i++) {
    const entry = meta.universe[i]
    if (!isObject(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') malformed('malformed instrument metadata entry')
    const sz = validNumeric(entry.szDecimals)
    const leverage = validNumeric(entry.maxLeverage)
    if (sz === undefined || !Number.isInteger(sz) || sz < 0 || sz > PERP_PRICE_DECIMALS || leverage === undefined || leverage <= 0) {
      malformed('malformed instrument metadata entry')
    }
  }
  if (ctxs.some((ctx) => ctx !== null && !isObject(ctx))) malformed('malformed instrument context response')
  const collateralToken = meta.collateralToken
  if (collateralToken !== undefined && (typeof collateralToken !== 'number' || !Number.isSafeInteger(collateralToken) || collateralToken < 0)) {
    malformed('malformed collateral token metadata')
  }
  const quote = collateralToken === undefined || collateralToken === 0 ? 'USDC' : `TOKEN${collateralToken}`
  return meta.universe.map((rawEntry, position): InstrumentRecord => {
    const e = rawEntry as unknown as RawMetaEntry
    const { base } = splitSymbol(e.name)
    const sz = num(e.szDecimals)
    const step = sizeStep(sz)
    const instrument: Instrument = {
      instrumentId: instrumentIdOf(e.name),
      venue: VENUE,
      symbol: e.name,
      displaySymbol: dexDisplay(dex, base),
      kind: 'perp',
      base,
      quote,
      settle: quote,
      settlement: 'linear',
      contractSize: asDecimal('1'),
      venueSizeUnit: 'base',
      assetClass: classify(dex, base),
      marketGroup: dex === '' ? null : dex,
      ...(dex === ''
        ? {}
        : { underlying: { description: `Tracks the ${base} price; synthetic perpetual, the underlying is not held.`, synthetic: true } }),
      status: e.isDelisted ? 'delisted' : 'trading',
      price: { sigFigs: 5, maxDecimals: maxPriceDecimals(sz) },
      size: { step: asDecimal(step), decimals: sz, min: asDecimal(step) },
      minNotional: asDecimal(MIN_ORDER_NOTIONAL),
      maxLeverage: num(e.maxLeverage),
      marginModes: marginModesOf(e),
      orderTypes: ['market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'],
      tif: ['gtc', 'ioc', 'alo'],
      triggerPriceTypes: ['mark'],
      fundingIntervalMs: FUNDING_INTERVAL_MS,
      // HL 永续 7x24 全天候交易，没有固定点差：时段只给一条全天常规窗口，不填 typicalSpreadBps
      sessions: { tz: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59', quality: 'regular' }] },
      fees: { maker: BASE_FEES.maker, taker: BASE_FEES.taker, source: 'assumed' },
      updatedAt: now,
    }
    return { instrument, assetId: assetIdOf(dexIndex, position), szDecimals: sz, coin: e.name, dex, maxLeverage: num(e.maxLeverage) }
  })
}

// ---- 上下文 / 行情 -----------------------------------------------------------
export function parseContext(instrumentId: string, raw: unknown, ts: number): MarketContext {
  if (!isObject(raw)) malformed('malformed market context')
  const c = raw as RawCtx
  const mark = validNumeric(c.markPx) ?? NaN
  const mid = validNumeric(c.midPx) ?? NaN
  const selectedMark = mark > 0 ? mark : mid > 0 ? mid : undefined
  if (selectedMark === undefined) malformed('market context has no usable mark or mid price')
  const oracle = validNumeric(c.oraclePx)
  const out: MarketContext = {
    instrumentId,
    ts,
    markPrice: selectedMark,
    fundingIntervalMs: FUNDING_INTERVAL_MS,
  }
  if (oracle !== undefined) out.oraclePrice = oracle
  if (validNumeric(c.midPx) !== undefined) out.midPrice = mid
  const f = validNumeric(c.funding)
  if (f !== undefined) out.fundingRate = f
  const oi = validNumeric(c.openInterest)
  if (oi !== undefined) out.openInterest = oi
  const vlm = validNumeric(c.dayNtlVlm)
  if (vlm !== undefined) out.dayNotionalVolume = vlm
  const prev = validNumeric(c.prevDayPx)
  if (prev !== undefined) out.prevDayPrice = prev
  return out
}

/** allMids → { instrumentId: mid }。names 给出时只保留其中的币；缺省时丢弃 `@n`（现货）与 `#n`（结果市场）键。 */
export function parseMids(raw: unknown, names?: ReadonlySet<string>): Record<string, number> {
  if (!isObject(raw)) malformed('malformed mids response')
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (names ? !names.has(k) : k.startsWith('@') || k.startsWith('#')) continue
    const n = num(v)
    if (n > 0) out[instrumentIdOf(k)] = n
  }
  return out
}

function levels(raw: unknown[]): BookLevel[] {
  const out: BookLevel[] = []
  for (const row of raw) {
    if (!isObject(row)) continue
    const price = validNumeric(row.px)
    const size = validNumeric(row.sz)
    const count = row.n === undefined ? 0 : validNumeric(row.n)
    if (price === undefined || price <= 0 || size === undefined || size < 0 || count === undefined || count < 0 || !Number.isInteger(count)) continue
    out.push({ price, size, count })
  }
  return out
}

/** l2Book → Book；bids 降序、asks 升序，按 depth 截断。 */
export function parseBook(raw: unknown, depth = 20): Book {
  if (!isObject(raw) || typeof raw.coin !== 'string' || raw.coin.trim() === '' || typeof raw.time !== 'number' || !Number.isInteger(raw.time) || raw.time < 0 ||
    !Array.isArray(raw.levels) || raw.levels.length !== 2 || !Array.isArray(raw.levels[0]) || !Array.isArray(raw.levels[1])) {
    malformed('malformed order book response')
  }
  const bids = levels(raw.levels[0]).sort((a, b) => b.price - a.price).slice(0, depth)
  const asks = levels(raw.levels[1]).sort((a, b) => a.price - b.price).slice(0, depth)
  return { instrumentId: instrumentIdOf(raw.coin), ts: raw.time, bids, asks }
}

/** candleSnapshot / candle 推送 → Candle[]，时间升序。 */
export function parseCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) malformed('malformed candle response')
  const out: Candle[] = []
  for (const row of raw) {
    if (!isObject(row) || typeof row.t !== 'number' || !Number.isInteger(row.t) || row.t < 0) continue
    const o = validNumeric(row.o), h = validNumeric(row.h), l = validNumeric(row.l), c = validNumeric(row.c), v = validNumeric(row.v)
    if (o === undefined || o <= 0 || h === undefined || h <= 0 || l === undefined || l <= 0 || c === undefined || c <= 0 || v === undefined || v < 0) continue
    out.push({ t: row.t, o, h, l, c, v })
  }
  return out.sort((a, b) => a.t - b.t)
}
