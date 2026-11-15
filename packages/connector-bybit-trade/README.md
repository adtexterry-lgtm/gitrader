> 许可证：CPAL-1.0。

> **未经真网验证，不得接实盘。**

# @gitrader/connector-bybit-trade

Bybit v5 USDT 线性永续（`category=linear`）交易连接器。只在进程内假服务器上测过，没有跑过真网。本包目前**只能当库用**：内核已为它写了装配代码、**已注册进内核**（`packages/cli/src/connectors.ts` 的 `tradeFallback`），但当前行为是——配置里有这家场所的**主网 live 账户**时，内核一律退回只读行情连接器并在启动时打一条警告；只有**测试网 live 账户且凭据句柄能解析**时才会装配本连接器（标记为未验证），而内核的账户监听（`userFills`）尚未接通，实测会报错。**所以现在不要指望在内核里用它下真单。** 所有下单仍经风控闸门。
它自己不会下单——`submit` / `cancel` / `amend` 只在内核发起的 `TradeContext` 窗口里执行。

## 它做什么

| 模块 | 内容 |
|---|---|
| `rest.ts` | 签名请求：`HMAC-SHA256(apiSecret, timestamp + apiKey + recvWindow + (query｜body))`（`node:crypto`），头 `X-BAPI-API-KEY / X-BAPI-SIGN / X-BAPI-TIMESTAMP / X-BAPI-RECV-WINDOW / X-BAPI-SIGN-TYPE: 2`；GET 的待签串是排序后的 query、POST 是 body 原文（签什么发什么）；`retCode 10002` 先用 `/v5/market/time` 重校再重试一次；`X-Bapi-Limit-Status` 是**剩余次数**（剩 0 按 reset 头退避）；429 / 418 / 403 + `access too frequent` → `VENUE_RATE_LIMITED` + retryable；信封 10006 / 10018 按 `X-Bapi-Limit-Reset-Timestamp` 退避；`ENDPOINTS` 是路径与 HTTP 方法的唯一事实源 |
| `orders.ts` | `OrderIntent` → `/v5/order/create` 请求体全表：市价意图发「参考价 ± `maxSlippageBps`」的 `Limit` + `IOC`；`stop_market` / `stop_limit` / `take_market` / `take_limit` 走同一个端点，必带 `triggerBy` + `triggerDirection`（线性建单不发 `orderFilter`）；数量按 `qtyStep` 向零截断、价格按 `tickSize` 校验；`reduceOnly` 在两种持仓模式都发，`positionIdx` 按模式落槽；`orderLinkId` ≤ 36，保护腿可用 `legSeq` 换号 |
| `trading.ts` | `submit`（`POST /v5/order/create`）、`cancel`（`POST /v5/order/cancel`）、`cancelAll`（`POST /v5/order/cancel-all`，`symbol` 或 `settleCoin`）、`amend`（`POST /v5/order/amend`，只改 Limit 系）、`setLeverage`（`/v5/position/set-leverage` + `/v5/account/set-margin-mode`）、`setTradingStop`（`/v5/position/trading-stop`） |
| `account.ts` | `/v5/account/wallet-balance`（可用余额取统一账户的 `totalAvailableBalance`）、持仓取 `/v5/position/list`、挂单 `/v5/order/realtime`（两者都按游标翻完全部页，超过 20 页拒绝半张清单）、单状态 `/v5/order/realtime` → 空则回退 `/v5/order/history`（无 symbol 时按 `settleCoin=USDT` 查）、成交 `/v5/execution/list`（按 7 天窗口切段 + 游标翻页 + `execId` 去重，最多回看 13 周） |
| `parse.ts` | 账户 / 持仓 / 订单 / 成交解析与私有流归一：成交去重键 `bybit|<execId>`、`execType` 原样保留（只排除 `Funding`，`BustTrade` / `AdlTrade` 标 `liquidation`）、`closedSize > 0` 的平仓行不因仓位归零被丢；私有流只收 `linear`；订单类型由 `orderType` + `triggerDirection` 反推 |
| `ws.ts` | 私有流：`op:auth`（`HMAC(secret, "GET/realtime"+expires)`）/ `op:subscribe` / `op:ping` 消息装配 + 帧归一；连接由注入的工厂提供（测试里没有真连接），诊断留痕里的密钥已脱敏 |
| `budget.ts` | 600 次 / 5 s 按 IP 的请求预算（目标 60% = 360），三档用途配额，下单独立计数桶（10 次 / s），429 退避；**权重 0 的下单请求也走 `acquire(0)`** |
| `venue-errors.ts` | Bybit v5 `retCode` / 文案 → 13 个稳定分类 → 协议 `Problem` + `retryable` 位（顺序照 QD `pending_orders/error_classification.py`） |
| `market.ts` | 只读行情直接复用 `@gitrader/connector-bybit-data` 的 `BybitMarket`（合约清单 / K 线 / 报价 / 盘口），不重复实现 |

## 已知缺口（都是故意的，不是待办）

- **市价意图不是裸 Market**：Bybit 的 `Market` 单不带价，无法限滑点。市价意图必须给 `maxSlippageBps`
  （缺 → `INVALID_PARAMS`），按盘口中间价 ± 滑点生成 `Limit` + `IOC`，价格贴 `tickSize`（买单向下、卖单向上）；
  没有新鲜报价直接 `STALE_PRICE`，不下单。
