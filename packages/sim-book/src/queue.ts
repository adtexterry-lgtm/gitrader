// SPDX-License-Identifier: CPAL-1.0
// 挂单（maker）成交判定三档：严格 / 队列位置估计 / 宽松。纯判定，不碰盘口台账，也不碰订单状态。
//
// 设计参照：nautilus_trader crates/execution/src/models/fill.rs@55c0e820 —— 把「限价单是否成交」从撮合核心里
//   抽成可替换的判定模型（is_limit_filled / 是否按盘口流动性成交），并区分「触价」与「排队成交」两种口径；
//   crates/execution/src/matching_engine/mod.rs@55c0e820 的成交模型挂钩点（每笔成交前问一次模型）。
// 设计参照：nautilus_trader crates/execution/src/matching_engine/mod.rs@55c0e820 —— snapshot_queue_position
//   在挂单时快照该档显示量作为前方量、decrement_queue_on_trade 在同价成交时递减前方量。
// 队列位置估计按该两处从零写。本包只做逐单估计，不做参照的「同价多张单按前方量排序、共享成交额度」，
// 已知限制：同价多张我方单各自重复计前方量（偏悲观）。
//
// 三档的假设（写死在文档里，代码按此实现）：
//   conservative 严格：只有成交价**穿过**我们的限价（买单：成交价 < 限价；卖单：成交价 > 限价）才算成交。
//     假设：穿价说明我们这一档整档被扫掉，我们前方的挂单也被一并吃掉。同价成交不算 —— 同价成交量可能
//     全部由前方队列吸收，我们的单一点没动，严格口径不承认这部分成交。
//   queue 队列位置估计：挂单到达场所时记下该档位显示量作为「前方量」，随后同价成交先扣前方量，扣完才轮到我们；
//     穿价成交把前方量一次性清零（整档被扫过）。假设：显示量就是前方量（看不到自己的单，也不考虑撤单与
//     隐藏单）；前方量只减不增（后续 add / update 不改估计）；同一笔成交里前方量与我们的成交共享同一份额度。
//   optimistic 宽松：成交价**触及或穿过**限价即成交（触价即成交）。假设：我们永远排在队首，同价成交全部
//     可以先落到我们头上。这是 Q1a 的缺省口径，也是「无限流动性 + 零延迟」退化配置用的口径。
import { ZERO, add, cmp, sub, type Fx } from '@gitrader/protocol/decimal'
import { minFx } from './num'
import type { Side } from './types'

export type MakerFillMode = 'conservative' | 'queue' | 'optimistic'

export const MAKER_FILL_MODES: readonly MakerFillMode[] = ['conservative', 'queue', 'optimistic']

export interface MakerFillInput {
  orderId: string
  side: Side
  limit: Fx
  /** 订单剩余未成交量。 */
  leaves: Fx
  /** 本笔成交里还没被别的挂单分走的额度。 */
  budget: Fx
  tradePrice: Fx
  tradeSize: Fx
}

export interface MakerFillResult {
  /** 本笔应给我方的成交量（maker，成交价永远是自己的限价）。 */
  qty: Fx
  /** 本笔消耗掉的额度（我方成交 + 我方前方量吃掉的量），调用方要从共享额度里扣掉。 */
  budgetUsed: Fx
}

const NONE: MakerFillResult = { qty: ZERO, budgetUsed: ZERO }

/**
 * 挂单成交判定器。有状态的部分只有队列估计（orderId → 前方量），
 * 所以同一串输入 + 同一串调用顺序必得同一结果。
 */
export class MakerFillJudge {
  readonly mode: MakerFillMode
  private readonly ahead = new Map<string, Fx>()

  constructor(mode: MakerFillMode = 'optimistic') {
    if (!MAKER_FILL_MODES.includes(mode)) throw new RangeError(`未知挂单判定档位：${String(mode)}`)
    this.mode = mode
  }

  /** 挂单到达场所：记下该档位此刻的显示量当作前方量（覆盖旧估计，改价后要重新记）。 */
  join(orderId: string, aheadQty: Fx): void {
    this.ahead.set(orderId, aheadQty < ZERO ? ZERO : aheadQty)
  }

  /** 订单终结：丢掉队列估计。 */
  forget(orderId: string): void {
    this.ahead.delete(orderId)
  }

  /** 当前估计的前方量（未记录为 0）。 */
  aheadOf(orderId: string): Fx {
    return this.ahead.get(orderId) ?? ZERO
  }

  /** 订单已终结的队列估计数量（诊断用）。 */
  get tracked(): number {
    return this.ahead.size
  }

  /**
   * 判一笔逐笔成交能给我方挂单多少量。relation 用「成交价 vs 我们的限价」：
   * 买单看成交价是否 ≤ 限价，卖单看成交价是否 ≥ 限价；再分同价 / 穿价。
   */
  judge(input: MakerFillInput): MakerFillResult {
    const { orderId, side, limit, leaves, budget, tradePrice } = input
    if (leaves <= ZERO || budget <= ZERO) return NONE

    // 成交价在我们这一侧或更好才算「到价」。
    const relation = side === 'buy' ? cmp(tradePrice, limit) : cmp(limit, tradePrice)
    if (relation > 0) return NONE // 成交价还没到我们的价，吃不到

    if (relation < 0) {
      // 穿价：整档被扫过，前方量一律清零。
      if (this.mode === 'queue') this.ahead.set(orderId, ZERO)
      const qty = minFx(leaves, budget)
      return { qty, budgetUsed: qty }
    }

    // 同价成交：三档在这里分道。
    if (this.mode === 'conservative') return NONE
    if (this.mode === 'optimistic') {
      const qty = minFx(leaves, budget)
      return { qty, budgetUsed: qty }
    }

    // queue：先用本笔成交量扣前方量，扣完才轮到我们。
    const ahead = this.ahead.get(orderId) ?? ZERO
    if (ahead <= ZERO) {
      const qty = minFx(leaves, budget)
      return { qty, budgetUsed: qty }
    }
    const eatAhead = minFx(ahead, budget)
    const leftAhead = sub(ahead, eatAhead)
    this.ahead.set(orderId, leftAhead)
    const leftBudget = sub(budget, eatAhead)
    if (leftAhead > ZERO || leftBudget <= ZERO) return { qty: ZERO, budgetUsed: eatAhead }
    const qty = minFx(leaves, leftBudget)
    return { qty, budgetUsed: add(eatAhead, qty) }
  }
}
