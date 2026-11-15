// SPDX-License-Identifier: CPAL-1.0
// @gitrader/exec-algos：执行算法纯函数库。数量 / 价格一律十进制字符串（@gitrader/protocol 的 decimal 工具），无 I/O。
export { makerPrice, bandPrice } from './price'
export {
  startMakerThenMarket,
  onFill,
  onTimeout,
  remainingSize,
  averagePrice,
} from './maker-then-market'
export { resolveCloseQuantity } from './close-quantity'
export { cancelOutcome } from './cancel'
export type { CancelOutcome } from './cancel'
export { clientOrderId } from './order-id'
export { fillDedupeKey } from './dedupe'
export type { ExecState, ExecStep, Fill, MakerThenMarketSpec, Side } from './types'
