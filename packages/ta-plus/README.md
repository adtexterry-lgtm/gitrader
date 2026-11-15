> 许可证：CPAL-1.0。

# @gitrader/ta-plus

指标库补齐包：把 `packages/engine-core/src/strategy/ta/` 缺的指标按「纯函数 + 因果 + 对齐输入」补上，口径对齐参考因子目录（QuantDinger）。零第三方依赖，只用 TypeScript 标准语法，不读文件、不联网。

与 engine-core 的分工（批 9 收尾，主会话裁定：**不并入** engine-core，保持独立包）：

- 与 engine-core **同口径同值**的 5 个（`plusDI` / `minusDI` / `aroonOsc` / `linRegSlope` / `linRegIntercept`）改为**直接转发** engine-core 的实现，本包不再维护第二套；`dx` / `linRegAngle` / `tsf` 由转发结果合成。
- 与 engine-core **口径不同**的 4 个（`adOsc` / `stochF` / `correl` / `variance`）保留本包实现，差异逐条写在下面「与 engine-core 的差异」。
- 转发是**相对路径只读引用**（`../../engine-core/src/strategy/ta/...`）：engine-core 的 `package.json` 只导出 `.`，且根入口没有 re-export `ta/`；本批又规定 engine-core 不动，所以不通过包名导入，也没有把本包并进内核。同值性由 `test/engine-core-parity.test.ts` 逐项断言。

## 约定（与 engine-core 的 ta/ 一致）

- 序列函数的输出**与输入等长**；指标尚未可算的位置是 `null`，不是 `0` 也不是 `NaN`。
- **因果**：第 i 项只用 ≤ i 的数据（截断尾部不改变历史值，测试里有专门的性态用例）。
- 周期参数必须是 ≥ 1 的整数；`period ≤ ddof`、分母为 0 这类无定义情形抛 `RangeError`，不返回 `Infinity`。
- **非法周期一律抛 `RangeError`**（0 / 负数 / 小数 / `NaN` / `Infinity` 五类都算），包括转发的 5 个：engine-core 遇非法周期静默返回全 `null`，本包的包装函数先校验、抛错。逐函数的表见 `test/period-errors.test.ts`；回归类另要求 `period ≥ 2`。
- 不修改输入数组 / K 线对象。
- 数值一律用 JavaScript 双精度浮点（与 engine-core 的 ta/ 相同口径，不引入 decimal）；**比率类返回分数而不是百分数**（`atrPercent` 返回 `atr/close` 的比率，`pricePosition` 返回 0..100 的百分数，见下）。

## 首批指标（26 个）

| 文件 | 指标 | 说明 |
|---|---|---|
| `src/fundamental.ts` | earningsYield / bookToPrice / returnOnEquity / debtToEquity / freeCashFlowYield / revenueGrowth | 标量进、标量出（最新一期财报字段的比率）。**实验性**：入参形状由本包自定（批 9 裁定），未与内核对齐，接口可能变 |
| `src/risk.ts` | realizedVolatility / downsideVolatility / skewness / kurtosis / maxDrawdown / atrPercent / amihudIlliquidity | 收益序列或 K 线进，等长序列出 |
| `src/momentum-ext.ts` | cmo / tsi / efficiencyRatio / smaDistance / emaDistance / emaSlope / zScore | 动量与均线偏离 |
| `src/liquidity.ts` | volumeRatio / pricePosition | 量比与近 N 根区间位置 |
| `src/stat-ext.ts` | avgDev / variance / bop / adxr | 平均绝对偏差、滚动方差、力量平衡、ADX 评级 |

## 第二批指标（T1b）

