// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 的请求权重预算（契约 §1.5.1 rateLimits）。
//   · 官方按 IP 计权重：2400 / 分钟（数据包 IP_WEIGHT_LIMIT 同口径）；本连接器目标 ≤ 60% = 1440；
//   · 按用途分三档（照 Hyperliquid 包 budget.ts）：trade 可用满 target，query 只能用 50%，background 只能用 35%，
//     所以交易动作永远留着至少一半配额；
//   · 额外账目：Binance 下单是独立计数桶（10 s / 300、1 min / 1200）。本类只记账（noteOrder）不做阻塞，
//     限速策略留给内核统一执行；usage() 里能看到两个窗口的已用下单数；
//   · X-MBX-USED-WEIGHT-1M 响应头回到 rest.ts → reconcile() 用场所口径校正本地账本（只向上补，不抹掉已记账）。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'

export type BudgetKind = 'trade' | 'query' | 'background'

export interface BinanceBudgetUsage extends BudgetUsage {
  byKind: Record<BudgetKind, number>
  orders: { last10s: number; last1min: number }
}

/** 预算对象的扩展面：协议 RateBudget + 场所口径校正 + 下单计数。 */
export interface BinanceBudget extends RateBudget {
  acquire(weight: number, opts?: { priority?: 'high' | 'low'; kind?: BudgetKind; signal?: AbortSignal }): Promise<void>
  charge(weight: number, kind?: BudgetKind): void
  usage(): BinanceBudgetUsage
  /** 用 X-MBX-USED-WEIGHT-1M 校正窗口内已用权重（只补差额）。 */
  reconcile(usedWeight: number): void
  /** 记一笔下单（Binance 下单请求权重为 0，但计入独立的下单计数桶）。 */
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

export const BINANCE_WEIGHT_LIMIT_PER_MIN = 2_400
export const DEFAULT_TARGET_RATIO = 0.6
export const ORDER_LIMIT_PER_10S = 300
export const ORDER_LIMIT_PER_MIN = 1_200
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

export function createWeightBudget(opts: WeightBudgetOptions = {}): BinanceBudget {
  const limit = opts.limit ?? BINANCE_WEIGHT_LIMIT_PER_MIN
  const target = Math.floor(limit * (opts.targetRatio ?? DEFAULT_TARGET_RATIO))
  const windowMs = opts.windowMs ?? 60_000
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
          // 最早在哪个时刻，老的权重滚出窗口后能放下这一笔
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
    reconcile(usedWeight) {
      if (!Number.isFinite(usedWeight) || usedWeight <= 0) return
      const now = clock()
      purge(now)
      const delta = usedWeight - used()
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
        backoffUntil: backoffUntil > now ? backoffUntil : 0,
        byKind,
        orders: {
          last10s: orders.filter((ts) => ts > now - 10_000).length,
          last1min: orders.length,
        },
      }
    },
  }
}

/** 各端点的请求权重（Binance USDⓈ-M 官方口径；测试里逐项断言）。 */
export const BINANCE_WEIGHTS = {
  exchangeInfo: 1,
  time: 1,
  premiumIndex: 1,
  bookTicker: 2,
  openOrdersWithSymbol: 1,
  openOrdersAllSymbols: 40,
  orderQuery: 1,
  account: 5,
  positionRisk: 5,
  userTrades: 5,
  leverage: 1,
  marginType: 1,
  cancelAll: 1,
  listenKey: 1,
  /** 下单 / 撤单 / 改单的请求权重按官方是 0，另计下单计数桶。 */
  order: 0,
  /** algo 单（触发 / 保护单）的端点权重。 */
  algoOrder: 0,
  algoOrderQuery: 1,
  openAlgoOrders: 1,
  algoOpenOrders: 1,
} as const

/** 下单 / 撤单 / 改单：权重 0 + 记一笔下单计数。 */
export function orderWeight(): number {
  return BINANCE_WEIGHTS.order
}
