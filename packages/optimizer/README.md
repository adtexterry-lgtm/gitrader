> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/optimizer

参数寻优：在 engine-core 的回测之上跑网格 / 随机 / 进化三种搜索，**每次都强制给过拟合指标**（试验次数、CSCV PBO、DSR），并强制配一段样本外验证（walk-forward 或留出期）。

只调 `@gitrader/engine-core` 的公开入口 `runBacktest` 与 `@gitrader/stats` 的公开统计函数；不改内核、不联网、零第三方依赖。本包不从 `packages/*/src` 深引，也不注册进 CLI。

## 为什么强制这两件事

参数寻优最容易做的事，就是在一段历史上挑出最好看的一组参数，然后把它当成未来的证据。本包不给这条路：

- **过拟合指标不是可选项**。返回值里永远有 `overfit.trials`、`overfit.pbo`、`overfit.dsr`；算不出来时字段是 `null` 且 `missing` 写明原因，不会用 0 糊过去。
- **样本外验证是必填参数**。`optimize({...})` 没有 `validation` 直接抛 `TypeError`。walk-forward 凑不出窗口时，结果 `inSampleOnly` 为真，报告首屏第一行就是「样本内，不可作为前向证据」。

## 三种搜索

| 方式 | 行为 | 复现 |
|---|---|---|
| `grid` | 参数空间笛卡尔积穷举，第一维最慢；组合数超过 `maxTrials` 抛 `RangeError`，不偷偷抽样 | 完全确定，不用随机数（结果里 `seed` 记 0） |
| `random` | 每维按取值域均匀抽，数值型贴 step 网格；抽满 `trials` 个互不重复的组合 | 同一 `seed` 逐点相同（`mulberry32`） |
| `evolution` | 精英保留 + 锦标赛选择 + 均匀交叉 + 逐基因变异，`population × generations` 次评估 | 同一 `seed` 逐点相同 |

同一个参数组合只回测一次（搜索内部按参数键缓存），所以「试验次数」就是寻优区间内真正回测过的组合数（不含留出期与盲段）。

## 用法

```ts
import { optimize, renderReport } from '@gitrader/optimizer'

const result = optimize({
  strategy,
  candles,
  space: {
    fast: { type: 'integer', min: 3, max: 20, step: 1 },
    slow: { type: 'integer', min: 10, max: 60, step: 5 },
    mode: { type: 'select', options: ['long', 'both'] },
  },
  search: { kind: 'evolution', population: 12, generations: 4 },
  validation: { kind: 'walk-forward', trainBars: 120, testBars: 40, embargoBars: 1 },
  warmupBars: 30, // 预热 30 根不计分；不传则按参数名推（见「测试窗预热」）
  seed: 7,
  sim: { feeRate: 0.0005, slippageBps: 2 },
})

console.log(renderReport(result)) // 首屏第一行 = 证据等级
```

## 过拟合指标怎么算

- **试验次数**：寻优区间内真正回测过的组合数（不含留出期与盲段）。
- **PBO**：把每条试验的收益按时间切成偶数块，用 CSCV 枚举样本内 / 样本外组合（`@gitrader/stats` 的 `cscvPbo`，Bailey–Borwein–López de Prado–Zhu 2014）。缺省 8 块（C(8,4)=70 组），周期不够时自动降到能整除的偶数块，低于 2 期记 `null`。
- **DSR**：最优试验的去膨胀 Sharpe（`@gitrader/stats` 的 `dsr`，Bailey & López de Prado 2014），基准是「N 次试验下的期望最大 Sharpe」，`N` 取本次试验次数。

## 测试窗预热（warm-up lookback）

每个参数组合在计入成绩之前，先在**寻优区间开头**跑一段 K 线：仓位、成交、权益照常算，但这段时间的收益**不进目标函数**（`returns` 从预热之后开始，长度 = 计分 K 线数 − 1）。防的是「参数在数据早期占便宜」——指标还没齐的头几根里，谁的仓位碰巧对着行情走，谁就在寻优里白拿一截分数。

```ts
const result = optimize({
  // …
  warmupBars: 30,          // 显式指定；不传则按下表推导
})
result.warmup        // { bars: 30, source: 'explicit' }
result.searchRange   // [0, 150)  寻优区间（留出期 / 盲段不在里面）
result.scoringRange  // [30, 150) 真正计分的区间
```

