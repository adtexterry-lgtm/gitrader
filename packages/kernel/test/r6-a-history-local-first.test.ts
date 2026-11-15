// SPDX-License-Identifier: CPAL-1.0
// R1-PERF-01：host.market.history 带 from 的区间请求本地优先、只补缺口（localFirstHistory）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Candle } from '@gitrader/protocol'
import { localFirstHistory } from '../src/market-history'
import type { HistorySource } from '../src/market-history'
import { FileCandleStore } from '../src/market-store'

const ID = 'hyperliquid:BTC'
const M = 60_000
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % M) // 对齐到分钟
const NOW = T0 + 10_000 * M + 30_000 // 当前处在第 10000 根的中间：第 10000 根还在形成
const bar = (i: number, o = 100 + i): Candle => ({ t: T0 + i * M, o, h: o + 1, l: o - 1, c: o, v: 1 })
const bars = (a: number, b: number, o?: (i: number) => number): Candle[] => Array.from({ length: b - a }, (_, k) => bar(a + k, o?.(a + k)))

let dir: string
let store: FileCandleStore
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gitrader-lf-')); store = new FileCandleStore(dir) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 假场所：按 from/to（闭区间）切自己的数据；记下每次请求；可注入延迟 / 报错。 */
function venue(data: Candle[], opt: { delay?: number; fail?: boolean; marker?: number } = {}) {
  const calls: Array<{ from?: number; to?: number }> = []
  const src: HistorySource = {
    venue: 'hyperliquid',
    async candles(_id, _iv, o = {}) {
      calls.push({ ...(o.from !== undefined ? { from: o.from } : {}), ...(o.to !== undefined ? { to: o.to } : {}) })
      if (opt.delay) await new Promise((r) => setTimeout(r, opt.delay))
      if (opt.fail) throw new Error('venue down')
      return data.filter((c) => (o.from === undefined || c.t >= o.from) && (o.to === undefined || c.t <= o.to)).map((c) => ({ ...c, o: opt.marker ?? c.o }))
    },
  }
  return { src, calls }
}
const ask = (src: HistorySource, from: number, to: number | undefined, n = 5000, now = NOW) =>
  localFirstHistory({ store, src, now }, ID, '1m', n, from, to)
const lines = (): Array<{ t: number; o: number }> => readFileSync(store.pathFor(ID, '1m'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: number; o: number })

