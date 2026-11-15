# REPORT-T2 · Python 引擎指标补齐到 engine-core + ta-plus 并集（批 9 主题二）

**做了什么**：`engine/indicators.py` 追加 ta-plus 一节（snake_case 同名 + TS 原名别名，`__all__` 同步）；新增夹具脚本 `export-ts-taplus-fixtures.mjs`（esbuild 打包真跑，62 例）与 `tests/test_indicators_taplus.py`（79 例）。实测并集 **119**（engine-core 64 + ta-plus 55，零重叠；工单的「58+56」是旧口径），运行时导出逐个核对 `missing in python: []`。非法周期抛 `ValueError`（对应 `RangeError`），engine-core 那批旧口径不回归。

**验收**（亲跑）：`unittest discover -s tests` → 441 例 OK（基线 362，零回归 + 79 新例）；`run-conformance.mjs` → pass 18 / skip 19 / fail 0，O1–O4 全 pass，与改前逐项相同。反证两条：CMO 的 `loss -= delta` 改 `+=` → 2 例红；NATR 种子 `range(period)` 改 `range(1, period+1)` → 2 例红；恢复后 79 例全绿，`grep MUTATION` 无残留。

**如实**：未覆盖——①指标未接引擎面（`strategy_api.py` 不暴露这批）；②`t3` 参照是 `ta_T3.c` 定义式的有理数重算 + 两个定义边界，非外部公开向量；③`natr`/`plusDI` 与 TA-Lib 有已知口径差（已注明，非 bug）；④一致性只做单点调用，无随机参数扫描。另：高负载下首跑 `discover` 有 3 例钩子超时 error（38.9 s），单跑该文件 63 OK、两次重跑 13.2 s/13.6 s 全绿，判为负载抖动，与本标段无关。

**需要主会话决定**：①这批指标是否接到 `strategy_api.py` 的策略面；②与 TA-Lib 的口径差（TR 起点、DI 种子、零区间取 50 还是 0）统一，还是保持两套并继续标差异。

---

## 并集清单（119，运行时导出核对，非手抄）

- **engine-core（64）**：sma ema wma macd cross / rsi stochastic roc momentum williamsR cci /
  trueRange atr rollingStd bollinger keltner donchian logReturns parkinsonVol garmanKlassVol annualizedVol /
  obv vwap mfi cmf adLine turnoverProxy volumeZscore / dema tema hma kama vwma alma zlema ichimoku
  parabolicSar supertrend pivotPoints linearRegression envelope / trix ultimateOscillator awesomeOscillator
  ppo aroon dpo adx stochRsi chaikinOscillator forceIndex easeOfMovement massIndex ulcerIndex vortex
  choppiness kdj elderRay / rollingSum rollingCorr rankPct idxMax idxMin linearResidual
- **ta-plus（55）**：simpleReturns / realizedVolatility downsideVolatility skewness kurtosis maxDrawdown
  atrPercent amihudIlliquidity / cmo tsi efficiencyRatio smaDistance emaDistance emaSlope zScore /
  pricePosition volumeRatio / adxr avgDev bop variance / avgPrice medPrice typPrice wclPrice /
  rollingMax rollingMin maxIndex minIndex midPoint midPrice / t3 trima / dx minusDI minusDM plusDI plusDM /
  aroonOsc stochF / beta correl linRegAngle linRegIntercept linRegSlope tsf / adOsc natr / levels /
  earningsYield bookToPrice returnOnEquity debtToEquity freeCashFlowYield revenueGrowth

## 参照来源表（第二道检验：独立来源，不用 Python 结果反证 TS）

