// SPDX-License-Identifier: CPAL-1.0
// 模糊测试：connector-gateio-trade 的交易所响应解析入口。
//
// 批 10 · F1 欠交件补齐。工单要求：每个解析入口至少 1 万个样本、种子写死、可复现、
// 只用 Node 标准库的伪随机 —— 本文件自己实现 mulberry32（种子 42），不引入任何依赖。
//
// 样本形状按入口**声明的第一个参数类型**喂（`unknown` 拿全部畸形族；`RawX` 拿对象形状的
// 脏字段；`RawX | null | undefined` 另外喂 null/undefined；`RawX[]` 喂数组；`string` 喂原始
// 文本）。理由：类型是调用方与解析器之间的契约，契约写成 `RawX` 的入口由调用方保证拿到一行。
//
// 判红的两类（任一出现即失败）：
//   ① V8 原生崩溃逃出解析器：`Cannot read properties of …`、`Cannot convert …`、
//      `x is not a function`、`x is not iterable`、栈溢出 —— 这是漏了守卫；
//      作者自己写下的拒绝（`ProblemError`、固定文案的 `TypeError`/`RangeError`，例如
//      `wire field is not an integer`、`alpaca order has no id`）不算：连接器把它们映射成
//      Problem，是工单要求的「数据缺失一律显式报错」。
//   ② 返回值里出现 NaN（`raw` 子树除外：那是原始响应的回显）。NaN 会静默穿透钱路算术。
//
// 可复现：样本流由 mulberry32(seed 42 ⊕ 入口 id 的 FNV-1a) 唯一决定，另有测试比对两次生成。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import * as parse from '../../src/parse'

const SEED = 42
const SAMPLES = 10_000
const TIMEOUT_MS = 180_000
const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url))

/** mulberry32：32 位状态的确定性 PRNG（自写，不碰 Math.random）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 每入口独立子流：seed 42 ⊕ 入口 id 的 FNV-1a，入口之间互不干扰，单入口可单独复现。 */
function streamSeed(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ((SEED * 0x9e3779b1) ^ h) >>> 0
}

const SCALARS: readonly unknown[] = [
  null, true, false, 0, -0, 1, -1, 2 ** 31, Number.MAX_SAFE_INTEGER, 1e308, -1e308, 1e-320,
  Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  '', ' ', 'null', 'undefined', 'NaN', 'Infinity', '-', '0x10', '1e999', '9'.repeat(40), '1'.repeat(400),
  'abc', '-0.00000001', '0.0', '.5', '5.', '+5', '5e-3', '\uff11', '\u0000', '{"a":1}', '[1,2,3]',
  'FILLED', 'NEW', 'filled', 'PARTIALLY_FILLED', 'OK', '0', 'true', 'buy', 'sell', 'USDT', 'BTC', '__proto__',
]

const TEXT_JUNK: readonly string[] = [
  '', ' ', '\u0000', '{', '}', '[]', '[', ']', 'null', 'nullnull', '{"a":', '{"a":1', '"unterminated',
  '{"data":null}', '{"code":"0"}', '{"code":0,"msg":null,"data":[]}', '\ufffd\ufffd', 'x'.repeat(5000),
  'NaN', 'Infinity', '-', '1e999', '0x10', 'undefined',
  '{"channel":"orders","arg":{"channel":"orders"},"data":[', '{"e":"ORDER_TRADE_UPDATE","o":{}}',
  'symbol,close\nAAPL,1.0', 'a,b\n1,2\n3', 'AAPL,2026-01-01,1,2,3,4,5', ',,,', '\n\n', 'T01:02:03.004Z',
  '{"result":"error","code":-1}', '{"code":"0","data":{"x":"1e999"}}', '1700000000.5\r\n',
]

const FIELDS_OK: readonly string[] = [
  '1', '0', '-1', '2.5', '100', '0.01', '10000', '2024', '1700000000', 'USD', 'AAPL', 'STK', 'SMART', 'BUY', 'SELL',
  'Filled', 'Submitted', 'PreSubmitted', 'Cancelled', 'Inactive', 'DUPLICATE', 'VALID', '', '2147483647',
]

/** 从本包源码里收真实字段名，让样本贴住真实响应形状；键池另外补上原型污染与通用键。 */
let KEY_CACHE: string[] | null = null
function keys(): readonly string[] {
  if (KEY_CACHE !== null) return KEY_CACHE
  const found = new Set<string>()
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(path)
        continue
      }
      if (!name.endsWith('.ts')) continue
      const text = readFileSync(path, 'utf8')
      for (const m of text.matchAll(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)) found.add(m[1] as string)
      for (const m of text.matchAll(/'([A-Za-z_][A-Za-z0-9_.]*)'\s*\]/g)) found.add(m[1] as string)
    }
  }
  walk(SRC_DIR)
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'id', 'ts', 'price', 'size', 'symbol']) found.add(k)
  KEY_CACHE = [...found].slice(0, 400)
  return KEY_CACHE
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length) % xs.length] as T
}

