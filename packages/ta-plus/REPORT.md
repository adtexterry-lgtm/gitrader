# REPORT · T1a packages/ta-plus 首批（指标库补齐）

## 一、做了什么

新建 `packages/ta-plus/`（20 文件，零依赖），26 个指标：基本面 6、风险 7、动量 7、流动性 2、统计 4。差集见下。

## 二、怎么做

口径同 QD 因子目录与行情派生量（file:line 见表），公式以 TA-Lib 官方 C 实现核对（BSD，未入库）。每指标至少一条独立参照：官方定义手算小例，无一条期望值出自本包或移植代码。约定同 engine-core `ta/`：等长、因果、预热 null、非法周期抛错。

## 三、验收（真实输出）

vitest 73 例、tsc 0、check-public 2085 文件、audit-headers 1292、deps-audit 52 包——全 ok；hygiene 5/6，失败那条属并行包缺 README，本包同条件单独 17 文件全过。

## 四、需要主会话决定

①并入 engine-core 与否；②TA-Lib 全量（≥201）未逐个映射，T1b 先补；③volumeRatio 取「基线不含当根」，与 QD registry 口径不同，请定；④hygiene 待并行包补齐；⑤耗时表在 T1b；⑥未动根 lock，收口请 `npm install` 登记。

---

## 差集清单

QD 原生因子层（`app/services/factors/registry.py:199-261` 共 63 个：56 技术 + 7 基本面）与 `app/services/market/technical_indicators.py` 的派生量，逐个与 `packages/engine-core/src/strategy/ta/` 的 64 个导出比对。**已覆盖 41 个技术因子**（sma / ema / momentum / roc / rsi / macd / bollinger_bands / stochastic / kdj / cci / williams_r / mfi / adx / aroon / trix / supertrend / atr / donchian_channels / keltner_channels / volume_zscore / turnover_proxy / obv / ad_line / chaikin_oscillator / vwap / cmf / dema / tema / zlema / hma / kama / ppo / awesome_oscillator / ultimate_oscillator / vortex / choppiness / elder_ray / force_index / ulcer_index / parkinson_volatility / garman_klass_volatility），差集如下（本批 **26 个全部实现**）：

| # | 指标（本包导出） | 类别 | 参考出处（file:line） | 本批 |
|---|---|---|---|---|
| 1 | `smaDistance` | trend | `factors/registry.py:201` sma_distance | ✔ |
| 2 | `emaDistance` | trend | `factors/registry.py:202` ema_distance | ✔ |
| 3 | `realizedVolatility` | risk | `factors/registry.py:218` realized_volatility | ✔ |
| 4 | `skewness` | risk | `factors/registry.py:219` skewness | ✔ |
| 5 | `kurtosis` | risk | `factors/registry.py:220` kurtosis | ✔ |
| 6 | `emaSlope` | trend | `factors/registry.py:221` ema_slope（`_ema_slope`:375-382） | ✔ |
| 7 | `atrPercent` | risk | `factors/registry.py:222` atr_pct（`_atr_pct`:384-387） | ✔ |
| 8 | `downsideVolatility` | risk | `factors/registry.py:223` downside_volatility（752-757） | ✔ |
| 9 | `maxDrawdown` | risk | `factors/registry.py:224` max_drawdown（759-764） | ✔ |
| 10 | `volumeRatio` | liquidity | `factors/registry.py:228`；基线口径取 `market/technical_indicators.py:157-163` | ✔ |
| 11 | `zScore` | reversal | `factors/registry.py:229` mean_reversion_zscore（`_zscore_last`:389-397） | ✔ |
| 12 | `cmo` | momentum | `factors/registry.py:242` cmo（`_cmo`:952-959） | ✔ |
| 13 | `tsi` | momentum | `factors/registry.py:245` tsi（991-1002） | ✔ |
| 14 | `efficiencyRatio` | trend | `factors/registry.py:248` efficiency_ratio（1043-1049） | ✔ |
| 15 | `amihudIlliquidity` | liquidity | `factors/registry.py:254` amihud_illiquidity（1075-1083） | ✔ |
| 16 | `earningsYield` | valuation | `factors/registry.py:256` earnings_yield | ✔ |
| 17 | `bookToPrice` | valuation | `factors/registry.py:257` book_to_price | ✔ |
| 18 | `returnOnEquity` | quality | `factors/registry.py:258` return_on_equity | ✔ |
| 19 | `revenueGrowth` | growth | `factors/registry.py:259` revenue_growth | ✔ |
| 20 | `debtToEquity` | quality | `factors/registry.py:260` debt_to_equity | ✔ |
| 21 | `freeCashFlowYield` | cashflow | `factors/registry.py:261` free_cash_flow_yield | ✔ |
| 22 | `pricePosition` | liquidity | `market/technical_indicators.py:165-168` price_position | ✔ |
| 23 | `avgDev` | statistic | TA-Lib `ta_AVGDEV.c:186-204`（QD 经 `talib_adapter.py:11` 暴露 ≥201 个函数） | ✔ |
| 24 | `variance` | statistic | TA-Lib `ta_VAR.c:181-182`（nbDev=1 即总体方差） | ✔ |
| 25 | `bop` | momentum | TA-Lib `ta_BOP.c:106` | ✔ |
| 26 | `adxr` | trend | TA-Lib `ta_ADXR.c:170-177` | ✔ |

