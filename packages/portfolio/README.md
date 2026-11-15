<!-- SPDX-License-Identifier: CPAL-1.0 -->
# @gitrader/portfolio

组合分析纯函数：跨场所持仓汇总、按注入的价格源统一定价到一种计价币、按资产 / 场所 / 标的 / 方向算敞口、按策略 / 场所 / 标的做已实现 + 未实现盈亏归因、集中度指标。

零第三方依赖（只依赖仓库内的 `@gitrader/protocol`，且只用它的类型与定点算术）。记账一律十进制字符串：协议 `Decimal`，内部 18 位定点 `bigint`（`@gitrader/protocol/decimal`），对外 8 位小数。不读时钟、不读环境变量、不发网络请求、不注册进内核与 CLI。

## 设计参照

- QuantDinger `backend_api_python/app/services/portfolio/positions.py`、`pricing.py`（Apache-2.0）：**只借鉴语义**——价格表注入、`market_value` / `cost_value` / `pnl` 三件套、按市场聚合分布。代码为本仓库重写，没有逐行翻译。
- 与本仓库不同的三处（有意为之）：
  1. QD 取价失败时把 `price` 写成 0 继续汇总；本包把缺价当必须显式处理的事件：缺省**报错并列出全部缺价标的**，或由调用方 `onMissingPrice: 'skip'` 跳过并记进 `unpriced`，绝不当 0 参与汇总。
  2. QD 全程 `float`；本包全程 18 位定点，任何金额都不经过浮点。
  3. QD 只给按市场的分布；本包另有按资产 / 场所 / 方向 / 策略 / 标的的敞口与归因，以及 HHI 集中度。

## 用法

```ts
import { analyzePortfolio, staticPriceSource } from '@gitrader/portfolio'

const analysis = analyzePortfolio({
  positions,                       // 协议 Position[]（只读类型，来自 packages/protocol）
  instruments,                     // 协议 Instrument[]（同上）
  valuationCcy: 'USD',
  prices: staticPriceSource({ 'binance:BTCUSDT': '40000' }), // 注入的价格源，也可以是场所行情
  fx: { 'USDT/USD': '1' },         // 报价币 -> 计价币；同币不需要
  strategyTags: { 'acct_a1|binance:BTCUSDT': 'trend' },      // 策略归因标签
})
// analysis.valuation / .exposure / .attribution / .concentration
```

单独用也可以：`valuePositions` / `exposureOf` / `attributionOf` / `concentrationOf` / `concentration(pos, 'venue')`。

## 口径

| 项 | 口径 |
|---|---|
| 名义敞口 | 基础数量 × 注入价；基础数量 = `venueSizeUnit: 'contract'` 时 `size × contractSize`，`'base'` 时就是 `size`（`contractSize` 只作展示）；仅 `settlement: 'linear'`；报价币按 `fx` 折成计价币 |
| 带方向敞口 | 多头为正、空头为负；`gross` = Σ|敞口|（多空不互抵），`net` = Σ敞口（同一资产跨场所互抵） |
| 未实现盈亏 | 用**注入价**重算：多头 `(标记−入场)×数量`，空头取反；场所上报的 `unrealizedPnl` 只作为 `venueUnrealizedPnl` 保留 |
| 对账差额 | `drift = 重算未实现 − 场所上报未实现`，非 0 说明价格口径不一致 |
| 已实现盈亏 / 资金费 | 取 `Position.realizedPnl` / `fundingSinceOpen`，按标的报价币 -> 计价币折算 |
| 策略归因 | 标签键 `${accountId}|${instrumentId}` 优先，其次 `${accountId}`，都没有记 `unassigned` |
| 集中度 | HHI = Σ(绝对敞口占比)²，`effectiveN = 1/HHI`，前 N 大占比按绝对敞口降序 |
| 精度 | 输出 8 位小数（四舍五入）；聚合在 18 位定点上做，中间乘除在 18 位定点上向零截断，桶之和与总额精确相等 |

## 会报错而不是兜底的情况

`valuePositions` 实际只抛三种 `code`：

- 逐笔问题（标的缺失、`settlement: 'inverse'`、`size <= 0`、同一 `(账户, 标的, 方向)` 重复、缺汇率、缺价且未显式 `skip`）聚合成一条 `valuation_failed`，`details` 每条以 `unknown_instrument:` / `unsupported_settlement:` / `invalid_position:` / `duplicate_position:` / `missing_price:` / `missing_fx:` 开头；
- `valuationCcy` 为空、汇率为 0 或负、`instruments` 里 `instrumentId` 重复，直接抛 `invalid_input`；
- 单独调 `fxRate()` 缺对，抛 `missing_fx`。

错误类型 `PortfolioError`，`code` 供分支，`details` 逐条列出全部问题（去重保序）。

## 不做的事

- 反向合约（`inverse`）折算：语义与线性合约不同，直接拒绝，不做半吊子实现。
- 三角汇率换算：只认 `FROM/TO` 直连对或 `TO/FROM` 反向对。
- 余额 / 权益 / 保证金 / 手续费：本包只算持仓侧；`Position` 里没有手续费，`Balance` 也不在这里汇总。
- 任何下单、平仓、撤单相关行为：本包是只读分析，没有动钱动作。

## 测试

64 例合成数据用例，数字手算后写死期望值；含 6 条「故意改坏必须变红」的反证记录（见 `REPORT.md`）。

```bash
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/portfolio
node node_modules/typescript/bin/tsc -p packages/portfolio --noEmit
```