describe('localFirstHistory', () => {
  it('库里齐了：只用本地数据，不发场所请求，source = store，区间是 [from, to)', async () => {
    await store.record(ID, '1m', bars(0, 100))
    const v = venue(bars(0, 100))
    const r = await ask(v.src, T0 + 10 * M, T0 + 60 * M)
    expect(v.calls).toHaveLength(0)
    expect(r).toMatchObject({ source: 'store', complete: true })
    expect(r!.candles.map((c) => c.t)).toEqual(bars(10, 60).map((c) => c.t))
  })

  it('from 不在格点上：从下一个格点算起', async () => {
    await store.record(ID, '1m', bars(0, 30))
    const v = venue([])
    const r = await ask(v.src, T0 + 10 * M - 5, T0 + 20 * M)
    expect(v.calls).toHaveLength(0)
    expect(r!.candles.map((c) => c.t)).toEqual(bars(10, 20).map((c) => c.t))
  })

  it('有缺口：只拉缺的那段，库里已有的根不被场所数据替换，只录新拉到的根，source = venue+store，不留重复行', async () => {
    await store.record(ID, '1m', bars(0, 90))
    const v = venue(bars(0, 100), { marker: 777 }) // 场所对每根都回 o=777（与库里的值不同）
    const r = await ask(v.src, T0, T0 + 100 * M)
    expect(v.calls).toEqual([{ from: T0 + 90 * M, to: T0 + 99 * M }]) // 只请求 90..99 这一段
    expect(r!.source).toBe('hyperliquid+store')
    expect(r!.candles).toHaveLength(100)
    expect(r!.candles.slice(0, 90).every((c) => c.o !== 777)).toBe(true) // 已有的 90 根是库里的值
    expect(r!.candles.slice(90).every((c) => c.o === 777)).toBe(true)
    expect(lines()).toHaveLength(100)
    expect(new Set(lines().map((x) => x.t)).size).toBe(100)
    // 第二次同样的请求：库里齐了，不再发请求
    const again = await ask(v.src, T0, T0 + 100 * M)
    expect(v.calls).toHaveLength(1)
    expect(again!.source).toBe('store')
  })

  it('缺口在中间和两头：一次请求覆盖第一个到最后一个缺口，中间已有的根仍以库为准', async () => {
    await store.record(ID, '1m', [...bars(5, 40), ...bars(45, 80)])
    const v = venue(bars(0, 100), { marker: 555 })
    const r = await ask(v.src, T0, T0 + 100 * M)
    expect(v.calls).toEqual([{ from: T0, to: T0 + 99 * M }])
    expect(r!.candles).toHaveLength(100)
    const byT = new Map(r!.candles.map((c) => [c.t, c.o]))
    expect(byT.get(T0 + 10 * M)).toBe(110) // 库里的
    expect(byT.get(T0 + 2 * M)).toBe(555) // 缺口补进来的
    expect(byT.get(T0 + 42 * M)).toBe(555)
    expect(lines()).toHaveLength(100)
  })

  it('形成中的那根不进结果也不进库：to 在未来时，库里已收盘的齐了就不碰场所', async () => {
    await store.record(ID, '1m', bars(0, 10_000)) // 第 0..9999 根已收盘
    const v = venue(bars(0, 10_001))
    const r = await ask(v.src, T0 + 9_990 * M, T0 + 20_000 * M)
    expect(v.calls).toHaveLength(0)
    expect(r!.candles.map((c) => c.t)).toEqual(bars(9_990, 10_000).map((c) => c.t))
    expect(r!.complete).toBe(true)
  })

  it('没给 to：到最后一根已收盘的为止', async () => {
    await store.record(ID, '1m', bars(0, 10_000))
    const v = venue([])
    const r = await ask(v.src, T0 + 9_995 * M, undefined)
    expect(r!.candles.map((c) => c.t)).toEqual(bars(9_995, 10_000).map((c) => c.t))
  })

  it('一页最多 limit 个格点，complete 到最后一页才为真；引擎按「最后一根 t + 1」翻页能拼回整段', async () => {
    await store.record(ID, '1m', bars(0, 12))
    const v = venue([])
    const got: number[] = []
    let from = T0
    for (let page = 0; page < 10; page++) {
      const r = await ask(v.src, from, T0 + 12 * M, 5)
      got.push(...r!.candles.map((c) => c.t))
      if (r!.complete) break
      from = r!.candles[r!.candles.length - 1]!.t + 1
    }
    expect(got).toEqual(bars(0, 12).map((c) => c.t))
    expect(v.calls).toHaveLength(0)
  })

  it('长窗口：每页只补本页的缺口；翻完整段后库里齐全、无重复', async () => {
    const v = venue(bars(0, 12_000).filter((c) => c.t < NOW))
    let from = T0
    const got: number[] = []
    for (let page = 0; page < 10; page++) {
      const r = await ask(v.src, from, T0 + 9_000 * M, 4000)
      got.push(...r!.candles.map((c) => c.t))
      if (r!.complete) break
      from = r!.candles[r!.candles.length - 1]!.t + 1
    }
    expect(got).toEqual(bars(0, 9_000).map((c) => c.t))
    expect(v.calls).toHaveLength(3) // 4000 + 4000 + 1000
    expect(lines()).toHaveLength(9_000)
    expect((await ask(v.src, T0, T0 + 9_000 * M, 4000))!.source).toBe('store')
    expect(v.calls).toHaveLength(3)
  })

  it('标的上市在窗口起点之后：整页没数据就往后翻，不会提前报「没有更多」', async () => {
    const v = venue(bars(7_000, 7_050))
    const r = await ask(v.src, T0, T0 + 8_000 * M, 1000)
    expect(r!.candles.map((c) => c.t)).toEqual(bars(7_000, 7_050).map((c) => c.t))
    expect(r!.source).toBe('hyperliquid+store')
  })

  it('场所报错：本页有本地数据就给本地的（source = store），一根都没有就原样抛场所的错', async () => {
    await store.record(ID, '1m', bars(0, 50))
    const down = venue([], { fail: true })
    const r = await ask(down.src, T0, T0 + 100 * M)
    expect(r!.source).toBe('store')
    expect(r!.candles).toHaveLength(50)
    await expect(ask(down.src, T0 + 500 * M, T0 + 600 * M)).rejects.toThrow('venue down')
  })

  it('两路并发补同一个缺口：场所只请求一次，库里没有重复行', async () => {
    await store.record(ID, '1m', bars(0, 90))
    const v = venue(bars(0, 100), { delay: 40 })
    const [a, b] = await Promise.all([ask(v.src, T0, T0 + 100 * M), ask(v.src, T0, T0 + 100 * M)])
    expect(v.calls).toHaveLength(1)
    expect(a!.candles).toHaveLength(100)
    expect(b!.candles).toHaveLength(100)
    expect(lines()).toHaveLength(100)
  })

  it('帮不上就回 null（调用方走原来的先打场所路径）：区间里还没有已收盘格点 / 参数不是有限数', async () => {
    const v = venue([])
    expect(await ask(v.src, T0 + 10_000 * M, T0 + 10_005 * M)).toBeNull() // 全在形成中的那一根里
    expect(await ask(v.src, T0 + 100 * M, T0 + 100 * M)).toBeNull() // 空区间
    expect(await ask(v.src, Number.NaN, T0 + 100 * M)).toBeNull()
    expect(v.calls).toHaveLength(0)
  })
})
