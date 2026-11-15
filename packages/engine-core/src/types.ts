// SPDX-License-Identifier: CPAL-1.0
// 引擎内部通用类型：K 线、周期。K 线沿用协议的 `{t,o,h,l,c,v}`（t = 开盘时间 ms，行情类允许 number）。
import type { Candle } from './proto'

export type { Candle }

/** 引擎支持的 K 线周期（毫秒）。1w 以内；月线长度不固定，不支持。 */
export const INTERVAL_MS: Readonly<Record<string, number>> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
}
export const DECLARED_INTERVALS: readonly string[] = ['1m', '5m', '15m', '1h', '4h', '1d']