| 文件 | 指标 | 说明 |
|---|---|---|
| `src/price-transform.ts` | avgPrice / medPrice / typPrice / wclPrice | 逐 bar 价格变换，无预热期 |
| `src/window.ts` | rollingMax / rollingMin / maxIndex / minIndex / midPoint / midPrice | 窗口极值、位置与中点 |
| `src/ma-ext.ts` | trima / t3 | 三角移动平均与 T3 |
| `src/directional.ts` | plusDM / minusDM / plusDI / minusDI / dx | Wilder 方向运动与方向指标（+DM / −DM 本包实现，+DI / −DI 转发 engine-core，dx 由两者合成） |
| `src/osc-ext.ts` | aroonOsc / stochF | Aroon 振荡（转发 engine-core）与快速随机指标（本包实现，与 engine-core `stochastic()` 口径不同） |
| `src/regression.ts` | correl / beta / linRegSlope / linRegIntercept / linRegAngle / tsf | 相关、回归斜率 / 截距 / 角度与时间序列预测（斜率与截距转发 engine-core） |
| `src/volatility-ext.ts` | natr / adOsc | 归一化真实波幅与蔡金振荡（ADOSC 的 EMA 种子与 engine-core 不同） |
| `src/levels.ts` | levels | 支撑 / 阻力合成（启发式估计，不是交易建议）；`tradingLevels` 已按批 9 裁定删除 |

完整差集清单（名字 / 类别 / 参考出处 file:line）见 `REPORT.md`。

## 口径差异（有意与参考实现不同，写清楚以免误用）

1. **volumeRatio 的基线不含当根**：取 `volume[i] / mean(volume[i−period .. i−1])`。参考实现 `services/factors/registry.py` 的量比把当根算进均值，而 `services/market/technical_indicators.py:157-163` 用「前 N 根」并注释说明含当根会系统性压低比值；本包采用后者，测试里给出两种口径的对照数字。
2. **atrPercent 返回比率**（`atr/close`），不是百分数；`pricePosition` 才返回 0..100。
3. **skewness / kurtosis 默认样本口径**（pandas `.skew()` / `.kurt()`、Excel SKEW / KURT 的校正公式，需要 n ≥ 3 / n ≥ 4），`{ sample: false }` 切到总体矩口径。
4. **CMO 用 TA-Lib 口径（Wilder 平滑）**：种子是前 period 个涨跌额的**平均**（不是和），之后按 Wilder 递推。QD `factors/registry.py` 的 `_cmo` 是 Chande 原始定义（最近 period 个涨跌额直接求和、不平滑），同一输入 `[10,11,10,12,12,13]`、period 3 时 QD 口径为 50 / 33.333… / 100，本包为 50 / 50 / 68。
5. **方向类 +DM / −DM / +DI / −DI 用 Wilder（1978）定义**：平滑和的种子 = 第 1..period 根 DM / TR 之和，首值在下标 period。与 engine-core `adx()` 内部同口径同值——批 9 起 `plusDI` / `minusDI` **直接转发**该实现（`dx` 由这两条序列合成），`plusDM` / `minusDM` 是 engine-core 没导出的中间量，仍由本包按同一递推实现；同值性由 `test/engine-core-parity.test.ts` 断言。TA-Lib `PLUS_DM` / `PLUS_DI` 的种子是前 period−1 根之和再平滑一步（首值在下标 period−1），预热段数值不同：本夹具 period 3 时 TA-Lib 的 +DI[3] = 200/7 = 28.571428…、本包 100/3（这两个数在批 8 收口时由审稿方按 `ta_PLUS_DI.c` 独立复算过；本批未联网重读该源码，此处只复核本包一侧的口径与本夹具数值一致）。
6. **NATR 的 ATR 用 engine-core / QD 口径**：第 0 根 TR = h−l，首批 period 根取简单平均，首值在下标 period−1，之后 Wilder 递推；`natr = 100 × atrPercent`（同一条 ATR，单位是百分比）。TA-Lib `ta_NATR.c` 的 TR 从第 1 根算、lookback = period（首值在下标 period），因此预热段不同：本夹具 period 3 时 TA-Lib natr[3] = 100×3/102 = 2.941176…、本包 natr[3] = 2.723311…（本包这一侧与 `test/volatility-ext.test.ts` 的期望值逐位一致；TA-Lib 那一侧是批 8 收口按源码复算的结果，本批未联网重读）。
7. **BETA 不做收益率转换**：TA-Lib `ta_BETA.c` 的输入是两条价格序列、lookback = period，内部先把价格转成单根收益率再回归；本包 `beta(a, b, period)` 直接对传入序列回归（a 相对 b 的斜率），要得到常规意义的 beta，调用方先用 `simpleReturns` 转收益率再传入。另外 `correl` / `beta` 在窗口方差为 0（退化）时输出 `null`，TA-Lib `ta_CORREL.c` 输出 0.0 —— 本包有意不照抄那个 0（0 会被误读成「无相关」而不是「无定义」）。

