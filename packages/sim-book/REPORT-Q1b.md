# REPORT · sim-book 判定与模型层（Q1b）

## 一、交付
新增 `queue.ts`（三档判定）、`latency.ts`（延迟 + 种子抖动）、`fees.ts`（maker / taker + 币种覆盖），
`engine.ts` 接三件模型（选项与 `modify` / `flush` / `feesOf` / `feeSummary` 等）；5 个测试文件、2 个脚本、1 份夹具。
**9 文件 209 例全过**（Q1a 125 例不回归，+84 例）。旧文件只改两处：`types.ts` 的 `price` 去 `readonly`（改单要写）、`index.ts` 增导出。

## 二、判定与假设
三档与假设见 README：严格须穿价（同价视为被前方队列吸收）；队列位置按到场时该档显示量递减、穿价清零；宽松触价即成交
（缺省＝Q1a）。改价丢队列位置。延迟三项各有固定值 + xorshift 种子抖动，命令「发出 + 延迟」到场才撮合；在途单不吃流动性，撤单 / 改单先于下单到场按未知单拒绕。费用逐笔计，资金费不在本包。

## 三、退化对照与性能
退化＝宽松 + 零延迟 + 深度为下单量 100 倍，对照 `engine-core` K 线模拟器（夹具由它真跑生成）：零滑点时
成交价与手续费逐笔相等（浮点 vs 定点，误差 < 1e-6）；25 bps 滑点差异恰为「滑点 × 开盘价」，写进报单价后再次相等。
结构差各有例证来源：下一根开盘 vs 信号那刻（差＝开盘 − 收盘）、权益算数量 vs 给定数量、一口价 vs 逐档吃量、市场冲击。
性能 100 万条：**1.59 s／62.6 万条每秒**（空簿）、**1.48 s／67.4 万条每秒**（常驻挂单）；Windows 11 / Node 22.23。

## 四、需要主会话决定
1. 是否接进 `engine-core` 模拟器（未接内核、未注册锁）。
2. 新增 API 与 `price` 去 `readonly` 是否同步进接口文档。
3. 队列位置只按挂单时显示量估计（同价多张我方单重复计前方量），要不要共享。
4. 新文件未被 `git ls-files` 收录，两项审计扫不到；另核对 15 个新文件首行 SPDX 全过。
5. 资金费、冰山、费用阶梯不做。

## 设计参照清单（nautilus_trader @55c0e820，只读，只借设计）

| 参照文件 | 借到的设计 |
|---|---|
| `crates/execution/src/models/fill.rs` | 把「限价单是否成交」抽成可替换判定模型，区分触价与排队成交两种口径 |
| `crates/execution/src/matching_engine/mod.rs` | 每笔成交前问一次成交模型；流动性消耗台账、FOK 回滚、post-only 会吃则拒；snapshot_queue_position 挂单时快照该档显示量为前方量、decrement_queue_on_trade 同价成交递减 |
| `crates/execution/src/models/latency.rs` | 延迟按 insert / update / delete 分开取，base 延迟加到每个操作上 |
| `crates/backtest/src/engine.rs` | 命令「发出 → 延迟 → 到场 → 撮合」的因果序，到场前场所里没有这张单 |
| `crates/backtest/src/exchange.rs` | 在途命令按到达时刻排序的队列 |
| `crates/execution/src/models/fee.rs` | maker / taker 双费率、按工具覆盖、负费率为返佣、Decimal 记账 |
| `crates/execution/src/matching_core.rs` | 改价丢队列位置 |

## 验收实跑（仓库根，真实输出）

| 命令 | 结果 |
|---|---|
| `npx vitest run --root packages/sim-book` | 9 文件 **209 例全过**（含 Q1a 125 例） |
| `npx tsc -p packages/sim-book --noEmit` | 退出 0 |
| `npx vitest run --root packages/protocol test/hygiene.test.ts` | 6/6 |
| `node scripts/check-public.mjs` | 退出 0（1960 文件） |
| `node tools/release/audit-headers.mjs` / `deps-audit.mjs` | 均退出 0（本包零第三方依赖） |