function scalar(rng: () => number): unknown {
  return pick(rng, SCALARS)
}

function shapeObject(rng: () => number, pool: readonly string[], depth = 0): Record<string, unknown> {
  const n = Math.floor(rng() * 6)
  const out: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) out[pick(rng, pool)] = depth > 1 ? scalar(rng) : value(rng, pool, depth + 1)
  return out
}

function value(rng: () => number, pool: readonly string[], depth = 0): unknown {
  const r = rng()
  if (depth > 2 || r < 0.45) return scalar(rng)
  if (r < 0.6) {
    const n = Math.floor(rng() * 4)
    return Array.from({ length: n }, () => (depth > 1 ? scalar(rng) : value(rng, pool, depth + 1)))
  }
  if (r < 0.72) {
    return Array.from({ length: Math.floor(rng() * 3) }, () =>
      Array.from({ length: Math.floor(rng() * 14) }, () => scalar(rng)))
  }
  return shapeObject(rng, pool, depth + 1)
}

type Mode = 'json' | 'row' | 'rownull' | 'array' | 'text' | 'fields'

const PLAUSIBLE: readonly unknown[] = [
  '1', '0', '0.01', '100', '1000', '1.5', '-0.25', '1750000000', '1733000000000', '2026-01-02T15:04:05Z',
  '2026-01-02', '15:59', 'BTCUSDT', 'BTC-USD', 'BTC_USDT', 'BTC', 'USDT', 'USD', 'AAPL', 'STK', 'SMART',
  'buy', 'sell', 'Buy', 'Sell', 'limit', 'market', 'gtc', 'ioc', 'filled', 'FILLED', 'new', 'NEW',
  'Submitted', 'Filled', 'Cancelled', 'true', 'false', true, false, 1, 0, 100,
]

/**
 * 「像样」的一行：键取自本包真实字段名，值取自常见取值池。
 * 只喂垃圾行的话，校验型入口会把每个样本都拒掉，成功路径一次都没走到 —— 这一族专门补这个洞。
 */
function plausibleRow(rng: () => number, pool: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (rng() < 0.5) {
    // 密集行：键取自键池头部（源码里靠前的字段名，通常就是必填的那几个），值都像样
    const n = Math.min(pool.length, 6 + Math.floor(rng() * 10))
    for (let i = 0; i < n; i++) out[pool[i] as string] = pick(rng, PLAUSIBLE)
    return out
  }
  const n = 1 + Math.floor(rng() * 9)
  for (let i = 0; i < n; i++) out[pick(rng, pool)] = pick(rng, PLAUSIBLE)
  return out
}

/** 对象形状的脏行：缺字段 / 类型错 / 数值边界 / 嵌套 / 原型污染。 */
function dirtyRow(rng: () => number, pool: readonly string[]): Record<string, unknown> {
  switch (Math.floor(rng() * 5)) {
    case 0: // 缺字段：只给一两个真字段
      return { [pick(rng, pool)]: scalar(rng), [pick(rng, pool)]: scalar(rng) }
    case 1: // 类型错：真字段配错类型标量
      return shapeObject(rng, pool, 0)
    case 2: // 超大数 / 精度边界
      return {
        [pick(rng, pool)]: pick(rng, [1e308, 2 ** 63, Number.MAX_SAFE_INTEGER, 1e-320, '9'.repeat(40), '1e999']),
        [pick(rng, pool)]: pick(rng, [-1e308, -0, 1e-320, '-9'.repeat(40)]),
      }
    case 3: // 嵌套爆炸
      return shapeObject(rng, pool, 1)
    default: // 原型污染 + 保留字键
      return { __proto__: { polluted: true }, constructor: { prototype: { polluted: true } }, [pick(rng, pool)]: scalar(rng) }
  }
}