**剩余差集（T1b 的输入，本批未做，已核过现状）**

| 项 | 类别 | 参考出处 | 处理 |
|---|---|---|---|
| `market_cap` | size | `factors/registry.py:255` | 字段直通（不是指标），不实现；由调用方直接用最新市值 |
| `levels`（支撑 / 阻力合成） | levels | `market/technical_indicators.py:106-120` | 待 T1b（启发式组合，接口形状要先定：返回 5 个标量还是序列） |
| `trading_levels`（ATR 止损止盈 + 风险回报比） | levels | `market/technical_indicators.py:132-152` | 待主会话定归属（含策略语义，可能属 engine-core 而非指标库） |
| `volume_ratio_meta` | metadata | `market/technical_indicators.py:161-163` | 元数据（基线说明），不实现 |
| TA-Lib 其余函数 | 各类 | `talib_adapter.py:11`（≥201 个） | 未逐个映射，T1b 先补映射表再补实现 |

## 参照来源（逐条可查）

| 指标组 | 独立参照 | 说明 |
|---|---|---|
| 6 个基本面比率 | 教科书定义 + 可整除手算（100/2500=0.04 等） | 期望值当场心算可核；分母为 0 抛错的行为单列 |
| `realizedVolatility` / `downsideVolatility` | 定义式 + 手算分数（±1% 交替 → s=0.011547005383792516；√(1.25e−4) 等） | ddof=1、整窗分母口径写进注释 |
| `skewness` / `kurtosis` | pandas `.skew()`/`.kurt()`、Excel SKEW/KURT 的公开校正公式 + 手算分数（1.2√2、36/(10√10)、−1.3、−1.2） | 样本 / 总体两套都测 |
| `maxDrawdown` / `atrPercent` / `amihudIlliquidity` | 定义式 + 小样本手算（−0.25、0.2、9.595959…e−7） | Amihud 手工列了两项的分母 |
| `cmo` | TA-Lib `ta_CMO.c:150-230`（Wilder 求和）+ 整数序列手算 | 逐步分数写在用例注释 |
| `tsi` | William Blau 定义 + k=2/3 分数手算（−1100/27） | 另测「动量恒正 → 100」的定义边界 |
| `efficiencyRatio` / `smaDistance` / `emaDistance` / `emaSlope` / `zScore` | 定义式 + 手算（1 / 0 / 0.2 / 0.25 / 1/7 / 1/3 / 2/√2.5） | EMA 的 seed 与 k 逐步列出 |
| `volumeRatio` / `pricePosition` | `market/technical_indicators.py:157-168` 定义 + 手算（2.0 / 1.5 / 83.333…） | 另测「含当根会得 1.2857…」的对照 |
| `avgDev` / `variance` / `bop` / `adxr` | TA-Lib `ta_AVGDEV.c` / `ta_VAR.c` / `ta_BOP.c` / `ta_ADXR.c` + 手算（1.2 / 2 与 2.5 / 0.25 / 20 与 30） | ADXR 的滞后位数按 `period−1` 核对 |

