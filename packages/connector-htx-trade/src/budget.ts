// SPDX-License-Identifier: CPAL-1.0
// HTX 私有接口的请求预算（契约 §1.5.1 rateLimits）。
//   · HTX 的私有接口**按 UID 计数**（官方《接口频率限制》），下单 / 撤单 与查询类分开计数；
//     本包默认下单类 10 次/秒、查询类 20 次/秒、公共行情 20 次/秒 —— 这三个数是**可覆盖的缺省值**：
//     场所调整频率时由内核注入 budget（同机多连接共用一份），代码里不写死期望；
//   · 按用途分三档（照 Hyperliquid / Bybit 包 budget.ts）：trade 可用满 target，query 只用 50%，
//     background 只用 35%，所以交易动作永远留着至少一半配额；
//   · 下单 / 撤单在 HTX 是独立计数桶：本类只记账（noteOrder）不做阻塞，阻塞策略留给内核；
//   · 权重为 0 的请求也要走 acquire(0)：429 / 418 退避期间不得绕过限流（acquire 会先等 backoff）。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'

export type BudgetKind = 'trade' | 'query' | 'background'

export interface HtxBudgetUsage extends BudgetUsage {
  byKind: Record<BudgetKind, number>
  orders: { last1s: number; last5s: number }
}

/** 预算对象的扩展面：协议 RateBudget + 场所口径校正 + 下单计数。 */
export interface HtxBudget extends RateBudget {
  acquire(weight: number, opts?: { priority?: 'high' | 'low'; kind?: BudgetKind; signal?: AbortSignal }): Promise<void>
  charge(weight: number, kind?: BudgetKind): void
  usage(): HtxBudgetUsage
  /** 记一笔下单 / 撤单 / 改单（HTX 下单类接口独立计数）。 */
  noteOrder(count?: number): void
}

export interface WeightBudgetOptions {
  limit?: number
  targetRatio?: number
  windowMs?: number
  queryShare?: number
  backgroundShare?: number
  clock?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** 缺省：下单类私有接口 10 次/秒（官方下单频率档；可由构造参数 / 内核注入覆盖）。 */
export const HTX_ORDER_LIMIT_PER_SEC = 10
/** 缺省：其余私有查询 20 次/秒。 */
export const HTX_QUERY_LIMIT_PER_SEC = 20
/** 缺省窗口：1 秒。 */
export const HTX_RATE_WINDOW_MS = 1_000
export const DEFAULT_TARGET_RATIO = 0.6
const BACKOFF_START_MS = 5_000
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

export function createWeightBudget(opts: WeightBudgetOptions = {}): HtxBudget {
  const limit = opts.limit ?? HTX_QUERY_LIMIT_PER_SEC
  const target = Math.floor(limit * (opts.targetRatio ?? DEFAULT_TARGET_RATIO))
  const windowMs = opts.windowMs ?? HTX_RATE_WINDOW_MS
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
    const orderCut = now - 5_000
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
          // 最早在哪个时刻，老的额度滚出窗口后能放下这一笔
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
        backoffUntil: backoffUntil > now ? backoffUntil : now,
        byKind,
        orders: {
          last1s: orders.filter((ts) => ts > now - 1_000).length,
          last5s: orders.length,
        },
      }
    },
  }
}

/** 各端点的请求权重（HTX 按「次数」计：每次请求记 1；下单类另记独立计数桶）。 */
export const HTX_WEIGHTS = {
  balance: 1,
  positions: 1,
  openOrders: 1,
  orderInfo: 1,
  matchResults: 1,
  setLeverage: 1,
  tpsl: 1,
  contracts: 1,
  /** 下单 / 撤单 / 全撤：另计下单计数桶。 */
  order: 0,
} as const

/** 下单 / 撤单 / 改单：权重 0 + 记一笔下单计数。 */
export function orderWeight(): number {
  return HTX_WEIGHTS.order
}
