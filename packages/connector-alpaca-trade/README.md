> 许可证：CPAL-1.0。

> **未经真网验证，不得接实盘。**

# @gitrader/connector-alpaca-trade

Alpaca 美股（`us_equity`）的交易连接器：只有假服务器上的单元测试，没有任何一条路径接过真网。内核已为它写了装配代码（`packages/cli/src/connectors.ts`），但当前行为是——配置里有这家场所的**主网 live 账户**时，内核退回只读行情连接器并在启动时打一条警告；只有**纸面 / 测试网 live 账户且凭据句柄能解析**时才装配本连接器（标记为未验证）。**所以现在不要指望在内核里用它下真单。** 所有下单仍经风控闸门。

- 交易环境由构造参数显式声明（`mode: 'paper' | 'live'`），基址随之决定；密钥前缀 `PK` = 模拟、`AK` = 实盘，前缀与声明不符 → **构造时拒绝**（只比前缀，从不打印密钥）。
- 鉴权是**请求头密钥对**（`APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`），不是 HMAC：没有时间戳、没有预签串、没有签名头。

## 它能做什么

- 下单：限价、市价意图（**必须**带 `maxSlippageBps`，实际发「价带限价 + IOC」）、止损（`stop`）、止损限价（`stop_limit`）、追踪止损（`trailing_stop` + `trail_percent`）、原生 `bracket` / `oto`（`intent.tpsl`）。
- 撤单（`DELETE /v2/orders/{id}`，支持按 `client_order_id` 先查后撤）、全撤（官方 `DELETE /v2/orders`，207 多状态逐行核结果；按标的时先列挂单再逐张撤）。
- 改单（`PATCH /v2/orders/{id}`，只带 `qty` / `limit_price` / `stop_price` / `trail` / `time_in_force`；`trail` 是百分比）。
- 只读：账户、持仓（持仓专用端点）、挂单（按订单 id 用 `after_order_id` 翻页）、成交（`account activities` 的 `FILL`，去重键 `order_id` + `cum_qty`）、单张订单状态（含 `by_client_order_id`，`replaced` 会沿 `replaced_by` 追到活单）、启动对账、账户限制标志。
- 私有流 `trade_updates`（socket 可注入，支持官方 paper 的二进制帧；成交去重键同样是 `order_id` + 累计成交量，`execution_id` 只作诊断）。
- 位置级保护单：成交后用原生 `oco`（`placeProtection()`，包内扩展方法，不算协议能力）。
- 参考价：数据 API v2 `GET /v2/stocks/{symbol}/snapshot`（默认 `feed=iex`，免费档）。

## 端点出处

REST 路径以 **Alpaca 官方 Trading API v2 / Market Data API v2 文档**为准（QD 的 `alpaca_trading/client.py` 走 `alpaca-py` SDK，只有 account activities 一处手写 HTTP，路径需自己核）。QD 侧参照：

| 用途 | 端点 | 出处 |
|---|---|---|
| 鉴权头 | `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` | QD `alpaca_trading/client.py:623-627` |
| paper / live 基址 | `paper-api.alpaca.markets` / `api.alpaca.markets` | QD `alpaca_trading/README.md:27-30`、`live_trading/factory.py:463` |
| 成交活动 | `GET /v2/account/activities?activity_types=FILL` | QD `client.py:592-643`（`page_size ≤ 100`、`page_token` = 上页最后一行 id） |
| 成交归属（先算自己的多头） | — | QD `live_trading/alpaca_ownership.py:64-125`（本包 `checkSellOwnership` 同口径） |
| 费用活动（FEE / INT） | `GET /v2/account/activities` | QD `live_trading/alpaca_activity_reconciliation.py:369-379`（本包不记账，只取 FILL） |
| 下单 / 改单 / 撤单 / 全撤 / 查单 | `POST|PATCH|DELETE /v2/orders`、`/v2/orders/{id}`、`/v2/orders:by_client_order_id` | 官方 Orders 文档（QD 经 SDK，未手写） |
| 账户 / 持仓 / 资产 / 日历 / 时钟 | `/v2/account`、`/v2/positions`、`/v2/assets/{symbol}`、`/v2/calendar`、`/v2/clock` | 官方文档（QD `client.py:647-699` 的账户字段即此） |
| 私有流 | `wss://paper-api.alpaca.markets/stream`（auth → listen → trade_updates） | 官方 Streaming 文档；QD `README.md:125-140` 记的握手坑 |

## 美股八条怎么落

