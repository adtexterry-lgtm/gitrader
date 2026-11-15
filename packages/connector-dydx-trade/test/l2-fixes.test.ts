// SPDX-License-Identifier: CPAL-1.0
// 批 10 · L2 修复回归（反证用）：
//   · L2-04 —— 广播 HTTP 200 但 tx_response 缺失 / code 缺失 / code=0 却缺 txhash。
//     修前：`res.response.tx_response?.code ?? 0` → 当成功 → ack open。
//     修后：3006 VENUE_OUTCOME_UNKNOWN + ack unknown（按 clientOrderId 对账），撤单同理 ok:false。
//   · L2-05 —— submit 里 loadMarkets / 块高在 try 之外裸抛。
//     修后：一律 ProblemError，带 code（500 → 3003 VENUE_UNAVAILABLE、块高读不出 → 3003）。
//   · L2-12 —— 错误文本里带账户地址。修后错误文本只剩 path 模板（账户段 `***`）。
import { describe, expect, it } from 'vitest'
import type { OrderIntent } from '@gitrader/protocol'
import type { AccountRef, TradeContext } from '@gitrader/protocol/connector'
import { DydxTradeConnector, txOutcomeOf } from '../src/trading'
import { DydxHttp } from '../src/client'
import type { FetchLike } from '../src/client'
import { asProblem } from '../src/errors'
import { FakeDydx } from './helpers/fake-dydx'

const KEY = '11'.repeat(32)

const intent = (o: Record<string, unknown>): OrderIntent => ({
  accountId: 'acc_1',
  instrumentId: 'dydx:BTC-USD',
  side: 'buy',
  type: 'limit',
  ...o,
} as unknown as OrderIntent)

const account = { accountId: 'acc_1', address: 'dydx1owner' } as unknown as AccountRef
const ctx = (): TradeContext => ({ account, signer: {} } as unknown as TradeContext)

function makeFake(extra: Record<string, unknown> = {}): FakeDydx {
  return new FakeDydx({
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
    subaccount: { address: 'dydx1owner', subaccountNumber: 0, equity: '1000', freeCollateral: '900' },
    ...extra,
  })
}

const makeConnector = (fetchImpl: FetchLike): DydxTradeConnector =>
  new DydxTradeConnector({
    privateKey: KEY,
    environment: 'testnet',
    indexerBaseUrl: 'https://indexer.test.local',
    nodeBaseUrl: 'https://node.test.local',
    fetchImpl,
  })

describe('L2-04 广播回执读不懂（缺 tx_response / code / txhash）→ 3006，不许当 open', () => {
  it('200 {}（无 tx_response）：ack unknown + 3006（修前是 open）', async () => {
    const fake = makeFake()
    const c = makeConnector(fake.fetchImpl)
    // 广播请求真的发出去了
    fake.opts.nextTxResponse = {}
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])

    const ack = res.acks[0]!
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.name).toBe('VENUE_OUTCOME_UNKNOWN')
    expect(ack.problem?.code).toBe(3006)
    // 不许报 open（修前 `?? 0` 的后果），也不许报 rejected（会让内核重发）
    expect(ack.status).not.toBe('open')
    expect(ack.status).not.toBe('rejected')
  })

  it('tx_response 存在但 code 缺失：同样 3006', async () => {
    const fake = makeFake()
    const c = makeConnector(fake.fetchImpl)
    fake.opts.nextTxResponse = { tx_response: { codespace: '', raw_log: '', txhash: 'abc' } }
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])

    expect(res.acks[0]!.status).toBe('unknown')
    expect(res.acks[0]!.problem?.code).toBe(3006)
  })

  it('code=0 但缺 txhash：仍然 3006（没有 txhash 就没有链上回执）', async () => {
    const fake = makeFake()
    const c = makeConnector(fake.fetchImpl)
    fake.opts.nextTxResponse = { tx_response: { code: 0, codespace: '', raw_log: '' } }
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])

    expect(res.acks[0]!.status).toBe('unknown')
    expect(res.acks[0]!.problem?.code).toBe(3006)
  })

  it('对照：正常回执（code 0 + txhash）仍是 open', async () => {
    const fake = makeFake()
    const c = makeConnector(fake.fetchImpl)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('open')
    expect(res.acks[0]!.venueOrderId).toBeTruthy()
  })

  it('对照：链上 code≠0 仍是 rejected（已确定失败，不是未知）', async () => {
    const fake = makeFake({ nextCode: 5, nextRawLog: 'insufficient funds' })
    const c = makeConnector(fake.fetchImpl)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('rejected')
    expect(res.acks[0]!.problem?.code).not.toBe(3006)
  })

  it('txOutcomeOf 纯函数：缺 tx_response / code 非数字 / code=0 缺 txhash 都返回 undefined', () => {
    expect(txOutcomeOf(undefined)).toBeUndefined()
    expect(txOutcomeOf({})).toBeUndefined()
    expect(txOutcomeOf({ tx_response: {} })).toBeUndefined()
    expect(txOutcomeOf({ tx_response: { code: Number.NaN, txhash: 'h' } })).toBeUndefined()
    expect(txOutcomeOf({ tx_response: { code: 0 } })).toBeUndefined()
    expect(txOutcomeOf({ tx_response: { code: 0, txhash: 'h' } })).toMatchObject({ code: 0, txhash: 'h' })
    // code≠0 时 txhash 缺失不算「不可读」（失败已确定，靠 raw_log 分类）
    expect(txOutcomeOf({ tx_response: { code: 5, raw_log: 'boom' } })).toMatchObject({ code: 5 })
  })
})