许可与获取：TA-Lib 源码 BSD，`main` commit `1da0e86bb6c5`（2026-10-19），只读下载 5 个 `src/ta_func/*.c` 用于核对公式，**留在临时目录，未进仓库、未参与运行**。QuantDinger Apache-2.0，仅借鉴口径与字段语义，代码独立实现（file:line 已标注）。

## 自查表（SELF-CHECK 14 条）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| S1 | 对照参照独立来源 | 过 | 参照=TA-Lib 官方 C 实现（BSD，commit 1da0e86bb6c5）/ 定义式手算小例 / QD file:line；无任何期望值由本包或移植代码生成（见「参照来源」表） |
| S2 | 端点、错误码、字段语义以官方文档实查 | 不适用 | 本包无网络端点；字段语义来自 QD 源码 file:line，非记忆 |
| S3 | 假服务器按参照规则实现、不 import 客户端 | 不适用 | 无假服务器；测试只用合成数据，`grep` 无外部 import（包内只 import `vitest` 与自身 src） |
| S4 | 碰钱脚本先有拦实盘护栏 | 不适用 | 无下单 / 无网络 |
| S5 | 遇安全闸门停报不绕 | 过 | 验收中 hygiene 第 6 条被并行标段半成品包阻断，未改他人目录、未绕过，写进「需要主会话决定」第 4 条 |
| S6 | 沙箱 / 限制能力过逃逸反例 | 不适用 | 本包不执行用户代码 |
| S7 | 子进程治理：PID / stderr / 临时目录 | 过 | 未起子进程；临时文件（TA-Lib 源码、临时 index、探针脚本、探针用例）收工前清理（见 S11） |
| S8 | 注释 / 文件头声称与实现一致 | 过 | 逐条核对：`warmup`、`ddof`、`整窗分母`、`基线不含当根` 的注释与代码一致；`atrPercent` 注释写明返回比率而非百分数 |
| S9 | 验收扫描覆盖新文件 | 过 | 用 `GIT_INDEX_FILE` + `git read-tree HEAD` + `git add -A packages/ta-plus` 造临时 index，check-public 扫到 2085 文件（含 20 个新文件），audit-headers 1292 源文件含新包 |
| S10 | 待办清单前查过 git log / 现状 | 过 | 用 `ls packages/`、`git ls-files`、`git status` 核过：`connector-htx-data` / `connector-htx-trade` / `symbol-search` / 四个行情连接器都是并行标段在建（未写 README），故不计入本标段待办 |
| S11 | 交付无临时文件、无无意义改动 | 过 | 删除 `test/zz-probe.test.ts`、临时 index、TA-Lib 下载目录与探针脚本；`git status` 只显示他人改动，本包未改任何既有文件（只新建） |
| S12 | REPORT 四段式 + 数字真实（亲跑粘贴） | 过 | 四段 + 差集 + 参照 + 自查；测试/tsc/check-public/audit 数字均来自本次真实输出 |
| S13 | 修复任务对照原审稿条目逐条核对 | 不适用 | 非修复单 |
| S14 | 状态机 / 撮合边界穷举 | 不适用 | 无状态机；边界值（period=1、标准差 0、区间 0、分母 0、全正收益、单调序列）均有用例 |
