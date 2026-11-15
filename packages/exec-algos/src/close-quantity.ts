// SPDX-License-Identifier: CPAL-1.0
// 平仓量三重上限：策略账本持仓、交易所持仓、同账户其它策略占用，三者取最小可用量。
import { fx, min as minFx, str, sub, type Fx } from '@gitrader/protocol/decimal'

/** 负值按 0 处理（交易所偶尔回负的持仓差额）。 */
function nonNegative(x: string): Fx {
  const v = fx(x)
  return v < 0n ? 0n : v
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/position_query.py:240-342; adapted.
/**
 * 计算可平仓数量：min(账本持仓, 交易所持仓 − 其它策略占用)。
 *
 * - 策略账本是**数量来源**：交易所持仓可能含用户手动持仓或别的策略的仓位，不能当来源。
 * - 交易所持仓是第二道安全上限；其它策略已占用的部分要从可用量里先扣掉。
 * - 三重上限任何一项耗尽 → 0（不发平仓单）。
 */
export function resolveCloseQuantity(input: {
  ledgerPosition: string
  venuePosition: string
  otherStrategiesHold: string
}): string {
  const ledger = nonNegative(input.ledgerPosition)
  const venue = nonNegative(input.venuePosition)
  const other = nonNegative(input.otherStrategiesHold)
  const available = sub(venue, other)
  return str(minFx(ledger, available > 0n ? available : 0n))
}
