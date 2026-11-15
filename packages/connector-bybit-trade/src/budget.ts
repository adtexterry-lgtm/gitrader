// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 的请求预算（契约 §1.5.1 rateLimits）。
//   · 官方按 UID 计：多数端点 600 次 / 5 秒（本连接器目标 ≤ 60% = 360），公共行情另按 IP 120 次 / 5 秒
//     （行情走 packages/connector-bybit-data，它的预算对象独立）；
//   · 按用途分三档（照 Hyperliquid / Binance 包 budget.ts）：trade 可用满 target，query 只能用 50%，
//     background 只能用 35%，所以交易动作永远留着至少一半配额；
//   · 下单 / 撤单 / 改单在 Bybit 是**独立计数桶**（10 次 / 秒 / UID）：本类只记账（noteOrder）不做阻塞，
//     限速策略留给内核统一执行；usage() 里能看到最近 1 s / 5 s 的已用下单数；
//   · 权重为 0 的请求也要走 acquire(0)：429 / 418 退避期间不得绕过限流（acquire 会先等 backoff）。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'

export type BudgetKind = 'trade' | 'query' | 'background'

export interface BybitBudgetUsage extends BudgetUsage {
  byKind: Record<BudgetKind, number>
  orders: { last1s: number; last5s: number }
}

/** 预算对象的扩展面：协议 RateBudget + 场所口径校正 + 下单计数。 */
export interface BybitBudget extends RateBudget {
  acquire(weight: number, opts?: { priority?: 'high' | 'low'; kind?: BudgetKind; signal?: AbortSignal }): Promise<void>
  charge(weight: number, kind?: BudgetKind): void
  usage(): BybitBudgetUsage
  /** 用 X-Bapi-Limit-Status 校正窗口内已用次数（只补差额，不抹掉已记账）。 */
  reconcile(used: number): void
  /** 记一笔下单 / 撤单 / 改单（Bybit 这些端点权重记 0，但计入独立的下单计数桶）。 */
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

/** 每 UID 每 5 秒 600 次（官方口径，多数私有端点）。 */
export const BYBIT_RATE_LIMIT = 600
export const BYBIT_RATE_WINDOW_MS = 5_000
export const DEFAULT_TARGET_RATIO = 0.6
/** 下单 / 撤单 / 改单：10 次 / 秒 / UID（官方 v5 口径）。 */
export const ORDER_LIMIT_PER_SEC = 10
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

export function createWeightBudget(opts: WeightBudgetOptions = {}): BybitBudget {
  const limit = opts.limit ?? BYBIT_RATE_LIMIT
  const target = Math.floor(limit * (opts.targetRatio ?? DEFAULT_TARGET_RATIO))
  const windowMs = opts.windowMs ?? BYBIT_RATE_WINDOW_MS
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
    reconcile(usedCount) {
      if (!Number.isFinite(usedCount) || usedCount <= 0) return
      const now = clock()
      purge(now)
      const delta = usedCount - used()
      if (delta > 0) events.push({ ts: now, w: delta, k: 'trade' })
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

/** 各端点的请求权重（Bybit v5：GET 记 1；下单 / 撤单 / 改单记 0 并另计下单桶）。 */
export const BYBIT_WEIGHTS = {
  walletBalance: 1,
  positionList: 1,
  executionList: 1,
  orderRealtime: 1,
  orderHistory: 1,
  setLeverage: 1,
  setMarginMode: 1,
  tradingStop: 1,
  /** 下单 / 撤单 / 全撤 / 改单：权重 0，另计下单计数桶。 */
  order: 0,
} as const

/** 下单 / 撤单 / 改单：权重 0 + 记一笔下单计数。 */
export function orderWeight(): number {
  return BYBIT_WEIGHTS.order
}
