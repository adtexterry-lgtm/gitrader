# REPORT · 标段 M（`packages/exec-algos`）

## 改了什么

只新建 `packages/exec-algos/`：9 个源文件（`types` / `num` / `price` / `maker-then-market` / `close-quantity` / `cancel` / `order-id` / `dedupe` / `index`）、6 个测试文件、`README.md`、`package.json`、`tsconfig.json`、`LICENSE`（复制根 CPAL-1.0）。内容是工单 M 节的九个接口：先挂后吃状态机（post-only 挂单 → 等待 → 撤余量 → 余量 ≥ minSize 发 IOC 价带尾单，< minSize 走 tail_guard）、挂单价与价带按 tick 两向取整、平仓量三重上限、撤单三种结果、clientOrderId（okx 纯字母数字 ≤ 32，default ≤ 36）、成交去重键（sha256）。9 条 `// Ported from QuantDinger …` 注释的文件与行号都用 `grep -n` 实查过；数量与价格全走 `@gitrader/protocol/decimal`，没有 JS 浮点加减。

## 跑了什么

`vitest --root packages/exec-algos`：6 文件 **72 例全过**；`tsc -p packages/exec-algos --noEmit` 退出 0；`packages/protocol` hygiene：**6/6 过**。

## 没做什么

没接内核、没有 I/O / 时钟 / 网络；没在真实交易所下过单；没登记 lock、没提交。

## 需要主会话决定

1. `ExecState` 按工单接口不含时间戳字段，审计时间只能由调用方持有——接线时若需要把 `steps` 落账，得在外面配时间。
2. tail guard 的余量按 `lotStep` 向零截断后再判 `minSize`；OKX 的 `minSz` 是张数口径，折算成币数量要在接线层做。
3. `bandPrice` 的出处标在 `limit_price_safety.py:25-40`：QD 是把可成交限价夹到参考价，我们夹到 `maxSlippageBps` 的带上，语义是 adapt 后的。
