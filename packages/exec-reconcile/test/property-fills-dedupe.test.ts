// SPDX-License-Identifier: CPAL-1.0
// 属性测试（批 10 欠交件 · 不变式 3）：成交去重幂等。
//
// 被测实现：src/fills.ts:101 dedupeFills（fillKeyFor 定键 → 同键分组 → 接受 / 重复 / 冲突分类）。
// 全仓 grep `dedupe|dedup|idempot|去重`：engine-core 与 sim-book 里没有「成交级」去重
// （sim-book 的 seen 是订单 id 去重，engine.ts:259；档位去重是快照内的 book.ts:241），
// 成交去重只有这一处，所以不变式钉在这里。
//
// 断的不变式：
//   (1) 幂等：同一批成交事件再喂一遍，账本里的成交记录数与成交量合计都不变（不产生新记录）；
//   (2) 稳定：accepted 恰好是每个去重键的第一次出现；
//   (3) 重复只增加「到达次数」，不增加「记录数」，也不制造新冲突；
//   (4) 纯函数：输入一个字段都不改（深冻结后跑，改了就抛）；
//   (5) 回退键在 needs_human 下一律不接受（宁可留给人看也不合并）。
//
// 随机源：本文件自带的 mulberry32，种子写死 42，样本数写死。
import { describe, expect, it } from 'vitest'
import { dedupeFills, fillKeyFor } from '../src/fills'
import { resolveOptions } from '../src/tolerance'
import type { ReconcileInput, VenueFillView } from '../src/types'
import { input, localOrder, NOW, options, venueOpen } from './helpers'

const SEED = 42
const SAMPLES = 600

/** mulberry32：32 位种子的确定性伪随机数（与引擎侧同算法；测试内自备一份，不跨包取）。 */
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

const SIZES = ['0.05', '0.1', '0.2', '0.0001', '1', '0.00000001', '12.5']
const PRICES = ['100', '100.5', '99.9999', '0.0001', '80000']

interface Scenario {
  input: ReconcileInput
  opts: ReturnType<typeof resolveOptions>
  /** 每条成交在其去重键下的序号（0 = 该键第一次出现）。 */
  arrivalOf: number[]
}

/** 造一个「有重复、有冲突、有缺号」的成交报告：每个唯一成交按 1..3 次到达。 */
function scenario(rnd: () => number): Scenario {
  const orderCount = 1 + Math.floor(rnd() * 4)
  const orders = []
  for (let i = 0; i < orderCount; i += 1) {
    orders.push(localOrder({ orderId: `o-${i}`, clientOrderId: `gt-${i}`, venueOrderId: `v-${i}`, filledSize: '0' }))
  }
  const fills: VenueFillView[] = []
  const uniqueCount = 1 + Math.floor(rnd() * 5)
  for (let u = 0; u < uniqueCount; u += 1) {
    const orderIdx = Math.floor(rnd() * orderCount)
    const size = SIZES[Math.floor(rnd() * SIZES.length)] as string
    const price = PRICES[Math.floor(rnd() * PRICES.length)] as string
    const base: VenueFillView = {
      // 1/4 的成交场所不给成交号 → 走「单号 + 时间 + 数量 + 价格」合成键
      venueFillId: rnd() < 0.25 ? '' : `f-${u}`,
      venueOrderId: `v-${orderIdx}`,
      clientOrderId: `gt-${orderIdx}`,
      instrumentId: 'test:BTC',
      side: rnd() < 0.5 ? 'buy' : 'sell',
      price,
      size,
      ts: NOW - 60_000 + u * 1_000,
    }
    const arrivals = 1 + Math.floor(rnd() * 3)
    for (let k = 0; k < arrivals; k += 1) {
      const roll = rnd()
      if (roll < 0.15) {
        // 同号同量同价、时间戳在时钟偏差内漂移 → 按重复处理
        fills.push({ ...base, ts: base.ts + Math.floor(rnd() * 1_500) })
      } else if (roll < 0.25) {
        // 同号但数量不同 → 冲突（不许当重复丢掉）
        fills.push({ ...base, size: SIZES[Math.floor(rnd() * SIZES.length)] as string })
      } else {
        fills.push({ ...base })
      }
    }
  }
  const built = input({
    orders,
    venue: { openOrders: [venueOpen({ venueOrderId: 'v-0', filledSize: '0', source: 'open' })], historyOrders: [], fills },
    localAsOf: NOW,
  })
  const knownIds = new Set(orders.map((o) => o.venueOrderId ?? ''))
  const seen = new Map<string, number>()
  const arrivalOf = fills.map((fill) => {
    const key = fillKeyFor(fill, knownIds).key
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return n
  })
  return { input: built, opts: resolveOptions(options({ dedupeFallback: rnd() < 0.5 ? 'accept_with_risk' : 'needs_human' })), arrivalOf }
}

