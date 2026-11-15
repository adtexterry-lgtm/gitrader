// SPDX-License-Identifier: CPAL-1.0
// 差异码 → 建议动作 + 默认严重度。
//
// 设计原则（照搬契约 §6.4「不一致保持 HALTED 等人处理」的方向）：
//   1. 每一个差异码都必须有建议，且必须写清为什么 —— 人看不到理由就不会用这份报告；
//   2. 凡是「改账」动作（记成交 / 改状态 / 采纳场所视图）一律 requiresHuman = true：
//      本包只给建议，不改账；
//   3. 判不出来的给 query_order_status / wait_and_recheck / review_*，不猜。
import type { Advice, FindingCode, Severity } from './types'

/** 每个差异码的默认严重度。 */
export const SEVERITY: Record<FindingCode, Severity> = {
  local_open_venue_filled: 'blocker',
  local_open_venue_cancelled: 'warn',
  local_open_venue_rejected: 'warn',
  local_open_venue_partially_recorded: 'blocker',
  local_open_venue_missing: 'blocker',
  local_terminal_venue_open: 'blocker',
  order_state_drift: 'warn',
  order_filled_size_drift: 'blocker',
  order_price_drift: 'warn',
  order_reduce_only_drift: 'warn',
  order_unverified_within_latency: 'info',
  amend_chain_resolved: 'info',
  amend_chain_broken: 'warn',
  amend_chain_ambiguous: 'blocker',
  venue_order_unmapped: 'blocker',
  venue_order_external: 'warn',
  order_venue_id_conflict: 'blocker',
  fill_duplicate: 'info',
  fill_conflict: 'blocker',
  fill_orphan: 'warn',
  fill_missing_inferred: 'blocker',
  fill_missing_unexplained: 'blocker',
  fill_dedupe_key_fallback: 'warn',
  fill_dedupe_key_cumulative: 'warn',
  fill_recorded_excess: 'blocker',
  fill_total_exceeds_order: 'warn',
  ledger_fill_duplicate: 'warn',
  fill_time_anomaly: 'warn',
  position_size_mismatch: 'blocker',
  position_missing_at_venue: 'blocker',
  position_missing_locally: 'blocker',
  position_side_mismatch: 'blocker',
  position_shape_mismatch: 'blocker',
  position_margin_mode_mismatch: 'warn',
  position_entry_price_drift: 'info',
  snapshot_stale: 'warn',
  venue_fills_truncated: 'warn',
  venue_report_unavailable: 'warn',
}

