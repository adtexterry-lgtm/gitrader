# 成交模式（fill-modes）

回测的 `fillMode` 有两个取值。缺省是 `'bar'`，老行为一个字节都不改。

## `'bar'`（缺省）

就是 `simulator.ts` 原有的撮合口径：信号出在第 i 根 K 线收盘，第 i+1 根**开盘价**成交，价格加 `slippageBps` 滑点，
成交量只受可选的 `maxVolumeShare`（K 线量占比）约束。这里没有单独的模块，因为它的代码路径必须与加入本参数之前完全一致。

守这条线的方式是金标夹具：`test/fixtures/fill-mode-golden.bar.json` 存着 10 个教学示例策略在缺省参数下的
完整输出（stats / trades / equity / funding / target / reasons），`test/fill-modes/golden.test.ts` 逐字节比对，
`node test/fill-modes/check-golden.mjs` 退出码 0 表示一致。

## `'book'`

调用 `@gitrader/sim-book`：把 `bookFeed` 里的 `book_snapshot` / `book_delta` / `trade` 记录按时间喂进盘口，
在成交时刻（K 线开盘时间）用市价 IOC 单逐档吃量，成交价取实际档位价的加权均价。

- 价格与可成交量都来自盘口，**不再额外加 `slippageBps`**（档位价里已经有真实的价差与冲击）。
- 簿上量不足时只成交吃得到的那部分，余额按成交价记进未成交名义（`stats.unfilledShare` 会体现）。
- 数据与成交判定只要有一处说不清就抛 `FillModeError`，**绝不退回 `'bar'`**：

| code | 触发条件 |
|---|---|
| `missing_feed` | 开了 `'book'` 却没给 `bookFeed`（或 `bookFeed` 里既无 `jsonl` 也无 `records`） |
| `feed_conflict` | `jsonl` 与 `records` 同时给；或记录落到盘口失败（标的冲突 / 盘口交叉 / 增删档位对不上） |
| `unparsable_feed` | 数据没通过 `validateJsonl` / `validateRecords`（语法、字段、ts 非递减、盘口可重放） |
| `empty_feed` | 数据源里一条记录都没有 |
| `stale_feed` | 成交时刻早于第一条记录、或晚于最后一条记录（数据没覆盖到这一刻） |
| `no_book` | 该时刻盘口有一侧为空，无法定价 |
| `no_liquidity` | 该时刻盘口吃不到任何量（不按 0 成交静默跳过） |
| `invalid_qty` | 数量非有限数 / 超定点范围 / 小于 1e-18 |
| `unknown_mode` | `fillMode` 不是 `'bar'` / `'book'` |
| `unsupported_option` | `'book'` 模式下同时开了保护规则或强平 |

## `'book'` 模式当前不支持的选项

保护规则（`protection`）与强平（`liquidation`）按 K 线高低价判定、按 K 线口径成交，与盘口口径冲突。
`'book'` 模式下传这两个选项会直接报 `unsupported_option`，而不是把两种价格来源混在一条成交上。
`lotStep` / `minLot` 先归一再下单，但**簿上量不足时的部分成交量不再按手数步长取整**；
`maxVolumeShare` 按 K 线量截量后再到盘口吃，`stats.unfilledShare` 把两种缺量合在一起算；
`funding` 只结算资金费，不参与成交价。

## 数据形状

`bookFeed` 的记录形状与校验规则见 `packages/sim-book/src/types.ts` 与 `packages/sim-book/README.md`；
本包不做自己的解析，全部走 sim-book 的 `validateJsonl` / `validateRecords`。

## 已知限制

- 只在「K 线开盘时刻」提交订单：`'book'` 模式给的是该时刻的盘口价，不模拟持仓途中的盘口跳动。
- 每个成交是一张独立的市价 IOC 单，不回测挂单排队位置（那是 sim-book 的 `fillModel` 能力，本包未接）。
- 记录流按 ts 递增消费一次，不支持乱序补数据。
- 数据覆盖范围之内的空档（两条记录相隔很久）按最后一版盘口成交，不报错；需要严格覆盖时请先自行检查数据。
