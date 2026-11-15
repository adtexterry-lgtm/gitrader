// SPDX-License-Identifier: CPAL-1.0
// Gate.io USDT 永续的请求预算（契约 §1.5.1 rateLimits）。
// 口径来源与取舍：
//   · 公共行情沿用数据包的 IP 口径：200 次 / 10 s（packages/connector-gateio-data/src/parse.ts:26-27
//     `IP_RATE_LIMIT` / `IP_RATE_WINDOW_MS`），行情与私有查询共用这一份窗口；
//   · Gate 官方按端点给私有接口限频，但**没有像币安那样的统一 weight 表**，所以这里不假装是官方权重：
//     查询类每请求记 1 个权重，下单 / 撤单 / 改单 / 杠杆另记一笔 `orders` 桶（缺省 10 次 / 秒）；
//   · 下单桶是 10 次 / 1 s 的滑动窗口，与查询窗口（10 s）分开；
//     这两个数字是本连接器的**本地自定上限**，不是场所承诺（README「限流」一节写明）；
//   · 目标 ≤ 60%：trade 可用满 target，query 只能用 50%，background 只能用 35%，交易动作永远留一半额度；
//   · 权重 0 的请求（下单类）**也走 acquire(0)**：429 退避期间不得绕过限流（工单教训 11）；
//   · 429 / 418 由 rest.ts 调 penalize(retryAfterMs) 整体退避。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'

export type BudgetKind = 'trade' | 'query' | 'background'

export interface AcquireOptions {
  priority?: 'high' | 'low'
  kind?: BudgetKind
  signal?: AbortSignal
  /** 下单 / 撤单 / 改单：权重要求和 counts 桶分开记。 */
  order?: boolean
}

export interface GateBudgetUsage extends BudgetUsage {
  byKind: Record<BudgetKind, number>
  orders: { lastSec: number; limit: number }
}

export interface GateBudget extends RateBudget {
  acquire(weight: number, opts?: AcquireOptions): Promise<void>
  charge(weight: number, kind?: BudgetKind): void
  usage(): GateBudgetUsage
  /** 记一笔下单类请求（place / cancel / cancel-all / amend / leverage）。 */
  noteOrder(count?: number): void
}

/** 公共行情 / 私有查询：200 次 / 10 s（数据包 IP 口径）。 */
export const GATE_QUERY_LIMIT = 200
export const GATE_QUERY_WINDOW_MS = 10_000
/** 下单类本地自定上限：10 次 / 1 s 的滑动窗口（本连接器自定，不是场所公布值）。 */
export const GATE_ORDER_LIMIT_PER_SEC = 10
/** 下单桶的窗口（与查询窗口 10 s 分开）。 */
export const GATE_ORDER_WINDOW_MS = 1_000
export const DEFAULT_TARGET_RATIO = 0.6
const BACKOFF_START_MS = 5_000
const BACKOFF_MAX_MS = 60_000

export interface WeightBudgetOptions {
  limit?: number
  targetRatio?: number
  windowMs?: number
  queryShare?: number
  backgroundShare?: number
  orderLimit?: number
  orderWindowMs?: number
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

export function createWeightBudget(opts: WeightBudgetOptions = {}): GateBudget {
  const limit = opts.limit ?? GATE_QUERY_LIMIT
  const target = Math.max(1, Math.floor(limit * (opts.targetRatio ?? DEFAULT_TARGET_RATIO)))
  const windowMs = opts.windowMs ?? GATE_QUERY_WINDOW_MS
  const orderLimit = opts.orderLimit ?? GATE_ORDER_LIMIT_PER_SEC
  const orderWindowMs = opts.orderWindowMs ?? GATE_ORDER_WINDOW_MS
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
    const orderCut = now - orderWindowMs
    if (orders.length > 0 && orders[0]! <= orderCut) orders = orders.filter((ts) => ts > orderCut)
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
        if (wait === 0 && o.order === true && orders.length >= orderLimit) {
          wait = orders[0]! + orderWindowMs - now + 1
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

/** 各端点消耗的权重（测试里逐项断言）。 */
export const GATE_WEIGHTS = {
  contracts: 1,
  contract: 1,
  ticker: 1,
  accounts: 1,
  positions: 1,
  openOrders: 1,
  orderDetail: 1,
  myTrades: 1,
  accountBook: 1,
  /** 下单 / 撤单 / 杠杆：0（另记 orders 桶，但走 acquire(0)）。 */
  order: 0,
  cancel: 0,
  amend: 0,
  setLeverage: 0,
} as const

/** 下单 / 撤单 / 改单：权重 0（但要走 acquire(0) 与 orders 桶）。 */
export function orderWeight(): number {
  return GATE_WEIGHTS.order
}