/** 建议动作与理由。理由写「为什么这么建议」，不写承诺。 */
export const ADVICE: Record<FindingCode, Advice> = {
  local_open_venue_filled: {
    action: 'mark_filled',
    why: '场所历史订单报告显示这张单已成，账本还当它在挂；不改状态的话后续撤单会打到不存在的单号上。',
    requiresHuman: true,
  },
  local_open_venue_cancelled: {
    action: 'mark_cancelled',
    why: '场所历史订单报告显示这张单已撤 / 已过期，账本还当它在挂；不撤本地状态会一直占着风控额度。',
    requiresHuman: true,
  },
  local_open_venue_rejected: {
    action: 'mark_cancelled',
    why: '场所历史订单报告显示这张单被场所拒绝，账本没有落 problem；建议按拒单处理并保留上游原话。',
    requiresHuman: true,
  },
  local_open_venue_partially_recorded: {
    action: 'record_fill',
    why: '场所只有部分成交的回报、没有终结状态，账本还当整单在挂；先补记成交再决定剩余量怎么处理。',
    requiresHuman: true,
  },
  local_open_venue_missing: {
    action: 'query_order_status',
    why: '场所挂单与历史订单都没有这张单；先按客户端单号再查一次，仍查不到才由人判定是丢失还是未到。',
    requiresHuman: true,
  },
  local_terminal_venue_open: {
    action: 'halt_account_and_review',
    why: '账本认为这张单已经结束，场所却还在挂 —— 存在一笔不受账本约束的敞口，先停这张账户再看。',
    requiresHuman: true,
  },
  order_state_drift: {
    action: 'adopt_venue_state',
    why: '两边都有这张单但状态不同；建议以场所报告为准，逐字段写进账本备注，便于事后追溯。',
    requiresHuman: true,
  },
  order_filled_size_drift: {
    action: 'record_fill',
    why: '场所累计成交量比账本多，说明有成交没记进账本；差额要有成交记录才能改账，先按缺口补记。',
    requiresHuman: true,
  },
  order_price_drift: {
    action: 'adopt_venue_state',
    why: '两边都挂着同一张单但价格不同（改单确认丢了或被场所调整）；以场所为准，并核对改单请求的回报。',
    requiresHuman: true,
  },
  order_reduce_only_drift: {
    action: 'adopt_venue_state',
    why: '只减仓标记两边不一致；这决定这张单会不会加仓，按场所报告修正并核对下单请求。',
    requiresHuman: true,
  },
  order_unverified_within_latency: {
    action: 'wait_and_recheck',
    why: '下单还在场所回报延迟窗口内，场所没看到属正常；等一个延迟窗口再查，现在下结论会误判成丢失。',
    requiresHuman: false,
  },
  amend_chain_resolved: {
    action: 'informational',
    why: '改单链已解析出客户端单号对应的全部场所单号，后续按场所单号认单即可。',
    requiresHuman: false,
  },
  amend_chain_broken: {
    action: 'review_amend_chain',
    why: '链上有场所单号没有对应的下单 / 改单记录，重启后按单号认单会漏；需要人补齐这条链。',
    requiresHuman: true,
  },
  amend_chain_ambiguous: {
    action: 'review_amend_chain',
    why: '一个场所单号被多条本地单号认领（或多条链指向同一单），谁是活单无法判定，交给人。',
    requiresHuman: true,
  },
  venue_order_unmapped: {
    action: 'review_unmapped_order',
    why: '场所有这张挂单，账本没有任何订单认领它（单号像是我们的单）；可能是重启前下的单，先人工确认归属。',
    requiresHuman: true,
  },
  venue_order_external: {
    action: 'review_external_order',
    why: '这张挂单不是本系统下的（没有客户端单号或前缀不属于我们）；是否纳管由人决定，不自动接管。',
    requiresHuman: true,
  },
  order_venue_id_conflict: {
    action: 'halt_account_and_review',
    why: '同一场所单号被两条本地订单同时认领，成交会记到错误的订单上，先停账户再理清。',
    requiresHuman: true,
  },
  fill_duplicate: {
    action: 'ignore_duplicate',
    why: '同一成交号重复到达（REST 与私有流各推一次），内容一致，去重丢弃即可。',
    requiresHuman: false,
  },
  fill_conflict: {
    action: 'halt_account_and_review',
    why: '同一成交号两次到达但数量 / 价格 / 时间不同，账本无法判断哪条是真的；照内核规则会按成交号冲突停机。',
    requiresHuman: true,
  },
  fill_orphan: {
    action: 'review_unmapped_order',
    why: '成交指向的场所单号不在账本任何订单（含改单链）里；先认领订单，否则这笔成交无处入账。',
    requiresHuman: true,
  },
  fill_missing_inferred: {
    action: 'record_fill',
    why: '场所累计成交量比账本已记的多，差额按场所均价推出一条成交；这是推断，必须人来确认后才入账。',
    requiresHuman: true,
  },
  fill_missing_unexplained: {
    action: 'halt_account_and_review',
    why: '有成交缺口但场所没给均价、账本也没有可参照的成交价，推不出成交价格；不猜，先停账户查成交明细。',
    requiresHuman: true,
  },
  fill_dedupe_key_fallback: {
    action: 'fix_dedupe_key',
    why: '场所没给成交号，只能用「单号 + 时间 + 数量 + 价格」当回退键；两条真实成交若这些字段全同会被误判成重复。',
    requiresHuman: true,
  },
  fill_dedupe_key_cumulative: {
    action: 'fix_dedupe_key',
    why: '成交号由「订单号 + 累计成交量」合成：同一笔成交的累计量不变才能对上，源端时间戳不一致时同号不同时间会被判成冲突。',
    requiresHuman: true,
  },
  fill_recorded_excess: {
    action: 'review_ledger_fills',
    why: '账本记的成交合计比场所多：可能同一笔成交入了两次账，或多记了一笔；先按成交号逐条核，再决定冲销哪条。',
    requiresHuman: true,
  },
  fill_total_exceeds_order: {
    action: 'review_ledger_fills',
    why: '场所给的成交明细加起来比它自己的累计成交量还多：常见于 ExecId 更正被当成新成交、或同一笔回报推了两次；照这笔明细入账会把量记大。',
    requiresHuman: true,
  },
  ledger_fill_duplicate: {
    action: 'review_ledger_fills',
    why: '同一成交号在账本里已入账多次（REST 与私有流各入一次）；数量会被记大，持仓与可用额度都受影响。',
    requiresHuman: true,
  },
  fill_time_anomaly: {
    action: 'review_position',
    why: '成交时间落在未来（超出允许的时钟偏差）或早于回补窗口；这类成交的时间不可靠，先核对时区与来源。',
    requiresHuman: true,
  },
  position_size_mismatch: {
    action: 'review_position',
    why: '同一标的同一方向的数量不符；差额可能来自未记成交或外部下单，先定差额再改账。',
    requiresHuman: true,
  },
  position_missing_at_venue: {
    action: 'review_position',
    why: '账本有持仓、场所报平；可能是账本多记了开仓成交，或场所有一笔未记的平仓成交。',
    requiresHuman: true,
  },
  position_missing_locally: {
    action: 'review_position',
    why: '场所有持仓、账本没有；可能是外部下单或重启前的成交没回补，先归属再决定是否补记。',
    requiresHuman: true,
  },
  position_side_mismatch: {
    action: 'halt_account_and_review',
    why: '方向相反，说明中间有一笔方向记反的成交；继续按账本下单会造成双向持仓。',
    requiresHuman: true,
  },
  position_shape_mismatch: {
    action: 'review_position',
    why: '场所按双向持仓报了两条腿、账本是净额（或反之）；持仓模式不一致，数量对比没有意义。',
    requiresHuman: true,
  },
  position_margin_mode_mismatch: {
    action: 'review_position',
    why: '保证金模式两边不一致，会影响强平价与可用额度；以场所为准改本地记录。',
    requiresHuman: true,
  },
  position_entry_price_drift: {
    action: 'informational',
    why: '数量一致但均价有偏移，通常是场所进位或资金费口径差异；记下来供人核对，不改账。',
    requiresHuman: false,
  },
  snapshot_stale: {
    action: 'wait_and_recheck',
    why: '账本或场所视图太旧，基于旧视图的差异结论不可靠；刷新后再对一次。',
    requiresHuman: true,
  },
  venue_fills_truncated: {
    action: 'query_order_status',
    why: '成交回补被场所条数上限截断，早期成交可能没取到；缺口推断会偏大，先按订单号查详情。',
    requiresHuman: true,
  },
  venue_report_unavailable: {
    action: 'informational',
    why: '这个场所给不出该类报告，相关结论只能停在「需要人工」，不能当成「场所没有」。',
    requiresHuman: true,
  },
}

/** 取建议；调用方可覆盖理由（例如把「场所不提供历史订单」写进理由里）。 */
export function adviceFor(code: FindingCode, override?: Partial<Advice>): Advice {
  return { ...ADVICE[code], ...override }
}

/** 默认严重度，可被具体证据抬升（例如同一条缺单在延迟窗口外）。 */
export function severityFor(code: FindingCode, override?: Severity): Severity {
  return override ?? SEVERITY[code]
}