## 与 engine-core 的差异（批 9 收尾：口径不同、未转发的 4 个）

下面 4 个与 engine-core `packages/engine-core/src/strategy/ta/` 有对应物但**口径不同**，所以保留本包实现、不转发也不删除。每条都有一条测试钉住差异（`test/engine-core-parity.test.ts`），改任何一边都会红。

| 指标 | 本包 | engine-core | 参照来源 |
|---|---|---|---|
| `adOsc` ↔ `chaikinOscillator()` | EMA 以**第一个 A/D 值**为种子，`k = 2/(n+1)`，首个非 null 在 `max(fast,slow)−1` | EMA 以**前 period 个 A/D 的简单平均**为种子（它的 `ema` 约定），预热段数值不同、随后收敛 | 本包照 TA-Lib `ta_ADOSC.c`（批 8 收口按源码复算）；engine-core 的种子口径见其 `strategy/ta/trend.ts` 的 `ema` |
| `stochF` ↔ `stochastic()` | 区间为 0（HH = LL）时 **K = 0**；默认 `kPeriod = 5` | 同样情形给 **50**；默认 `kPeriod = 14` | 本包照 TA-Lib `ta_STOCHF.c`；其余公式两边相同（K 逐位一致，D 的求和顺序不同，末位差 < 1e-13） |
| `correl` ↔ `rollingCorr()` | 入参 `number[]`、**要求等长**（不等长抛 RangeError）、默认 `period = 20`；窗口方差为 0 给 `null` | 入参 `(number|null)[]`、`period` 必填；**任何窗口含 null 就给 null**；分母为 0 给 `null` | 数值口径同为窗口 Pearson（测试断言两者逐项一致到 1e-12）；公式参照 TA-Lib `ta_CORREL.c`，但**不照抄**它退化时输出 0.0 的做法 |
| `variance` ↔ `rollingStd()` | 输出**方差**（不开放根），`ddof` 可调（0 总体 / 1 样本），默认 `period = 20` | 输出**标准差**（= √方差），`ddof` 同样可调，`period` 必填 | TA-Lib `ta_VAR.c`（nbDev=1 时总体方差）；同一输入下 `variance = rollingStd²`（测试断言到 1e-10） |

另外三个是本包独有的：`beta`（engine-core 没有）、`plusDM` / `minusDM`（engine-core 只在 `adx()` 内部算，未导出）、`dx` / `linRegAngle` / `tsf`（由转发结果合成，不重复实现）。

## 参照与出处

参照值都**不来自本包实现**，也不来自任何移植代码的输出：

