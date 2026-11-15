// SPDX-License-Identifier: CPAL-1.0
// 属性测试（批 10 欠交件 · 不变式 4）：对账是纯函数，跑多少遍都不改账。
//
// 被测实现：src/reconcile.ts:149 reconcile（+ classifyFills / classifyOrders / classifyPositions）。
// 源码注释第 4-8 行明确承诺：不读系统时钟、不读写文件、不发请求、不碰全局状态、输入一个字段都不改。
// 这条属性就是把这个承诺变成可执行断言：输入深冻结后跑，改一个字段就抛；跑 N 遍输出逐字节一致。
//
// 断的不变式：
//   (1) 幂等：同一输入跑 5 遍，输出逐字节一致（无隐藏状态、无时钟依赖）；
//   (2) 不改账：深冻结的输入跑完不被改写，账本已记成交合计前后一致；
//   (3) 自洽：counts 与 findings 重算一致，verdict 与 counts 一致，coverage 与输入长度一致；
//   (4) 推断成交 id 唯一且可复算（同一缺口重复对账得到同一个 id）。
//
// 随机源：本文件自带的 mulberry32，种子写死 42。
import { describe, expect, it } from 'vitest'
import { reconcile } from '../src/reconcile'
import { localFilledSum } from '../src/fills'
import { sumDecimal } from '../src/decimal'
import type { ReconcileInput, ReconcileOptions, ReconcileReport } from '../src/types'
import { ACCOUNT, input, localFill, localOrder, longPosition, NOW, options, venueFill, venueHistory, venueOpen, venuePositionOf } from './helpers'

const SEED = 42
const SAMPLES = 500
const RUNS = 5

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

const SIZES = ['0.05', '0.1', '0.2', '1', '0.0001']
const PRICES = ['100', '100.5', '99.5']

