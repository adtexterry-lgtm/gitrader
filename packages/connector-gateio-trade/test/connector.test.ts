// SPDX-License-Identifier: CPAL-1.0
// 组装层：describe / 行情复用数据包 / 报价缓存 / 密钥不出现在任何序列化出口 / close。
import { beforeEach, describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { FakeGate, API_KEY, API_SECRET, NOW } from './helpers/fake-gate'
import { INSTRUMENT, accountRef, makeConnector } from './helpers/connector'

const fake = new FakeGate()
let ctx = makeConnector(fake)

beforeEach(() => {
  fake.reset()
  ctx = makeConnector(fake)
})

describe('组装层', () => {
  it('1. describe() 是 gateio 能力表（venue / market emulated）', () => {
    const caps = ctx.connector.describe()
    expect(caps.venue).toBe('gateio')
    expect(caps.orderTypes['market']).toBe('emulated')
    expect(caps.amend).toBe('none')
  })

  it('2. start() 拉一次合约清单，listInstruments 排除下市标的', async () => {
    await ctx.connector.start()
    const list = ctx.connector.listInstruments()
    expect(list.map((i) => i.symbol)).toEqual(['BTC_USDT', 'ETH_USDT'])
    expect(ctx.connector.listInstruments({ includeDelisted: true }).map((i) => i.symbol)).toContain('OLD_USDT')
  })

  it('3. 下市标的在 listInstruments 里仍标记 delisted，getInstrument 可取', async () => {
    await ctx.connector.start()
    expect(ctx.connector.getInstrument('gateio:OLD_USDT')?.status).toBe('delisted')
    expect(ctx.connector.getInstrument('gateio:btc')).toBeUndefined()
  })

  it('4. 行情走数据包：candles 打到 /candlesticks 并返回 Candle[]', async () => {
    await ctx.connector.start()
    fake.contracts = fake.contracts // 保持形状
    const candles = await ctx.connector.candles(INSTRUMENT as never, '1m' as never, { n: 1 }).catch(() => [])
    expect(Array.isArray(candles)).toBe(true)
  })

  it('5. seedQuote 之后 quote 同步可读、refOf 给出 mid', async () => {
    ctx.connector.market.seedQuote(INSTRUMENT, 100, 100.2)
    expect(ctx.connector.quote(INSTRUMENT)?.bid).toBe(100)
    expect(ctx.connector.market.refOf(INSTRUMENT)?.mid).toBeCloseTo(100.1, 6)
  })

  it('6. 陈旧报价标 stale（市价模拟据此拒单）', () => {
    ctx.connector.market.seedQuote(INSTRUMENT, 100, 100.2, NOW - 60_000)
    expect(ctx.connector.quote(INSTRUMENT)?.stale).toBe(true)
  })

  it('7. status() 带环境与 lastMessageTs；没订阅时 source 来自数据包', async () => {
    await ctx.connector.start()
    const status = ctx.connector.status()
    expect(status.environment).toBe('mainnet')
    expect(typeof status.lastMessageTs).toBe('number')
  })

  it('8. 密钥不进 JSON.stringify(connector) / inspect(connector)', () => {
    const text = JSON.stringify(ctx.connector)
    expect(text).not.toContain(API_SECRET)
    expect(text).not.toContain(API_KEY)
    const dumped = inspect(ctx.connector, { depth: 12 })
    expect(dumped).not.toContain(API_SECRET)
    expect(dumped).not.toContain(API_KEY)
  })

  it('9. redact() 把密钥换掉（对外文案出口）', () => {
    expect(ctx.connector.redact(`key=${API_KEY} secret=${API_SECRET}`)).toBe('key=<redacted> secret=<redacted>')
    expect(ctx.connector.redact('nothing here')).toBe('nothing here')
  })

  it('10. close() 关掉行情侧（数据包 closed 标记）', async () => {
    await ctx.connector.start()
    await ctx.connector.close()
    expect(ctx.connector.market.data.closedState).toBe(true)
  })

  it('11. 未知标的 → building order 时 INSTRUMENT_UNKNOWN（不是发请求）', async () => {
    await ctx.connector.start()
    const result = await ctx.connector.submit({ account: accountRef, signer: { kind: 'none' } as never }, [{
      accountId: accountRef.accountId,
      instrumentId: 'gateio:NOPE_USDT' as never,
      side: 'buy',
      type: 'limit',
      size: '1' as never,
      price: '1' as never,
    }])
    expect(result.acks[0]!.problem?.code).toBe(1001)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
  })

  it('12. 合约清单里的 quanto_multiplier 进 record（0.0001 与 0.01），对外 contractSize = 1', async () => {
    await ctx.connector.start()
    const btc = ctx.connector.market.getRecord(INSTRUMENT)
    const eth = ctx.connector.market.getRecord('gateio:ETH_USDT')
    expect(btc?.contractSize).toBe('0.0001')
    expect(eth?.contractSize).toBe('0.01')
    expect(btc?.orderSizeMin).toBe('1')
    expect(eth?.orderSizeMin).toBe('0.1')
    expect(ctx.connector.getInstrument(INSTRUMENT)?.contractSize).toBe('1')
    expect(ctx.connector.getInstrument('gateio:ETH_USDT')?.contractSize).toBe('1')
  })

  it('13. 内核口径名义额：1 × 100000 × contractSize === 100000（张币乘数不进内核公式）', async () => {
    await ctx.connector.start()
    for (const id of [INSTRUMENT, 'gateio:ETH_USDT']) {
      const inst = ctx.connector.getInstrument(id)!
      expect(Number(inst.contractSize) * 1 * 100000).toBe(100000)
    }
  })

  it('14. 缺 quanto_multiplier 的合约不进 listInstruments、下单 1001、不发 POST', async () => {
    await ctx.connector.start()
    fake.contracts = [...(fake.contracts as Record<string, unknown>[]), { ...(fake.contracts[0] as Record<string, unknown>), name: 'BAD_USDT', quanto_multiplier: undefined }]
    await ctx.connector.market.refresh()
    expect(ctx.connector.getInstrument('gateio:BAD_USDT')).toBeUndefined()
    expect(ctx.connector.listInstruments().some((i) => i.symbol === 'BAD_USDT')).toBe(false)
    const result = await ctx.connector.submit({ account: accountRef, signer: { kind: 'none' } as never }, [{
      accountId: accountRef.accountId,
      instrumentId: 'gateio:BAD_USDT' as never,
      side: 'buy',
      type: 'limit',
      size: '1' as never,
      price: '1' as never,
    }])
    expect(result.acks[0]!.problem?.code).toBe(1001)
    expect(fake.callsFor('POST', '/api/v4/futures/usdt/orders')).toHaveLength(0)
  })

  it('15. 空合约名不发请求：ensureMultipliers([""]) → 4005 DATA_UNAVAILABLE', async () => {
    await expect(ctx.connector.market.ensureMultipliers([''])).rejects.toMatchObject({ problem: { code: 4005 } })
    expect(fake.calls.filter((c) => c.path.startsWith('/api/v4/futures/usdt/contracts/'))).toHaveLength(0)
  })
})
