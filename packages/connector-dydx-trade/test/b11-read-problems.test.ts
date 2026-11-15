// SPDX-License-Identifier: CPAL-1.0
// 批 11 主题二 ①（dYdX 读方法归一 + 脱敏）的回归：
//   · 修前：accountState / openOrders / fills / orderStatus / startupSnapshot / loadMarkets 直接抛
//     DydxHttpError / DydxNetworkError —— 内核只认 ProblemError.problem.code，等于读失败没有分类；
//     client.ts 的 pathOf 只抹 path，上游 body 回显账户地址时地址照样进错误文本。
//   · 修后：一律 ProblemError（3003 / 3005 / 3006 / 1005 按状态码分类），文本里既有端点模板又不含地址。
import { describe, expect, it } from 'vitest'
import type { Problem } from '@gitrader/protocol'
import type { AccountRef } from '@gitrader/protocol/connector'
import { DydxTradeConnector } from '../src/trading'
import type { FetchLike } from '../src/client'
import { FakeDydx } from './helpers/fake-dydx'

const KEY = '22'.repeat(32)
/** 金丝雀：只出现在 account.address 里，任何错误文本/ack 里都不许出现。 */
const ADDR = 'CANARY-B11-DYDX-ADDR-9c41'

const ref = { accountId: 'acc_1', address: ADDR } as unknown as AccountRef

const connector = (fetchImpl: FetchLike): DydxTradeConnector =>
  new DydxTradeConnector({
    privateKey: KEY,
    environment: 'testnet',
    indexerBaseUrl: 'https://indexer.test.local',
    nodeBaseUrl: 'https://node.test.local',
    fetchImpl,
  })

const account = (): FakeDydx => new FakeDydx({
  chainId: 'dydx-testnet-4',
  accountNumber: 9,
  height: 1000,
  sequence: 3,
  markets: {
    'BTC-USD': {
      clobPairId: 0,
      atomicResolution: -10,
      quantumConversionExponent: -9,
      stepBaseQuantums: 1_000_000,
      subticksPerTick: 100_000,
      oraclePrice: '20000',
      tickSize: '1',
      stepSize: '0.0001',
    },
  },
  subaccount: { address: ADDR, subaccountNumber: 0, equity: '1000', freeCollateral: '900' },
})

/** 固定状态码 + 可回显 body 的 fetch。 */
const failing = (status: number, body = 'boom', headers: Record<string, string> = {}): FetchLike =>
  (async () => ({
    ok: false,
    status,
    text: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  })) as unknown as FetchLike

/** 断连（fetch 直接 reject）→ DydxNetworkError。 */
const down = (async () => { throw new TypeError('fetch failed') }) as unknown as FetchLike

async function problemOf(fn: () => Promise<unknown>): Promise<{ error: Error & { problem?: Problem }; json: string }> {
  try {
    await fn()
  } catch (e) {
    const error = e as Error & { problem?: Problem }
    return { error, json: JSON.stringify(error) }
  }
  throw new Error('expected the read to reject')
}

describe('读方法归一成 ProblemError（修前是裸 DydxHttpError / DydxNetworkError）', () => {
  it('accountState 500 → ProblemError(3003)，文本有端点模板、无地址', async () => {
    const c = connector(failing(500))
    const { error } = await problemOf(() => c.accountState(ref))

    expect(error.name).toBe('ProblemError')
    expect(error.problem?.code).toBe(3003)
    expect(error.problem?.name).toBe('VENUE_UNAVAILABLE')
    expect(error.problem?.retryable).toBe(true)
    expect(error.message).toContain('GET /v4/addresses/***/subaccountNumber/0')
    expect(error.message).not.toContain(ADDR)
  })

  it('openOrders 500 且 body 回显地址 → 地址仍不进错误文本（path 模板 + body 双脱敏）', async () => {
    const c = connector(failing(500, JSON.stringify({ errors: { address: ADDR, reason: 'boom' } })))
    const { error, json } = await problemOf(() => c.openOrders(ref))

    expect(error.name).toBe('ProblemError')
    expect(error.problem?.code).toBe(3003)
    expect(error.message).toContain('GET /v4/orders')
    expect(error.message).toContain('address=***')
    expect(json).not.toContain(ADDR)
  })

  it('fills 断连 → ProblemError(3003 VENUE_UNAVAILABLE)，不是裸 DydxNetworkError', async () => {
    const c = connector(down)
    const { error } = await problemOf(() => c.fills(ref, 0))

    expect(error.name).toBe('ProblemError')
    expect(error.problem?.code).toBe(3003)
    expect(error.message).not.toContain(ADDR)
  })

  it('orderStatus 401 → ProblemError(3005 VENUE_AUTH)，不可重试', async () => {
    const c = connector(failing(401, 'unauthorized'))
    const { error } = await problemOf(() => c.orderStatus(ref, { clientOrderId: 'abcdef0123456789abcdef0123456789' }))

    expect(error.name).toBe('ProblemError')
    expect(error.problem?.code).toBe(3005)
    expect(error.problem?.name).toBe('VENUE_AUTH')
    expect(error.problem?.retryable).toBe(false)
  })

  it('startupSnapshot 500 → ProblemError(3003)（三个读里任一失败都归一）', async () => {
    const c = connector(failing(500))
    const { error } = await problemOf(() => c.startupSnapshot(ref, 0))

    expect(error.name).toBe('ProblemError')
    expect(error.problem?.code).toBe(3003)
    expect(error.message).not.toContain(ADDR)
  })

  it('loadMarkets 500 → ProblemError(3003)（直连调用也不再裸抛）', async () => {
    const c = connector(failing(500))
    const { error } = await problemOf(() => c.loadMarkets(true))

    expect(error.name).toBe('ProblemError')
    expect(error.problem?.code).toBe(3003)
    expect(error.message).toContain('GET /v4/perpetualMarkets')
  })

  it('429 → 3003 + retryable + retryAfterMs（读数也带限流信息）', async () => {
    const c = connector(failing(429, 'slow down', { 'retry-after': '2' }))
    const { error } = await problemOf(() => c.accountState(ref))

    expect(error.problem?.code).toBe(3003)
    expect(error.problem?.retryable).toBe(true)
    expect(error.problem?.retryAfterMs).toBe(2000)
  })

  it('accountState 404 → 仍是 ACCOUNT_NOT_BOUND(1005)，不被二次包裹成 3003', async () => {
    const c = connector(failing(404, 'not found'))
    const { error } = await problemOf(() => c.accountState(ref))

    expect(error.name).toBe('ProblemError')
    expect(error.problem?.code).toBe(1005)
    expect(error.problem?.name).toBe('ACCOUNT_NOT_BOUND')
    expect(error.message).not.toContain(ADDR)
  })
})

describe('对照：归一化没有把正常读路径拦死', () => {
  it('假场所：accountState / openOrders / fills / orderStatus / startupSnapshot 照常返回', async () => {
    const fake = account()
    const c = connector(fake.fetchImpl)

    const state = await c.accountState(ref)
    expect(state.balances[0]!.total).toBe('1000')
    await expect(c.openOrders(ref)).resolves.toBeInstanceOf(Array)
    await expect(c.fills(ref, 0)).resolves.toBeInstanceOf(Array)
    await expect(c.orderStatus(ref, { venueOrderId: 'unknown-id' })).resolves.toMatchObject({ found: false })
    const snap = await c.startupSnapshot(ref, 0)
    expect(snap.account.balances[0]!.accountId).toBe('acc_1')
  })
})
