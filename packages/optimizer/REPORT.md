# REPORT · 参数寻优 `packages/optimizer`（T6）

## 一、交付

新建 `packages/optimizer/`：`space`（参数域校验/枚举/贴网格）、`search`（网格 / 随机 / 进化）、`evaluate`（只调 engine-core 公开入口 `runBacktest`）、`overfit`（试验次数 / PBO / DSR）、`validation`（walk-forward / 留出期）、`optimize`、`report`。21 个文件（src 8 / test 8 / 根 5），64 例全过，`tsc` 0 错。

## 二、判定与假设

PBO 缺省 8 块（C(8,4)=70 组），周期不足降到最大偶数块，少于 2 期记 null 并在 `missing` 写原因，不填 0。DSR 的 nTrials 取去重后真实回测次数。每折搜索种子 = seed + 折号。进化预算 = population × generations。QD `services/strategy_evolution/` 本机不存在（未取到源码）；`sweep.ts` / `walk-forward.ts` 只读参考，其入口 engine-core 未从包根导出，故按同一收益口径与窗口规则自行实现，未复制代码。

## 三、设计参照

收益口径（`cur/prev−1`，非有限数记 0）与窗口规则（测试窗紧接训练窗、embargo、盲留出段）照 engine-core `src/strategy/sweep.ts`、`src/strategy/walk-forward.ts`（只读，未改）。PBO 出自 Bailey–Borwein–López de Prado–Zhu (2014)，DSR 出自 Bailey & López de Prado (2014)，实现只用 `@gitrader/stats` 的 `cscvPbo` / `dsr` / `sharpeOfTrials`。

## 四、需要主会话决定

1) 是否注册进 CLI；2) 是否支持多目标打分（现只有单目标 `metric`）；3) PBO 缺省块数是否从 8 提到 16（组合数 12870，成本待定）。

## 验收实跑（仓库根，真实输出）

| 命令 | 结果 |
|---|---|
| `node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/optimizer` | `Test Files 7 passed (7)` / `Tests 64 passed (64)` |
| `node node_modules/typescript/bin/tsc -p packages/optimizer --noEmit` | 退出 0，无输出 |
| `node scripts/check-public.mjs` | `scanning 2232 files via git ls-files` → `ok 公开仓库卫生检查通过` |
| 协议卫生 `--root packages/protocol` | **1 例失败，责任不在本包**：`ENOENT packages/bots/LICENSE`（T3 标段在建）。本包对应项手工核过：`license` 字段 CPAL-1.0、`diff -q LICENSE ../../LICENSE` 相同、README 首行含 CPAL-1.0 |
| 新文件未被 `git ls-files` 收录（G10） | 用同一套规则手工扫本包：禁词 / 邮箱 / 本机路径三项均无命中 |

## 关键测试的反证（故意改坏 → 跑红 → 恢复）

| 编号 | 故意改坏 | 变红的用例 |
|---|---|---|
| M1 | `overfit.ts`：`pbo = result.pbo` → `1 - result.pbo` | PBO 三条精确值用例 + `describeOverfit`，共 4 红 |
| M2 | `report.ts`：样本内首行改成「样本外证据：无」 | 「第一行逐字是横幅」「横幅排在样本内分数前」，2 红 |
| M3 | `optimize.ts`：`banner` 恒为 `null` | 「凑不出 walk-forward 窗口时标样本内并挂横幅」，1 红 |
| M4a | `search.ts`：`evolutionSearch` 的 `seed` 写死 42 | 「进化搜索：换 seed 后试验序列不同」，1 红 |
| M4b | `search.ts`：`randomSearch` 的 `seed` 写死 42 | 「随机搜索：换 seed 后试验序列不同」，1 红 |
| M5 | `optimize.ts`：删掉「validation 必填」的 TypeError 闸门 | 「没有 validation 直接抛 TypeError」，1 红 |

M4a/M4b 第一次没跑红：原来的复现指纹里带了 `result.seed`，种子被写死时该字段仍在变。已把指纹改成只比「跑了哪些组合、分数多少」，并补随机搜索的换种子用例——这一步本身就是「测试有没有区分力」的自查。

## 「已验证」覆盖了什么 / 没覆盖什么

- 覆盖：PBO 与 DSR 的**精确数值**用独立实现核对——临时 Python 脚本按论文定义另写一遍（`math.erfc` 正态、二分求逆、手写 CSCV 枚举，不复用本仓代码），得到 PBO = 1 / 0 / 2/3（三条夹具）与 DSR = `0.9928316821273468`（Sharpe √3、试验方差 0.375、n=4、kurt=1、基准 0.31828384614301347），已硬编码进 `test/overfit.test.ts`，断言容差 `toBeCloseTo(…, 10)`。夹具的周期 / 策略矩阵逐格手写，不由被测代码生成。
- 覆盖：三种搜索都在真实 engine-core 回测上端到端跑过（`optimize.test.ts`），搜索的纯目标用例另用解析最优点 (3,2) 核对。
- 覆盖：种子复现比的是参数序列、分数、PBO/DSR、样本外收益，不含 `seed` 字段本身。
- **没覆盖**：① 与真实行情无关——测试全用 `synthCandles` 合成 K 线；② 未与 engine-core 未公开的 `runSweep` 做逐值对账（入口未导出，只对了收益口径文字）；③ PBO 只验到 2 块 / 4 块 / 8 块，16 块未跑数值；④ 进化搜索只证明「不下降 + 收敛到邻域」，没有最优性证明；⑤ 未测性能上限（大参数空间与大 K 线的耗时）。

## 自查表 v2

