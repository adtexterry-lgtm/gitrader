> 许可证：CPAL-1.0。

> **未经真网验证，不得接实盘。**

# @gitrader/connector-okx-trade

OKX USDT / USDC 永续（`SWAP`）交易连接器。只在假服务器上测过，没有跑过真网。本包目前**只能当库用**：内核已为它写了装配代码、**已注册进内核**（`packages/cli/src/connectors.ts` 的 `tradeFallback`），但当前行为是——配置里有这家场所的**主网 live 账户**时，内核一律退回只读行情连接器并在启动时打一条警告；只有**测试网 live 账户且凭据句柄能解析**时才会装配本连接器（标记为未验证），而内核的账户监听（`userFills`）尚未接通，实测会报错。**所以现在不要指望在内核里用它下真单。** 所有下单仍经风控闸门。它自己不会下单——`submit` / `cancel` / `amend` 只在内核发起的 `TradeContext` 窗口里执行。

## 它做什么

| 模块 | 内容 |
|---|---|
| `rest.ts` | 签名请求：`base64(HMAC-SHA256(secret, timestamp + METHOD + path + body))`，四个 `OK-ACCESS-*` 头；`timestamp` 是带毫秒的 RFC3339（注入时钟、严格递增）；GET 的 query 按 key 排序并进预签名串；body 先序列化再签名，签名对的就是实际发出的字节；演示盘靠 `x-simulated-trading: 1` 区分（同主机）；429 → `VENUE_RATE_LIMITED`（3002）；GET 503 → `VENUE_UNAVAILABLE`（3003）；非 GET 503 / 50004 / 无响应 → `VENUE_OUTCOME_UNKNOWN`（3006） |
| `orders.ts` | `OrderIntent` → `/trade/order` 或 `/trade/order-algo`：`tdMode`、`posSide`（net / long / short）、`ordType`（`limit` / `post_only` / `ioc` / `fok` / `conditional` / `oco` / `move_order_stop`）、数量**张**（按 `ctVal` 折币）、价格按 `tickSz`、`reduceOnly`（仅 net 模式）、普通单 `clOrdId` / 算法单 `algoClOrdId`、触发单 `TriggerPxType: mark`、市价 = 带价 IOC |
| `trading.ts` | `submit` / `cancel`（ordId 或 clOrdId）/ `cancelAll`（枚举 + `cancel-batch-orders` + `cancel-algos`）/ `amend`（`/trade/amend-order`，仅普通 limit）/ `status` / `openOrders`；撤单与全撤逐行判 `sCode`，算法单走 `cancel-algos`；杠杆 `/account/set-leverage`；死人开关 `/trade/cancel-all-after` 的 `timeOut`（10–120 s，不夹取） |
| `account.ts` | `/account/balance`、`/account/positions`、`/trade/orders-pending`（翻页）、`/trade/orders-algo-pending`（翻页）、`/trade/order`、`/trade/fills`（缺省全量 SWAP）；**数量单位一律币数量**（`venueSizeUnit = base`），张数按 `ctVal` 换算，ctVal 不明报 1001 |
| `parse.ts` | 标的记录（ctVal / 张步长）与状态映射（普通单 / 算法单两张表）；私有流逐行归一（`orders` / `orders-algo` / `positions` / `account` / `login` / `error`）。合约与行情解析**不复制**：直接用 `@gitrader/connector-okx-data` |
| `ws.ts` | 私有流：`login` 帧（`timestamp` 是**秒**，`sign = base64(HMAC(secret, ts + "GET" + "/users/self/verify"))`）、登录成功后自动订阅、25 s `ping`；`sent()` 里的 login 帧脱敏；低层默认保留 `orders` / `positions` / `account` 私有通道，连接器默认再启用 business 的 `orders-algo` / `algo-advance`；旧高级通道别名 `advance-algo-orders` 入站兼容、发送使用 `algo-advance` |
| `budget.ts` | 按端点计次（OKX 不是权重制）：交易 60 次 / 2 s / 账户、单标的 10 次 / 2 s、账户只读 10 次 / 2 s；三档用途配额，429 退避 |
| `venue-errors.ts` | OKX v5 错误码 / 文案 → 13 个稳定分类 → 协议 `Problem` + `retryable` 位（分类顺序照 QD `pending_orders/error_classification.py`） |

## 已知缺口（都是故意的，不是待办）

- **没有 attach 式父子单**：带 `tpsl` 的 `submit` 直接返回 `1004`；`buildProtectionOrders(parentIntent, filledSize)`
  是纯函数，成交后由内核调用。两腿一起给时**一条原生 OCO 算法单**（`ordType=oco`）就够，
  只给一腿时是 `conditional`；数量 = 成交 delta，方向 = 父单反向，net 模式带 `reduceOnly`。
- **改单只对普通 limit 单**：算法单 / 市价单返回 `1004`。协议 `SupportLevel` 只有 native / emulated / none，
  表达不了「部分支持」，能力位按原生端点存在声明 `native`，限制写在 README 与 REPORT 里。
- **`cancelAll` 是 emulated**：OKX 没有「一次撤掉我全部挂单」的端点（`/trade/cancel-all-after` 是计时器），
  实现是「枚举挂单 + 两个批量端点」，因此能力位写 `emulated`。
- **`scheduleCancel` / `armDeadman` 是原生的**：`/trade/cancel-all-after` 的 `timeOut`（10–120 秒）到点全撤、持仓不动。
- **`fills` 缺省扫全量 SWAP**；`orderStatus` 只认本实例下过的单（进程内记录）或调用方显式给的 `symbol`，否则报 `INVALID_PARAMS`。
- **高级算法订单流**：有效状态归一为挂单状态；`actualSz` / `actualPx` 描述实际下发的子单，不代表成交。成交量只从 `accFillSz` / `fillSz` 读取，缺失时不合成成交。
- **不使用 `ctx.signer`**：OKX 是 HMAC（apiKey + apiSecret + passphrase），没有签名器句柄，也不回调 `ctx.onSigned`。
- **不调用任何提现接口**：能力位 `signers.withdrawCapable = false` 表示本连接器不用提现能力；API key 不要开提现权限。
- **行情**：只有 REST（复用数据包）；`subscribe` 支持轮询报价，其它通道抛 `CAPABILITY_UNSUPPORTED`。

## 密钥

`apiKey` / `apiSecret` / `passphrase` 只从构造参数进；三者都必须非空且是 ASCII（HTTP 头按 latin-1 编码，
中文 / 全角字符会在发请求前炸）。错误消息与告警经 `redactSecret`（含 base64 形态）；
三者在 `OkxHttp` / `OkxTradeConnector` 里都是 `#` 私有字段，`OkxAccounts` / `OkxTrading` 只保留私有依赖对象；`sent()` 的 login 帧写 `<redacted>`。签名只在 `OkxHttp.lastSignature` 里留 base64 供测试对拍，不进日志、不进 JSON-RPC。

## 跑测试

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-okx-trade
node node_modules/typescript/bin/tsc -p packages/connector-okx-trade --noEmit
```

假服务器在 `test/helpers/fake-okx-trade.ts`：进程内按 `方法 + 路径` 回答，不开端口、不联网、不读夹具文件。

## 移植来源

结构照 `packages/connector-binance-trade`；合约 / 行情解析复用 `packages/connector-okx-data`；
签名、下单参数、张数折算、算法单与持仓模式照 QuantDinger v5.6.5（Apache-2.0）
`backend_api_python/app/services/live_trading/okx.py`，每个函数上方标了 `file:line`。
