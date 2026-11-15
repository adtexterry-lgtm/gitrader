// SPDX-License-Identifier: CPAL-1.0
// OKX 的请求预算（契约 §1.5.1 rateLimits）。OKX 是**按端点计次**，不是权重：
//   · 交易类端点：60 次 / 2 s / 账户（单个 instId 再限 10 次 / 2 s）；
//   · 账户只读端点（balance / positions / config）：10 次 / 2 s / 账户；
//   · 公共行情端点：20 次 / 2 s / IP / 端点（与 connector-okx-data 的 IP_RATE_LIMIT 同口径）。
// 本类按「一次调用 = 一个额度」记账（与权重制同形：weight 恒为 1），分三档用途配额：
// trade 可用满 target，query 只能用 50%，background 只能用 35% —— 交易动作永远留着至少一半配额。
// 429 / 50011 让整份预算退避到 Retry-After（退避期间 acquire 会等，不抛错）。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'

export type BudgetKind = 'trade' | 'query' | 'background'

export interface OkxBudgetUsage extends BudgetUsage {
  byKind: Record<BudgetKind, number>
  orders: { last2s: number; last1min: number }
}

/** 预算对象的扩展面：协议 RateBudget + 场所口径校正 + 下单计数。 */
export interface OkxBudget extends RateBudget {
  acquire(weight: number, opts?: { priority?: 'high' | 'low'; kind?: BudgetKind; signal?: AbortSignal }): Promise<void>
  charge(weight: number, kind?: BudgetKind): void
  usage(): OkxBudgetUsage
  /** 记一笔下单（OKX 下单也计次，与查询同一窗口口径）。 */
  noteOrder(count?: number): void
}

export interface CountBudgetOptions {
  limit?: number
  targetRatio?: number
  windowMs?: number
  queryShare?: number
  backgroundShare?: number
  clock?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** 交易类端点：60 次 / 2 s / 账户。 */
export const OKX_TRADE_LIMIT = 60
export const OKX_TRADE_WINDOW_MS = 2_000
/** 单个 instId 的下单上限：10 次 / 2 s。 */
export const OKX_ORDER_LIMIT_PER_INSTRUMENT = 10
/** 账户只读端点：10 次 / 2 s。 */
export const OKX_ACCOUNT_READ_LIMIT = 10
export const DEFAULT_TARGET_RATIO = 0.6
const BACKOFF_START_MS = 2_000
const BACKOFF_MAX_MS = 60_000

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

export function createCountBudget(opts: CountBudgetOptions = {}): OkxBudget {
  const limit = opts.limit ?? OKX_TRADE_LIMIT
  const target = Math.floor(limit * (opts.targetRatio ?? DEFAULT_TARGET_RATIO))
  const windowMs = opts.windowMs ?? OKX_TRADE_WINDOW_MS
  const caps: Record<BudgetKind, number> = {
    trade: target,
    query: Math.floor(target * (opts.queryShare ?? 0.5) + 1e-9),
    background: Math.floor(target * (opts.backgroundShare ?? 0.35) + 1e-9),
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
    const orderCut = now - 60_000
    if (orders.length > 0 && orders[0]! <= orderCut) orders = orders.filter((ts) => ts > orderCut)
  }
  const used = (): number => events.reduce((sum, e) => sum + e.w, 0)

  return {
    async acquire(weight, o = {}) {
      const kind: BudgetKind = o.kind ?? (o.priority === 'low' ? 'query' : 'trade')
      const cap = caps[kind]
      for (;;) {
        const now = clock()
        purge(now)
        let wait = Math.max(0, backoffUntil - now)
        if (wait === 0) {
          const u = used()
          if (u + weight <= cap || u === 0) {
            events.push({ ts: now, w: weight, k: kind })
            return
          }
          let acc = u
          for (const e of events) {
            acc -= e.w
            if (acc + weight <= cap) {
              wait = e.ts + windowMs - now + 1
              break
            }
          }
          if (wait <= 0) wait = windowMs
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
        orders: {
          last2s: orders.filter((ts) => ts > now - windowMs).length,
          last1min: orders.length,
        },
      }
    },
  }
}

/** 各端点的计次（OKX 官方口径；测试里逐项断言）。一次调用 = 1。 */
export const OKX_ENDPOINT_COSTS = {
  publicTime: 1,
  instruments: 1,
  ticker: 1,
  accountBalance: 1,
  accountPositions: 1,
  accountConfig: 1,
  leverageInfo: 1,
  setLeverage: 1,
  ordersPending: 1,
  ordersAlgoPending: 1,
  orderQuery: 1,
  fills: 1,
  order: 1,
  orderAlgo: 1,
  cancelOrder: 1,
  cancelBatch: 1,
  cancelAlgos: 1,
  amendOrder: 1,
  cancelAllAfter: 1,
} as const

/** 下单计次（与查询同一窗口，但单独记一笔，供 usage().orders 观察）。 */
export function orderCost(): number {
  return OKX_ENDPOINT_COSTS.order
}