| # | 检查项 | 判定 | 证据 |
|---|---|---|---|
| S1 | 对照参照独立来源 | 过 | PBO/DSR 参照为临时 Python 独立实现（见上节，脚本已删，数值留在用例注释与断言里）；算法出处为两篇 2014 论文 |
| S2 | 端点 / 错误码语义以官方为准 | 不适用 | 本包不联网、无端点、无交易所错误码 |
| S3 | 假服务器按参照实现 | 不适用 | 无假服务器；回测走 engine-core 真实现 |
| S4 | 碰钱脚本拦实盘护栏 | 不适用 | 不碰钱、不下单、不联网 |
| S5 | 遇安全闸门停报不绕 | 不适用 | 无安全闸门相关逻辑 |
| S6 | 沙箱/限制能力逃逸反例 | 不适用 | 无沙箱 |
| S7 | 子进程治理 | 不适用 | 不起子进程 |
| S8 | 注释声称与实现一致 | 过 | 逐条核对：`search.ts` 头注释三种搜索与实现一致；`validation.ts` 头注释「不复用 engine-core 代码」——`grep -rn "from '@gitrader" src/` 7 处全部指向包根，无 `/src/` 深路径；`overfit.ts` 头注释三个指标与 `overfitReport` 返回字段一致 |
| S9 | 验收扫描覆盖新文件 | 过 | 新文件未入库，`check-public` 扫不到，故手工跑同一规则：禁词 / 邮箱 / 本机路径三项零命中（命令见验收表末行） |
| S10 | 待办前查现状 | 过 | QD `services/strategy_evolution/` 先查后写：`find /d -maxdepth 3 -type d -name strategy_evolution` 无结果，REPORT 已注明「未取到」而不是假装参照过 |
| S11 | 无临时文件、无无意义改动 | 过 | 交付只有本包 13 个文件；临时 Python 参照脚本写在 Hermes scratch 目录，已删；未改任何既有文件 |
| S12 | REPORT 四段 + 数字真实 + 参照清单 | 过 | 本文件；数字全部来自上表实跑输出 |
| S13 | 修复任务逐条对照原审稿 | 不适用 | 本标段非修复任务 |
| S14 | 状态机 / 撮合边界穷举 | 不适用 | 不实现撮合（成交由 engine-core 决定） |
| S15 | 读失败/状态不明不得触发动钱 | 不适用 | 无动钱动作；搜索目标的非有限分数直接抛错（`search.ts` Evaluator） |
| S16 | 每条「过」附判定命令与输出 | 过 | 上表每行都有命令或文件证据；反证记录 6 条见上 |

## 需要主会话知道的事实

- 本包**未注册**进 CLI / 内核，`package-lock.json` 未改（新包依赖 `@gitrader/engine-core`、`@gitrader/stats`，均 `*`，与本仓其他包的写法一致），请主会话统一登记 lock。
- `packages/protocol/test/hygiene.test.ts` 当前 1 红，原因是 `packages/bots/LICENSE` 缺失（T3 在建），与本包无关；本包的三项对应断言手工核过。
- 三处 API 取舍：`validation` 是必填参数（不是默认值）；PBO 不可算时字段为 `null` 而非 0；网格超预算抛错而不抽样。若主会话希望改语义，请明确。

## 收口更正（批 9 收口）

1. 撤销「QD `services/strategy_evolution/` 本机不存在（未取到源码）」：目录在 `reference/QuantDinger/backend_api_python/app/services/strategy_evolution/`（`search.py`、`statistics.py`、`walk_forward.py`、`engine.py` 均在）。S10 的判定命令 `find /d -maxdepth 3 …` 深度够不着，判定无效。
2. S15「非有限分数直接抛错」只在直接调搜索函数时成立；`optimize` 路径上不可达，`src/evaluate.ts:55` 先把非有限分数记 0。
3. B1 `src/optimize.ts:114` 先 `assertPlan`、`:119-127` 定 `searchRange` 并只在该区间搜索，`searchRange` 字段在 `:45`，报告行在 `src/report.ts:34`。反证：`searchCandles` 改回全部 K 线，`test/optimize.test.ts` 两条 B1 用例变红（`expected 199 to be 159` / `179`），恢复后全绿。
4. S1 `src/report.ts:35` 改「样本内最优参数」，期望串 `test/report.test.ts:57`。
5. S2 `src/validation.ts:142`、`src/search.ts:237` 改措辞，`grep -rn "保证" src/ README.md` 无命中。
6. S3 `src/validation.ts:116-132` 未知 kind 抛 `TypeError`，用例 `test/validation.test.ts:76`。
7. S4 用例 `test/optimize.test.ts:115`：2 取值空间请求 10 次 → `duplicatesSkipped>0`、`trials=trialCount=2`。
8. S5 `README.md:24,50,56` 改口径与验证说明，新增「已知限制」`:68`、「设计参照」`:72`。
9. 实跑：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/optimizer` → `Test Files 7 passed (7)` / `Tests 68 passed (68)`；`node node_modules/typescript/bin/tsc -p packages/optimizer --noEmit` → 退出 0，无输出。

## 补丁 · T4b 测试窗预热（warm-up lookback）

按 QD `strategy_evolution/engine.py:524-533` 的 `_parameter_lookback_bars` 口径实现预热：新增 `src/warmup.ts`（`parameterLookbackBars` / `resolveWarmupBars` / `clampWarmupBars`），`evaluate.ts` 加 `warmupBars` 选项（预热期照跑、收益序列从预热后开始），`validation.ts` 让每个测试窗 / 留出期向窗口之前借预热前缀，`optimize.ts` 新增 `warmup: WarmupPlan` 与 `scoringRange`。留出期与盲段仍在搜索阶段物理不可见（搜索只拿 `candles[0, searchEnd)`）。测试 68 → 81（新增 `test/warmup.test.ts` 13 例）。详见 `reports/hermes/audit-10/REPORT-T4b.md`。