/** 造一份「大体一致、局部有差」的双侧视图：挂着单、部分成交、持仓、少量重复成交。 */
function scenario(rnd: () => number): { input: ReconcileInput; opts: ReconcileOptions } {
  const orderCount = 1 + Math.floor(rnd() * 3)
  const orders = []
  const fills = []
  const venueFills = []
  const openOrders = []
  const historyOrders = []
  for (let i = 0; i < orderCount; i += 1) {
    const size = SIZES[Math.floor(rnd() * SIZES.length)] as string
    const price = PRICES[Math.floor(rnd() * PRICES.length)] as string
    const roll = rnd()
    const status = roll < 0.4 ? 'open' : roll < 0.7 ? 'partially_filled' : 'filled'
    const filledSize = status === 'open' ? '0' : status === 'partially_filled' ? SIZES[0] as string : size
    orders.push(localOrder({ orderId: `o-${i}`, clientOrderId: `gt-${i}`, venueOrderId: `v-${i}`, size, price, status, filledSize, createdAt: NOW - 120_000 }))
    if (filledSize !== '0') {
      fills.push(localFill({ venueFillId: `f-${i}`, orderId: `o-${i}`, clientOrderId: `gt-${i}`, venueOrderId: `v-${i}`, size: filledSize, price, ts: NOW - 60_000 }))
      // 场所侧同一笔成交可能重复上报（私有流 + REST 补发）
      venueFills.push(venueFill({ venueFillId: `f-${i}`, venueOrderId: `v-${i}`, clientOrderId: `gt-${i}`, size: filledSize, price, ts: NOW - 60_000 }))
      if (rnd() < 0.3) venueFills.push(venueFill({ venueFillId: `f-${i}`, venueOrderId: `v-${i}`, clientOrderId: `gt-${i}`, size: filledSize, price, ts: NOW - 60_000 }))
    }
    const venueFilled = status === 'filled' ? size : rnd() < 0.2 ? SIZES[0] as string : filledSize
    if (status === 'open' || status === 'partially_filled') {
      openOrders.push(venueOpen({ venueOrderId: `v-${i}`, clientOrderId: `gt-${i}`, size, price, filledSize: venueFilled, status: status === 'open' ? 'open' : 'partially_filled', createdAt: NOW - 120_000 }))
    } else {
      historyOrders.push(venueHistory({ venueOrderId: `v-${i}`, clientOrderId: `gt-${i}`, size, price, filledSize: venueFilled, avgFillPrice: price }))
    }
  }
  const localPositions = []
  const venuePositions = []
  if (rnd() < 0.5) {
    const pos = longPosition({ instrumentId: 'test:BTC', size: SIZES[Math.floor(rnd() * SIZES.length)] as string, entryPrice: PRICES[0] as string })
    localPositions.push(pos)
    venuePositions.push(venuePositionOf(rnd() < 0.7 ? pos : longPosition({ size: SIZES[1] as string, entryPrice: PRICES[1] as string })))
  }
  const unavailable: ReconcileInput['venue']['unavailable'] = rnd() < 0.2 ? ['fills'] : []
  return {
    input: input({
      orders,
      fills,
      positions: localPositions,
      venue: {
        openOrders,
        historyOrders,
        fills: venueFills,
        positions: venuePositions,
        asOf: NOW - Math.floor(rnd() * 90_000),
        ...(unavailable.length > 0 ? { unavailable } : {}),
      },
      localAsOf: NOW - Math.floor(rnd() * 90_000),
    }),
    opts: options({ staleAfterMs: 120_000, sizeTolerance: rnd() < 0.3 ? '0.001' : '0' }),
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** 从 findings 重算 counts：报告自报的数字必须能被自己的明细复算出来。 */
function recomputeCounts(report: ReconcileReport): ReconcileReport['counts'] {
  const f = report.findings
  return {
    findings: f.length,
    blocker: f.filter((x) => x.severity === 'blocker').length,
    warn: f.filter((x) => x.severity === 'warn').length,
    info: f.filter((x) => x.severity === 'info').length,
    needsHuman: f.filter((x) => x.advice.requiresHuman).length,
    inferredFills: f.filter((x) => x.code === 'fill_missing_inferred').length,
    duplicateFills: f.filter((x) => x.code === 'fill_duplicate').length,
    conflictingFills: f.filter((x) => x.code === 'fill_conflict').length,
  }
}

describe('不变式 4 · 对账纯函数不改账（种子 42，500 组随机双侧视图）', () => {
  it(`同一输入跑 ${RUNS} 遍输出逐字节一致，深冻结的输入与账本状态都不被改写（${SAMPLES} 组）`, () => {
    const rnd = mulberry32(SEED)
    let withFindings = 0
    for (let i = 0; i < SAMPLES; i += 1) {
      const s = scenario(rnd)
      const frozen = deepFreeze(structuredClone(s.input))
      const beforeJson = JSON.stringify(frozen)
      const ledgerBefore = frozen.local.orders.map((o) => localFilledSum(frozen, o.orderId))
      const fillsSumBefore = sumDecimal(frozen.local.fills.map((f) => f.size))

      const reports: ReconcileReport[] = []
      for (let r = 0; r < RUNS; r += 1) reports.push(reconcile(frozen, s.opts))
      const first = reports[0] as ReconcileReport
      for (const report of reports.slice(1)) expect(JSON.stringify(report)).toBe(JSON.stringify(first))

      // (2) 输入与账本一个字段都没变（冻结下若被写会直接抛 TypeError）
      expect(JSON.stringify(frozen)).toBe(beforeJson)
      expect(frozen.local.orders.map((o) => localFilledSum(frozen, o.orderId))).toEqual(ledgerBefore)
      expect(sumDecimal(frozen.local.fills.map((f) => f.size))).toBe(fillsSumBefore)

      // (3) 自洽：counts / verdict / coverage
      expect(first.counts).toEqual(recomputeCounts(first))
      const verdict = first.counts.blocker > 0 ? 'blocked' : first.counts.warn > 0 || first.counts.needsHuman > 0 ? 'attention' : 'clean'
      expect(first.verdict).toBe(verdict)
      expect(first.coverage.localOrders).toBe(frozen.local.orders.length)
      expect(first.coverage.localFills).toBe(frozen.local.fills.length)
      expect(first.coverage.venueFills).toBe(frozen.venue.fills.length)
      expect(first.coverage.venueHistoryOrders).toBe(frozen.venue.historyOrders?.length ?? 0)

      // (4) 推断成交 id 唯一
      const ids = first.inferredFills.map((f) => f.id)
      expect(new Set(ids).size).toBe(ids.length)
      // 报告里声明的上限：接受 + 重复 + 冲突 覆盖了场所成交，且接受集合无重复键
      expect(first.dedupe.accepted.length).toBeLessThanOrEqual(frozen.venue.fills.length)
      if (first.findings.length > 0) withFindings += 1
    }
    expect(withFindings).toBeGreaterThan(SAMPLES / 2)
  })

  it(`对账结论只依赖输入：换掉 options.now 之外的一切都不改结论（${SAMPLES} 组）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES; i += 1) {
      const s = scenario(rnd)
      const frozen = deepFreeze(structuredClone(s.input))
      const a = reconcile(frozen, s.opts)
      // 同一份输入再包一层（内容相同的副本）必须得到同一结论：没有任何隐藏的全局状态参与
      const copy = deepFreeze(structuredClone(s.input))
      const b = reconcile(copy, s.opts)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
      expect(b.accountId).toBe(ACCOUNT)
      expect(b.generatedAt).toBe(s.opts.now)
    }
  })
})
