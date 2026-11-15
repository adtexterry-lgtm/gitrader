// SPDX-License-Identifier: CPAL-1.0
// 从 早期 Demo 原型 的快照派生 HIP-3 夹具（离线，不联网）。
//   node fixtures/derive-from-demo.mjs [demo-snapshot.json]
// 产物（写进 fixtures/hl/）：perpDexs.json、metaAndAssetCtxs-<dex>.json、allMids-<dex>.json、
//   l2Book-xyz_TSLA.json、candleSnapshot-xyz_TSLA-1h.json、replay/btc-1m.json。
// 真实 vs 派生（详见 fixtures/hl/README.md）：BTC 的 allMids / meta / l2Book / candles 四个文件是 Demo 当时从主网录的原始响应；
// 这里的 HIP-3 文件是用 Demo 的整理后快照（snapshot.json）倒推成 HL 原始响应形状，数值真实、字段是补齐的，
// 已下架 / 离线 dex 是**合成**的（flx：全部 isDelisted；用来测试动态发现的剔除逻辑）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'hl')
mkdirSync(join(out, 'replay'), { recursive: true })
const snapPath = process.argv[2] ?? process.env.GITRADER_DEMO_SNAPSHOT
if (!snapPath) { console.error('用法：node fixtures/derive-from-demo.mjs <Demo 快照 snapshot.json>（或设环境变量 GITRADER_DEMO_SNAPSHOT）'); process.exit(2) }
const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
const w = (name, obj) => writeFileSync(join(out, name), JSON.stringify(obj, null, 1) + '\n')

const dexes = ['xyz', 'io', 'para', 'mkts']
const quotesBySymbol = new Map(snap.quotes.map((q) => [q.symbol, q]))

for (const dex of dexes) {
  const insts = snap.instruments.filter((i) => i.dex === dex)
  const universe = insts.map((i) => ({ szDecimals: i.szDecimals, name: i.symbol, maxLeverage: i.maxLeverage, ...(i.onlyIsolated ? { onlyIsolated: true } : {}) }))
  const ctxs = insts.map((i) => {
    const q = quotesBySymbol.get(i.symbol)
    const mark = q?.markPx ?? q?.mid ?? 1
    const prev = q && q.change24hPct !== undefined ? mark / (1 + q.change24hPct / 100) : mark
    return {
      funding: String(q?.fundingHourly ?? 0), openInterest: String(q?.openInterest ?? 0), prevDayPx: String(prev),
      dayNtlVlm: String(i.dayNtlVlm ?? 0), oraclePx: String(mark), markPx: String(mark), midPx: String(q?.mid ?? mark),
    }
  })
  if (dex === 'xyz') {
    // 加两条已下架条目，测「已下架不进标的清单，但占着资产下标」
    for (const name of ['xyz:OLDCO1', 'xyz:OLDCO2']) {
      universe.push({ szDecimals: 2, name, maxLeverage: 5, isDelisted: true })
      ctxs.push({ funding: '0', openInterest: '0', prevDayPx: '1', dayNtlVlm: '0', oraclePx: '1', markPx: '1', midPx: '1' })
    }
  }
  w(`metaAndAssetCtxs-${dex}.json`, [{ universe }, ctxs])
  w(`allMids-${dex}.json`, Object.fromEntries(insts.map((i) => [i.symbol, String(quotesBySymbol.get(i.symbol)?.mid ?? 1)])))
}

// 合成的「已关停」dex：全部下架（Felix 在 2026-06 的真实遭遇，见知识库 HIP-3_dex清单）
w('metaAndAssetCtxs-flx.json', [
  { universe: ['flx:TSLA', 'flx:NVDA', 'flx:GOLD'].map((name) => ({ szDecimals: 3, name, maxLeverage: 10, isDelisted: true })) },
  ['a', 'b', 'c'].map(() => ({ funding: '0', openInterest: '0', prevDayPx: '1', dayNtlVlm: '0', oraclePx: '1', markPx: '1', midPx: '1' })),
])

// perpDexs：第 0 项为 null（默认 dex）；index 即资产 ID 里的 dexIndex。
w('perpDexs.json', [null, ...[...dexes, 'flx'].map((name) => ({ name, fullName: name.toUpperCase(), deployer: '0x' + '0'.repeat(40) }))])

// 单个标的的盘口与 K 线（xyz:TSLA）
const b = snap.books['xyz:TSLA']
const lv = (a) => a.map((l) => ({ px: String(l.px), sz: String(l.sz), n: l.n }))
w('l2Book-xyz_TSLA.json', { coin: 'xyz:TSLA', time: b.ts, levels: [lv(b.bids), lv(b.asks)] })
w('candleSnapshot-xyz_TSLA-1h.json', snap.candles['xyz:TSLA|1h'].candles.map((c) => ({
  t: c.t, T: c.t + 3_599_999, s: 'xyz:TSLA', i: '1h', o: String(c.o), c: String(c.c), h: String(c.h), l: String(c.l), v: String(c.v), n: 1,
})))

// 回放夹具：用 BTC 真实 1m K 线的收盘价驱动，盘口形状取自真实 l2Book（按收盘价平移），资金费取 BTC 当时的真实值。
const candles = JSON.parse(readFileSync(join(out, 'candleSnapshot-BTC-1m.json'), 'utf8'))
const book = JSON.parse(readFileSync(join(out, 'l2Book-BTC.json'), 'utf8'))
const meta = JSON.parse(readFileSync(join(out, 'metaAndAssetCtxs.json'), 'utf8'))
const btcIdx = meta[0].universe.findIndex((u) => u.name === 'BTC')
const funding = Number(meta[1][btcIdx].funding)
const bid0 = Number(book.levels[0][0].px)
const ask0 = Number(book.levels[1][0].px)
const spread = ask0 - bid0
const frames = candles.map((c) => {
  const close = Number(c.c)
  const shift = Math.round(close - spread / 2) - bid0 // 整档平移，保持原盘口的价差与档位间距
  const lv = (side) => book.levels[side].map((l) => [Number(l.px) + shift, Number(l.sz)])
  return { ts: c.T, marks: { 'hyperliquid:BTC': close }, funding: { 'hyperliquid:BTC': funding }, books: { 'hyperliquid:BTC': { bids: lv(0), asks: lv(1) } } }
})
w('replay/btc-1m.json', { instrument: 'hyperliquid:BTC', interval: '1m', source: 'candleSnapshot-BTC-1m.json + l2Book-BTC.json (book shape re-centered on each close)', frames })
console.log('fixtures written to', out, '| replay frames', frames.length)
