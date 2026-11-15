// SPDX-License-Identifier: CPAL-1.0
// Bitget v2 mix 的请求频率预算（契约 §1.5.1 rateLimits）。
//   · Bitget 不是「权重」模型，而是**按端点的每秒次数**：私有下单类 10 次 / 秒 / UID（官方 place-order 限频），
//     查询类 20 次 / 秒 / UID，公共行情 20 次 / 秒 / IP（数据包 IP_RATE_LIMIT 同口径，见 parse.ts:27-28）；
//   · 本连接器目标 ≤ 60%：查询 12 / 秒，下单 6 / 秒；按用途分三档（照 Hyperliquid 包 budget.ts）：
//     trade 可用满 target，query 只能用 50%，background 只能用 35%，交易动作永远留一半配额；
//   · 下单 / 撤单 / 改单在 Bitget 不消耗查询配额（weight = 0），但**仍然走 acquire(0)**：429 退避期间不得绕过限流，
//     并且另记一笔下单计数（orders 桶，10 / 秒）；
//   · 429 / 418 由 rest.ts 调 penalize(retryAfterMs) 整体退避。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'

export type BudgetKind = 'trade' | 'query' | 'background'

export interface AcquireOptions {
  priority?: 'high' | 'low'
  kind?: BudgetKind
  signal?: AbortSignal
  /** 下单 / 撤单 / 改单：weight 为 0，但要走下单计数桶（10 / 秒）。 */
  order?: boolean
}

export interface BitgetBudgetUsage extends BudgetUsage {
  byKind: Record<BudgetKind, number>
  orders: { lastSec: number; limit: number }
}

export interface BitgetBudget extends RateBudget {
  acquire(weight: number, opts?: AcquireOptions): Promise<void>
  charge(weight: number, kind?: BudgetKind): void
  usage(): BitgetBudgetUsage
  /** 记一笔下单类请求（place / cancel / modify / cancel-all）。 */
  noteOrder(count?: number): void
}

/** 公共行情与查询类：20 次 / 秒。 */
export const BITGET_QUERY_LIMIT_PER_SEC = 20
/** 下单 / 撤单 / 改单：10 次 / 秒 / UID（官方 place-order 限频口径）。 */
export const BITGET_ORDER_LIMIT_PER_SEC = 10
export const DEFAULT_TARGET_RATIO = 0.6
const BACKOFF_START_MS = 5_000
const BACKOFF_MAX_MS = 60_000

export interface CountBudgetOptions {
  limit?: number
  targetRatio?: number
  windowMs?: number
  queryShare?: number
  backgroundShare?: number
  orderLimit?: number
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

export function createCountBudget(opts: CountBudgetOptions = {}): BitgetBudget {
  const limit = opts.limit ?? BITGET_QUERY_LIMIT_PER_SEC
  const target = Math.max(1, Math.floor(limit * (opts.targetRatio ?? DEFAULT_TARGET_RATIO)))
  const windowMs = opts.windowMs ?? 1_000
  const orderLimit = opts.orderLimit ?? BITGET_ORDER_LIMIT_PER_SEC
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
        // 不占查询配额的下单类请求也要排队：orders 桶 10 / 秒
        if (wait === 0 && o.order === true && orders.length >= orderLimit) {
          wait = orders[0]! + windowMs - now + 1
        }
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
        orders: { lastSec: orders.length, limit: orderLimit },
      }
    },
  }
}

/** 各端点消耗的查询配额（Bitget 是次数模型：查询 1，下单类 0 + 独立计数桶）。测试里逐项断言。 */
export const BITGET_WEIGHTS = {
  contracts: 1,
  ticker: 1,
  depth: 1,
  candles: 1,
  fundingRate: 1,
  accounts: 1,
  account: 1,
  positions: 1,
  ordersPending: 1,
  ordersPlanPending: 1,
  detail: 1,
  fills: 1,
  tradeRate: 1,
  /** 下单 / 撤单 / 改单 / 全撤：0（另记下单计数桶）。 */
  order: 0,
  cancel: 0,
  amend: 0,
  cancelAll: 0,
  setLeverage: 1,
} as const

/** 下单 / 撤单 / 改单：权重 0（但要走 acquire(0) 与下单计数桶）。 */
export function orderWeight(): number {
  return BITGET_WEIGHTS.order
}
