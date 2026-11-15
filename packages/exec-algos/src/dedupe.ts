// SPDX-License-Identifier: CPAL-1.0
// 成交去重键：有交易所成交号就用它，没有就用订单号 + 规范化数量 / 价格 / 时间的合成键，统一 sha256。
import { createHash } from 'node:crypto'
import { canonical } from './num'

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/execution_streams/events.py:93-122; adapted.
/**
 * 成交去重键（sha256 十六进制，64 位）：
 *
 * - 有 `tradeId`（交易所成交号）时，键只由 venue + orderId + tradeId 决定。数量 / 价格不参与，
 *   因为同一笔成交可能被私有流、轮询、对账三条路径各报一次，报的数量口径可能不同（累计 vs 增量）。
 * - 没有 `tradeId` 时退化成 venue + orderId + ts + 规范化数量 + 规范化价格。数量 / 价格先规范成
 *   十进制字符串，所以 "0.10" 与 "0.1" 得到同一个键。
 */
export function fillDedupeKey(f: {
  venue: string
  tradeId?: string
  orderId: string
  ts: number
  size: string
  price: string
}): string {
  const venue = f.venue.trim().toLowerCase()
  if (venue === '') throw new RangeError('fillDedupeKey needs a venue')
  const orderId = f.orderId.trim()
  if (orderId === '') throw new RangeError('fillDedupeKey needs an orderId')
  if (!Number.isFinite(f.ts)) throw new RangeError(`fillDedupeKey needs a finite ts: ${String(f.ts)}`)
  const tradeId = (f.tradeId ?? '').trim()
  const basis =
    tradeId !== ''
      ? ['v1', venue, orderId, tradeId]
      : ['v1', venue, orderId, String(f.ts), canonical(f.size), canonical(f.price)]
  return createHash('sha256').update(JSON.stringify(basis), 'utf8').digest('hex')
}
