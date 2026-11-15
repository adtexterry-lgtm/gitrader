// SPDX-License-Identifier: CPAL-1.0
// 交易日历 / 时钟（美股八条第 1 条：sessions 从场所接口取，不写死；节假日与提前收盘以接口为准）。
// 端点出处（Trading API v2 官方文档）：
//   · `GET /v2/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` → [{date, open, close, settlement_date}]
//   · `GET /v2/clock` → {timestamp, is_open, next_open, next_close}
// QD 未调用这两个端点（它的 sessions 需求不存在），所以「不写死」这条完全由本包把关：
// 日历拿不到就返回空日历，sessionStateAt 会把任何时刻判成休市（fail closed，不按「大概开着吧」下单）。
import type { Ms } from '@gitrader/protocol'
import type { AlpacaHttp } from './rest'
import { ALPACA_WEIGHTS } from './budget'
import { emptyCalendar, parseCalendar } from './sessions'
import type { TradingCalendar } from './sessions'
import { ProblemError, asProblem } from './errors'
import { isoOf } from './parse'

export interface MarketClockSnapshot {
  timestamp: Ms
  isOpen: boolean
  nextOpen: Ms | null
  nextClose: Ms | null
}

export class AlpacaCalendar {
  #calendar: TradingCalendar = emptyCalendar()
  #loadedAt: Ms = 0
  #clockSnapshot: MarketClockSnapshot | null = null
  readonly #now: () => number

  constructor(
    private readonly http: AlpacaHttp,
    private readonly ttlMs = 6 * 60 * 60_000,
    clock: () => number = () => Date.now(),
  ) {
    this.#now = clock
  }

  /** 当前快照（没拉过就是空日历 = 全休市）。 */
  get(): TradingCalendar {
    return this.#calendar
  }

  /** 拉一次日历（缺省回看 7 天、前瞻 14 天；覆盖下一交易日判断）。 */
  async load(opts: { start?: string; end?: string; signal?: AbortSignal } = {}): Promise<TradingCalendar> {
    const now = this.#now()
    const start = opts.start ?? isoOf(now - 7 * 86_400_000).slice(0, 10)
    const end = opts.end ?? isoOf(now + 14 * 86_400_000).slice(0, 10)
    try {
      const payload = await this.http.request<unknown>('GET', '/v2/calendar', {
        params: { start, end },
        weight: ALPACA_WEIGHTS.calendar,
        kind: 'query',
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      this.#calendar = parseCalendar(payload, undefined, now)
      this.#loadedAt = now
      return this.#calendar
    } catch (e) {
      // 宁可留空日历（全休市），也不编一个「应该开着」的日历。
      throw new ProblemError(asProblem(e, { secrets: this.http.secretsForRedaction(), endpoint: 'signed' }))
    }
  }

  loadedAt(): Ms {
    return this.#loadedAt
  }

  /** 日历是否过期（缺省 6 小时；缺省当前时刻走注入时钟）。 */
  stale(now: Ms = this.#now()): boolean {
    return this.#loadedAt === 0 || now - this.#loadedAt > this.ttlMs
  }

  /** `GET /v2/clock`：上游口径的「现在开没开」+ 下一个开 / 收盘（与本包的 sessions 互为校验）。 */
  async clock(signal?: AbortSignal): Promise<MarketClockSnapshot> {
    try {
      const payload = await this.http.request<unknown>('GET', '/v2/clock', {
        weight: ALPACA_WEIGHTS.clock,
        kind: 'query',
        ...(signal ? { signal } : {}),
      })
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('alpaca clock response is not an object')
      const row = payload as Record<string, unknown>
      const stamp = Date.parse(String(row['timestamp'] ?? ''))
      const nextOpen = Date.parse(String(row['next_open'] ?? ''))
      const nextClose = Date.parse(String(row['next_close'] ?? ''))
      const snapshot: MarketClockSnapshot = {
        timestamp: Number.isFinite(stamp) ? stamp : Date.now(),
        isOpen: row['is_open'] === true,
        nextOpen: Number.isFinite(nextOpen) ? nextOpen : null,
        nextClose: Number.isFinite(nextClose) ? nextClose : null,
      }
      this.#clockSnapshot = snapshot
      // 用上游时间重校时钟偏移（不用于鉴权，只用于时段 / 报价年龄判断）。
      this.http.resync(snapshot.timestamp)
      return snapshot
    } catch (e) {
      throw new ProblemError(asProblem(e, { secrets: this.http.secretsForRedaction(), endpoint: 'signed' }))
    }
  }

  lastClock(): MarketClockSnapshot | null {
    return this.#clockSnapshot
  }
}
