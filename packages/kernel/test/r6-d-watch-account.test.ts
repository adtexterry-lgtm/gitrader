// SPDX-License-Identifier: CPAL-1.0
// R3-20：只读观察账户（mode: 'watch'）。配置校验、只读、下单 / 提案 / 起策略一律被拒、读失败不走下单路径、不写交易类账本、接管遇到它不报错。
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig, validateConfig } from '../src/config'
import type { ConfigAccount, GitraderConfig } from '../src/config'
import { makeProblem } from '../src/proto'
import { ORG_SCOPE } from '../src/trading-state'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness, TestAgent } from './helpers/harness'

const ADDR = `0x${'cd'.repeat(20)}`
const WATCH_ID = 'acct_WATCH000000000000000000001'
const watchEntry = (over: Record<string, unknown> = {}): ConfigAccount => ({ alias: 'obs', venue: 'hyperliquid', environment: 'testnet', mode: 'watch', watch: { address: ADDR }, accountId: WATCH_ID, ...over } as unknown as ConfigAccount)
const withAccount = (a: ConfigAccount): GitraderConfig => { const c = defaultConfig(); c.accounts.push(a); return c }

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.cleanup())) })
const setup = async (): Promise<Harness> => {
  const h = await makeHarness({ configure: (c) => { c.accounts.push(watchEntry()) } })
  harnesses.push(h)
  return h
}
const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const call = async (h: Harness, a: TestAgent, tool: string, params: Record<string, unknown> = {}): Promise<{ data: any }> => // eslint-disable-line @typescript-eslint/no-explicit-any
  (await h.k.ops.call(h.k, `agent.${tool}`, { principal: a.principal, params: { requestId: RID, ...params }, transport: 'http' })) as { data: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const tradingTypes = (h: Harness): string[] => h.k.ledger.query({ limit: 1000 }).map((e) => e.type).filter((t) => /^(order|fill|proposal|position)/.test(t))
const intent = (accountId: string) => ({ accountId, instrumentId: BTC, side: 'buy', type: 'limit', price: '1000', size: '0.001', reason: 'r6 watch must refuse' })

describe('配置校验', () => {
  it('合法的观察账户通过；地址必须是 0x + 40 位十六进制', () => {
    expect(validateConfig(withAccount(watchEntry()))).toEqual([])
    for (const address of ['0x123', ADDR.slice(0, -1), `0x${'zz'.repeat(20)}`, ADDR.replace('0x', ''), '']) {
      expect(validateConfig(withAccount(watchEntry({ watch: { address } }))).join(';')).toMatch(/watch\.address/)
    }
    expect(validateConfig(withAccount(watchEntry({ watch: undefined }))).join(';')).toMatch(/watch\.address/)
  })

  it('观察账户不许带 signerRef / credentials / paper；场所只支持 hyperliquid；环境可以和场所连的网不同（按自己的网读，r3-20 跟进）', () => {
    expect(validateConfig(withAccount(watchEntry({ signerRef: 'w1' }))).join(';')).toMatch(/signerRef must not be set/)
    expect(validateConfig(withAccount(watchEntry({ credentials: { key: 'env:K' } }))).join(';')).toMatch(/credentials must not be set/)
    expect(validateConfig(withAccount(watchEntry({ paper: { initialBalance: '1', ccy: 'USDC' } }))).join(';')).toMatch(/paper must not be set/)
    expect(validateConfig(withAccount(watchEntry({ venue: 'binance' }))).join(';')).toMatch(/hyperliquid only/)
    expect(validateConfig(withAccount(watchEntry({ environment: 'mainnet' })))).toEqual([]) // 默认场所连测试网，观察账户在主网：合法
    expect(validateConfig(withAccount(watchEntry({ environment: 'devnet' }))).join(';')).toMatch(/environment must be mainnet\|testnet/)
  })

  it('live / paper / shadow 的校验不变：未知 mode 仍是原来的报错', () => {
    expect(validateConfig(withAccount(watchEntry({ mode: 'bogus', watch: undefined }))).join(';')).toMatch(/mode must be live\|paper\|shadow/)
    expect(validateConfig(withAccount(watchEntry({ mode: 'live', watch: undefined }))).join(';')).toMatch(/signerRef or valid credentials required for live mode/)
    expect(validateConfig(defaultConfig())).toEqual([])
  })
})

describe('读', () => {
  it('account list 里它的 mode 是 watch、状态只读；summary / positions 按地址经场所连接器读，不需要钥匙', async () => {
    const h = await setup()
    const a = await makeAgent(h, 'read_only', { accounts: [WATCH_ID] as never })
    const list = (await call(h, a, 'account', { action: 'list' })).data as Array<{ accountId: string; mode: string }>
    expect(list).toEqual([expect.objectContaining({ accountId: WATCH_ID, mode: 'watch' })])
    const before = h.live.accountStateCalls
    const summary = (await call(h, a, 'account', { action: 'summary' })).data
    expect(summary).toMatchObject({ accountId: WATCH_ID, mode: 'watch' })
    expect(h.live.accountStateCalls).toBeGreaterThan(before)
    const positions = (await call(h, a, 'account', { action: 'positions', accountId: 'obs' })).data
    expect(Array.isArray(positions.items)).toBe(true)
    expect((await call(h, a, 'account', { action: 'orders' })).data).toEqual({ items: [] })
    expect(tradingTypes(h)).toEqual([])
  })

  it('钥匙同时覆盖纸面账户和观察账户：不写 accountId 时缺省仍是纸面账户；观察账户要显式写', async () => {
    const h = await setup()
    const a = await makeAgent(h, 'read_only', { accounts: [h.paper.accountId, WATCH_ID] as never })
    expect((await call(h, a, 'account', { action: 'summary' })).data).toMatchObject({ accountId: h.paper.accountId, mode: 'paper' })
    expect((await call(h, a, 'account', { action: 'summary', accountId: 'obs' })).data).toMatchObject({ accountId: WATCH_ID, mode: 'watch' })
  })

  it('读失败时报错，不退回任何下单路径，账本里没有交易类条目', async () => {
    const h = await setup()
    const a = await makeAgent(h, 'read_only', { accounts: [WATCH_ID] as never })
    h.live.accountState = async () => { throw new Error('upstream down') }
    await expect(call(h, a, 'account', { action: 'summary' })).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE', message: expect.stringContaining('upstream down') } })
    expect(h.sim.submitted.length + h.live.submitted.length).toBe(0)
    expect(tradingTypes(h)).toEqual([])
  })

  it('读失败时上游自己带 Problem 的异常保留原码（如 BUSY），不被兜底成 INTERNAL_ERROR', async () => {
    const h = await setup()
    const a = await makeAgent(h, 'read_only', { accounts: [WATCH_ID] as never })
    h.live.accountState = async () => { throw Object.assign(new Error('tracked accounts over the cap'), { problem: makeProblem('BUSY', 'tracked accounts over the cap') }) }
    await expect(call(h, a, 'account', { action: 'summary' })).rejects.toMatchObject({ problem: { name: 'BUSY', message: expect.stringContaining('over the cap') } })
    expect(h.sim.submitted.length + h.live.submitted.length).toBe(0)
    expect(tradingTypes(h)).toEqual([])
  })
})

describe('只能看、不能动', () => {
  it('confirm 档钥匙落在观察账户上：order preview / place / cancel_all、propose、起策略一律 CAPABILITY_UNSUPPORTED，账本没有交易类条目', async () => {
    const h = await setup()
    const a = await makeAgent(h, 'confirm', { accounts: [WATCH_ID] as never })
    for (const [tool, args] of [
      ['order', { action: 'preview', intent: intent(WATCH_ID) }],
      ['order', { action: 'place', intent: intent('obs') }],
      ['order', { action: 'cancel_all' }],
      ['order', { action: 'close', instrumentId: BTC }],
      ['propose', { action: 'order', accountId: WATCH_ID, intents: [intent(WATCH_ID)], reason: 'r6 watch' }],
      ['engines', { action: 'start_strategy', engineId: 'gitrader-core', strategyId: 'x', instruments: [BTC] }],
    ] as const) {
      await expect(call(h, a, tool, args as unknown as Record<string, unknown>), `${tool}.${args.action}`).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED', message: expect.stringMatching(/read-only watch account/) } })
    }
    expect(h.sim.submitted.length + h.live.submitted.length + h.live.cancelAllCalls.length).toBe(0)
    expect(tradingTypes(h)).toEqual([])
  })

  it('交易侧永远只看到一个空账户；总线对它没有下单路由', async () => {
    const h = await setup()
    const watch = h.k.accounts.find('obs')!
    expect(watch.mode).toBe('watch')
    const snap = await h.k.bus.snapshot(watch)
    expect(snap.positions).toEqual([])
    expect(snap.openOrders).toEqual([])
    expect(() => h.k.bus.routeFor(watch)).toThrowError(/read-only watch account/)
    expect(await h.k.bus.cancelAll(watch)).toEqual({ cancelled: 0, acks: [] })
  })

  it('接管（全撤 / 全平）遇到观察账户是无事可做，不报错也不写失败记录', async () => {
    const h = await setup()
    await enableLive(h)
    for (const level of ['cancel_all', 'flatten_all'] as const) {
      const rec = await h.k.takeover.execute({ level, scope: ORG_SCOPE, reason: `r6 ${level} with a watch account present` }, { ...h.human('takeover'), proof: await h.pinProof() } as never)
      expect(rec.ok, level).toBe(true)
    }
    expect(h.k.ledger.query({ types: ['takeover.failed'], limit: 10 })).toEqual([])
    expect(tradingTypes(h).filter((t) => t !== 'order.cancelled')).toEqual([])
  })
})