| 指标 | 参照来源（独立性） | 参照值摘录 | 用例 |
|---|---|---|---|
| cmo | TA-Lib `ta_CMO.c` 定义式 + 手算分数（Wilder 种子） | 50 / 50 / **68**（批 8「自算 57.89」的反例） | `test_cmo_talib_hand_computed` |
| tsi | Blau 定义式 + 2/3 权重手算 | −1100/27 = −40.740740740740735 | `test_tsi_hand_computed` |
| realizedVolatility | pandas `.std()` 定义式手算 + CPython `statistics.stdev` | 0.011547005383792516、年化 0.18330302779823363 | `test_realized_volatility_hand_computed` |
| downsideVolatility | QD `_downside_volatility` 定义式手算（分母整窗） | 0.011180339887498949、mar=1% → 0.018027756377319945 | `test_downside_volatility_hand_computed` |
| skewness / kurtosis | pandas `.skew()/.kurt()` 校正公式手算 | 1.697056274847714（=1.2√2）、−1.3 / −1.2 | `test_skewness_hand_computed`、`test_kurtosis_hand_computed` |
| maxDrawdown / atrPercent / amihudIlliquidity | 定义式手算（QD `_max_drawdown/_atr_pct/_amihud_illiquidity`） | −0.25、0.2、9.595959595959598e−7 | `test_max_drawdown_hand_computed` 等 3 例 |
| avgDev variance bop adxr | TA-Lib `ta_AVGDEV.c` / `ta_VAR.c` / `ta_BOP.c` / `ta_ADXR.c` | 1.2、2 与 2.5、0.25、20 与 30 | `test_avg_dev_hand_computed` 等 4 例 |
| efficiencyRatio / smaDistance / emaDistance / emaSlope / zScore | 考夫曼定义式、均线定义式、手算 | 0.2、0.25、0.25、1/7 与 1/3、2/√2.5 | 5 例 |
| volumeRatio / pricePosition | QD `technical_indicators.py:157-168` 定义（基线不含当根） | 2.0、1.5（含当根会是 1.2857…）、83.333… | 2 例 |
| avgPrice medPrice typPrice wclPrice | TA-Lib `ta_func.h` 四价定义 + 手算 | 100/103.5/106.5、320/3、427/4 | `test_price_transforms_hand_computed` |
| rollingMax/Min maxIndex minIndex midPoint midPrice | TA-Lib MAX/MIN/MAXINDEX/MININDEX/MIDPOINT/MIDPRICE（并列取最新） | 103、100、下标 2 与 3、101.5、102.5 | `test_window_hand_computed` |
| trima | TA-Lib `ta_TRIMA.c:159-160` 两层 SMA + 手算 | 102（i=3） | `test_trima_hand_computed` |
| t3 | TA-Lib `ta_T3.c` 权重式（和=1）+ 定义边界 | 常数序列还原 42、`period=1` 还原输入 | `test_t3_definition_boundaries`（**弱参照，见「如实」②**） |
| plusDM minusDM plusDI minusDI dx | Wilder(1978) 定义式手算（种子 = 第 1..period 根之和） | +DM 种子 3、−DM 1、+DI 100/3、−DI 100/9、DX 50 | `test_directional_wilder_hand_computed` |
| stochF / aroonOsc | TA-Lib `ta_STOCHF.c` / `ta_AROONOSC.c` + 手算 | 80、65、200/3 | 2 例 |
| linRegSlope/Intercept/Angle/tsf | TA-Lib `ta_LINEARREG_*.c` / `ta_TSF.c` + 手算 | 0.7、100.7、atan(0.7)、103.5 | `test_regression_hand_computed` |
| correl / beta | **CPython `statistics.correlation` / `linear_regression`**（他人实现） | 与 stdlib 逐位对齐（1e-9） | `test_correl_beta_hand_and_stdlib` |
| natr / adOsc | TA-Lib `ta_NATR.c` / `ta_ADOSC.c` + 手算（含与 TA-Lib 的已知差） | 100×(8/3)/103 = 2.588996763754、279.585185185185 | 2 例 |
| levels | QD `market/technical_indicators.py:106-152` 定义式手算 | support 100.762884361579、resistance 106.670448971754 | `test_levels_hand_computed` |
| 6 个基本面比率 / simpleReturns | 教科书定义 + 可心算整数 | 0.04、0.2、0.25、0.75、0.024、±0.1 | `test_fundamental_hand_computed`、`test_simple_returns_hand_computed` |

## 自查表 v2（每项判定命令 + 实际输出摘录）

| # | 项 | 结论 | 判定命令 | 输出摘录 |
|---|---|---|---|---|
| S1 | 对照参照独立来源 | 过 | 见上表「参照来源」列 | 来源分三类：TA-Lib 定义式/手算分数、QD 定义式、CPython `statistics`；无一条用 Python 输出反证 |
| S2 | 端点/错误码官方文档 | 不适用 | — | 本标段无网络端点与错误码 |
| S3 | 假服务器不 import 客户端 | 不适用 | — | 本标段无假服务器 |
| S4 | 碰钱脚本护栏 | 不适用 | — | 本标段无下单/平仓路径 |
| S5 | 遇安全闸门停报不绕 | 过 | `grep -n "trading\|order" packages/engine-python/engine/indicators.py` | 无匹配（指标库是纯函数，不触达闸门） |
| S6 | 沙箱逃逸反例 | 不适用 | — | 未改 `sandbox.py` |
| S7 | 子进程治理 | 不适用 | — | 未起子进程（夹具脚本一次性跑完即删临时目录） |
| S8 | 注释声称与实现一致 | 过 | 逐条对照 `indicators.py` 顶部 docstring、节头与 `ta-plus/src` 注释 | 新增 6 处口径说明与实现逐条核对；README 第 228 行「未接引擎面」仍属实 |
| S9 | 验收扫描覆盖新文件 | 部分（本包内） | `node packages/engine-python/tests/fixtures/_audit-exports.mjs`（临时，已删） | `core 64 plus 55 / union 119 / overlap [] / missing in python: []` |
| S10 | 待办前查现状 | 过 | `git status --porcelain -- packages/engine-python` | 只有本标段 4 个文件（1 改 3 新） |
| S11 | 无临时文件、无无意义改动 | 过 | 同上 + 临时审计脚本已删 | `M engine/indicators.py`、`?? …export-ts-taplus-fixtures.mjs`、`?? …ts-taplus.json`、`?? …test_indicators_taplus.py` |
| S12 | REPORT 四段+数字真实亲跑 | 过 | 四个验收命令的输出原文抄进「验收」段 | 441/441、18-19-0、两条反证红例 |
| S13 | 修复对照原审稿 | 不适用 | — | 非修复任务 |
| S14 | 状态机/撮合边界穷举 | 不适用 | — | 无撮合状态机；边界改为「零区间 / 零方差 / 零成交额 / 预热期 / 等长」用例 |
| S15 | 读失败分支不触动钱动作 | 不适用 | — | 无读取、无动钱动作 |
| S16 | 每条「过」附命令与输出 | 过 | 本表自身 | 每条「过」都有命令与摘录；无证据的项一律标「不适用」 |
| 新增 | 关键测试的反证 | 过 | 两次改坏→跑→恢复 | ①`loss -= delta`→`loss += delta`：`FAIL: test_cmo`、`FAIL: test_cmo_talib_hand_computed`（2 红）②`range(period)`→`range(1, period+1)`：`FAIL: test_natr`、`FAIL: test_natr_hand_computed`（2 红）；恢复后 `Ran 79 tests … OK`，`grep MUTATION` 无残留 |
