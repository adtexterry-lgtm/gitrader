// SPDX-License-Identifier: CPAL-1.0
// 标的目录：`GET /v2/assets/{symbol}`（单张）+ `GET /v2/assets?status=active&asset_class=us_equity`（列表）。
// 目的只有一个：下单前拿到 fractionable / shortable / borrow_status / price_increment（美股八条第 4、5 条）。
// 缓存带 TTL（缺省 10 分钟）：资产属性是慢变量，但不是不变（停牌 / 暂停融券会发生），所以 TTL 到期重取。
import type { Instrument, Ms } from '@gitrader/protocol'
import type { AssetRecord } from './assets'
import { parseAsset, parseAssetList, symbolOf } from './assets'
import { VENUE } from './constants'
import { ProblemError, asProblem } from './errors'
import type { AlpacaHttp } from './rest'
import { ALPACA_WEIGHTS } from './budget'
import { emptyCalendar } from './sessions'
import type { TradingCalendar } from './sessions'

export interface AlpacaAssetsOptions {
  /** 缓存时长（毫秒），缺省 10 分钟。 */
  ttlMs?: number
  /** 交易日历来源（生成 sessions）；缺省空日历（＝任何时刻都按休市处理）。 */
  calendar?: () => TradingCalendar
  clock?: () => number
}

export class AlpacaAssets {
  readonly #cache = new Map<string, { record: AssetRecord; at: Ms }>()
  readonly #ttl: number
  readonly #calendar: () => TradingCalendar
  readonly #clock: () => number

  constructor(private readonly http: AlpacaHttp, opts: AlpacaAssetsOptions = {}) {
    this.#ttl = opts.ttlMs ?? 10 * 60_000
    this.#calendar = opts.calendar ?? (() => emptyCalendar())
    this.#clock = opts.clock ?? (() => Date.now())
  }

  /** 同步读缓存（不联网）；没有就 undefined。 */
  get(instrumentId: string): AssetRecord | undefined {
    let symbol: string
    try {
      symbol = symbolOf(instrumentId)
    } catch {
      return undefined
    }
    const hit = this.#cache.get(symbol)
    if (hit === undefined) return undefined
    if (this.#clock() - hit.at > this.#ttl) return undefined
    return hit.record
  }

  /** 缓存里的全部标的（`listInstruments` 用；不联网，只有已经取过的）。 */
  list(): AssetRecord[] {
    const now = this.#clock()
    const out: AssetRecord[] = []
    for (const [, entry] of this.#cache) if (now - entry.at <= this.#ttl) out.push(entry.record)
    return out
  }

  /** 强制刷新一张（下单前要最新属性时用）。 */
  async refresh(instrumentId: string, opts: { signal?: AbortSignal } = {}): Promise<AssetRecord> {
    return this.fetch(symbolOf(instrumentId), opts)
  }

  /** 取一张（缓存命中直接返回；未命中 / 过期的联网取）。 */
  async ensure(instrumentId: string, opts: { signal?: AbortSignal } = {}): Promise<AssetRecord> {
    const hit = this.get(instrumentId)
    if (hit !== undefined) return hit
    return this.fetch(symbolOf(instrumentId), opts)
  }

  /** 批量载入（`GET /v2/assets`）；单行坏了跳过（列表容忍）。 */
  async loadAll(opts: { signal?: AbortSignal } = {}): Promise<AssetRecord[]> {
    let payload: unknown
    try {
      payload = await this.http.request<unknown>('GET', '/v2/assets', {
        params: { status: 'active', asset_class: 'us_equity' },
        weight: ALPACA_WEIGHTS.asset,
        kind: 'query',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.http.secretsForRedaction(), endpoint: 'signed' }))
    }
    const records = parseAssetList(payload, { calendar: this.#calendar(), now: this.#clock() })
    const now = this.#clock()
    for (const record of records) this.#cache.set(record.symbol, { record, at: now })
    return records
  }

  private async fetch(symbol: string, opts: { signal?: AbortSignal } = {}): Promise<AssetRecord> {
    let payload: unknown
    try {
      payload = await this.http.request<unknown>('GET', `/v2/assets/${encodeURIComponent(symbol)}`, {
        weight: ALPACA_WEIGHTS.asset,
        kind: 'query',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.http.secretsForRedaction(), endpoint: 'signed' }))
    }
    let record: AssetRecord
    try {
      record = parseAsset(payload, { calendar: this.#calendar(), now: this.#clock() })
    } catch (e) {
      throw new ProblemError({
        code: 1001,
        name: 'INSTRUMENT_UNKNOWN',
        category: 'REJECTED',
        message: e instanceof Error ? e.message : String(e),
        retryable: false,
        venue: { id: VENUE, message: e instanceof Error ? e.message : String(e) },
      })
    }
    this.#cache.set(record.symbol, { record, at: this.#clock() })
    return record
  }

  /** 包成协议 Instrument（`getInstrument` 用）。 */
  instrument(instrumentId: string): Instrument | undefined {
    return this.get(instrumentId)?.instrument
  }

  /** 诊断：清空缓存。 */
  clear(): void {
    this.#cache.clear()
  }
}
