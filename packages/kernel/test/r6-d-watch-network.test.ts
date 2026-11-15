// SPDX-License-Identifier: CPAL-1.0
// R3-20 跟进：观察账户按它自己的 environment 读公开数据，与交易场所连的是哪个网无关。
// 场所连测试网、观察账户在主网 → 经注入的只读源工厂读；环境一致 → 用场所现有连接；没有工厂（--offline）→ DATA_UNAVAILABLE。
// 只读源绝不进总线的 connectors / marketSources，下单路由拿不到它。全部用假源，不联网。
import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigAccount } from '../src/config'
import type { Account } from '../src/proto'
import { WatchReader } from '../src/watch'
import type { WatchSource, WatchSourceFactory } from '../src/watch'
import { ConnectorBus } from '../src/connector'
import { FakeClock } from '../src/util/clock'
import { BTC, FakeConnector } from './helpers/fake-connector'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

const MAIN_ID = 'acct_WATCH000000000000000000001'
const MAIN2_ID = 'acct_WATCH000000000000000000002'
const TEST_ID = 'acct_WATCH000000000000000000003'
const addr = (n: string) => `0x${n.repeat(20)}`
const watchEntry = (alias: string, accountId: string, environment: 'mainnet' | 'testnet', address: string): ConfigAccount =>
  ({ alias, venue: 'hyperliquid', environment, mode: 'watch', watch: { address }, accountId }) as unknown as ConfigAccount

