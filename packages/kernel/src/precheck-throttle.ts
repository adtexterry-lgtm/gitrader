// SPDX-License-Identifier: CPAL-1.0
// 预览预检落账限量：每个主体每个整分钟窗口前 N 条逐条写，超出的只计数并在窗口结束时写一条汇总；
// 每个本地日结束时写一条日汇总（仅当天发生过汇总时写）。本文件只做计数与决定，落账由调用方注入 write。

export interface PrecheckSummaryNote {
  kind: 'precheck.summary'; actor: string; windowStart: number; windowEnd: number; count: number
  ruleHits: Record<string, number>; samplePrecheckIds: string[]
}
export interface PrecheckDailyNote {
  kind: 'precheck.daily'; actor: string; day: string; individual: number; summarized: number; ruleHits: Record<string, number>
}
export type PrecheckNote = PrecheckSummaryNote | PrecheckDailyNote
export interface PrecheckThrottleOptions {
  perMinute?: number                 // 默认 20
  now: () => number                  // 毫秒
  dayOf?: (ms: number) => string     // 默认本地日期 'YYYY-MM-DD'：new Date(ms) 的 getFullYear()、getMonth()+1、getDate()，月日两位补零
  write: (note: PrecheckNote) => void
}

interface WindowState {
  windowStart: number
  windowEnd: number
  individual: number
  overflow: number
  ruleHits: Record<string, number>
  samples: string[]
}

interface DayState {
  day: string
  individual: number
  summarized: number
  ruleHits: Record<string, number>
}

const MINUTE_MS = 60_000

function defaultDayOf(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function bump(hits: Record<string, number>, codes: readonly string[]): void {
  for (const code of codes) hits[code] = (hits[code] ?? 0) + 1
}

export class PrecheckThrottle {
  private readonly perMinute: number
  private readonly now: () => number
  private readonly dayOf: (ms: number) => string
  private readonly write: (note: PrecheckNote) => void
  private readonly windows = new Map<string, WindowState>()
  private readonly days = new Map<string, DayState>()

  constructor(opts: PrecheckThrottleOptions) {
    this.perMinute = opts.perMinute ?? 20
    this.now = opts.now
    this.dayOf = opts.dayOf ?? defaultDayOf
    this.write = opts.write
  }

  /** true = 调用方照常逐条写账本；false = 已计入汇总，调用方不要写。ruleCodes = 这次预检命中的规则码（可为空数组）。 */
  admit(actor: string, ruleCodes: readonly string[], precheckId: string): boolean {
    this.flush(false)

    const at = this.now()
    let win = this.windows.get(actor)
    if (!win) {
      const windowStart = Math.floor(at / MINUTE_MS) * MINUTE_MS
      win = { windowStart, windowEnd: windowStart + MINUTE_MS, individual: 0, overflow: 0, ruleHits: {}, samples: [] }
      this.windows.set(actor, win)
    }
    let daily = this.days.get(actor)
    if (!daily) {
      daily = { day: this.dayOf(at), individual: 0, summarized: 0, ruleHits: {} }
      this.days.set(actor, daily)
    }

    if (win.individual < this.perMinute) {
      win.individual++
      daily.individual++
      bump(daily.ruleHits, ruleCodes)
      return true
    }

    win.overflow++
    bump(win.ruleHits, ruleCodes)
    if (win.samples.length < 3) win.samples.push(precheckId)
    daily.summarized++
    bump(daily.ruleHits, ruleCodes)
    return false
  }

  /** 结算已结束的分钟窗口与本地日；force = 全部结算（关机时用）。 */
  flush(force = false): void {
    const at = this.now()

    for (const [actor, win] of this.windows) {
      if (force || at >= win.windowEnd) {
        if (win.overflow > 0) {
          try {
            this.write({
              kind: 'precheck.summary',
              actor,
              windowStart: win.windowStart,
              windowEnd: win.windowEnd,
              count: win.overflow,
              ruleHits: win.ruleHits,
              samplePrecheckIds: win.samples,
            })
          } catch {
            // 落账失败不影响计数状态清理。
          }
        }
        this.windows.delete(actor)
      }
    }

    const today = this.dayOf(at)
    for (const [actor, daily] of this.days) {
      if (force || today !== daily.day) {
        if (daily.summarized > 0) {
          try {
            this.write({
              kind: 'precheck.daily',
              actor,
              day: daily.day,
              individual: daily.individual,
              summarized: daily.summarized,
              ruleHits: daily.ruleHits,
            })
          } catch {
            // 落账失败不影响计数状态清理。
          }
        }
        this.days.delete(actor)
      }
    }
  }
}
