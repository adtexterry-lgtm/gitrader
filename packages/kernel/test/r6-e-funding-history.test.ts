// SPDX-License-Identifier: CPAL-1.0
// R3-07：host.market.fundingHistory（GEP 宿主方法）取自场所连接器的公开资金费历史。用假连接器覆盖：拿到、拿不到、部分缺失。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FundingRatePoint } from '../src/proto'
import { makeProblem } from '../src/proto'
import { fundingHistoryFor } from '../src/funding'
import { KernelError } from '../src/util/errors'
import { BTC } from './helpers/fake-connector'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const H = 3_600_000
const T0 = 1_700_000_000_000
const pt = (i: number, rate = '0.0000125'): FundingRatePoint => ({ instrumentId: BTC as never, t: (T0 + i * H) as never, rate: rate as never })

/** 只实现 marketSource 的最小总线：venue -> 连接器。 */
const busOf = (map: Record<string, unknown>) => ({ marketSource: (venue: string) => map[venue] as never })
const fakeVenue = (venue: string, fundingHistory?: unknown) => ({ venue, ...(fundingHistory ? { fundingHistory } : {}) })

describe('R3-07 fundingHistoryFor：拿到', () => {
  it('把连接器的公开资金费点按时间升序、去重返回，区间外的多余行丢掉，complete=true', async () => {
    const calls: unknown[] = []
    const bus = busOf({ hyperliquid: fakeVenue('hyperliquid', async (id: string, opts: unknown) => { calls.push([id, opts]); return [pt(3), pt(1), pt(1), pt(2), pt(-1), pt(9)] }) })
    const r = await fundingHistoryFor(bus, { instrumentId: BTC, from: T0, to: T0 + 5 * H })
    expect(r).toEqual({ points: [pt(1), pt(2), pt(3)], complete: true })
    expect(calls).toEqual([[BTC, { from: T0, to: T0 + 5 * H }]])
  })

  it('to 缺省时不替连接器编一个终点', async () => {
    const seen: unknown[] = []
    const bus = busOf({ hyperliquid: fakeVenue('hyperliquid', async (_id: string, opts: unknown) => { seen.push(opts); return [pt(1)] }) })
    expect((await fundingHistoryFor(bus, { instrumentId: BTC, from: T0 })).points).toEqual([pt(1)])
    expect(seen).toEqual([{ from: T0 }])
  })
})

describe('R3-07 fundingHistoryFor：拿不到（如实报错，回测据此降级，不补零）', () => {
  it('场所没有公开资金费历史 -> CAPABILITY_UNSUPPORTED', async () => {
    await expect(fundingHistoryFor(busOf({ hyperliquid: fakeVenue('hyperliquid') }), { instrumentId: BTC, from: T0 })).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED' } })
  })

  it('没有这个行情源 -> DATA_UNAVAILABLE', async () => {
    await expect(fundingHistoryFor(busOf({}), { instrumentId: BTC, from: T0 })).rejects.toMatchObject({ problem: { name: 'DATA_UNAVAILABLE' } })
  })

  it('上游报错（不可达 / 限流）原样抛出，不吞成空列表', async () => {
    const down = new KernelError(makeProblem('VENUE_UNAVAILABLE', 'hyperliquid fundingHistory HTTP 503'))
    const bus = busOf({ hyperliquid: fakeVenue('hyperliquid', async () => { throw down }) })
    await expect(fundingHistoryFor(bus, { instrumentId: BTC, from: T0 })).rejects.toBe(down)
  })

  it.each([
    [{ instrumentId: 'BTC', from: T0 }, 'venue:SYMBOL'],
    [{ instrumentId: BTC }, 'from'],
    [{ instrumentId: BTC, from: -1 }, 'from'],
    [{ instrumentId: BTC, from: 1.5 }, 'from'],
    [{ instrumentId: BTC, from: T0, to: T0 - 1 }, 'to'],
    [{ instrumentId: BTC, from: T0, to: 'x' }, 'to'],
  ])('参数不合法 %j -> INVALID_PARAMS，且不去问连接器', async (params, what) => {
    let asked = 0
    const bus = busOf({ hyperliquid: fakeVenue('hyperliquid', async () => { asked++; return [] }) })
    await expect(fundingHistoryFor(bus, params)).rejects.toMatchObject({ problem: { name: 'INVALID_PARAMS', message: expect.stringContaining(what) } })
    expect(asked).toBe(0)
  })
})

describe('R3-07 fundingHistoryFor：部分缺失', () => {
  it('费率或时间不合法的行丢掉并标 complete=false，其余照给', async () => {
    const bad = [{ instrumentId: BTC, t: T0 + 4 * H, rate: 'oops' }, { instrumentId: BTC, rate: '0.1' }, { instrumentId: BTC, t: T0 + 5 * H, rate: '' }, null]
    const bus = busOf({ hyperliquid: fakeVenue('hyperliquid', async () => [pt(1), ...bad, pt(2)]) })
    expect(await fundingHistoryFor(bus, { instrumentId: BTC, from: T0 })).toEqual({ points: [pt(1), pt(2)], complete: false })
  })

  it('连接器给了空列表：返回空点（complete=true 只表示没丢行），由引擎写 no funding points in range 并降级', async () => {
    const bus = busOf({ hyperliquid: fakeVenue('hyperliquid', async () => []) })
    expect(await fundingHistoryFor(bus, { instrumentId: BTC, from: T0 })).toEqual({ points: [], complete: true })
  })
})

describe('R3-07 经 GepHost 的 host.market.fundingHistory', () => {
  let h: Harness
  beforeEach(async () => { h = await makeHarness() })
  afterEach(async () => { await h.cleanup() })
  const hostCall = (params: Record<string, unknown>): Promise<unknown> =>
    (h.k.gep as unknown as { hostMethod(conn: unknown, method: string, params: unknown): Promise<unknown> }).hostMethod({}, 'host.market.fundingHistory', params)

  it('hyperliquid 行情源有资金费历史：点原样回给引擎', async () => {
    Object.assign(h.live, { fundingHistory: async () => [pt(2), pt(1)] })
    expect(await hostCall({ instrumentId: BTC, from: T0, to: T0 + 3 * H })).toEqual({ points: [pt(1), pt(2)], complete: true })
  })

  it('没有资金费历史的行情源（假连接器、内核模拟场所）：CAPABILITY_UNSUPPORTED', async () => {
    await expect(hostCall({ instrumentId: BTC, from: T0 })).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED' } })
    await expect(hostCall({ instrumentId: 'nowhere:X', from: T0 })).rejects.toMatchObject({ problem: { name: 'CAPABILITY_UNSUPPORTED' } })
  })
})
