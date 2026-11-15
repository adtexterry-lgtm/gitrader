// SPDX-License-Identifier: CPAL-1.0
// 模糊测试：sim-book 的 JSONL 记录解析入口（批 10 · F1 欠交件补齐）。
//
// 入口：
//   A. parseJsonLine(line)         src/records.ts —— 一行文本 → 已解析的值
//   B. validateJsonl(text, opts)   src/validate.ts —— 整串 JSONL → 校验结果（含严格盘口回放）
//   C. validateRecords(values[])   src/validate.ts —— 已解析的记录数组 → 校验结果
//
// 判定（任一出现即失败）：
//   ① V8 原生崩溃逃出（`Cannot read properties of …` / `Cannot convert …` / `x is not a function` /
//      `x is not iterable` / 栈溢出）：解析器吃的是用户给的 JSONL 文件，坏文件只能变成
//      `{ ok: false, errors: [...] }`，不能抛；
//   ② 校验「通过」的记录里出现 NaN（NaN 会静默穿透 sim-book 的成交算术）；
//   ③ 可复现：同种子两跑样本流逐字节一致，且同一份输入两次校验结果一致。
//
// 记录形状取自 src/types.ts；变异算子把合法记录改成缺字段 / 类型错 / 非法枚举 / 超大数 / 深嵌套 /
// 截断 JSON / 超长行。种子写死 42，每入口 10 000 个样本，只用 Node 标准库伪随机。
import { expect, it } from 'vitest'
import { parseJsonLine } from '../../src/records'
import { validateJsonl, validateRecords } from '../../src/validate'

const SEED = 42
const SAMPLES = 10_000
const TIMEOUT_MS = 180_000

/** mulberry32：32 位状态的确定性 PRNG。 */
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

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length) % xs.length] as T
}

const int = (rng: () => number, n: number): number => Math.floor(rng() * n)

/** 合法记录（types.ts 的形状）；变异从这些种子出发。 */
const SEEDS: readonly Record<string, unknown>[] = [
  { type: 'book_snapshot', ts: 1_700_000_000_000, instrument: 'binance:BTCUSDT', bids: [['100', '1'], ['99.5', '2']], asks: [['100.5', '1'], ['101', '3']] },
  { type: 'book_delta', ts: 1_700_000_000_001, instrument: 'binance:BTCUSDT', side: 'bid', action: 'update', price: '100', size: '2' },
  { type: 'book_delta', ts: 1_700_000_000_002, instrument: 'binance:BTCUSDT', side: 'ask', action: 'clear' },
  { type: 'trade', ts: 1_700_000_000_003, instrument: 'binance:BTCUSDT', price: '100', size: '0.5', aggressor: 'buy', tradeId: 't-1' },
]

const JUNK_SCALARS: readonly unknown[] = [
  null, true, false, 0, -0, -1, 1e308, -1e308, 1e-320, Number.NaN, Number.POSITIVE_INFINITY,
  '', ' ', 'NaN', '-', '1e999', '0x10', '9'.repeat(40), 'abc', '\u0000', '__proto__', {}, [],
]

const BAD_ENUM: readonly unknown[] = ['BOOK_SNAPSHOT', 'bookdelta', 'add ', 'ADD', 'clear', 'bid', 'BUY', '', null, 1, {}, '__proto__']

const FIELDS = ['type', 'ts', 'seq', 'instrument', 'bids', 'asks', 'side', 'action', 'price', 'size', 'aggressor', 'tradeId']