| `warmupBars` | 取什么 |
|---|---|
| 非负整数 | 就用它（`source: 'explicit'`）。非法值（负数 / 小数）抛 `RangeError`，不静默夹 |
| 不传 | 按参数空间推：名字含 `period` / `lookback` / `window` / `length` / `bars` 的数值维度，取其**上界最大值**（`source: 'params'`）。这是 QuantDinger `_parameter_lookback_bars`（`backend_api_python/app/services/strategy_evolution/engine.py:524-533`）同一口径的安全上界 |
| 推不出来（参数名不命中） | 0，`source: 'none'`，结果里挂一条「未设预热」的提示 |

预热根数不能占满寻优区间：`warmupBars` 大于 `searchEnd − 2` 时抛 `RangeError`，而不是给一堆 0 分去排名。

口径上与 QuantDinger 有两处不同：显式 `warmupBars` 直接采用，**不与按参数名推出的上界取 max**（QD 的 `backend_api_python/app/services/strategy_evolution/engine.py:76-79` 是 `max(显式值, _parameter_lookback_bars(...))`）；参数上界取 `Math.ceil`（QD 的 `_parameter_lookback_bars` 用 `int(parameter.maximum)` 截断）。策略自报的 `series.warmup` 只记录、不参与这里的计算（见「已知限制」）。

**测试窗也预热**：`walk-forward` 的每折测试窗、`holdout` 的留出期，评估时会向**窗口之前那侧**借 `warmupBars` 根历史当预热（`FoldResult.warmupBars` / `HoldoutResult.warmupBars` 记下借了多少），计分仍只覆盖窗口本身 —— 所以样本外收益长度不变，只是窗口开头不再是一段「指标没齐的空仓」。

**留出期与盲段在寻优阶段物理不可见**：主搜索只拿到 `candles[0, searchEnd)` 这一段切片，留出期 / 盲段的 K 线对象根本不在手上；PBO、DSR、试验次数、`best` 都只由这段切片算出。测试用两条可观测行为钉住它：把留出期 / 盲段的行情改成离谱价后寻优结果逐位不变；以及给策略装探针，按调用顺序检查搜索阶段拿到的每一段 K 线都不含留出期时间戳。

## 验证方式

主搜索、PBO、DSR 只在寻优区间上算（`holdout` 为 `[0, n − holdoutBars)`，`walk-forward` 为 `[0, n − (blindHoldoutBars ?? 0))`），再按 `warmupBars` 从区间开头切掉预热段；walk-forward 各折的样本外得分评估的是这套寻优流程，最终 `best` 在整个计分区间上重选。

- `walk-forward`：窗口规则与 engine-core 只读参考 `walk-forward.ts` 一致（测试窗紧接训练窗，中间可留 `embargoBars`，末尾 `blindHoldoutBars` 谁都不碰）。每折只在训练窗寻优，最优参数原样拿到测试窗回测。
- `holdout`：在样本内寻优，最优参数只在末尾留出期回测一次。
- 每折的搜索种子 = `seed + 折号`：各折不会抽到同一批组合，同时整体仍可复现。

## 它不做什么

- 不做成交仿真（那是 engine-core 与 sim-book 的事），不按盘口撮合。
- 不做多目标优化（夏普、回撤、换手一起打分）；目标函数是一个 `returns => number`，要别的口径自己传 `metric`。
- 不判断参数是否有经济含义，也不替你决定该不该上实盘。

## 已知限制

- 预热根数缺省只按**参数名**推：参数叫 `fast` / `slow` 这类名字的策略推不出回看长度，会落到 `warmupBars: 0` 并挂一条提示。这种策略自己知道最长回看期，应显式传 `warmupBars`（如 `slow` 的上界）。
- 预热只按 K 线下标算，不换算日历时间：多周期策略（日线 + 4h）只有一个预热根数，取最长的那条。
- 策略自报的 `series.warmup`（指标达标的上一根）只记录在 `CandidateEvaluation.indicatorWarmup` 里供对账，不自动提升计分起点 —— 计分起点只由 `warmupBars` 决定，便于复现与审计。

## 设计参照

QuantDinger `backend_api_python/app/services/strategy_evolution/`（`search.py` 网格 / 随机 / TPE、`statistics.py` 的 DSR / PBO / 自助法、`walk_forward.py`、`engine.py` 的成本压力与按参数推回看预热）是同类模块。本包借了它的「试验次数与 PBO/DSR 强制随结果给出」与「按参数名推回看长度做预热」（`engine.py:524-533` 的 `_parameter_lookback_bars`、`engine.py:76-79` 与 `walk_forward.py` 的 `warmup_bars` 用法）两点做法，未实现 TPE、成本压力、自助法，代码未照抄。

## 测试

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/optimizer
node node_modules/typescript/bin/tsc -p packages/optimizer --noEmit
```
