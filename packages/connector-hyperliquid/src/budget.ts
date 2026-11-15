// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid 按 IP 的 REST 聚合权重预算：1200 / 分钟（知识库「API_info与exchange要点_速率限制」）。
// 预算对象由内核注入（同一台机器上所有连接共用一个），这里给默认实现：滚动窗口权重账本。
//   · 任意连续 60 s 内已批准的权重总和 ≤ target（默认 1200 × 60% = 720），所以占用比例有硬上限；
//   · 按用途分三档：交易动作（trade）可用满 target；用户查询（query）只能用 target 的 50%；后台（background：发现、历史 K 线、轮询兜底）只能用 35%——
//     所以不管查询多猛，交易动作永远至少保留 50% 的配额；（旧的 priority: low 等价于 query，high 等价于 trade）
//   · 收到 429 后整体退避（5 s 起翻倍，封顶 60 s）。

/** 权重用途：trade = 下单 / 撤单 / 改单等交易动作；query = 用户触发的查询；background = 后台任务。 */
export type BudgetKind = 'trade' | 'query' | 'background'

export interface BudgetUsage {
  /** 窗口内已批准的权重。 */
  used: number
  /** 目标上限（limit × targetRatio）。 */
  target: number
  /** 场所硬上限（1200）。 */
  limit: number
  /** used / limit：对外公布的「HL 权重占用」。 */
  ratio: number
  windowMs: number
  /** 退避截止时刻（ms，0 = 无退避）。 */
  backoffUntil: number
  /** 窗口内按用途分的已批准权重。 */
  byKind: Record<BudgetKind, number>
}

export interface RateBudget {
  /** 等到预算够用再返回；预算由调用方在返回后立即视为已花掉。 */
  acquire(weight: number, opts?: { priority?: 'high' | 'low'; kind?: BudgetKind; signal?: AbortSignal }): Promise<void>
  /** 事后补记权重（例如按返回条数追加的权重），不等待。 */
  charge(weight: number, kind?: BudgetKind): void
  /** 收到 429：整体退避。 */
  penalize(retryAfterMs?: number): void
  /** 一次成功响应：清零连续退避计数。 */
  reportOk(): void
  usage(): BudgetUsage
}

export interface WeightBudgetOptions {
  limit?: number
  targetRatio?: number
  windowMs?: number
  /** query 档可用的 target 份额，默认 0.5（旧名 lowShare 同义）。 */
  queryShare?: number
  lowShare?: number
  /** background 档可用的 target 份额，默认 0.35。 */
  backgroundShare?: number
  clock?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export const HL_WEIGHT_LIMIT_PER_MIN = 1200
export const DEFAULT_TARGET_RATIO = 0.6
const BACKOFF_START_MS = 5_000
const BACKOFF_MAX_MS = 60_000

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(signal!.reason instanceof Error ? signal!.reason : new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createWeightBudget(opts: WeightBudgetOptions = {}): RateBudget {
  const limit = opts.limit ?? HL_WEIGHT_LIMIT_PER_MIN
  const target = Math.floor(limit * (opts.targetRatio ?? DEFAULT_TARGET_RATIO))
  const windowMs = opts.windowMs ?? 60_000
  const caps: Record<BudgetKind, number> = {
    trade: target,
    query: Math.floor(target * (opts.queryShare ?? opts.lowShare ?? 0.5) + 1e-9),
    background: Math.floor(target * (opts.backgroundShare ?? 0.35) + 1e-9),
  }
  const clock = opts.clock ?? (() => Date.now())
  const sleep = opts.sleep ?? defaultSleep
  let events: Array<{ ts: number; w: number; k: BudgetKind }> = []
  let backoffUntil = 0
  let backoffMs = 0

  const purge = (now: number) => {
    const cut = now - windowMs
    if (events.length && events[0]!.ts <= cut) events = events.filter((e) => e.ts > cut)
  }
  const used = () => events.reduce((s, e) => s + e.w, 0)

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
            if (acc + weight <= cap) { wait = e.ts + windowMs - now + 1; break }
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
      backoffMs = retryAfterMs ?? Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : BACKOFF_START_MS)
      backoffUntil = Math.max(backoffUntil, clock() + backoffMs)
    },
    reportOk() {
      if (clock() >= backoffUntil) backoffMs = 0
    },
    usage() {
      const now = clock()
      purge(now)
      const u = used()
      const byKind: Record<BudgetKind, number> = { trade: 0, query: 0, background: 0 }
      for (const e of events) byKind[e.k] += e.w
      return { used: u, target, limit, ratio: u / limit, windowMs, backoffUntil: backoffUntil > now ? backoffUntil : 0, byKind }
    },
  }
}