/** 把一个合法记录改坏：缺字段 / 类型错 / 非法枚举 / 数值边界 / 深嵌套 / 插入未知键。 */
function mutateRecord(rng: () => number): Record<string, unknown> {
  const record: Record<string, unknown> = { ...pick(rng, SEEDS) }
  const steps = 1 + int(rng, 3)
  for (let s = 0; s < steps; s++) {
    const field = pick(rng, FIELDS)
    switch (int(rng, 7)) {
      case 0:
        delete record[field]
        break
      case 1:
        record[field] = pick(rng, JUNK_SCALARS)
        break
      case 2:
        record[field] = pick(rng, BAD_ENUM)
        break
      case 3:
        record[field] = { nested: { deeper: { deepest: [1, 2, 3] } } }
        break
      case 4:
        record[field] = pick(rng, [['100', 'NaN'], [['100', '1']], [], [null, null], [['1e999', '-1']]])
        break
      case 5:
        record[pick(rng, ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'])] = pick(rng, JUNK_SCALARS)
        break
      default:
        record[field] = pick(rng, ['1e308', '-0', '0.000000000000000000001', '9'.repeat(50), 'Infinity'])
    }
  }
  return record
}

/** 一条 JSONL 文本：多数是「改坏但仍合法」的 JSON，少数是断掉的文本 / 超长行 / 空行。 */
function mutateLine(rng: () => number): string {
  const text = JSON.stringify(mutateRecord(rng))
  switch (int(rng, 10)) {
    case 0: // 截断
      return text.slice(0, int(rng, text.length))
    case 1: // 去掉一个字符
      return text.slice(0, int(rng, text.length)) + text.slice(int(rng, text.length) + 1)
    case 2: // 超长行（超过任何合理的单行上限）
      return text + ',"pad":"' + 'x'.repeat(200_000) + '"'
    case 3: // 重复键
      return '{"type":"trade","type":"book_delta",' + text.slice(1)
    case 4: // 非对象
      return pick(rng, ['null', '[]', '1', '"x"', 'true'])
    case 5: // 空行 / 空白
      return pick(rng, ['', ' ', '\t', '\r'])
    case 6: // 孤立代理对与 NUL
      return text.replace('"instrument"', '"instrument":"\\ud800\\u0000"')
    case 7: // 深嵌套
      return '{"type":"trade","data":' + '['.repeat(pick(rng, [10, 100, 1000])) + ']'.repeat(pick(rng, [10, 100, 1000])) + '}'
    case 8: // 合法记录本身（走成功路径）
      return JSON.stringify(pick(rng, SEEDS))
    default:
      return text
  }
}

/** V8 原生崩溃（漏守卫）；作者写下的拒绝（TypeError('book_delta add 缺 price') 之类）不算。 */
const NATIVE_CRASH = /^(Cannot read propert|Cannot convert |Cannot destructure|Maximum call stack|Invalid array length)| is not a function$| is not iterable$| is not defined$/

function isNativeCrash(err: unknown): boolean {
  if (!(err instanceof TypeError) && !(err instanceof RangeError) && !(err instanceof ReferenceError)) return false
  return NATIVE_CRASH.test(err.message)
}

/** 任何一处 NaN 都要抓出来（跳过对象里回显的原始值 `raw`）。 */
function findNaN(root: unknown, label: string): string | null {
  const seen = new Set<unknown>()
  const stack: Array<{ v: unknown; path: string }> = [{ v: root, path: '$' }]
  let steps = 0
  while (stack.length > 0 && steps < 4000) {
    const cur = stack.pop() as { v: unknown; path: string }
    steps += 1
    const v = cur.v
    if (typeof v === 'number' && Number.isNaN(v)) return `${label} @ ${cur.path}`
    if (v === null || typeof v !== 'object') continue
    if (seen.has(v)) continue
    seen.add(v)
    if (Array.isArray(v)) {
      const n = Math.min(v.length, 64)
      for (let i = 0; i < n; i++) stack.push({ v: v[i], path: `${cur.path}[${i}]` })
      continue
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) stack.push({ v: x, path: `${cur.path}.${k}` })
  }
  return null
}

const protoKeysBefore = Object.keys(Object.prototype).length

it(`parseJsonLine 吃 ${SAMPLES} 行变异文本：不崩`, () => {
  const rng = mulberry32(SEED)
  const failures: string[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const line = mutateLine(rng)
    try {
      parseJsonLine(line)
    } catch (err) {
      // JSON.parse 的 SyntaxError 是这条入口的约定（调用方按 bad_json 记错误）
      if (isNativeCrash(err)) {
        if (failures.length < 5) failures.push(`#${i} ${(err as Error).name}: ${(err as Error).message}｜行=${line.slice(0, 120)}`)
      }
    }
  }
  expect(failures).toEqual([])
}, TIMEOUT_MS)

it(`validateJsonl 吃 ${SAMPLES} 串变异 JSONL：不崩、通过的记录不含 NaN、两次结果一致`, () => {
  const rng = mulberry32(SEED)
  const failures: string[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const text = mutateLine(rng) + '\n' + mutateLine(rng)
    let result
    try {
      result = validateJsonl(text)
    } catch (err) {
      if (isNativeCrash(err)) {
        if (failures.length < 5) failures.push(`#${i} V8 崩溃逃出：${(err as Error).name}: ${(err as Error).message}｜文本=${text.slice(0, 120)}`)
      }
      continue
    }
    if (result.ok) {
      const hit = findNaN(result.records, 'validateJsonl')
      if (hit !== null && failures.length < 5) failures.push(`#${i} 校验通过但含 NaN：${hit}｜文本=${text.slice(0, 120)}`)
    }
    // 同一份输入两次校验必须给出同一结论（回放盘口是状态的，不能有隐藏顺序依赖）
    const again = validateJsonl(text)
    if (again.ok !== result.ok || again.errors.length !== result.errors.length) {
      if (failures.length < 5) failures.push(`#${i} 两次校验结论不同：${result.ok}/${again.ok} ${result.errors.length}/${again.errors.length}`)
    }
  }
  expect(failures).toEqual([])
}, TIMEOUT_MS)

it(`validateRecords 吃 ${SAMPLES} 组变异记录数组：不崩、通过的记录不含 NaN`, () => {
  const rng = mulberry32(SEED)
  const failures: string[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const values = Array.from({ length: int(rng, 4) }, () => mutateRecord(rng))
    let result
    try {
      result = validateRecords(values)
    } catch (err) {
      if (isNativeCrash(err)) {
        if (failures.length < 5) failures.push(`#${i} V8 崩溃逃出：${(err as Error).name}: ${(err as Error).message}｜输入=${JSON.stringify(values).slice(0, 120)}`)
      }
      continue
    }
    if (result.ok) {
      const hit = findNaN(result.records, 'validateRecords')
      if (hit !== null && failures.length < 5) failures.push(`#${i} 校验通过但含 NaN：${hit}｜输入=${JSON.stringify(values).slice(0, 120)}`)
    }
  }
  expect(failures).toEqual([])
}, TIMEOUT_MS)

it('同种子两跑产出同一串样本（可复现）', () => {
  const stream = (): string => {
    const rng = mulberry32(SEED)
    return JSON.stringify(Array.from({ length: 64 }, () => mutateLine(rng)))
  }
  expect(stream()).toBe(stream())
})

it('模糊风暴没有污染 Object.prototype', () => {
  expect(Object.keys(Object.prototype).length).toBe(protoKeysBefore)
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
})
