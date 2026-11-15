// SPDX-License-Identifier: CPAL-1.0
// Alpaca Trading API 的请求预算（契约 §1.5.1 rateLimits）。
//   · Alpaca 按**每分钟请求数**限流（官方 rate limit：每账户 200 次 / 分钟），不是权重模型；
//   · 本连接器目标 ≤ 60%（120 次 / 分钟），按用途分三档（照 Hyperliquid 包 budget.ts）：
//     trade 可用满 target，query 只用 50%，background（行情参考价）只用 35%，交易动作永远留一半配额；
//   · 下单 / 撤单 / 改单 / 全撤在 Alpaca 与查询共用同一个请求额度，按 1 次请求计入并另记下单计数：
//     429 退避期间不得绕过限流（教训 11）；
//   · 429 由 rest.ts 调 penalize(retryAfterMs) 整体退避。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'
import { REQUESTS_PER_MINUTE, TARGET_RATIO } from './constants'

export type BudgetKind = 'trade' | 'query' | 'background'

export interface AcquireOptions {
  priority?: 'high' | 'low'
  kind?: BudgetKind
  signal?: AbortSignal
  /** 下单 / 撤单 / 改单 / 全撤：按 1 次请求计额度，并另记一笔下单计数。 */
  order?: boolean
}

export interface AlpacaBudgetUsage extends BudgetUsage {
  byKind: Record<BudgetKind, number>
  orders: { lastMinute: number }
}

export interface AlpacaBudget extends RateBudget {
  acquire(weight: number, opts?: AcquireOptions): Promise<void>
  charge(weight: number, kind?: BudgetKind): void
  usage(): AlpacaBudgetUsage
  /** 记一笔下单类请求（POST / PATCH / DELETE orders*）。 */
  noteOrder(count?: number): void
}

const WINDOW_MS = 60_000
const BACKOFF_START_MS = 5_000
const BACKOFF_MAX_MS = 60_000

export interface CountBudgetOptions {
  limit?: number
  targetRatio?: number
  windowMs?: number
  queryShare?: number
  backgroundShare?: number
  clock?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createAlpacaBudget(opts: CountBudgetOptions = {}): AlpacaBudget {
  const limit = opts.limit ?? REQUESTS_PER_MINUTE
  const target = Math.max(1, Math.floor(limit * (opts.targetRatio ?? TARGET_RATIO)))
  const windowMs = opts.windowMs ?? WINDOW_MS
  const caps: Record<BudgetKind, number> = {
    trade: target,
    query: Math.max(1, Math.floor(target * (opts.queryShare ?? 0.5) + 1e-9)),
    background: Math.max(1, Math.floor(target * (opts.backgroundShare ?? 0.35) + 1e-9)),
  }
  const clock = opts.clock ?? (() => Date.now())
  const sleep = opts.sleep ?? defaultSleep
  let events: Array<{ ts: number; w: number; k: BudgetKind }> = []
  let orders: number[] = []
  let backoffUntil = 0
  let backoffMs = 0

  const purge = (now: number): void => {
    const cut = now - windowMs
    if (events.length > 0 && events[0]!.ts <= cut) events = events.filter((e) => e.ts > cut)
    if (orders.length > 0 && orders[0]! <= cut) orders = orders.filter((ts) => ts > cut)
  }
  const used = (): number => events.reduce((sum, e) => sum + e.w, 0)

  const waitFor = (cap: number, weight: number): number => {
    const u = used()
    if (u + weight <= cap || u === 0) return 0
    let acc = u
    for (const e of events) {
      acc -= e.w
      if (acc + weight <= cap) return e.ts + windowMs - clock() + 1
    }
    return windowMs
  }

  return {
    async acquire(weight, o = {}) {
      const kind: BudgetKind = o.kind ?? (o.priority === 'low' ? 'query' : 'trade')
      const cap = caps[kind]
      for (;;) {
        const now = clock()
        purge(now)
        let wait = Math.max(0, backoffUntil - now)
        if (wait === 0) wait = waitFor(cap, weight)
        if (wait <= 0) {
          events.push({ ts: now, w: weight, k: kind })
          if (o.order === true) orders.push(now)
          return
        }
        await sleep(wait, o.signal)
      }
    },
    charge(weight, kind = 'query') {
      const now = clock()
      purge(now)
      events.push({ ts: now, w: weight, k: kind })
    },
    penalize(retryAfterMs) {
      backoffMs = retryAfterMs ?? Math.min(BACKOFF_MAX_MS, backoffMs > 0 ? backoffMs * 2 : BACKOFF_START_MS)
      backoffUntil = Math.max(backoffUntil, clock() + backoffMs)
    },
    reportOk() {
      if (clock() >= backoffUntil) backoffMs = 0
    },
    noteOrder(count = 1) {
      const now = clock()
      purge(now)
      for (let i = 0; i < count; i++) orders.push(now)
    },
    usage() {
      const now = clock()
      purge(now)
      const u = used()
      const byKind: Record<BudgetKind, number> = { trade: 0, query: 0, background: 0 }
      for (const e of events) byKind[e.k] += e.w
      return {
        used: u,
        target,
        limit,
        ratio: u / limit,
        windowMs,
        backoffUntil: backoffUntil > now ? backoffUntil : 0,
        byKind,
        orders: { lastMinute: orders.length },
      }
    },
  }
}

/** 各端点消耗的请求数（Alpaca 是次数模型：每次请求 1；下单类另记下单计数）。测试逐项断言。 */
export const ALPACA_WEIGHTS = {
  account: 1,
  positions: 1,
  openOrders: 1,
  orderById: 1,
  orderByClientId: 1,
  activities: 1,
  calendar: 1,
  clock: 1,
  asset: 1,
  watchlist: 1,
  /** 交易动作：与查询共用额度，但另记下单计数。 */
  order: 1,
  cancel: 1,
  cancelAll: 1,
  amend: 1,
} as const

/** 下单类请求的权重（Alpaca 计 1 次请求；会同时 noteOrder）。 */
export function orderWeight(): number {
  return ALPACA_WEIGHTS.order
}
