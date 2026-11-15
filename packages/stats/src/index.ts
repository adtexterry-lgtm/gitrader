// SPDX-License-Identifier: CPAL-1.0
// @gitrader/stats 入口：回测统计纯函数（分布 / PSR / DSR、切分、CSCV PBO、块自助法）。
export { mean, variance, stdev, skewness, kurtosis, sharpe, annualizeSharpe, normalCdf, normalInv, psr, expectedMaxSharpe, dsr, sharpeOfTrials, informationRatio } from './dist'
export { purgedKFold, walkForward, combinations } from './splits'
export type { Fold, Window } from './splits'
export { cscvPbo } from './pbo'
export type { PboResult } from './pbo'
export { mulberry32, quantile, circularBlockBootstrap } from './bootstrap'
export type { BootstrapResult } from './bootstrap'
export { downsideDeviation, sortino, drawdownStats, calmar, varCvar } from './risk'
export type { DrawdownStats } from './risk'