- **`submit` 不挂保护单**：Bybit 建单时可以用 `tpslMode=Partial` 附带 TP/SL，但那些保护腿**没有独立订单号**，
  内核按 `clientOrderId` 对账时会对不上。所以 `tpsl.attachToOrder / positionLevel` 都声明 `false`，
  带 `tpsl` 的 `submit` 回 `1004`；成交后由内核调 `buildProtectionOrders()`（reduce-only + `closeOnTrigger`
  的 StopOrder 腿）或持仓级 `buildTradingStop()`。
- **改单只支持 Limit 系**：`amend` 的 `market` / `stop_market` / `take_market` / `trailing_stop` 回 `1004`。
  协议 `SupportLevel` 只有 native / emulated / none，表达不了「部分支持」，所以能力位写 `emulated`
  并在 `x-amendScope` 里写明范围。
- **追踪止损只能做持仓级**：Bybit 没有 `/v5/order/create` 的追踪单类型，`orderTypes.trailing_stop` 声明 `none`；
  追踪走 `setTradingStop()`（会覆盖该槽位已有的 TP/SL，内核要知道自己在覆盖什么）。
- **场所级定时撤单没有**：`scheduleCancel` / `armDeadman` 抛 `CAPABILITY_UNSUPPORTED`（5002），撤单循环由内核负责。
- **`orderStatus` 没给 symbol 时按 `settleCoin=USDT` 查**：不再用构造参数的 `defaultSymbol`（那个只留给启动对账）；
  带 `symbol` 才发 `symbol`，否则发 `settleCoin`；按 `orderId` / `orderLinkId` 查不到就 `found: false`，不猜也不扫全市场。
- **统一账户的保证金模式是账户级**：`setLeverage(…, marginMode)` 与带 `marginMode` 的意图会切换整个账户
  （组合保证金账户会被降级）；意图不带 `marginMode` 时只设杠杆，reduce-only 意图不做任何账户配置。
  本实例只在账户模式变化时才切换，切换后清空杠杆缓存重新设置。
- **成交按 7 天窗口拉**：`/v5/execution/list` 单次只给 7 天，最多回看 13 周；超过起点要求直接 `INVALID_PARAMS`，
  启动对账会把它记为 `truncated` 而不是报错。
- **不使用 `ctx.signer`**：Bybit 是 HMAC（apiKey + apiSecret），没有签名器句柄，也不回调 `ctx.onSigned`。
- **不调用任何提现接口**：`signers.withdrawCapable = false` 表示本连接器不用提现能力；API key 不要开提现权限。
- **行情只有 REST**：`subscribe` 支持 `quote` / `mids` 轮询（数据包实现），其它通道抛 `CAPABILITY_UNSUPPORTED`。

## 端点与 HTTP 方法（都照 QD v5.6.5 的当前实现 / Bybit v5 官方）

| 用途 | 方法 + 路径 |
|---|---|
| 建单（含 StopOrder 触发单） | `POST /v5/order/create` |
| 撤单 | `POST /v5/order/cancel` |
| 全撤 | `POST /v5/order/cancel-all` |
| 改单 | `POST /v5/order/amend` |
| 挂单 / 单状态 | `GET /v5/order/realtime`、`GET /v5/order/history` |
| 持仓 | `GET /v5/position/list` |
| 余额 | `GET /v5/account/wallet-balance` |
| 成交 | `GET /v5/execution/list` |
| 杠杆 / 保证金模式 | `POST /v5/position/set-leverage`、`POST /v5/account/set-margin-mode` |
| 持仓级 TP / SL / 追踪 | `POST /v5/position/trading-stop` |
| 服务时间 | `GET /v5/market/time` |

## 「结果未知」的口径

非 GET 请求（建单 / 撤单 / 全撤 / 改单 / 设杠杆 / 设 TP-SL）遇到超时、断网、HTTP 5xx、或
`retCode` 10000 / 10016 / 10019 / 110072（同号订单已在场上），一律落 `VENUE_OUTCOME_UNKNOWN`
（3006，`retryable = false`），必须按 `clientOrderId` 对账后再决定；只有 GET 查询的同类错误才落 3003 并可重试。
`retCode` 10006 / 10018 是限流（3002），按响应头的 reset 时间退避。

## 测试

```bash
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-bybit-trade
node node_modules/typescript/bin/tsc -p packages/connector-bybit-trade --noEmit
```

所有用例都离线：假服务器（`test/helpers/fake-bybit-trade.ts`）用同一个 secret **复算签名**、校验 HTTP 方法、
缺参回 Bybit 的真实码（10001 / 10003 / 10004 / 110001）。没有真网、没有真 WebSocket、没有密钥。

## 移植出处

签名、下单参数、持仓 / 成交读取、私有流归一、错误分类分别移植自 QuantDinger v5.6.5（Apache-2.0）的
`backend_api_python/app/services/live_trading/bybit.py`、`native_protection.py`（bybit 段）、
`execution_streams/normalizers.py`、`pending_orders/error_classification.py`；
每个移植函数上方有 `// Ported from …:<行号>; adapted.` 注释。只读行情来自本仓库的 `@gitrader/connector-bybit-data`。