/**
 * 内核注入的共享预算（KernelRateBudget）不按用途分档：background 与 query 共用同一个 576 上限。
 * 测试网有 275 个 dex，发现流程每分钟吃掉约 560 权重，用户的 K 线查询（权重 20+）永远排不进，10 s 后超时。
 * 这里在共享预算前面加一道本连接器自己的分档闸（query 50% / background 35%），共享预算只管总量；trade 不过闸，不被拖慢。
 * 没有 byKind 的预算才包；自带分档的预算（createWeightBudget）原样使用。
 * ponytail: 闸只记本连接器的花费；共享 acquire 失败（被 abort）时闸里已记的权重不退（宁可少发，不会超额）。
 */
export function withKindCaps(shared: RateBudget, clock: () => number): RateBudget {
  // 只给形状完整的共享预算套闸；已分档的、或不是本连接器预算形状的（宿主自带的别种预算 / 测试替身）原样用
  if (typeof shared.usage !== 'function' || typeof shared.acquire !== 'function') return shared
  if ('byKind' in shared.usage()) return shared
  const share = { query: 0.5, background: 0.35 }
  const gate = createWeightBudget({ clock, queryShare: share.query, backgroundShare: share.background })
  return {
    acquire(weight, o = {}) {
      const kind: BudgetKind = o.kind ?? (o.priority === 'low' ? 'query' : 'trade')
      if (kind === 'trade') return shared.acquire(weight, o)
      const u = gate.usage()
      // 份额够就同一拍直接记账并转给共享预算（不多等一个微任务）；不够才在闸里排队
      if (u.byKind[kind] + weight <= Math.floor(u.target * share[kind] + 1e-9)) { gate.charge(weight, kind); return shared.acquire(weight, o) }
      return gate.acquire(weight, o).then(() => shared.acquire(weight, o))
    },
    charge(weight, kind = 'query') {
      if (kind !== 'trade') gate.charge(weight, kind)
      shared.charge(weight, kind)
    },
    penalize: (retryAfterMs) => shared.penalize(retryAfterMs),
    reportOk: () => shared.reportOk(),
    usage: () => shared.usage(),
  }
}

/** info 请求的基础权重（官方口径）；按条数追加的权重见 extraInfoWeight。 */
export function infoWeight(type: string): number {
  switch (type) {
    case 'l2Book':
    case 'allMids':
    case 'clearinghouseState':
    case 'orderStatus':
    case 'spotClearinghouseState':
    case 'exchangeStatus':
      return 2
    case 'userRole':
      return 60
    default:
      return 20
  }
}

/** 官方：recentTrades / historicalOrders / userFills / userFillsByTime / fundingHistory 等每 20 条返回加 1；candleSnapshot 每 60 条加 1。 */
export function extraInfoWeight(type: string, returned: number): number {
  if (type === 'candleSnapshot') return Math.floor(returned / 60)
  if (['recentTrades', 'historicalOrders', 'userFills', 'userFillsByTime', 'fundingHistory', 'userFunding', 'twapHistory', 'userTwapSliceFills', 'delegatorHistory', 'nonUserFundingUpdates', 'userTwapSliceFillsByTime', 'delegatorRewards', 'validatorStats'].includes(type)) {
    return Math.floor(returned / 20)
  }
  return 0
}

/** exchange 动作：权重 1 + floor(batchLength / 40)。 */
export function exchangeWeight(batchLength: number): number {
  return 1 + Math.floor(batchLength / 40)
}
