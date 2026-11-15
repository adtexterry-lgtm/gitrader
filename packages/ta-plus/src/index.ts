// SPDX-License-Identifier: CPAL-1.0
// @gitrader/ta-plus 入口：补齐 engine-core ta/ 缺的指标（对齐参考因子目录），纯函数、因果、对齐输入、预热期 null。
// 与 engine-core 的分工（批 9 收尾）：同口径同值的 5 个（plusDI / minusDI / aroonOsc / linRegSlope /
// linRegIntercept）直接转发 engine-core 的实现，本包不再维护第二套；口径不同的 4 个（adOsc / stochF /
// correl / variance）保留本包实现，差异与参照来源见 README「与 engine-core 的差异」。
export type { Bar, Series } from './types'
export { simpleReturns } from './internal'

// 基本面比率（标量进、标量出）——**实验性**：入参形状由本包自定（批 9 主会话裁定），未与内核对齐，接口可能变。
export {
  bookToPrice,
  debtToEquity,
  earningsYield,
  freeCashFlowYield,
  returnOnEquity,
  revenueGrowth,
} from './fundamental'

// 风险 / 波动
export {
  amihudIlliquidity,
  atrPercent,
  downsideVolatility,
  kurtosis,
  maxDrawdown,
  realizedVolatility,
  skewness,
} from './risk'

// 动量 / 趋势强度
export {
  cmo,
  efficiencyRatio,
  emaDistance,
  emaSlope,
  smaDistance,
  tsi,
  zScore,
} from './momentum-ext'

// 流动性 / 区间位置
export { pricePosition, volumeRatio } from './liquidity'

// 统计与区间
export { adxr, avgDev, bop, variance } from './stat-ext'

// 价格变换（TA-Lib AVGPRICE / MEDPRICE / TYPPRICE / WCLPRICE）
export { avgPrice, medPrice, typPrice, wclPrice } from './price-transform'

// 窗口极值与中点（TA-Lib MAX / MIN / MAXINDEX / MININDEX / MIDPOINT / MIDPRICE）
export { maxIndex, midPoint, midPrice, minIndex, rollingMax, rollingMin } from './window'

// 均线扩展（TA-Lib TRIMA / T3）
export { t3, trima } from './ma-ext'

// 方向类（TA-Lib PLUS_DM / MINUS_DM 本包实现；PLUS_DI / MINUS_DI / DX 转发 engine-core adx()）
export { dx, minusDI, minusDM, plusDI, plusDM } from './directional'

// 振荡补充（TA-Lib AROONOSC 转发 engine-core aroon()；STOCHF 本包实现，与 engine-core stochastic() 口径不同）
export { aroonOsc, stochF } from './osc-ext'

// 回归与相关（TA-Lib CORREL / BETA 本包实现；LINEARREG_* 转发 engine-core linearRegression()；TSF）
export { beta, correl, linRegAngle, linRegIntercept, linRegSlope, tsf } from './regression'

// 波动与量能补充（TA-Lib NATR / ADOSC；两者与 engine-core 口径不同，保留本包实现）
export { adOsc, natr } from './volatility-ext'

// 价位估计（支撑 / 阻力合成；tradingLevels 已按批 9 裁定删除）
export { levels } from './levels'
export type { LevelsEstimate, LevelsOptions } from './levels'
