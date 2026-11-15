// SPDX-License-Identifier: CPAL-1.0
// R1-PERF-03：录制库写入对「已有内容」去重（重启后、并发写同一序列都成立），老文件里的重复行照常读出，读走索引。
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Candle } from '@gitrader/protocol'
import { FileCandleStore } from '../src/market-store'

const ID = 'hyperliquid:BTC'
const c = (t: number, o = t): Candle => ({ t, o, h: o + 1, l: o - 1, c: o, v: 1 })
const batch = (from: number, n: number): Candle[] => Array.from({ length: n }, (_, i) => c(from + i))

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gitrader-dedupe-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const rows = (store: FileCandleStore, iv = '1m'): Array<{ t: number; o: number }> =>
  readFileSync(store.pathFor(ID, iv), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: number; o: number })
const dups = (store: FileCandleStore, iv = '1m'): number => { const r = rows(store, iv); return r.length - new Set(r.map((x) => x.t)).size }

describe('R1-PERF-03 录制库写入去重', () => {
  it('两个 FileCandleStore 实例先后对同一目录 record 同一批根（模拟重启）：行数 = 唯一 t 数', async () => {
    const a = new FileCandleStore(dir)
    await a.record(ID, '1m', batch(100, 50))
    const b = new FileCandleStore(dir) // 重启：新实例，没有任何进程内状态
    await b.record(ID, '1m', batch(100, 50))
    await b.record(ID, '1m', batch(120, 50)) // 部分重叠：只新增 150..169 这 20 根
    expect(rows(b)).toHaveLength(70)
    expect(dups(b)).toBe(0)
    expect((await new FileCandleStore(dir).read(ID, '1m')).map((x) => x.t)).toEqual(Array.from({ length: 70 }, (_, i) => 100 + i))
  })

  it('recordNew 也一样：重启后同一批不再追加，返回实际写入根数', async () => {
    const a = new FileCandleStore(dir)
    expect(await a.recordNew(ID, '1m', batch(1, 10))).toBe(10)
    expect(await a.recordNew(ID, '1m', batch(1, 10))).toBe(0)
    const b = new FileCandleStore(dir)
    expect(await b.recordNew(ID, '1m', batch(1, 10))).toBe(0)
    expect(await b.recordNew(ID, '1m', batch(6, 10))).toBe(5)
    expect(rows(b)).toHaveLength(15)
  })

  it('并发两次 record 同一批根（同实例 / 两个实例）：结果无重复行', async () => {
    const a = new FileCandleStore(dir)
    await Promise.all([a.record(ID, '1m', batch(1, 200)), a.record(ID, '1m', batch(1, 200))])
    expect(rows(a)).toHaveLength(200)
    const x = new FileCandleStore(dir)
    const y = new FileCandleStore(dir)
    await Promise.all([x.record(ID, '5m', batch(1, 300)), y.record(ID, '5m', batch(100, 300)), x.record(ID, '5m', batch(1, 400))])
    expect(dups(a, '5m')).toBe(0)
    expect(rows(a, '5m')).toHaveLength(400)
  })

  it('已含重复行的老文件可读（同 t 取最后一行），新写入不再加重复', async () => {
    const store = new FileCandleStore(dir)
    await store.record(ID, '1m', [c(1)]) // 建目录
    const path = store.pathFor(ID, '1m')
    const lines = [c(3), c(1), c(2), c(2, 99), c(3), c(1, 7), c(2, 99)].map((x) => JSON.stringify(x)).join('\n') + '\n'
    writeFileSync(path, lines) // 乱序 + 多处重复 + 修订
    const fresh = new FileCandleStore(dir)
    const got = await fresh.read(ID, '1m')
    expect(got.map((x) => [x.t, x.o])).toEqual([[1, 7], [2, 99], [3, 3]])
    const before = rows(fresh).length
    await fresh.record(ID, '1m', [c(1, 7), c(2, 99), c(3), c(4)]) // 前三根与读出的最终值相同，只有 4 是新的
    expect(rows(fresh).length).toBe(before + 1)
    expect((await fresh.read(ID, '1m')).map((x) => x.t)).toEqual([1, 2, 3, 4])
  })

  it('值不同的同 t 当修订追加（读时后写覆盖，沿用旧语义）', async () => {
    const store = new FileCandleStore(dir)
    await store.record(ID, '1m', [c(1), c(2)])
    await store.record(ID, '1m', [c(2, 50)])
    expect(rows(store)).toHaveLength(3)
    expect((await store.read(ID, '1m')).map((x) => [x.t, x.o])).toEqual([[1, 1], [2, 50]])
  })
})

