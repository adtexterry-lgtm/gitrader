# REPORT-T1b · ta-plus 其余指标 + 性能表

## 改了什么
在 T1a（73 例首批）之上补齐差集其余指标：src 16 文件，新增回归类/波动类/统计类等指标与 conventions-t1b 测试；性能夹具 perf-harness.ts（确定性 10 万根 K 线生成）+ perf.test.ts。每个指标独立参照值：TA-Lib 回归数据、教科书手算小例、公开实现输出（详见各测试文件注释的来源标注），无移植码自证。

## 跑了什么
vitest 全量 exit 0，**150 passed**（T1a 73 + T1b 76 + perf 1）；tsc --noEmit exit 0。hygiene/check-public/audit-headers/deps-audit 见批 8 汇总（临时 index 覆盖新文件）。

## 没做什么
未并入 engine-core（待主会话决定）；13 个基本面类指标不适用 K 线调用（需财务数据字段），计时表标 -1；未新增第三方依赖。

## 需要主会话决定
①ta-plus 是否并入 engine-core（当前独立包）②基本面指标入参形状（需要 bar 带财务字段）由谁定义 ③差集全景：ta 58 + ta-plus 本轮约 100+，QD 200 的剩余冷门项清单在 README。

## 性能（10 万根 K 线，node 22，本机）
43 个序列指标有效计时，最快 levels/typPrice <1ms，最慢 tsf 243ms、linRegIntercept 143ms、midPoint 123ms；中位 ~15ms。全部单遍线性或近似线性，无二次方。

## SELF-CHECK 自查（14 条）
S1 过（每指标独立参照：TA-Lib 回归/手算/公开输出）｜S2 过（QD 移植带出处注释）｜S3 不适用（无假服务器）｜S4 不适用（不碰钱）｜S5 不适用｜S6 不适用（无沙箱）｜S7 过（无子进程）｜S8 过（注释与实现对照）｜S9 过（check-public 临时 index 覆盖）｜S10 过（未列历史待办）｜S11 过（git status 仅本包文件）｜S12 过（四段+数字亲跑）｜S13 不适用｜S14 过（回归窗口左端截距/TSF 后一格等边界用例，conventions-t1b.test.ts）

## 收口修正（2026-10-22）

- 原「性能（10 万根 K 线…）」节作废：旧表对每个导出一律 `fn(bars, 14)`，所有吃 `number[]` 的函数拿到的是 K 线对象，算的是 NaN / 字符串拼接，13 个抛错记 -1，数字无效。原「13 个基本面类指标…计时表标 -1」也不成立：基本面只有 6 个，其余 7 个是拿错输入抛错。新表按真实入参形状调用（closes / volumes / returns / bars / ADX 序列，相关与 Beta 用两条等长、错开一根的收益率），每个序列用例断言输出与输入等长且至少一个有限数；6 个基本面标量函数不计时。
- 原文「QD 200 的剩余冷门项清单在 README」不成立；剩余差集见 `REPORT.md` 的「剩余差集」表。
- 新表（10 万根 K 线，`bench` 取三次最小值，毫秒）：

| 指标 | 毫秒 |
|---|---:|
| levels | 0.00 |
| simpleReturns | 0.47 |
| adxr | 0.55 |
| typPrice | 0.72 |
| avgPrice | 0.76 |
| medPrice | 0.78 |
| wclPrice | 0.97 |
| emaDistance | 1.02 |
| efficiencyRatio | 1.03 |
| smaDistance | 1.03 |
| emaSlope | 1.03 |
| bop | 1.10 |
| tradingLevels | 1.11 |
| cmo | 1.42 |
| volumeRatio | 1.52 |
| variance | 2.06 |
| plusDM | 2.13 |
| avgDev | 2.22 |
| minusDM | 2.22 |
| linRegAngle | 2.40 |
| natr | 2.42 |
| atrPercent | 2.43 |
| trima | 2.60 |
| adOsc | 2.64 |
| linRegIntercept | 2.77 |
| maxIndex | 3.06 |
| minIndex | 3.16 |
| rollingMax | 3.20 |
| rollingMin | 3.29 |
| linRegSlope | 3.98 |
| amihudIlliquidity | 4.07 |
| realizedVolatility | 4.22 |
| stochF | 4.44 |
| tsf | 4.96 |
| correl | 5.76 |
| beta | 5.77 |
| skewness | 6.02 |
| kurtosis | 6.21 |
| midPoint | 7.09 |
| downsideVolatility | 7.23 |
| maxDrawdown | 7.29 |
| pricePosition | 7.70 |
| midPrice | 7.79 |
| t3 | 7.84 |
| aroonOsc | 9.47 |
| tsi | 10.95 |
| dx | 11.84 |
| zScore | 13.62 |
| plusDI | 14.47 |
| minusDI | 15.06 |

标量函数（6 个基本面比率），不计时。新的最慢三项：minusDI 15.06ms、plusDI 14.47ms、zScore 13.62ms。
