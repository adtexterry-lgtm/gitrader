// SPDX-License-Identifier: CPAL-1.0
// host.market.history 带 from 的区间请求：本地优先、只补缺口（R1-PERF-01）。
//   · 请求区间内每个已收盘的周期格点（t = ceil(from/step)·step … < to）录制库里都有 → 只用本地数据，不发场所请求，source = "store"；
//   · 有缺口 → 只向场所拉「第一个缺口 … 最后一个缺口」这一段；录制库已有的格点不被场所数据替换，只把新拉到的根录进库，source = "<venue>+store"；
//   · 一次最多答 limit（≤ 5000）个格点，长窗口靠引擎翻页（HostApi.history 以 最后一根 t + 1 为下一页的 from）；
//   · 形成中的那根（尚未收盘）不在这条路径里：它不是库里的数据，回测也不该吃到。
// 不带 from 的「最近 n 根」请求不走这里（照旧先打场所）。
import type { Candle, CandleInterval, MarketHistoryResult } from './proto'
import type { FileCandleStore } from './market-store'

/** 周期毫秒数。协议里 1M 是自然月，这里按 30 天近似：月线对不上格点就等于永远有缺口，结果只是退回场所路径，不会错。 */
const STEP_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 30 * 86_400_000,
}

export interface HistorySource {
  readonly venue: string
  candles(id: string, interval: CandleInterval, opts?: { n?: number; from?: number; to?: number }): Promise<Candle[]>
}

/** 同一场所源上、同一缺口的在途请求只发一次（两路并发补同一个缺口不重复打场所）。 */
const inflight = new WeakMap<object, Map<string, Promise<Candle[]>>>()

function fetchSpan(src: HistorySource, id: string, interval: CandleInterval, from: number, to: number): Promise<Candle[]> {
  let m = inflight.get(src)
  if (!m) inflight.set(src, (m = new Map()))
  const key = `${id}|${interval}|${from}|${to}`
  let p = m.get(key)
  if (!p) {
    const mine = m
    p = src.candles(id, interval, { n: Math.round((to - from) / STEP_MS[interval]) + 1, from, to }).finally(() => { mine.delete(key) })
    m.set(key, p)
  }
  return p
}

/**
 * 回 null = 这条路径帮不上（区间里还没有已收盘的格点 / 参数不是有限数），调用方走原来的先打场所路径。
 * 场所请求失败：本页有本地数据就只给本地的（source = "store"），一根都没有就把场所的错原样抛出。
 */
export async function localFirstHistory(
  x: { store: FileCandleStore; src: HistorySource; now: number },
  id: string, interval: CandleInterval, n: number, from: number, to: number | undefined,
): Promise<MarketHistoryResult | null> {
  if (!Number.isFinite(from) || (to !== undefined && !Number.isFinite(to))) return null
  const step = STEP_MS[interval]
  const lastClosed = Math.floor(x.now / step) * step - step // 最后一根已收盘 K 线的开盘时刻
  const lastT = Math.floor(Math.min((to ?? x.now) - 1, lastClosed) / step) * step // 区间内最后一个已收盘格点
  let cursor = Math.ceil(from / step) * step
  if (lastT < cursor) return null
  for (let guard = 0; guard < 400 && cursor <= lastT; guard++) {
    const pageLast = Math.min(lastT, cursor + (n - 1) * step)
    const have = new Set(await x.store.times(id, interval, { from: cursor, to: pageLast + 1 }))
    let firstMiss = -1
    let lastMiss = -1
    for (let t = cursor; t <= pageLast; t += step) {
      if (have.has(t)) continue
      if (firstMiss < 0) firstMiss = t
      lastMiss = t
    }
    const local = have.size > 0 ? await x.store.read(id, interval, { from: cursor, to: pageLast + 1 }) : []
    let candles = local
    let source = 'store'
    if (firstMiss >= 0) {
      let fetched: Candle[] | undefined
      try { fetched = await fetchSpan(x.src, id, interval, firstMiss, lastMiss) } catch (e) { if (local.length === 0) throw e }
      if (fetched) {
        // 库里已有的格点不被场所数据替换：只收库里没有的根
        const fresh = fetched.filter((c) => c.t >= firstMiss && c.t <= lastMiss && !have.has(c.t))
        if (fresh.length > 0) {
          await x.store.record(id, interval, fresh).catch(() => {}) // 库是尽力而为，录不进去不影响这次回答
          candles = [...local, ...fresh].sort((a, b) => a.t - b.t)
        }
        source = `${x.src.venue}+store`
      }
    }
    if (candles.length > 0 || pageLast >= lastT) return { candles: candles.slice(0, n), source, complete: pageLast >= lastT } satisfies MarketHistoryResult
    cursor = pageLast + step // 这一页整段都没有数据（例如标的上市在窗口起点之后）：往后找下一页
  }
  return null
}
