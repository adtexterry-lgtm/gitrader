// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, KernelClient, LinkHub, createFixtureBridge, createHostBridge, createRemoteBridge, serveBridge, type BlockBridge, type BlockManifest, type PortLike } from '../src'
import { startFakeKernel, type FakeKernel } from '../src/testing/fake-kernel'
import { good } from './helpers'

let k: FakeKernel
let client: KernelClient
const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('超时'); await new Promise((r) => setTimeout(r, 10)) }
}

beforeEach(async () => {
  k = await startFakeKernel()
  const r = await fetch(`${k.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: k.bootstrapToken }) })
  const tok = ((await r.json()) as { sessionToken: string }).sessionToken
  client = new KernelClient({ url: k.wsUrl, getToken: () => tok })
  await client.connect()
})
afterEach(async () => { client.close(); await k.close() })

const host = (m: BlockManifest, extra: Partial<Parameters<typeof createHostBridge>[0]> = {}) =>
  createHostBridge({ manifest: m, instanceId: 'bi_t_1', kernel: client, hub: new LinkHub({ A: { symbol: 'hyperliquid:BTC' } }), schedule: (fn) => queueMicrotask(fn), isUserActive: () => true, ...extra })

describe('宿主桥 · 清单约束', () => {
  it('只能订阅清单声明的主题；maxHz 取声明与请求的较小值', async () => {
    const b = host(good())
    expect(() => b.subscribe('account.positions', () => {})).toThrowError(BridgeError)
    const off = b.subscribe('market.quote', () => {}, { maxHz: 60 })
    await until(() => k.subscriptions().length === 1)
    expect(k.subscriptions()[0]?.maxHz).toBe(10)
    off()
  })

  it('权限不足（清单里有但用户没授予）→ PERMISSION_DENIED', () => {
    const b = host(good(), { grants: ['workspace.control'] })
    expect(() => b.subscribe('market.quote', () => {})).toThrowError(/market\.read/)
  })

  it('事件批量投递：同一调度窗口内到达的多条事件按序一次性回调', async () => {
    let pending: (() => void) | null = null
    const b = host(good(), { schedule: (fn) => { pending = fn } })
    const got: number[] = []
    b.subscribe('market.quote', (e) => got.push((e.data as { n: number }).n))
    await until(() => k.subscriptions().length === 1)
    k.publish('market.quote', { n: 1 }); k.publish('market.quote', { n: 2 }); k.publish('market.quote', { n: 3 })
    await until(() => pending !== null)
    await new Promise((r) => setTimeout(r, 30))
    expect(got).toEqual([]) // 还没到下一帧
    ;(pending as unknown as () => void)()
    expect(got).toEqual([1, 2, 3])
  })

  it('查询必须在 inputs.queries 里', async () => {
    k.onQuery('market.candles', () => ({ candles: [] }))
    const b = host(good())
    expect(await b.query('market.candles')).toEqual({ candles: [] })
    await expect(b.query('account.positions')).rejects.toMatchObject({ code: 'QUERY_NOT_ALLOWED' })
  })

  it('命令：必须声明、权限、非人点击被拒；origin.tool 带块 id', async () => {
    k.onCommand('order.place', () => ({ ok: true }))
    const b = host(good())
    await b.command('order.place', { q: 1 })
    expect(k.commands[0]?.origin).toEqual({ tool: 'block:block.gitrader.chart:order.place', via: 'ui' })
    await expect(b.command('order.cancel', {})).rejects.toMatchObject({ code: 'ACTION_NOT_DECLARED' })
    await expect(host(good({ actions: ['takeover.halt_new'], permissions: ['market.read'] })).command('takeover.halt_new', {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(host(good(), { isUserActive: () => false }).command('order.place', {})).rejects.toMatchObject({ code: 'USER_ACTIVATION_REQUIRED' })
  })

  it('批准提案只给一方签名 inline 块', async () => {
    k.onCommand('proposal.approve', () => ({ ok: true }))
    const m = good({ actions: ['proposal.approve'] })
    await expect(host(m).command('proposal.approve', {})).rejects.toMatchObject({ code: 'FIRST_PARTY_ONLY' })
    await expect(host(m, { trusted: true }).command('proposal.approve', {})).resolves.toEqual({ ok: true })
    await expect(host({ ...m, isolation: 'iframe' }, { trusted: true }).command('proposal.approve', {})).rejects.toMatchObject({ code: 'FIRST_PARTY_ONLY' })
  })

  it('联动：读写分级；link.<group> 订阅走联动中枢，不经内核', async () => {
    const hub = new LinkHub({ A: { symbol: 'hyperliquid:BTC' } })
    const rw = host(good(), { hub })
    const ro = host(good({ linkGroups: [{ group: 'symbol', mode: 'read' }] }), { hub })
    const seen: unknown[] = []
    ro.subscribe('link.symbol', (e) => seen.push(e.data))
    rw.link.set('symbol', 'hyperliquid:ETH')
    expect(seen).toEqual(['hyperliquid:ETH'])
    expect(ro.link.get('symbol')).toBe('hyperliquid:ETH')
    expect(() => ro.link.set('symbol', 'x:1')).toThrowError(BridgeError)
    expect(() => rw.subscribe('link.account', () => {})).toThrowError(/未声明联动组/)
    expect(k.subscriptions()).toHaveLength(0)
    expect((await rw.hello()).links).toEqual({ symbol: 'hyperliquid:ETH' })
  })
})

describe('远程桥（MessageChannel）与宿主桥语义一致', () => {
  const pair = (hostBridge: BlockBridge): { remote: BlockBridge; stop: () => void } => {
    const ch = new MessageChannel()
    const stop = serveBridge(ch.port1 as unknown as PortLike, hostBridge)
    const remote = createRemoteBridge(ch.port2 as unknown as PortLike, { blockId: hostBridge.blockId, instanceId: hostBridge.instanceId })
    return { remote, stop: () => { stop(); ch.port1.close(); ch.port2.close() } }
  }

  it('hello / 订阅 / 查询 / 命令 / 联动穿过 postMessage；拒绝以同类错误回来', async () => {
    k.onQuery('market.candles', () => ({ candles: [1] }))
    k.onCommand('order.place', () => ({ filled: false }))
    const hub = new LinkHub({ A: { symbol: 'hyperliquid:BTC' } })
    const { remote, stop } = pair(host(good(), { hub }))
    const hello = await remote.hello()
    expect(hello).toMatchObject({ blockId: 'block.gitrader.chart', links: { symbol: 'hyperliquid:BTC' } })
    expect(remote.link.get('symbol')).toBe('hyperliquid:BTC')
    const got: unknown[] = []
    remote.subscribe('market.quote', (e) => got.push(e.data))
    await until(() => k.subscriptions().length === 1)
    k.publish('market.quote', { mid: '1' })
    await until(() => got.length === 1)
    expect(await remote.query('market.candles')).toEqual({ candles: [1] })
    expect(await remote.command('order.place', {})).toEqual({ filled: false })
    await expect(remote.query('account.positions')).rejects.toMatchObject({ name: 'BridgeError', code: 'QUERY_NOT_ALLOWED' })
    const links: unknown[] = []
    remote.link.subscribe('symbol', (v) => links.push(v))
    hub.set('A', 'symbol', 'hyperliquid:SOL', 'other')
    await until(() => links.length === 1)
    expect(links).toEqual(['hyperliquid:SOL'])
    expect(remote.link.get('symbol')).toBe('hyperliquid:SOL')
    stop()
  })

  it('被拒的订阅不会让远程块崩溃', async () => {
    const { remote, stop } = pair(host(good()))
    await remote.hello()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    remote.subscribe('ledger.entry', () => {})
    await until(() => err.mock.calls.length > 0)
    err.mockRestore()
    stop()
  })
})

describe('夹具桥（离线预览）', () => {
  it('按时间轴回放事件、返回夹具查询、记录命令', async () => {
    const fb = createFixtureBridge(good(), { events: [{ t: 0, topic: 'market.quote', data: { mid: '1' } }, { t: 20, topic: 'market.quote', data: { mid: '2' } }], queries: { 'market.candles': { candles: [] } }, links: { symbol: 'hyperliquid:BTC' } })
    const got: unknown[] = []
    fb.subscribe('market.quote', (e) => got.push(e.data))
    await until(() => got.length === 2)
    expect(got).toEqual([{ mid: '1' }, { mid: '2' }])
    expect(await fb.query('market.candles')).toEqual({ candles: [] })
    await fb.command('order.place', { a: 1 })
    expect(fb.commandLog).toEqual([{ action: 'order.place', params: { a: 1 } }])
    expect(fb.link.get('symbol')).toBe('hyperliquid:BTC')
  })
})
