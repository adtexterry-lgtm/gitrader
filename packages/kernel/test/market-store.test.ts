// SPDX-License-Identifier: CPAL-1.0
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Candle } from '@gitrader/protocol'
import { EventBus } from '../src/events'
import { FileCandleStore, attachClosedCandleRecorder } from '../src/market-store'

const c = (t: number): Candle => ({ t, o: t, h: t + 1, l: t - 1, c: t, v: 1 })

let dir: string
let store: FileCandleStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitrader-store-'))
  store = new FileCandleStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)

describe('FileCandleStore', () => {
  it('pathFor 按 venue/symbol/interval 拼路径并清洗非法字符', () => {
    expect(store.pathFor('hyperliquid:BTC', '1h')).toBe(join(dir, 'hyperliquid', 'BTC', '1h.jsonl'))
    expect(store.pathFor('x:A/B', '1h')).toBe(join(dir, 'x', 'A_B', '1h.jsonl'))
  })

  it('record 追加、read 去重升序且后写覆盖', async () => {
    await store.record('hyperliquid:BTC', '1h', [c(1), c(2)])
    await store.record('hyperliquid:BTC', '1h', [{ ...c(2), o: 99 }, c(3)])
    expect(lines(store.pathFor('hyperliquid:BTC', '1h'))).toHaveLength(4)
    const out = await store.read('hyperliquid:BTC', '1h')
    expect(out.map((x) => x.t)).toEqual([1, 2, 3])
    expect(out[1]?.o).toBe(99)
  })

  it('read 支持 from/to 区间与 n 截断，缺文件返回空数组', async () => {
    await store.record('hyperliquid:BTC', '1h', [c(1), c(2), c(3)])
    expect((await store.read('hyperliquid:BTC', '1h', { from: 2, to: 3 })).map((x) => x.t)).toEqual([2])
    expect((await store.read('hyperliquid:BTC', '1h', { n: 2 })).map((x) => x.t)).toEqual([2, 3])
    expect(await store.read('hyperliquid:NOPE', '1h')).toEqual([])
  })

  it('read 跳过坏行不抛错', async () => {
    await store.record('hyperliquid:BTC', '1h', [c(1), c(2)])
    appendFileSync(store.pathFor('hyperliquid:BTC', '1h'), 'not json\n{"t":"x"}\n')
    const out = await store.read('hyperliquid:BTC', '1h')
    expect(out.map((x) => x.t)).toEqual([1, 2])
  })

  it('record 丢弃坏项，v 缺省为 0', async () => {
    const bad = { t: 5, o: NaN, h: 1, l: 1, c: 1, v: 1 } as Candle
    await store.record('hyperliquid:BTC', '1h', [bad, c(6)])
    const path = store.pathFor('hyperliquid:BTC', '1h')
    expect(lines(path)).toHaveLength(1)
    await store.record('hyperliquid:BTC', '1h', [{ t: 7, o: 1, h: 1, l: 1, c: 1 } as Candle])
    const out = await store.read('hyperliquid:BTC', '1h')
    expect(out.find((x) => x.t === 7)?.v).toBe(0)
  })

  it('compact 原子重写为去重升序并返回行数', async () => {
    await store.record('hyperliquid:BTC', '1h', [c(1), c(2)])
    await store.record('hyperliquid:BTC', '1h', [{ ...c(2), o: 99 }, c(3)])
    const before = await store.read('hyperliquid:BTC', '1h')
    expect(await store.compact('hyperliquid:BTC', '1h')).toBe(3)
    expect(lines(store.pathFor('hyperliquid:BTC', '1h'))).toHaveLength(3)
    expect(await store.read('hyperliquid:BTC', '1h')).toEqual(before)
  })

  it('list 还原 instrumentId 与 interval', async () => {
    await store.record('hyperliquid:BTC', '1h', [c(1)])
    await store.record('binance:ETH', '1m', [c(1)])
    const got = await store.list()
    expect(got).toHaveLength(2)
    const pairs = got.map((x) => `${x.instrumentId}|${x.interval}`).sort()
    expect(pairs).toEqual(['binance:ETH|1m', 'hyperliquid:BTC|1h'])
  })
})

describe('attachClosedCandleRecorder', () => {
  it('只录已收盘的 K 线，同 t 替换、更小 t 忽略，退订后不再录', async () => {
    const bus = new EventBus(() => 0)
    const unsubscribe = attachClosedCandleRecorder(bus, store, { onError: () => {} })
    bus.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '1m', candles: [c(1)] })
    bus.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '1m', candles: [{ ...c(1), o: 5 }] })
    bus.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '1m', candles: [c(2)] })
    bus.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '1m', candles: [c(1)] })
    bus.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '1m', candles: [c(3)] })
    await new Promise((r) => setTimeout(r, 20))
    const out = await store.read('hyperliquid:BTC', '1m')
    expect(out.map((x) => [x.t, x.o])).toEqual([[1, 5], [2, 2]])
    unsubscribe()
    bus.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '1m', candles: [c(4)] })
    await new Promise((r) => setTimeout(r, 20))
    expect((await store.read('hyperliquid:BTC', '1m')).map((x) => x.t)).toEqual([1, 2])
  })

  it('形状不对的事件不抛错也不录', async () => {
    const bus = new EventBus(() => 0)
    const unsubscribe = attachClosedCandleRecorder(bus, store)
    expect(() => bus.publish('market.candles', 'oops')).not.toThrow()
    expect(() => bus.publish('market.candles', { instrumentId: 'hyperliquid:BTC', interval: '1m' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))
    unsubscribe()
    expect(await store.read('hyperliquid:BTC', '1m')).toEqual([])
  })
})
