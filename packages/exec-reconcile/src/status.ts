// SPDX-License-Identifier: CPAL-1.0
// 场所原始状态串 → 对账用的粗分类。
//
// 为什么需要它：各场所的状态词表都不一样（NEW / live / New / open / Submitted / finished），
// 协议明确要求「上游原始状态字符串不翻译」（packages/protocol/src/connector/account.ts:64 VenueOrderStatus），
// 所以判定只能在这层做归一，原文照旧写进证据里给人看。
// 设计参照：nautilus_trader crates/live/src/execution/manager.rs（订单报告状态归一后再做差异判定）@55c0e820

export type VenueStatusClass = 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'unknown'

/**
 * 归一顺序很重要：
 *   1. 先认拒单（rejected / Inactive），避免 "Rejected" 里的子串被别的规则吃掉；
 *   2. 再认「撤单中 / 改单中」（pending_cancel / PendingCancel / pending_replace）：
 *      它们都还没结束，场所里仍是活单；
 *   3. 再认终结的撤单类（cancel / expire / replace / deactivat / done_for_day / suspend），
 *      因为 Bybit 的 "PartiallyFilledCanceled"、Gate 的 "finished/cancelled" 本质是已撤；
 *   4. 再认完全成交（"filled" 但排除 partial）；
 *   5. 再认部分成交；
 *   6. 最后才是活单类（new / live / submitted / open / held / triggered / pending / stopped）。
 */
export function classifyVenueStatus(raw: string): VenueStatusClass {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (s === '') return 'unknown'
  if (/reject|inactive|refus|denied/.test(s)) return 'rejected'
  // 撤单中 / 改单中：场所还在处理，单子没结终
  if (/pending(cancel|replace)/.test(s)) return 'open'
  if (/cancel|expire|deactivat|replace|doneforday|suspend|mmp/.test(s)) return 'cancelled'
  if (/filled/.test(s) && !/partial|part/.test(s)) return 'filled'
  if (/partial|part/.test(s)) return 'partially_filled'
  if (/new|live|open|submit|accept|held|trigger|pend|working|untrigger|stopped/.test(s)) return 'open'
  return 'unknown'
}

/** 场所状态是否终结（成交 / 撤单 / 拒单）。 */
export function isVenueStatusTerminal(klass: VenueStatusClass): boolean {
  return klass === 'filled' || klass === 'cancelled' || klass === 'rejected'
}

/** 该状态下「还有剩余量在场所」：活单与部分成交。 */
export function isVenueStatusLive(klass: VenueStatusClass): boolean {
  return klass === 'open' || klass === 'partially_filled'
}