- **TA-Lib**（BSD，只读下载，未入库）：`src/ta_func/ta_CMO.c`、`ta_BOP.c`、`ta_AVGDEV.c`、`ta_VAR.c`、`ta_ADXR.c`、`ta_PLUS_DM.c`、`ta_PLUS_DI.c`、`ta_AROONOSC.c`、`ta_STOCHF.c`、`ta_ADOSC.c`、`ta_NATR.c`、`ta_CORREL.c`、`ta_BETA.c`、`ta_LINEARREG_*.c`、`ta_TSF.c`，commit `1da0e86bb6c5`（2026-10-19）——用于核对公式定义（CMO 的 Wilder 平滑（种子取平均）、BOP 的单 bar 定义、AVGDEV 除 period、VAR 的总体方差、ADXR 的 `(ADX[k]+ADX[k−(period−1)])/2`、AROONOSC 的 period+1 根窗口、STOCHF 区间为 0 的兜底、ADOSC 的 EMA 种子、NATR 的 lookback、CORREL 退化输出 0.0）。**口径归属**：这批源码只读、未入库，本批（批 9）未联网重读；README 里出现的「TA-Lib 的数值」都是批 8 收口时按源码独立复算的结果，本批只复核了本包一侧的口径与夹具期望值一致。
- **engine-core**（本仓库，CPAL-1.0）：`packages/engine-core/src/strategy/ta/{oscillators,overlap}.ts`——`plusDI` / `minusDI`（`adx()`）、`aroonOsc`（`aroon().osc`）、`linRegSlope` / `linRegIntercept`（`linearRegression()`）直接转发这五个实现；差异对照用到的 `chaikinOscillator()` / `stochastic()` / `rollingCorr()` / `rollingStd()` 也读自同目录。这是**同一仓库内的单一真相源**，不算独立参照值。
- **QuantDinger**（Apache-2.0）：`app/services/factors/registry.py`（`_realized_vol` / `_downside_volatility` / `_skewness` / `_kurtosis` / `_max_drawdown` / `_atr_pct` / `_amihud_illiquidity` / `_ma_distance` / `_ema_slope` / `_zscore_last` / `_ratio_last`）与 `app/services/market/technical_indicators.py`（量比、价格位置）。只借鉴口径与字段语义，代码为本包独立实现。
- **手算小例**：每个指标至少一条用可整除的小整数构造、把分数推导写在注释里的用例（如 CMO `[10,11,10,12,12,13]` → `68`、TSI 二级 EMA → `−1100/27`、峰度 `[1..5]` → `−1.3`）。

## 用法

```ts
import { cmo, realizedVolatility, simpleReturns, volumeRatio } from '@gitrader/ta-plus'

const returns = simpleReturns(closes)            // 第 0 项 null，其余 c[i]/c[i-1] − 1
const vol = realizedVolatility(returns.slice(1) as number[], 20)  // 年化 ×√252，ddof=1
const momentum = cmo(closes, 14)                 // −100..100，前 14 项 null
const ratio = volumeRatio(volumes, 20)           // 基线不含当根
```

## 测试与验收

```bash
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/ta-plus    # 18 文件 / 162 例
node node_modules/typescript/bin/tsc -p packages/ta-plus --noEmit      # 0
```

每个数值断言都附参照来源与推导；另有约定类用例（等长、因果、预热期 null、输入不被修改、非法周期抛错）覆盖全部非基本面导出（49 个，共 55 个导出 = 49 + 6 个标量基本面），其中非法周期由 `test/period-errors.test.ts` 逐函数列表跑 0 / 负数 / 小数 / `NaN` / `Infinity` 五类；与 engine-core 的分工由 `test/engine-core-parity.test.ts` 断言（5 个转发的逐位同值 + 4 个差异各一条「改任一边就红」）。

**反证记录**（每个关键行为都要能证明「实现错了测试会红」，见 `REPORT-T1.md`）：把 `internal.ts` 的 `assertPeriod` 判断删掉（改成什么都不做）→ 10 个文件 14 条用例红；把 `plusDI` 故意转发成 `adx().minusDi` → 6 条红（含 parity 的逐位比对）。两次改动都已恢复，`git diff` 为空。

## 依赖

零第三方依赖（`package.json` 没有 `dependencies`）。批 9 裁定：**不并入** `packages/engine-core`，保持独立包；同口径同值的 5 个指标按相对路径只读引用 engine-core 的 `src/strategy/ta/`（不通过包名导入，因为它的 `exports` 只有 `.` 且根入口没有 re-export `ta/`，本批又不允许改 engine-core）。
