// SPDX-License-Identifier: CPAL-1.0
// 离线假 Hyperliquid：用 fixtures/hl 里的原始响应回答 /info，/exchange 交给测试注入的 handler。全部在进程内，不开端口。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let FX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'hl')
/** 打包运行（基准）时 import.meta.url 不再指向源码目录，由调用方指定夹具目录。 */
export const setFixturesDir = (dir: string): void => { FX_DIR = dir }
export const loadFixture = <T = any>(name: string): T => JSON.parse(readFileSync(join(FX_DIR, name), 'utf8')) as T

/** fixtures 里 BTC 盘口 / K 线的时间基准。 */
export const FX_NOW = 1791483435048

export interface Call { endpoint: 'info' | 'exchange'; url: string; body: any }

export class FakeHl {
  calls: Call[] = []
  /** 这些 dex 的 metaAndAssetCtxs 返回 500。 */
  failDex = new Set<string>()
  /** 覆盖某个 info type 的响应：返回对象 = 200 JSON，返回 Response 则原样给。 */
  info = new Map<string, (body: any) => unknown>()
  /** /exchange 的响应；缺省返回 {status:'err', response:'no handler'}。 */
  exchange: (body: any) => unknown = () => ({ status: 'err', response: 'no handler' })
  /** 让下一次 exchange 请求在「已发出」之后抛网络错误（模拟结果未知）。 */
  exchangeNetworkFail = false

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const endpoint = url.endsWith('/exchange') ? 'exchange' : 'info'
    const body = JSON.parse(String(init?.body ?? '{}'))
    this.calls.push({ endpoint, url, body })
    if (endpoint === 'exchange') {
      if (this.exchangeNetworkFail) { this.exchangeNetworkFail = false; throw new TypeError('fetch failed: ECONNRESET') }
      const out = this.exchange(body)
      return out instanceof Response ? out : json(out)
    }
    const custom = this.info.get(body.type)
    if (custom) {
      const out = await custom(body)
      return out instanceof Response ? out : json(out)
    }
    switch (body.type) {
      case 'perpDexs': return json(loadFixture('perpDexs.json'))
      case 'metaAndAssetCtxs': {
        const dex = body.dex ?? ''
        if (this.failDex.has(dex)) return new Response('Internal Server Error', { status: 500 })
        return json(loadFixture(dex === '' ? 'metaAndAssetCtxs.json' : `metaAndAssetCtxs-${dex}.json`))
      }
      case 'allMids': return json(loadFixture(body.dex ? `allMids-${body.dex}.json` : 'allMids.json'))
      case 'l2Book':
        if (body.coin === 'BTC') return json(loadFixture('l2Book-BTC.json'))
        if (body.coin === 'xyz:TSLA') return json(loadFixture('l2Book-xyz_TSLA.json'))
        return new Response('null', { status: 200 })
      case 'candleSnapshot': {
        const r = body.req
        const all = r.coin === 'BTC' ? loadFixture<any[]>('candleSnapshot-BTC-1m.json') : loadFixture<any[]>('candleSnapshot-xyz_TSLA-1h.json')
        return json(all.filter((c) => c.t >= r.startTime && c.t <= r.endTime))
      }
      default: return new Response(`unhandled info type ${body.type}`, { status: 422 })
    }
  }

  infoCalls(type?: string): Call[] {
    return this.calls.filter((c) => c.endpoint === 'info' && (!type || c.body.type === type))
  }
  exchangeCalls(): Call[] {
    return this.calls.filter((c) => c.endpoint === 'exchange')
  }
}

const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

// ---- 假 WebSocket ----------------------------------------------------------------
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static reset() { FakeWebSocket.instances = []; FakeWebSocket.autoReply = null }
  static get last(): FakeWebSocket { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]! }
  readyState = 0
  sent: any[] = []
  private handlers = new Map<string, Set<(ev: any) => void>>()
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  addEventListener(type: string, fn: (ev: any) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(fn)
  }
  /** 测试侧：收到某条订阅时自动回哪些推送（场所的首批快照）。 */
  static autoReply: ((sub: any) => unknown[] | undefined) | null = null
  send(data: string) {
    const m = JSON.parse(data)
    this.sent.push(m)
    if (m.method === 'subscribe' && FakeWebSocket.autoReply) {
      const msgs = FakeWebSocket.autoReply(m.subscription)
      if (msgs) queueMicrotask(() => { for (const x of msgs) this.push(x) })
    }
  }
  close() { this.readyState = 3; this.emit('close', {}) }
  // 测试侧
  open() { this.readyState = 1; this.emit('open', {}) }
  push(obj: unknown) { this.emit('message', { data: JSON.stringify(obj) }) }
  drop() { this.readyState = 3; this.emit('close', {}) }
  subs(): any[] { return this.sent.filter((m) => m.method === 'subscribe').map((m) => m.subscription) }
  unsubs(): any[] { return this.sent.filter((m) => m.method === 'unsubscribe').map((m) => m.subscription) }
  private emit(type: string, ev: unknown) { for (const fn of [...(this.handlers.get(type) ?? [])]) fn(ev) }
}
export const FakeWS = FakeWebSocket as unknown as typeof WebSocket