describe('R1-PERF-03 读走索引', () => {
  it('区间 / n / 缺文件语义与旧实现一致', async () => {
    const store = new FileCandleStore(dir)
    await store.record(ID, '1m', batch(10, 100))
    expect((await store.read(ID, '1m', { from: 20, to: 25 })).map((x) => x.t)).toEqual([20, 21, 22, 23, 24])
    expect((await store.read(ID, '1m', { from: 105 })).map((x) => x.t)).toEqual([105, 106, 107, 108, 109])
    expect((await store.read(ID, '1m', { to: 12 })).map((x) => x.t)).toEqual([10, 11])
    expect((await store.read(ID, '1m', { from: 50, to: 100, n: 3 })).map((x) => x.t)).toEqual([97, 98, 99])
    expect(await store.read(ID, '1m', { n: 0 })).toEqual([])
    expect(await store.read(ID, '1m', { from: 500 })).toEqual([])
    expect(await store.read('hyperliquid:NOPE', '1m')).toEqual([])
    expect(await store.times(ID, '1m', { from: 12, to: 15 })).toEqual([12, 13, 14])
  })

  it('索引建好之后，别的写入方追加的新行 / 把文件换成更短的内容，下一次读都跟得上', async () => {
    const store = new FileCandleStore(dir)
    await store.record(ID, '1m', batch(1, 5))
    expect((await store.read(ID, '1m')).map((x) => x.t)).toEqual([1, 2, 3, 4, 5])
    appendFileSync(store.pathFor(ID, '1m'), batch(6, 3).map((x) => JSON.stringify(x)).join('\n') + '\n')
    expect((await store.read(ID, '1m')).map((x) => x.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    writeFileSync(store.pathFor(ID, '1m'), batch(100, 2).map((x) => JSON.stringify(x)).join('\n') + '\n')
    expect((await store.read(ID, '1m')).map((x) => x.t)).toEqual([100, 101])
  })

  it('文件尾有没写完的残行：新写入补换行不粘连，残行不影响读', async () => {
    const store = new FileCandleStore(dir)
    await store.record(ID, '1m', batch(1, 3))
    appendFileSync(store.pathFor(ID, '1m'), '{"t":4,"o":4,"h"') // 崩在半行
    expect((await store.read(ID, '1m')).map((x) => x.t)).toEqual([1, 2, 3])
    await store.record(ID, '1m', [c(5)])
    expect((await store.read(ID, '1m')).map((x) => x.t)).toEqual([1, 2, 3, 5])
    expect((await new FileCandleStore(dir).read(ID, '1m')).map((x) => x.t)).toEqual([1, 2, 3, 5])
  })

  it('compact 之后索引随之更新', async () => {
    const store = new FileCandleStore(dir)
    await store.record(ID, '1m', [c(1), c(2)])
    await store.record(ID, '1m', [c(2, 9)])
    expect(await store.compact(ID, '1m')).toBe(2)
    expect(rows(store)).toHaveLength(2)
    await store.record(ID, '1m', [c(3)])
    expect((await store.read(ID, '1m')).map((x) => [x.t, x.o])).toEqual([[1, 1], [2, 9], [3, 3]])
  })

  it('大文件：首次读建索引，之后区间读不再随文件大小变慢', async () => {
    const store = new FileCandleStore(dir)
    await store.record(ID, '1m', batch(0, 60_000))
    await store.read(ID, '1m', { from: 0, to: 10 }) // 建索引
    const t0 = performance.now()
    for (let i = 0; i < 50; i++) await store.read(ID, '1m', { from: 30_000 + i, to: 30_000 + i + 1000 })
    const per = (performance.now() - t0) / 50
    expect(per).toBeLessThan(40) // 整文件重读 + 解析 6 万行远大于此；留足余量给负载高的机器
    expect((await store.read(ID, '1m', { from: 59_999, to: 60_001 })).map((x) => x.t)).toEqual([59_999])
  })
})
