# REPORT · Q2 `packages/exec-reconcile`（执行对账纯函数包）

## 一、做了什么
新建 `packages/exec-reconcile/`：12 源文件、8 测试文件 127 例全过、`tsc` 0。输入账本视图与场所视图，输出 38 个差异码的分类、建议与证据；无写入口，零第三方依赖。

## 二、怎么做的
借 NautilusTrader 的启动 / 持续对账设计：先收报告、未命中再定向查、最后下结论；净额与分方向持仓双比；推断成交用确定性 id 便于重放去重。只借设计不抄码，逐处注「设计参照…@55c0e820」。判定全程十进制字符串 + BigInt，时间比较带时钟偏差与场所延迟容差；去重键优先场所成交号，回退键与累计量键的风险写进差异；推断成交标 `inferred` 并写依据，判不出的给人工。

## 三、验证
五条验收实跑：vitest 127/127、tsc 0、hygiene 6/6、check-public 0、audit-headers 与 deps-audit 0。八家场所用真实回报形状各 3 个场景；收口报告 14 条遗留问题各有用例。

## 四、留给主会话
启动对账接 `kernel.ts:365`、周期节奏、推断成交须人确认才入账写在 README，未改内核。事实：账本成交映射须带 `orderId` 否则缺口算大；IBKR 不查 `completedOrders`、Gate 只查 `finished` 须在 `unavailable` 声明，否则「查不到」被读成「没有」；replace 身份映射重启会丢。

## 设计参照清单（nautilus_trader @55c0e82053142bce3a5cba4de4221d3929c2d3bc，只读）

| 我们 | 参照 |
|---|---|
| `src/orders.ts` 先查再判、延迟窗口内不下结论 | `crates/live/src/execution/manager.rs` `check_open_orders` / `prepare_open_order_report_check` |
| `src/tolerance.ts` 在途窗口、按账户容差 | `crates/live/src/node/reconciliation.rs` `ReconciliationCheckIntervals`；`manager.rs` `position_reconciliation_tolerance` |
| `src/positions.ts` 净额 + 分方向 + report shape | `crates/live/src/execution/reconciliation.rs` `PositionQuantityComparison` |
| `src/fills.ts` 确定性成交号以便重放去重 | `crates/execution/src/reconciliation/ids.rs` `create_inferred_reconciliation_trade_id` |
| `src/links.ts` 先定归属再做定向查询 | `crates/live/src/execution/reconciliation.rs` `request_targeted_order_reports` |

真实回报形状来源：`connector-{hyperliquid,binance,okx,bybit,bitget,gateio}-trade/test/`、`connector-alpaca-trade/test/`、`connector-ibkr-trade/test/`（逐条注在 `test/fixtures/venues.ts` 顶部）。
