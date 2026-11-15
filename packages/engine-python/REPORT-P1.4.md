# REPORT · P1.4 指标库

## 一、改了什么
新建 `engine/indicators.py`（64 个指标，纯标准库，无 numpy / pandas，K 线用映射，TS 名与 snake_case 名为同一函数）、`tests/test_indicators.py`（86 例）、`tests/fixtures/`（导出脚本 + 75 个 case 的 JSON 夹具）。QD 出处注释按 `grep -n` 实查行号写。

## 二、跑了什么
夹具连跑两次 hash 相同；`python -m unittest …/test_indicators.py` → 86 例全过；逐值比对 18,549 个数值与 2,011 个 null 位置，最大偏差 1.42e-14（限 1e-9）。

## 三、没做什么
没写 gep / main / strategy_api / sandbox / backtest；没跑 TS 侧 vitest；没做增量指标；没改 engine-core 任何文件。

## 四、需要主会话决定
1. QD `builtin_indicators.py` 只做示例播种（SQL + 源码字符串），不含指标数学；口径改取 QD `technical_indicators.py`、`factors/registry.py`、`qlib_adapter.py`。
2. `ta/index.ts` 未再导出 parkinsonVol / garmanKlassVol / turnoverProxy / volumeZscore（仅源文件 export）；是否补导出须改 engine-core。
3. QD 的 KDJ / RSI 结果 round 到 4 位小数；为与 TS 逐值相等保留全精度，是否加兼容开关。

## 指标清单

| 类别 | 指标（64） | TS 源 |
|---|---|---|
| 趋势 | sma, ema, wma, macd, cross | ta/trend.ts |
| 动量 | rsi, stochastic, roc, momentum, williams_r, cci | ta/momentum.ts |
| 波动 | true_range, atr, rolling_std, bollinger, keltner, donchian, log_returns, annualized_vol, parkinson_vol, garman_klass_vol | ta/volatility.ts |
| 量价 | obv, vwap, mfi, cmf, ad_line, turnover_proxy, volume_zscore | ta/volume.ts |
| 叠加 | dema, tema, hma, kama, vwma, alma, zlema, ichimoku, parabolic_sar, supertrend, pivot_points, linear_regression, envelope | ta/overlap.ts |
| 振荡 | trix, ultimate_oscillator, awesome_oscillator, ppo, aroon, dpo, adx, stoch_rsi, chaikin_oscillator, force_index, ease_of_movement, mass_index, ulcer_index, vortex, choppiness, kdj, elder_ray | ta/oscillators.ts |
| Alpha158 算子 | rolling_sum, rolling_corr, rank_pct, idx_max, idx_min, linear_residual | ta/alpha-ops.ts |

夹具 case 分布：以上 64 个函数各 1 条（含 4 个只在源文件导出、index.ts 未再导出的）+ vwapWindow + rollingStdDdof1 + 9 个全平盘（区间 0 / 量 0）分支 = 75。
