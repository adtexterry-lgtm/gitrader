// SPDX-License-Identifier: CPAL-1.0
import type { AccountRef, VenueConnector, VenueOpenOrder } from '@gitrader/protocol/connector'
import type { Account, Problem } from '../proto'
import { makeProblem } from '../proto'
import { KernelError } from '../util/errors'

export type WatchRead = Awaited<ReturnType<VenueConnector['accountState']>>

/**
 * 观察账户的只读数据源：只有两个只读读法，没有签名器，也没有任何下单 / 撤单方法。
 * 它不在总线里登记，下单路由永远拿不到它；内核只认这个接口，不 import 任何连接器包。
 */
export interface WatchSource {
  accountState(ref: AccountRef): Promise<WatchRead>
  openOrders(ref: AccountRef): Promise<VenueOpenOrder[]>
  /** 源自己带着后台资源（连接、定时器）时实现；内核停机时调用。 */
  close?(): Promise<void> | void
}
/** 由 CLI 装配：按 (场所, 环境) 造只读源；这个场所 / 环境没有只读源就返回 undefined。读速率预算要与交易连接共用。 */
export type WatchSourceFactory = (venue: string, environment: Account['environment']) => WatchSource | undefined

// 新读的账户首次返回常常是"还没拿到首批快照"（stale）：REST 在后台补，这里最多再等 8 s（只读本地缓存，不额外打网）。
const FRESH_POLL_MS = 250
const FRESH_POLLS = 32

/**
 * 按地址读场所的公开账户状态（HL：clearinghouseState 等 info 查询，不需要钥匙）。
 * 观察账户按它自己的 environment 读，与交易场所连的是哪个网无关：
 *  - environment 一致：用场所现有连接（不新建）；
 *  - 不一致或场所没有连接：经注入的工厂懒创建一个只读源，同一 (场所, 环境) 复用一个。
 * 只调两个只读方法 accountState / openOrders；同一账户 TTL 内合并，守住公开接口的限速（≤2 次/秒）。
 */
export class WatchReader {
  private cache = new Map<string, { at: number; p: Promise<{ state: WatchRead; openOrders: VenueOpenOrder[] }> }>()
  private sources = new Map<string, WatchSource>()
  private factory?: WatchSourceFactory

  constructor(
    private find: (venue: string) => VenueConnector | undefined,
    private now: () => number,
    private ttlMs = 3_000,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  setSourceFactory(factory: WatchSourceFactory): void { this.factory = factory }

  /** 内核停机：关掉自己造的只读源（场所现有连接归总线关）。 */
  async close(): Promise<void> {
    const sources = [...this.sources.values()]
    this.sources.clear()
    this.cache.clear()
    await Promise.all(sources.map(async (s) => { try { await s.close?.() } catch { /* 已断 */ } }))
  }

  read(a: Account): Promise<{ state: WatchRead; openOrders: VenueOpenOrder[] }> {
    const hit = this.cache.get(a.accountId)
    if (hit && this.now() - hit.at < this.ttlMs) return hit.p
    const p = this.fetch(a)
    const entry = { at: this.now(), p }
    this.cache.set(a.accountId, entry)
    p.catch(() => { if (this.cache.get(a.accountId) === entry) this.cache.delete(a.accountId) })
    return p
  }

  private sourceFor(a: Account): WatchSource {
    const vc = this.find(a.venue)
    if (vc && vc.environment === a.environment) return vc
    const key = `${a.venue}:${a.environment}`
    const hit = this.sources.get(key)
    if (hit) return hit
    const why = vc ? `venue ${a.venue} is connected to ${vc.environment}` : `no data connection for venue ${a.venue}`
    if (!this.factory) throw new KernelError(makeProblem('DATA_UNAVAILABLE', `watch account ${a.alias} (${a.environment}) cannot be read: ${why}, and no read-only ${a.environment} data source is available (is the service running with --offline?)`))
    let made: WatchSource | undefined
    try { made = this.factory(a.venue, a.environment) } catch (e) { throw new KernelError(makeProblem('DATA_UNAVAILABLE', `watch account ${a.alias} (${a.environment}) cannot be read: ${e instanceof Error ? e.message : String(e)}`)) }
    if (!made) throw new KernelError(makeProblem('DATA_UNAVAILABLE', `watch account ${a.alias} (${a.environment}) cannot be read: ${why}, and venue ${a.venue} has no read-only ${a.environment} data source`))
    this.sources.set(key, made)
    return made
  }

  private async fetch(a: Account): Promise<{ state: WatchRead; openOrders: VenueOpenOrder[] }> {
    const src = this.sourceFor(a)
    const ref: AccountRef = { accountId: a.accountId, address: a.owner.address as AccountRef['address'] }
    // 上游抛的异常在读取层包好：连接器自己的 ProblemError（带 .problem）保留原码，其余一律 DATA_UNAVAILABLE 并带原文，不留给 Agent 层兜底成 INTERNAL_ERROR。
    const readBoth = async (): Promise<[WatchRead, VenueOpenOrder[]]> => {
      try { return await Promise.all([src.accountState(ref), src.openOrders(ref)]) } catch (e) {
        if (e instanceof KernelError) throw e
        const p = (e as { problem?: Problem } | null)?.problem
        if (p && typeof p.name === 'string' && typeof p.message === 'string') throw new KernelError(p)
        throw new KernelError(makeProblem('DATA_UNAVAILABLE', `watch account ${a.alias} cannot be read: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    let [state, openOrders] = await readBoth()
    for (let i = 0; i < FRESH_POLLS && state.stale === true; i++) {
      await this.sleep(FRESH_POLL_MS)
      ;[state, openOrders] = await readBoth()
    }
    if ((state as typeof state & { ok?: boolean }).ok === false) throw new KernelError(makeProblem('DATA_UNAVAILABLE', `account state of ${a.alias} is unavailable`))
    return { state, openOrders }
  }
}