/** 账本模型：按去重键入账，同一键只记一条（重复到达不新增记录）。 */
function ledgerOf(accepted: readonly VenueFillView[], knownIds: ReadonlySet<string>): Map<string, string> {
  const ledger = new Map<string, string>()
  for (const fill of accepted) {
    const key = fillKeyFor(fill, knownIds).key
    if (!ledger.has(key)) ledger.set(key, fill.size)
  }
  return ledger
}

/** 深冻结：实现若偷偷改输入，严格模式下直接抛 TypeError。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

describe('不变式 3 · 成交去重幂等（种子 42，600 组随机报告）', () => {
  it(`同一批成交到达两次，接受集合与账本记录数都不变（${SAMPLES} 组）`, () => {
    const rnd = mulberry32(SEED)
    let withDuplicateGroups = 0
    for (let i = 0; i < SAMPLES; i += 1) {
      const s = scenario(rnd)
      const knownIds = new Set(s.input.local.orders.map((o) => o.venueOrderId ?? ''))
      const once = dedupeFills(s.input, s.opts)
      // 同一批事件原样再喂一遍（私有流重连后的重复补发）
      const twiceInput: ReconcileInput = {
        ...s.input,
        venue: { ...s.input.venue, fills: [...s.input.venue.fills, ...s.input.venue.fills] },
      }
      const twice = dedupeFills(twiceInput, s.opts)

      // (1) 接受集合不增长：每条到达两遍，账本只记一份
      expect(twice.dedupe.accepted.length).toBe(once.dedupe.accepted.length)
      expect(JSON.stringify(twice.dedupe.accepted)).toBe(JSON.stringify(once.dedupe.accepted))
      // (2) 账本模型对比：记录数与各键的数量完全一致
      const ledgerOnce = ledgerOf(once.dedupe.accepted, knownIds)
      const ledgerTwice = ledgerOf(twice.dedupe.accepted, knownIds)
      expect(ledgerTwice.size).toBe(ledgerOnce.size)
      for (const [key, size] of ledgerOnce) expect(ledgerTwice.get(key)).toBe(size)
      // (3) 冲突不因重复到达而增加「种类」：冲突签名（键 + 双方数量）集合完全相同
      const conflictSig = (rows: typeof once.dedupe.conflicts): string[] => [...new Set(rows.map((c) => `${c.key}|${c.existing.size}|${c.incoming.size}`))].sort()
      expect(conflictSig(twice.dedupe.conflicts)).toEqual(conflictSig(once.dedupe.conflicts))
      // (4) 重复只增加「到达次数」：被列为重复的键集合只增不减，且重复条目数不减
      const keysOnce = new Set(once.dedupe.duplicates.map((d) => d.key))
      const keysTwice = new Set(twice.dedupe.duplicates.map((d) => d.key))
      for (const key of keysOnce) expect(keysTwice.has(key)).toBe(true)
      expect(twice.dedupe.duplicates.length).toBeGreaterThanOrEqual(once.dedupe.duplicates.length)
      // (5) 稳定：accepted 只能是该键第一次到达的那条
      for (const fill of once.dedupe.accepted) {
        const idx = s.input.venue.fills.indexOf(fill)
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(s.arrivalOf[idx]).toBe(0)
      }
      if (once.dedupe.duplicates.length > 0) withDuplicateGroups += 1
    }
    // 样本里必须真的出现过重复组，否则这条属性等于没测
    expect(withDuplicateGroups).toBeGreaterThan(SAMPLES / 2)
  })

  it(`去重是纯函数：同一份输入跑两次逐字节一致，深冻结的输入不被改写（${SAMPLES} 组）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES; i += 1) {
      const s = scenario(rnd)
      const frozen = deepFreeze(structuredClone(s.input))
      const before = JSON.stringify(frozen)
      const a = dedupeFills(frozen, s.opts)
      const b = dedupeFills(frozen, s.opts)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
      expect(JSON.stringify(frozen)).toBe(before)
    }
  })

  it(`回退键（场所没给成交号）在 needs_human 下一律不接受，严格集 ⊆ 宽松集（${SAMPLES} 组）`, () => {
    const rnd = mulberry32(SEED)
    let fallbackSeen = 0
    for (let i = 0; i < SAMPLES; i += 1) {
      const s = scenario(rnd)
      const knownIds = new Set(s.input.local.orders.map((o) => o.venueOrderId ?? ''))
      const strict = dedupeFills(s.input, { ...s.opts, dedupeFallback: 'needs_human' })
      const legacy = dedupeFills(s.input, { ...s.opts, dedupeFallback: 'accept_with_risk' })
      const fallbackKeys = new Set(strict.dedupe.keys.filter((k) => k.kind === 'fallback_composite').map((k) => k.key))
      if (fallbackKeys.size === 0) continue
      fallbackSeen += 1
      for (const fill of strict.dedupe.accepted) {
        expect(fallbackKeys.has(fillKeyFor(fill, knownIds).key)).toBe(false)
      }
      expect(strict.dedupe.accepted.length).toBeLessThanOrEqual(legacy.dedupe.accepted.length)
    }
    expect(fallbackSeen).toBeGreaterThan(0)
  })
})
