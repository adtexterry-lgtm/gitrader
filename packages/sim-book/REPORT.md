# REPORT · 盘口级成交仿真核心（Q1a）

## 一、交付
新建 `packages/sim-book/`，12 个源码 / 测试文件、125 例全过：`records.ts` 三种 JSONL 记录与 .gz 读写；`validate.ts` 字段、十进制语法、正数量、档位排序去重、交叉盘口、ts / seq 单调；`book.ts` 盘口 + 流动性台账；`match.ts` 试算 / 落账 / 触发；`engine.ts` 八种订单形态。五条验收命令全绿（实跑结果见下）。

## 二、判定与假设
同一份量只吃一次：台账记「原始量 + 已消耗」，档位量被新数据改写或快照刷新即清零；逐笔成交先吃该价挂单，我方挂单再从这一笔成交量里分配，两处不重复。FOK 先试算后落账，吃不下整单作废且不留消耗。停损按最新价判触发，无成交时退回对手价。maker 按自己限价成交，taker 按档位价。延迟、费用、挂单成交概率不在本标段。

## 三、设计参照
见下清单（nautilus_trader @55c0e820，只读，仅借设计，未复制代码）。

## 四、需要主会话决定
1. 记录格式是否并入 `@gitrader/data-files`（未改该包）。2. 是否作为 `engine-core` 可选成交模式（未接内核、未注册锁）。3. 新包未被 `git ls-files` 收录，audit-headers 与 check-public 提交前扫不到；我另在无 git 的临时目录跑首行 SPDX 审计，12 文件全过，请提交时再跑。4. Q1b 待接三档挂单判定、延迟、费用、性能。

## 验收实跑（仓库根）
- `vitest --root packages/sim-book`：4 文件 125 例全过
- `tsc -p packages/sim-book --noEmit`：0 错
- `vitest --root packages/protocol test/hygiene.test.ts`：6/6
- `node scripts/check-public.mjs`：退出 0
- `node tools/release/audit-headers.mjs`：退出 0；`deps-audit.mjs`：退出 0（本包零第三方依赖）

## 设计参照清单
| 参照文件（@55c0e820） | 借到的设计 |
|---|---|
| `crates/execution/src/matching_engine/mod.rs` | 流动性消耗台账（原始量 + 已消耗、档位量变化清零）、FOK 回滚、post-only 会吃则拒、IOC 剩余撤单、同一笔成交量只分配一次；process_market_order 的 “No market for …” 市价单无对手盘即拒单 |
| `crates/execution/src/matching_core.rs` | 限价簿 / 停损簿分册、同价 FIFO、停损按触发价排序、买档高价优先卖档低价优先 |
| `crates/execution/src/models/fill.rs` | 限价单只在价格可成交时进入撮合（is_price_tradable） |
| `crates/model/src/data/order.rs` | 增量的 add / update / delete / clear 四种动作与各自字段要求 |
| `crates/model/src/data/trade.rs` | 逐笔成交的 price / size / aggressor_side / trade_id / ts_event 语义 |
| `crates/model/src/orderbook/book.rs` | 档位按价格排序、买一必须低于卖一 |