/** 一族一个样本；族的归属也走同一条随机流，所以整串样本由种子唯一决定。 */
function makeSample(mode: Mode, rng: () => number, pool: readonly string[]): unknown {
  if (mode === 'fields') {
    // 拆帧后的字段数组：大部分给像样的列（数字 / 金额 / 枚举），少数给垃圾，
    // 否则解码器每次都在第一个字段就被拒，等于没测到后面的逻辑。
    if (rng() < 0.6) {
      // 像 TWS 真帧那样的长列（几十到上百个字段，绝大多数是数字），少数位置塞垃圾
      const n = 40 + Math.floor(rng() * 100)
      return Array.from({ length: n }, () => (rng() < 0.9 ? pick(rng, FIELDS_OK) : String(scalar(rng))))
    }
    const n = Math.floor(rng() * 21)
    return Array.from({ length: n }, () => (rng() < 0.75 ? pick(rng, FIELDS_OK) : String(scalar(rng))))
  }
  if (mode === 'text') {
    switch (Math.floor(rng() * 4)) {
      case 0:
        return pick(rng, TEXT_JUNK)
      case 1: {
        const text = JSON.stringify(shapeObject(rng, pool, 0))
        const cut = Math.floor(rng() * text.length)
        return rng() < 0.5 ? text.slice(0, cut) : text.slice(cut)
      }
      case 2:
        return pick(rng, TEXT_JUNK) + pick(rng, TEXT_JUNK)
      default:
        return JSON.stringify(value(rng, pool, 0))
    }
  }
  if (mode === 'row') return rng() < 0.2 ? plausibleRow(rng, pool) : dirtyRow(rng, pool)
  if (mode === 'rownull') {
    if (rng() < 0.25) return pick(rng, [null, undefined])
    return rng() < 0.2 ? plausibleRow(rng, pool) : dirtyRow(rng, pool)
  }
  if (mode === 'array') {
    const n = Math.floor(rng() * 4)
    return Array.from({ length: n }, () => dirtyRow(rng, pool))
  }
  switch (Math.floor(rng() * 8)) {
    case 0: // 畸形 JSON 残片当成已解析的值喂进去
      return pick(rng, TEXT_JUNK)
    case 1: // null / 空 / 类型全错
      return pick(rng, [null, undefined, '', 0, false, [], {}, Number.NaN, Number.POSITIVE_INFINITY])
    case 2: // 像样的一行（走成功路径）
      return rng() < 0.5 ? plausibleRow(rng, pool) : dirtyRow(rng, pool)
    default:
      return dirtyRow(rng, pool)
  }
}

/** 返回值里任何一处 NaN 都要抓出来（NaN 会静默穿透钱路算术）；`raw` 子树是原始回显，跳过。 */
function findNaN(root: unknown, label: string): string | null {
  const seen = new Set<unknown>()
  const stack: Array<{ v: unknown; path: string; inRaw: boolean }> = [{ v: root, path: '$', inRaw: false }]
  let steps = 0
  while (stack.length > 0 && steps < 4000) {
    const cur = stack.pop() as { v: unknown; path: string; inRaw: boolean }
    steps += 1
    const v = cur.v
    if (cur.inRaw) continue
    if (typeof v === 'number' && Number.isNaN(v)) return `${label} @ ${cur.path}`
    if (v === null || typeof v !== 'object') continue
    if (seen.has(v)) continue
    seen.add(v)
    if (Array.isArray(v)) {
      const n = Math.min(v.length, 64)
      for (let i = 0; i < n; i++) stack.push({ v: v[i], path: `${cur.path}[${i}]`, inRaw: false })
      continue
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      stack.push({ v: x, path: `${cur.path}.${k}`, inRaw: k === 'raw' })
    }
  }
  return null
}

/** V8 原生崩溃（漏守卫）；作者写下的拒绝不算。 */
const NATIVE_CRASH = /^(Cannot read propert|Cannot convert |Cannot destructure|Maximum call stack|Invalid array length|out of memory)| is not a function$| is not iterable$| is not defined$/

function isNativeCrash(err: unknown): boolean {
  if (!(err instanceof TypeError) && !(err instanceof RangeError) && !(err instanceof ReferenceError)) return false
  return NATIVE_CRASH.test(err.message)
}

function preview(v: unknown): string {
  try {
    const text = JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x))
    return (text ?? String(v)).slice(0, 200)
  } catch {
    return String(v).slice(0, 200)
  }
}

interface Entry {
  /** 入口 id：包名.函数名 */
  id: string
  mode: Mode
  /** 喂一个样本，返回解析结果；V8 原生崩溃 = 发现 */
  call: (v: any) => unknown
  /** 'model' 输出里不许有 NaN；'exempt' 是把调用方载荷原样交回的入口（无模型可查） */
  nan: 'model' | 'exempt'
}

const E = (id: string, mode: Mode, call: (v: any) => unknown): Entry => ({ id, mode, call, nan: 'model' })
const J = (id: string, call: (v: any) => unknown): Entry => E(id, 'json', call)
const T = (id: string, call: (v: any) => unknown): Entry => E(id, 'text', call)
const R = (id: string, call: (v: any) => unknown): Entry => E(id, 'row', call)

const NOW = 1_733_000_000_000
const ctx = { accountId: 'acc-fuzz' as never, now: NOW }
const mult = (): never => '0.01' as never

