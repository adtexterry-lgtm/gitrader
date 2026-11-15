// SPDX-License-Identifier: CPAL-1.0
// clientOrderId 生成：OKX 只收 ≤ 32 位字母数字（`gt` + 摘要 + 阶段后缀，恰 32 位）；其它交易所用 `gt_<摘要>_<阶段>`（≤ 36 位）。
// 号码（策略 / 队列）是任意字符串（可能是 26 位 ULID），所以一律用「摘要 + 阶段后缀」，而不是拼接号码。

import { createHash } from 'node:crypto'

const OKX_MAX = 32
/** Bybit 的 orderLinkId 上限是 36；default 形态按最紧的通用上限收口。 */
const DEFAULT_MAX = 36

function alnum(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '')
}

function segment(s: string): string {
  return s.replace(/[^A-Za-z0-9.-]/g, '-')
}

/** (策略, 队列, 阶段) 的 sha256 十六进制；阶段已 trim + 小写。 */
function digest(strategyId: string, queueId: string, phase: string): string {
  return createHash('sha256')
    .update(JSON.stringify([strategyId.trim(), queueId.trim(), phase]), 'utf8')
    .digest('hex')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/pending_orders/live_order_support.py:196-205; adapted.
/**
 * 生成 clientOrderId。QD 的号码是整数，拼出来很短；这里号码是任意字符串，改为摘要以保证
 * 不同 (策略, 队列, 阶段) 不撞号。
 *
 * - `venue: 'okx'`：`gt` + 摘要（截到 30 − 阶段后缀长度）+ 阶段后缀（去非字母数字后前 8 位），
 *   恰 32 位、纯字母数字，阶段后缀总在末尾。
 * - `venue: 'default'`（缺省）：`gt_<摘要>_<阶段>`，阶段里非 `[A-Za-z0-9.-]` 的字符换成 `-`
 *   后取前 8 位；上限 36 位。阶段为空时是 `gt_<摘要>`（≤ 35 位）。
 *
 * 阶段一律小写。strategyId / queueId trim 后为空时没有可用 id，抛 RangeError。
 */
export function clientOrderId(parts: {
  strategyId: string
  queueId: string
  phase: string
  venue?: 'okx' | 'default'
}): string {
  if (parts.strategyId.trim() === '' || parts.queueId.trim() === '') {
    throw new RangeError('clientOrderId needs strategyId / queueId')
  }
  const p = parts.phase.trim().toLowerCase()
  const d = digest(parts.strategyId, parts.queueId, p)
  if (parts.venue === 'okx') {
    const pa = alnum(p).slice(0, 8)
    return (`gt${d.slice(0, OKX_MAX - 2 - pa.length)}${pa}`).slice(0, OKX_MAX)
  }
  const ps = segment(p).slice(0, 8)
  return ps === ''
    ? (`gt_${d.slice(0, DEFAULT_MAX - 4)}`).slice(0, DEFAULT_MAX)
    : (`gt_${d.slice(0, DEFAULT_MAX - 4 - ps.length)}_${ps}`).slice(0, DEFAULT_MAX)
}
