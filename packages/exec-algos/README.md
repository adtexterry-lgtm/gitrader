> 许可证：CPAL-1.0。本包 CPAL-1.0，随 Gitrader 本体发布。

# @gitrader/exec-algos

执行算法的纯函数库：**先挂后吃**（maker-then-market）状态机、tail guard、平仓量三重上限、撤单二次确认、clientOrderId、成交去重键。没有 I/O、不读钟、不发请求、不连内核；要接线由内核下一轮做。

数量与价格一律十进制字符串，算术走 `@gitrader/protocol` 的 `decimal`（18 位定点），不做 JS 浮点加减。整数 bps 与毫秒是 number。

## 用法

```ts
import { startMakerThenMarket, onFill, onTimeout, cancelOutcome, clientOrderId, fillDedupeKey, resolveCloseQuantity } from '@gitrader/exec-algos'

const spec = { side: 'buy', size: '1', refPrice: '100', makerOffsetBps: 5, makerWaitMs: 1500,
               maxSlippageBps: 30, tickSize: '0.01', lotStep: '0.001', minSize: '0.01' } as const

let { state, next } = startMakerThenMarket(spec, Date.now())   // next = place_limit @ 99.95（post-only）
// …把 next 发给交易所，成交回喂（任何阶段的成交都记账）：
state = onFill(spec, state, { size: '0.4', price: '99.95' }, Date.now()).state
// …等到 makerWaitMs 到期，第一次 onTimeout 只发撤单：
const cancel = onTimeout(spec, state, Date.now())               // next = cancel，phase 仍是 maker
// …撤单请求发出、用快照确认（cancelOutcome 为 confirmed / filled_meanwhile），
//   确认前到的成交照常 onFill，然后再调一次 onTimeout：
const retry = onTimeout(spec, cancel.state, Date.now())         // next = place_ioc 0.6 @ 100.3
```

`onTimeout` 的调用约定是**两段**：第一次（最后一步不是 `cancel`）只排撤单；第二次必须在撤单确认之后调，才按确认后的 `filled` 算余量排 IOC（余量 < `minSize` 走 `done/tail_guard`）。IOC 结束后再调一次（taker 阶段）收尾为 `done/market_fallback`。

## 语义要点

- **定价**：挂单价 = 参考价 ∓ 偏移，买单向下取整到 tick、卖单向上取整到 tick——成交价不会比算出来的偏移价更差。市价意图的价带上限同理只收紧、不放宽。
- **数量**：一律先向零截断到 `lotStep`；截断后不足 `minSize` 不发单。满量判定用截断后的实际挂单量，不用原始 `size`。
- **成交记账**：`onFill` 在任何阶段（maker / taker / done）都把成交累加进 `filled` / `notional` / `fees`；IOC 分多笔成交不会丢后面的。重复回报由调用方用 `fillDedupeKey` 去重。
- **tail guard**：挂单超时后撤掉余量，撤单确认后的余量 < `minSize` 就结束（`done/tail_guard`），不再发尾单——尾单会被交易所拒或变成无意义的碎单。
- **三重上限**：`resolveCloseQuantity` = min(账本持仓, 交易所持仓 − 其它策略占用)。账本是数量来源，交易所持仓只是安全上限。
- **撤单**：`cancelOutcome` 把撤单拆成 confirmed / pending / filled_meanwhile。结果以订单快照为准（ack 只作记录）：快照 cancelled 且无新成交即 confirmed。撤单期间的成交要先落账。
- **clientOrderId**：两种形态都用「sha256 摘要 + 阶段后缀」，不同 (策略, 队列, 阶段) 不会因为号码拼接而撞号。`okx` 形态是纯字母数字、恰 32 位且保留阶段后缀；`default` 形态是 `gt_<摘要>_<阶段>`、≤ 36 位。
- **去重键**：有交易所成交号时只由 venue + 订单号 + 成交号决定；没有时退化成 venue + 订单号 + 时间 + 规范化数量 / 价格。输出 sha256。

## 测试

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/exec-algos
node node_modules/typescript/bin/tsc -p packages/exec-algos --noEmit
```

移植自 QuantDinger v5.6.5（Apache-2.0）的函数在源码上方有 `// Ported from …` 注释，标了文件与行号。
