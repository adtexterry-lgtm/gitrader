// SPDX-License-Identifier: CPAL-1.0
// 周期名 ↔ 毫秒。名单以 protocol 的 CANDLE_INTERVALS 为唯一来源（@gitrader/protocol/constants），
// 毫秒值照数据连接器的 INTERVAL_MS 表：packages/connector-binance-data/src/parse.ts:26-30。
// '1M' 是日历月、没有固定毫秒，这里的 30 天只作毫秒换算 / 校验用；续拉游标在 1M 上取
// 「末根开盘时间 + 1 ms」（见 fetch-candles.mjs 的 pageCandles），按固定毫秒推进会跳过整月。
import { CANDLE_INTERVALS } from '@gitrader/protocol/constants'

const MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
}

/** 协议支持的周期名（升序不定，顺序同 protocol）。 */
export const INTERVALS = [...CANDLE_INTERVALS]

/** 周期 → 毫秒；不认识返回 undefined（调用方转成用法错误）。 */
export function stepMs(interval) {
  return Object.hasOwn(MS, interval) && INTERVALS.includes(interval) ? MS[interval] : undefined
}

export function isInterval(value) {
  return stepMs(value) !== undefined
}
