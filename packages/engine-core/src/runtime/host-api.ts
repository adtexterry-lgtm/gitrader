// SPDX-License-Identifier: CPAL-1.0
// 引擎调用宿主（host.*）的类型化封装。连接没了就抛 3003 VENUE_UNAVAILABLE 风格的可重试错误（由调用方决定怎么处理）。
import type {
  AccountId, AccountSnapshot, Candle, ClientOrderId, HostMethods, Instrument, InstrumentId, MarketHistoryResult,
  Order, OrderIntent, OrderResult, PrecheckResult,
} from '../proto'
import { rpcErr } from '../gep/peer'

export interface HostLink {
  call<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params?: unknown): void
}

type Params<K extends keyof HostMethods> = HostMethods[K]['params']
type Result<K extends keyof HostMethods> = HostMethods[K]['result']

/** 把对端回的 K 线（对象 `{t,o,h,l,c,v}` 或数组 `[t,o,h,l,c,v]`）规整成 Candle；坏数据丢弃。 */
export function normalizeCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const c of raw) {
    if (Array.isArray(c) && c.length >= 6 && c.slice(0, 6).every((x) => typeof x === 'number' && Number.isFinite(x))) out.push({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] })
    else if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>
      const v = [o.t, o.o, o.h, o.l, o.c, o.v ?? 0]
      if (v.every((x) => typeof x === 'number' && Number.isFinite(x))) out.push({ t: v[0] as number, o: v[1] as number, h: v[2] as number, l: v[3] as number, c: v[4] as number, v: v[5] as number })
    }
  }
  return out
}

/** 资金费点（分析级数据，number）。 */
export interface FundingPoint { t: number; rate: number }

/** 把对端回的资金费点规整：接受 {t, rate}（rate 可为 number 或十进制字符串）或 [t, rate]；坏项丢弃；按 t 升序、按 t 去重（保留先出现）。 */
export function normalizeFunding(raw: unknown): FundingPoint[] {
  if (!Array.isArray(raw)) return []
  const out: FundingPoint[] = []
  for (const p of raw) {
    let t: unknown
    let rate: unknown
    if (Array.isArray(p)) {
      if (p.length < 2) continue
      t = p[0]
      rate = p[1]
    } else if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>
      t = o.t
      rate = o.rate
    } else continue
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    const n = typeof rate === 'number' ? rate : typeof rate === 'string' ? Number(rate) : NaN
    if (!Number.isFinite(n)) continue
    out.push({ t, rate: n })
  }
  out.sort((a, b) => a.t - b.t)
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1]!.t)
}

export class HostApi {
  constructor(private readonly linkOf: () => HostLink | null) {}

  get connected(): boolean { return this.linkOf() !== null }

  async call<K extends keyof HostMethods>(method: K, params: Params<K>, timeoutMs?: number): Promise<Result<K>> {
    const link = this.linkOf()
    if (!link) throw rpcErr('VENUE_UNAVAILABLE', `host not connected (${method})`, { retryable: true })
    return link.call<Result<K>>(method, params, timeoutMs)
  }

  notify(method: string, params?: unknown): void { this.linkOf()?.notify(method, params) }

  async instruments(ids: InstrumentId[]): Promise<Instrument[]> { return (await this.call('host.instruments', { ids })).instruments }

  /** 分页取历史 K 线，直到覆盖 [from, to] 或没有更多；每页 ≤ 5000（契约上限）。 */
  async history(instrumentId: InstrumentId, interval: string, opts: { from?: number; to?: number; limit?: number; maxBars?: number } = {}): Promise<{ candles: Candle[]; source: string; complete: boolean }> {
    const page = 5000
    const maxBars = opts.maxBars ?? 5000
    if (opts.from === undefined) {
      const r = (await this.call('host.market.history', { instrumentId, interval, ...(opts.to !== undefined ? { to: opts.to } : {}), limit: Math.min(opts.limit ?? 300, page) })) as MarketHistoryResult
      return { candles: normalizeCandles(r.candles), source: r.source, complete: r.complete }
    }
    const all: Candle[] = []
    let cursor = opts.from
    let source = ''
    let complete = false
    for (let guard = 0; guard < 2000 && all.length < maxBars; guard++) {
      const r = (await this.call('host.market.history', { instrumentId, interval, from: cursor, ...(opts.to !== undefined ? { to: opts.to } : {}), limit: Math.min(page, maxBars - all.length) })) as MarketHistoryResult
      const cs = normalizeCandles(r.candles)
      source = r.source
      if (cs.length === 0) { complete = true; break }
      const lastT = all.length ? all[all.length - 1]!.t : -Infinity
      for (const c of cs) if (c.t > lastT) all.push(c)
      const nextCursor = cs[cs.length - 1]!.t + 1
      if (nextCursor <= cursor) break
      cursor = nextCursor
      if (r.complete || (opts.to !== undefined && cursor > opts.to)) { complete = true; break }
    }
    return { candles: all, source, complete }
  }

  /** 宿主资金费率历史（GEP 宿主方法 host.market.fundingHistory，协议 0.1.13 登记；对端没有该方法时由调用方按错误降级）。 */
  async fundingHistory(instrumentId: InstrumentId, opts: { from: number; to?: number }): Promise<{ points: FundingPoint[]; complete: boolean }> {
    const link = this.linkOf()
    if (!link) throw rpcErr('VENUE_UNAVAILABLE', 'host not connected (host.market.fundingHistory)', { retryable: true })
    const r = await link.call<unknown>('host.market.fundingHistory', { instrumentId, from: opts.from, ...(opts.to !== undefined ? { to: opts.to } : {}) })
    if (Array.isArray(r)) return { points: normalizeFunding(r), complete: true }
    if (r && typeof r === 'object') {
      const o = r as { points?: unknown; complete?: unknown }
      return { points: normalizeFunding(o.points), complete: o.complete === true }
    }
    return { points: [], complete: false }
  }

  accountSnapshot(accountId: AccountId): Promise<AccountSnapshot> { return this.call('host.account.snapshot', { accountId }) }
  placeOrder(p: Params<'host.order.place'>): Promise<OrderResult> { return this.call('host.order.place', p) }
  orderStatus(ref: { orderId?: string; clientOrderId?: ClientOrderId }): Promise<Order> { return this.call('host.order.status', ref as Params<'host.order.status'>) }
  precheck(accountId: AccountId, intent: OrderIntent): Promise<PrecheckResult> { return this.call('host.risk.precheck', { accountId, intent }) }
}
