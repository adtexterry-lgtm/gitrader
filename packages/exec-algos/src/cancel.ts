// SPDX-License-Identifier: CPAL-1.0
// 撤单二次确认：撤单回执不算终态，必须再读一次订单快照；撤销期间有成交要先把成交落账。

import { fx } from '@gitrader/protocol/decimal'

export type CancelOutcome = 'confirmed' | 'pending' | 'filled_meanwhile'

/** 撤单后新成交量必须是合法十进制且非负。 */
function fillAmount(raw: string): bigint {
  const v = fx(raw)
  if (v < 0n) throw new RangeError(`fillsSinceCancel must not be negative: ${JSON.stringify(raw)}`)
  return v
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/grid/engine.py:1457-1490; adapted.
/**
 * 判定一次撤单的三种结果（照 QD `_cancel_confirmed_order`：撤单请求异常只记日志，照样查快照；
 * 快照 cancelled 且无未处理成交才算确认）：
 *
 * - `filled_meanwhile`：撤单期间出现了成交（fillsSinceCancel > 0）。撤单与成交在交易所侧竞争，
 *   这时不能把订单当已撤——先落这笔成交，再重新计算覆盖。
 * - `confirmed`：快照状态是 cancelled / canceled，且没有新成交。**不论 ackOk**——撤单回执（ack）
 *   本身不是终态快照，请求超时但订单其实已撤的情况也要按 confirmed 走。
 * - `pending`：其它情况（快照仍是 open、缺状态，或回执没确认）。订单留在待轮询集合里。
 *
 * `ackOk` 参数保留只为接口稳定与调用方记录，不参与结果判定：结果以快照为准。
 */
export function cancelOutcome(input: {
  ackOk: boolean
  status?: string
  fillsSinceCancel: string
}): CancelOutcome {
  if (fillAmount(input.fillsSinceCancel) > 0n) return 'filled_meanwhile'
  const status = (input.status ?? '').trim().toLowerCase()
  if (status === 'cancelled' || status === 'canceled') return 'confirmed'
  return 'pending'
}