describe('L2-05 下单前的读失败不许裸抛：loadMarkets / 块高都要归一成带 code 的 Problem', () => {
  it('perpetualMarkets 500 → ProblemError(3003)，不是裸 DydxHttpError', async () => {
    const fake = makeFake()
    const fetching = async (url: string, init?: { method?: string; body?: string }) =>
      url.includes('/v4/perpetualMarkets')
        ? { ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } }
        : fake.fetchImpl(url, init)
    const c = makeConnector(fetching as never)

    let thrown: unknown
    try {
      await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    const problem = asProblem(thrown)
    expect(problem?.code).toBe(3003)
    expect(problem?.name).toBe('VENUE_UNAVAILABLE')
    // 反证：不许是无 code 的裸异常（修前是 DydxHttpError 直接逃出 submit）
    expect((thrown as { name?: string }).name).toBe('ProblemError')
  })

  it('perpetualMarkets 断连 → ProblemError(3003)，不是裸 DydxNetworkError', async () => {
    const fake = makeFake()
    const fetching = async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/v4/perpetualMarkets')) throw new TypeError('fetch failed')
      return fake.fetchImpl(url, init)
    }
    const c = makeConnector(fetching as never)

    await expect(c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })]))
      .rejects.toMatchObject({ name: 'ProblemError', problem: { code: 3003 } })
  })

  it('块高读不出（height=0）→ ProblemError(3003)，不是裸 Error', async () => {
    const fake = makeFake({ height: 0 })
    const c = makeConnector(fake.fetchImpl)

    await expect(c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })]))
      .rejects.toMatchObject({ name: 'ProblemError', problem: { code: 3003 } })
  })

  it('对照：市场参数正常时照常放行（读失败归一化没有把正常路径拦死）', async () => {
    const fake = makeFake()
    const c = makeConnector(fake.fetchImpl)
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])
    expect(res.acks[0]!.status).toBe('open')
  })
})

describe('L2-12 错误文本不带账户地址（只剩 path 模板）', () => {
  const CANARY = 'CANARY-L2-7f3a91'

  it('accountState 500：错误文本里没有地址，只有 /v4/addresses/***/subaccountNumber/0', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } })
    const http = new DydxHttp({ indexerBaseUrl: 'https://indexer.test.local', nodeBaseUrl: 'https://node.test.local', fetchImpl: fetchImpl as never })
    const ref = { accountId: 'acc_1', address: CANARY as never } as unknown as AccountRef

    let message = ''
    try {
      await http.indexerGet(`/v4/addresses/${CANARY}/subaccountNumber/0`)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toContain(CANARY)
    expect(message).toContain('/v4/addresses/***/subaccountNumber/0')
    // 账户读的公开入口（accountState）走同一条路径：抛出来的错误文本同样不含地址
    const c = makeConnector(fetchImpl as never)
    let stateMessage = ''
    try {
      await c.accountState(ref)
    } catch (e) {
      stateMessage = (e as Error).message
    }
    expect(stateMessage).not.toContain(CANARY)
    expect(stateMessage).toContain('/v4/addresses/***/subaccountNumber/0')
  })

  it('查询参数里的 address 也被抹掉，其余参数保留', async () => {
    const seen: string[] = []
    const fetchImpl = async (url: string) => {
      seen.push(url)
      return { ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } }
    }
    const http = new DydxHttp({ indexerBaseUrl: 'https://indexer.test.local', nodeBaseUrl: 'https://node.test.local', fetchImpl: fetchImpl as never })
    let message = ''
    try {
      await http.indexerGet('/v4/orders', { address: CANARY, subaccountNumber: 0, limit: 50 })
    } catch (e) {
      message = (e as Error).message
    }
    expect(seen[0]).toContain(CANARY) // 真的发给了场所（脱敏只发生在错误文本）
    expect(message).not.toContain(CANARY)
    expect(message).toContain('address=***')
    expect(message).toContain('limit=50')
  })

  it('node 的 /cosmos/auth/v1beta1/accounts/<addr> 也被抹掉', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down', headers: { get: () => null } })
    const http = new DydxHttp({ indexerBaseUrl: 'https://indexer.test.local', nodeBaseUrl: 'https://node.test.local', fetchImpl: fetchImpl as never })
    let message = ''
    try {
      await http.nodeGet(`/cosmos/auth/v1beta1/accounts/${CANARY}`)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toContain(CANARY)
    expect(message).toContain('/cosmos/auth/v1beta1/accounts/***')
  })
})

describe('L2-04b 3006 分支的场所原文先脱敏（回显私钥不许进 ack）', () => {
  it('下单：回包回显 KEY → 3006，ack JSON 不含 KEY', async () => {
    const fake = makeFake()
    const c = makeConnector(fake.fetchImpl)
    fake.opts.nextTxResponse = { echo: KEY }
    const res = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc' })])

    const ack = res.acks[0]!
    expect(ack.status).toBe('unknown')
    expect(ack.problem?.code).toBe(3006)
    expect(JSON.stringify(ack)).not.toContain(KEY)
  })

  it('撤单：回包回显 KEY → ok false + 3006，ack JSON 不含 KEY', async () => {
    const fake = makeFake()
    const c = makeConnector(fake.fetchImpl)
    const placed = await c.submit(ctx(), [intent({ price: '20000', size: '0.01', tif: 'ioc', clientOrderId: '11112222333344445555666677778888' })])
    expect(placed.acks[0]!.status).toBe('open')

    fake.opts.nextTxResponse = { echo: KEY }
    const acks = await c.cancel(ctx(), [{
      instrumentId: 'dydx:BTC-USD' as never,
      clientOrderId: '11112222333344445555666677778888' as never,
    }])

    const ack = acks[0]!
    expect(ack.ok).toBe(false)
    expect(ack.problem?.code).toBe(3006)
    expect(JSON.stringify(ack)).not.toContain(KEY)
  })
})