| # | 做法 | 代码 |
|---|---|---|
| 1 时段 | 日历 `GET /v2/calendar` 驱动，纽约时区换算走 `Intl`（含夏令时）；节假日 / 提前收盘以日历为准；拿不到日历 = 全休市 | `sessions.ts`、`calendar.ts` |
| 2 休市不排队 | 常规时段外的市价意图一律 `INVALID_PARAMS` + hint（绝不挂到次日）；盘前盘后仅在构造参数 `extendedHours: true` 时接受，且只收 limit + day | `orders.ts` |
| 3 市价走价带 | 缺 `maxSlippageBps` → `INVALID_PARAMS`；发「参考价（买 ask / 卖 bid）± 滑点」的限价 + IOC；没有参考价 / 报价陈旧 → `STALE_PRICE`，不退回裸市价 | `orders.ts` |
| 4 碎股 | 只有 `fractionable` 资产收小数股；`size` 必须是资产步长的整数倍（不取整，不合规 `PRECISION`），只有 `notional` 折算允许向下截；碎股的市价意图本地拒 | `orders.ts`、`assets.ts` |
| 5 卖空 | 卖出超过本账户**可卖**多头持仓 = 开空，要 `shortable` + `borrow_status=easy_to_borrow`（官方 2026-09-22 移除旧字段 `easy_to_borrow`，旧字段只作回落；两者都缺 = 借券状态未知 → 拒开空并提示只卖持仓内股数）+ 账户 `shorting_enabled`；卖单前强制新拉持仓并按 `qty_available` 判，持仓查不到 → 拒 | `orders.ts`、`account.ts`、`parse.ts` |
| 6 账户限制 | `trading_blocked` / `account_blocked` 为真时所有下单拒绝；`pattern_day_trader` / `daytrade_count` / `shorts` 等标志原样上报（见「协议缺口」） | `parse.ts`、`trading.ts` |
| 7 模拟 / 实盘不混 | `mode` 显式 + 密钥前缀校验，不符构造期抛 | `rest.ts` |
| 8 能力老实 | 无资金费、无永续强平价；杠杆按账户倍数（Reg T 2×）如实报；`take_market` / `take_limit` / `twap` / `alo` / `gtd` 一律 1004；定时全撤 5002；公司行动（拆股 / 分红）不在范围 | `capabilities.ts`、`orders.ts`、`trading.ts` |

## 已知限制（如实）

- **行情只有参考价**：`book()` / `candles()` / `context()` 与 `mids` / `book` / `candle` / `context` 订阅一律 `5002`——K 线 / 盘口属于只读行情包（`@gitrader/connector-alpaca-data`），本包不假装有。
- **协议缺口（未自行加字段，见 REPORT）**：`OrderIntent` 没有「允许盘前盘后」字段，也没有 `day` 这种 TIF；`AccountSnapshot` 没有 `trading_blocked` / `pattern_day_trader` / `daytrade_count` 字段。前者用构造参数 `extendedHours` 显式声明、后者用 `restrictions()` 单独上报；小数股与扩展时段按场所要求强制 `time_in_force=day`（比 GTC 短，不是放宽），并写回执告警。
- `amend` 声明 `native`，但**带腿的单**（bracket / oto / oco）与市价价带单一律 `1004`（协议 `SupportLevel` 表达不了「部分支持」）；官方 replace 会返回新订单，本包把新 id / 新 client id 映回原 client id，`replaced` 不当作终态外发。
- `tpsl.positionLevel` 声明为 `false`：协议 `grouping: 'position'` 回 `1004`；`placeProtection()` 是包内扩展方法，不算协议能力。
- 成交手续费恒 `0`：Alpaca 把 SEC / TAF / 佣金记成独立的 `FEE` 活动，本包只取 `FILL`；`maker` / `taker` 上游不给，一律按 `taker` 记（费用侧偏高，不低报）。
- `realizedPnl` 恒 `0`（活动行不给逐笔已实现盈亏）；`liquidationPrice` 为 `null`（股票没有强平价）。
- 位置级保护只做「平多」的 OCO；融券空头的保护单不在本批次范围。OCO 必须同时给止盈与止损两条腿，body 里没有顶层 `limit_price`（官方形状）。
- 没有定时全撤端点（`scheduleCancel` → 5002）；没有逐标的杠杆端点（只能等于账户倍数）；批量下单未实现（一次一张）。
- `listInstruments()` 只列**已取过**的标的（资产按需单张拉取；`warmAssets()` 用 `GET /v2/assets` 预热）。
- 公司行动（拆股 / 分红）不在本批次范围。

## 用法

```ts
import { AlpacaTradeConnector } from '@gitrader/connector-alpaca-trade'

const connector = new AlpacaTradeConnector({
  mode: 'paper',                                  // PK = paper，AK = live；不符会在构造时抛
  apiKey: process.env.ALPACA_API_KEY!,
  apiSecret: process.env.ALPACA_API_SECRET!,
  extendedHours: false,                           // 是否允许盘前盘后限价单（协议没有该字段）
})
await connector.start()                           // 拉交易日历（拿不到 = 全休市）
const [ack] = (await connector.submit(ctx, [intent])).acks
```

凭据只从构造参数进，放在 `#` 私有字段里：`JSON.stringify(connector)`、`util.inspect`、错误文本都看不到。

## 会访问哪些主机（只有用户显式运行时）

- `paper-api.alpaca.markets` 或 `api.alpaca.markets`（交易 REST）
- `data.alpaca.markets`（参考价快照）
- `wss://paper-api.alpaca.markets/stream` 或 `wss://api.alpaca.markets/stream`（私有流，需调用 `stream.connect()`）

测试与 CI 不联网：`test/helpers/fake-alpaca.ts` 在进程内回答两个主机的请求。

## 测试

```bash
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-alpaca-trade
node node_modules/typescript/bin/tsc -p packages/connector-alpaca-trade --noEmit
```

假服务器校验鉴权头、HTTP 方法（用错方法回 405）、必填参数（缺参回 422 + `42210000`），并复算场所规则（小数股必须 day、扩展时段只收 limit、bracket 要两条腿、oto 只收一条）。