interface Spy { src: FakeConnector; source: WatchSource; closed: number }
/** 假只读源：背后是一个独立的假连接器（权益 777），只对外暴露两个读方法和 close。 */
const spySource = (h: Harness): Spy => {
  const src = new FakeConnector({ id: 'hyperliquid', clock: h.clock, initialEquity: '777' })
  const spy: Spy = { src, closed: 0, source: { accountState: (r) => src.accountState(r), openOrders: (r) => src.openOrders(r), close: async () => { spy.closed++ } } }
  return spy
}

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.cleanup())) })
// 默认场所连测试网（harness 的 hyperliquid 假连接器是 testnet）：两个主网观察账户 + 一个测试网观察账户
const setup = async (registerLive = true): Promise<Harness> => {
  const h = await makeHarness({
    registerLive,
    configure: (c) => {
      c.accounts.push(watchEntry('obs-main', MAIN_ID, 'mainnet', addr('ab')), watchEntry('obs-main2', MAIN2_ID, 'mainnet', addr('cd')), watchEntry('obs-test', TEST_ID, 'testnet', addr('ef')))
    },
  })
  harnesses.push(h)
  return h
}
const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const call = async (h: Harness, a: TestAgent, tool: string, params: Record<string, unknown> = {}): Promise<{ data: any }> => // eslint-disable-line @typescript-eslint/no-explicit-any
  (await h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params: { requestId: RID, ...params }, transport: 'http' })) as { data: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const acct = (h: Harness, alias: string): Account => h.k.accounts.find(alias)!

describe('场所连测试网、观察账户在主网', () => {
  it('走工厂给的主网只读源，不碰测试网连接器；agent 的 account 工具读到的是只读源的数据', async () => {
    const h = await setup()
    const calls: Array<[string, string]> = []
    const spy = spySource(h)
    h.k.bus.setWatchSourceFactory(((venue, environment) => { calls.push([venue, environment]); return spy.source }) as WatchSourceFactory)
    const liveBefore = h.live.accountStateCalls + h.live.openOrdersCalls
    const a = await makeAgent(h, 'read_only', { accounts: [MAIN_ID] as never })
    const summary = (await call(h, a, 'account', { action: 'summary' })).data
    expect(summary).toMatchObject({ accountId: MAIN_ID, mode: 'watch', equity: '777' })
    expect(calls).toEqual([['hyperliquid', 'mainnet']])
    expect(spy.src.accountStateCalls).toBeGreaterThan(0)
    expect(h.live.accountStateCalls + h.live.openOrdersCalls).toBe(liveBefore) // 测试网连接器一次都没碰
  })

  it('没有 hyperliquid 连接（比如连接器没起来）也能读：同样经工厂', async () => {
    const h = await setup(false)
    expect(h.k.bus.get('hyperliquid')).toBeUndefined()
    const spy = spySource(h)
    h.k.bus.setWatchSourceFactory(() => spy.source)
    const { state } = await h.k.bus.readWatch(acct(h, 'obs-main'))
    expect(state.margin.equity).toBe('777')
  })
})

describe('环境一致', () => {
  it('观察账户和场所同在测试网：用场所现有连接，工厂一次都不调用', async () => {
    const h = await setup()
    let factoryCalls = 0
    h.k.bus.setWatchSourceFactory((() => { factoryCalls++; return spySource(h).source }) as WatchSourceFactory)
    const before = h.live.accountStateCalls
    const { state } = await h.k.bus.readWatch(acct(h, 'obs-test'))
    expect(state.margin.equity).toBe('10000') // 场所连接器的权益，不是只读源的 777
    expect(h.live.accountStateCalls).toBeGreaterThan(before)
    expect(factoryCalls).toBe(0)
  })
})

describe('没有工厂（--offline）或工厂给不出源', () => {
  it('没装配工厂：主网观察账户 DATA_UNAVAILABLE，文案说清原因；同网的观察账户不受影响', async () => {
    const h = await setup()
    await expect(h.k.bus.readWatch(acct(h, 'obs-main'))).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE', message: expect.stringMatching(/obs-main.*mainnet.*connected to testnet.*read-only mainnet data source.*--offline/) } })
    await expect(h.k.bus.readWatch(acct(h, 'obs-test'))).resolves.toBeTruthy()
  })

  it('场所也没有连接又没有工厂：DATA_UNAVAILABLE', async () => {
    const h = await setup(false)
    await expect(h.k.bus.readWatch(acct(h, 'obs-main'))).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE', message: expect.stringMatching(/no data connection for venue hyperliquid/) } })
  })

  it('工厂返回 undefined 或抛错：DATA_UNAVAILABLE，不会退回任何别的路径', async () => {
    const h = await setup()
    h.k.bus.setWatchSourceFactory(() => undefined)
    await expect(h.k.bus.readWatch(acct(h, 'obs-main'))).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE' } })
    const h2 = await setup()
    h2.k.bus.setWatchSourceFactory(() => { throw new Error('boom') })
    await expect(h2.k.bus.readWatch(acct(h2, 'obs-main'))).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE', message: expect.stringMatching(/boom/) } })
  })
})

describe('只读源不是交易连接', () => {
  it('不在总线的 connectors / marketSources 里；对观察账户下单、提案仍是 CAPABILITY_UNSUPPORTED，两边的假场所都没收到任何单', async () => {
    const h = await setup()
    const spy = spySource(h)
    h.k.bus.setWatchSourceFactory(() => spy.source)
    await h.k.bus.readWatch(acct(h, 'obs-main')) // 先让工厂真的造出来
    expect(h.k.bus.get('hyperliquid')).toBe(h.live)
    expect(h.k.bus.list()).not.toContain(spy.src)
    expect(h.k.bus.list()).not.toContain(spy.source as never)
    expect(h.k.bus.marketSource('hyperliquid')).toBe(h.live)
    expect(() => h.k.bus.routeFor(acct(h, 'obs-main'))).toThrowError(/read-only watch account/)
    const confirm = await makeAgent(h, 'confirm', { accounts: [MAIN_ID] as never })
    const intent = { accountId: MAIN_ID, instrumentId: BTC, side: 'buy', type: 'limit', price: '1000', size: '0.001', reason: 'r6 watch must refuse' }
    for (const [tool, args] of [['order', { action: 'preview', intent }], ['order', { action: 'place', intent }], ['propose', { action: 'order', accountId: MAIN_ID, intents: [intent], reason: 'r6 watch' }]] as const) {
      await expect(call(h, confirm, tool, args as unknown as Record<string, unknown>), `${tool}.${args.action}`).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED' } })
    }
    expect(spy.src.submitted.length + h.live.submitted.length + h.sim.submitted.length).toBe(0)
    expect(await h.k.bus.snapshot(acct(h, 'obs-main'))).toMatchObject({ positions: [], openOrders: [] }) // 交易侧仍是空账户
  })
})

describe('同一 (场所, 环境) 只建一次', () => {
  it('两个主网观察账户、多次读（过了 TTL 也一样）只调用一次工厂；停机时关一次', async () => {
    const h = await setup()
    let factoryCalls = 0
    const spy = spySource(h)
    h.k.bus.setWatchSourceFactory(() => { factoryCalls++; return spy.source })
    await h.k.bus.readWatch(acct(h, 'obs-main'))
    await h.k.bus.readWatch(acct(h, 'obs-main2'))
    h.clock.advance(10_000)
    await h.k.bus.readWatch(acct(h, 'obs-main'))
    await h.k.bus.readWatch(acct(h, 'obs-test')) // 同网的不经工厂
    expect(factoryCalls).toBe(1)
    expect(spy.closed).toBe(0)
    await h.k.bus.close()
    expect(spy.closed).toBe(1)
  })

  it('3 s TTL 合并保留：TTL 内同一账户重复读不再碰只读源', async () => {
    const h = await setup()
    const spy = spySource(h)
    h.k.bus.setWatchSourceFactory(() => spy.source)
    await h.k.bus.readWatch(acct(h, 'obs-main'))
    const n = spy.src.accountStateCalls
    await h.k.bus.readWatch(acct(h, 'obs-main'))
    expect(spy.src.accountStateCalls).toBe(n)
    h.clock.advance(3_100)
    await h.k.bus.readWatch(acct(h, 'obs-main'))
    expect(spy.src.accountStateCalls).toBeGreaterThan(n)
  })
})

describe('新读的账户先返回 stale：读取器最多等一轮后台补全', () => {
  const account = { accountId: MAIN_ID, alias: 'obs-main', venue: 'hyperliquid', environment: 'mainnet', mode: 'watch', owner: { address: addr('ab') } } as unknown as Account
  const snap = (stale: boolean, equity: string) => ({ margin: { equity }, positions: [], balances: [], stale }) as never
  const reader = (source: WatchSource, slept: number[]) => {
    const r = new WatchReader(() => undefined, () => new FakeClock().now(), 3_000, async (ms) => { slept.push(ms) })
    r.setSourceFactory(() => source)
    return r
  }

  it('前两次 stale、第三次新鲜：返回新鲜的那份', async () => {
    let n = 0
    const slept: number[] = []
    const r = reader({ accountState: async () => snap(++n < 3, n < 3 ? '0' : '555'), openOrders: async () => [] }, slept)
    expect((await r.read(account)).state.margin.equity).toBe('555')
    expect(slept.length).toBe(2)
  })

  it('一直 stale：等有限次后原样返回（不死等，不改变原来的返回语义）', async () => {
    const slept: number[] = []
    const r = reader({ accountState: async () => snap(true, '0'), openOrders: async () => [] }, slept)
    expect((await r.read(account)).state.margin.equity).toBe('0')
    expect(slept.length).toBeGreaterThan(0)
    expect(slept.length).toBeLessThanOrEqual(40)
  })

  it('读失败：错误原样抛出，不吞（调用方不会走到任何下单路径）', async () => {
    const r = reader({ accountState: async () => { throw new Error('upstream down') }, openOrders: async () => [] }, [])
    await expect(r.read(account)).rejects.toThrow(/upstream down/)
  })
})

describe('ConnectorBus 没装配工厂时的缺省', () => {
  it('新建的总线 readWatch 对没有连接的场所给 DATA_UNAVAILABLE', async () => {
    const bus = new ConnectorBus(new FakeClock())
    const account = { accountId: MAIN_ID, alias: 'x', venue: 'hyperliquid', environment: 'mainnet', mode: 'watch', owner: { address: addr('ab') } } as unknown as Account
    await expect(bus.readWatch(account)).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE' } })
  })
})
