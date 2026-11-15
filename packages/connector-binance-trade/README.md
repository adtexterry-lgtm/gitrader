> 许可证：CPAL-1.0。

> **未经真网验证，不得接实盘。**

# @gitrader/connector-binance-trade

Binance USDⓈ-M 永续（`fapi`）交易连接器。只在假服务器上测过，没有跑过真网。本包目前**只能当库用**：内核已为它写了装配代码、**已注册进内核**（`packages/cli/src/connectors.ts` 的 `tradeFallback`），但当前行为是——配置里有这家场所的**主网 live 账户**时，内核一律退回只读行情连接器并在启动时打一条警告；只有**测试网 live 账户且凭据句柄能解析**时才会装配本连接器（标记为未验证），而内核的账户监听（`userFills`）尚未接通，实测会报错。**所以现在不要指望在内核里用它下真单。** 所有下单仍经风控闸门。它自己不会下单——`submit` / `cancel` / `amend` 只在内核发起的 `TradeContext` 窗口里执行。

## 它做什么

| 模块 | 内容 |
|---|---|
| `rest.ts` | 签名请求：HMAC-SHA256 over query string（`node:crypto`），`recvWindow` + `timestamp`（时钟注入、可 `resync`，`-1021` 重校后只重试一次），头 `X-MBX-APIKEY`；`X-MBX-USED-WEIGHT-1M` 回填预算；429 / 418 → `VENUE_UNAVAILABLE` + retryable + `Retry-After`；listenKey 只带 API key 头、不签名 |
| `orders.ts` | `OrderIntent` → 下单参数全表：市价意图用「参考价 ± `maxSlippageBps`」的 `LIMIT` + `IOC`；`LIMIT` 走 `/fapi/v1/order`；五类触发单（`STOP_MARKET` / `STOP` / `TAKE_PROFIT_MARKET` / `TAKE_PROFIT` / `TRAILING_STOP_MARKET`）走 `/fapi/v1/algoOrder`（`algoType=CONDITIONAL` / `triggerPrice` / `workingType=MARK_PRICE` / `clientAlgoId`）；数量按 `stepSize` 向零截断，价格按 `tickSize` 校验 |
| `trading.ts` | `submit`（普通 / algo 两个端点）/ `cancel`（普通失败后退回 algo）/ `cancelAll`（`DELETE /fapi/v1/allOpenOrders` + `DELETE /fapi/v1/algoOpenOrders`，没有该端点时逐单撤）/ `amend`（`PUT /fapi/v1/order`，仅 LIMIT）/ `status` / `openOrders`；杠杆 `/fapi/v1/leverage` + 保证金模式 `/fapi/v1/marginType` |
| `account.ts` | `/fapi/v2/account` 只取余额 / 可用，持仓取 `/fapi/v2/positionRisk`（`positionAmt` / `entryPrice` / `markPrice` / `unRealizedProfit` / `marginType` / `leverage` / `notional`）；挂单合并 `/fapi/v1/openOrders` + `/fapi/v1/openAlgoOrders`；`/fapi/v1/userTrades`；对账数值走协议 decimal |
| `parse.ts` | 标的 / K 线 / 盘口 / 报价 / 上下文解析（复制 `@gitrader/connector-binance-data` 的逻辑，那份为准）；订单状态映射；私有流归一（`ORDER_TRADE_UPDATE` / `ACCOUNT_UPDATE` / `listenKeyExpired`） |
| `ws.ts` | `listenKey` 创建 / 25 分钟续期 / 关闭；WebSocket 只做帧解析，连接由注入的工厂提供（测试里没有真连接） |
| `budget.ts` | IP 权重预算 2400 / 分钟（目标 60% = 1440），三档用途配额，下单计数桶，429 退避 |
| `venue-errors.ts` | 币安错误码 / 文案 → 13 个稳定分类 → 协议 `Problem` + `retryable` 位（分类顺序照 QD `pending_orders/error_classification.py`） |

## 已知缺口（都是故意的，不是待办）

- **市价意图不是裸 MARKET**：币安 `MARKET` 不带价，无法限滑点。市价意图必须给 `maxSlippageBps`（缺 → `INVALID_PARAMS`），
  按盘口中间价 ± 滑点生成 `LIMIT` + `IOC`，价格贴 `tickSize`（买单向下、卖单向上）；参考报价超过
  `refPriceMaxAgeMs`（缺省 5000 ms，可配）直接拒单 `INVALID_PARAMS`，不下单。
- **没有原生父子单**：币安不提供 attach 式 TP/SL。带 `tpsl` 的 `submit` 直接返回 `1004`；
  `buildProtectionOrders(parentIntent, filledSize)` 是纯函数，成交后由内核补挂 reduce-only 的
  `STOP_MARKET` / `TAKE_PROFIT_MARKET`（也是 `algoType=CONDITIONAL` 形状）。
- **改单只有 LIMIT**：`amend` 的其它类型返回 `1004`。协议 `SupportLevel` 只有 native / emulated / none，
  表达不了「部分支持」，所以能力位写 `emulated`。
- **场所级死人开关**：币安有 `countdownCancelAll`（按 symbol）API，但**本包没有接入**内核死人开关；
  `scheduleCancel` / `armDeadman` 抛 `CAPABILITY_UNSUPPORTED`（5002），撤单循环由内核负责。
- **`userTrades` / `orderStatus` 强制要 symbol**：`fills` / `orderStatus` 没给 symbol 时用构造参数的
  `defaultSymbol`，两者都没有就报 `INVALID_PARAMS`，不猜也不扫全市场；启动对账按「持仓 ∪ 挂单」的 symbol 集合逐个拉。
- **成交回补窗口**：`fills` 只接受最近 3 个月内的非负整数毫秒时间；连接器用本地 90 天保护窗在发请求前拒绝更早的时间，不会截断查询并假称完整。若停机超过窗口，旧成交需要人工补账。
- **不使用 `ctx.signer`**：币安是 HMAC（apiKey + apiSecret），没有签名器句柄，也不回调 `ctx.onSigned`。
- **不调用任何提现接口**：能力位 `signers.withdrawCapable = false` 表示本连接器不用提现能力；
  API key 不要开提现权限。
- **行情**：只有 REST；`subscribe` 支持 `quote` / `mids` 轮询，其它通道抛 `CAPABILITY_UNSUPPORTED`。

## 基址

- 生产：`https://fapi.binance.com`（缺省）。
- 测试网 / demo：`https://demo-fapi.binance.com`（照 QD `binance.py:40`）。
- `baseUrl` 可显式覆盖（本地假服务器 / 镜像）；测试里用 `http://binance.example.test`。

## 密钥

`apiKey` / `apiSecret` 只从构造参数进；错误消息与告警经 `redactSecret`（含 base64 形态）；
签名只在 `BinanceHttp.lastSignature` 里留 hex 供测试对拍，不进日志、不进 JSON-RPC。

## 跑测试

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-binance-trade
node node_modules/typescript/bin/tsc -p packages/connector-binance-trade --noEmit
```

假服务器在 `test/helpers/fake-binance-trade.ts`：进程内按 `方法 + 路径` 回答，不开端口、不联网。

## 移植来源

结构照 `packages/connector-hyperliquid`；行情 / 合约 / K 线解析复制 `packages/connector-binance-data`；
签名、下单参数、保护单与错误码分类照 QuantDinger v5.6.5（Apache-2.0）
`backend_api_python/app/services/live_trading/binance.py`、`native_protection.py`、
`pending_orders/error_classification.py`，每个函数上方标了 `file:line`。