const ENTRIES: readonly Entry[] = [
  J('gateio-trade.parseInstrumentRecords', (v) => parse.parseInstrumentRecords(v, NOW)),
  T('gateio-trade.mapOrderStatus', (v) => parse.mapOrderStatus(v, 'filled')),
  J('gateio-trade.multipliersOf', (v) => parse.multipliersOf(v)),
  J('gateio-trade.msOfSeconds', (v) => parse.msOfSeconds(v, NOW)),
  J('gateio-trade.msOfEither', (v) => parse.msOfEither(v, NOW)),
  R('gateio-trade.marginOfPositionRow', (v) => parse.marginOfPositionRow(v as never)),
  R('gateio-trade.parsePosition', (v) => parse.parsePosition(v, ctx, '0.01' as never)),
  J('gateio-trade.parsePositions', (v) => parse.parsePositions(v, ctx, mult as never)),
  J('gateio-trade.parseAccount', (v) => parse.parseAccount(v, ctx, [])),
  R('gateio-trade.orderStatusWord', (v) => parse.orderStatusWord(v as never)),
  R('gateio-trade.parseOpenOrder', (v) => parse.parseOpenOrder(v, NOW, '0.01' as never)),
  J('gateio-trade.parseOpenOrders', (v) => parse.parseOpenOrders(v, NOW, mult as never)),
  R('gateio-trade.fillTsOf', (v) => parse.fillTsOf(v as never, NOW)),
  R('gateio-trade.parseFill', (v) => parse.parseFill(v, NOW, '0.01' as never)),
  J('gateio-trade.parseFills', (v) => parse.parseFills(v, NOW, mult as never)),
  J('gateio-trade.parseOrderDetail', (v) => parse.parseOrderDetail(v, '0.01' as never)),
  R('gateio-trade.priceOrderIdOf', (v) => parse.priceOrderIdOf(v as never)),
  J('gateio-trade.parsePriceOrders', (v) => parse.parsePriceOrders(v, NOW, mult as never, () => null)),
  J('gateio-trade.normalizeGateEvent', (v) => parse.normalizeGateEvent(v, { now: NOW, contractSize: mult as never })),
  J('gateio-trade.parseFundingRows', (v) => parse.parseFundingRows(v)),
]

const protoKeysBefore = Object.keys(Object.prototype).length

for (const entry of ENTRIES) {
  it(`${entry.id}：${SAMPLES} 个带种子畸形样本不崩、不产 NaN`, () => {
    const rng = mulberry32(streamSeed(entry.id))
    const pool = keys()
    const failures: string[] = []
    let calls = 0
    let rejected = 0
    for (let i = 0; i < SAMPLES; i++) {
      const sample = makeSample(entry.mode, rng, pool)
      calls += 1
      let out: unknown
      try {
        out = entry.call(sample)
      } catch (err) {
        if (isNativeCrash(err)) {
          const where = ((err as Error).stack ?? '').split(String.fromCharCode(10)).find((l) => l.includes('/src/')) ?? ''
          if (failures.length < 5) failures.push(`#${i} V8 崩溃逃出：${(err as Error).name}: ${(err as Error).message}｜位置=${where.trim().slice(0, 120)}｜样本=${preview(sample)}`)
        } else {
          rejected += 1
        }
        continue
      }
      if (entry.nan === 'model') {
        const hit = findNaN(out, entry.id)
        if (hit !== null && failures.length < 5) failures.push(`#${i} 输出含 NaN：${hit}｜样本=${preview(sample)}`)
      }
    }
    expect(calls).toBe(SAMPLES)
    // 拒绝（作者定义的领域错误）是正确行为，不计入失败；这里只统计，用来在报告里说明
    // 该入口本轮走到了拒绝路径还是接受路径。
    expect(rejected).toBeLessThanOrEqual(SAMPLES)
    expect(failures).toEqual([])
  }, TIMEOUT_MS)
}

it('同种子两跑产出同一串样本（可复现）', () => {
  for (const entry of ENTRIES) {
    const stream = (): string => {
      const rng = mulberry32(streamSeed(entry.id))
      const pool = keys()
      return JSON.stringify(Array.from({ length: 64 }, () => makeSample(entry.mode, rng, pool)))
    }
    const first = stream()
    const second = stream()
    expect(second).toBe(first)
    expect(first.length).toBeGreaterThan(2)
  }
})

it('模糊风暴没有污染 Object.prototype', () => {
  expect(Object.keys(Object.prototype).length).toBe(protoKeysBefore)
  const probe = {} as Record<string, unknown>
  expect(probe['polluted']).toBeUndefined()
})

