未经真网验证，不得接实盘；注册进内核由主会话另行决定。（许可证：CPAL-1.0）

# @gitrader/connector-htx-trade · HTX（火币）USDT 本位永续交易连接器（离线件）

本包只做 HTX USDT 本位永续（linear swap / `*-USDT` 合约）的交易侧：下单、撤单、全撤、调杠杆、
仓位级止盈止损（仅 v1）、账户 / 持仓 / 挂单 / 成交读取，外加交易必需的最小公共行情（合约规格、参考价、盘口、K 线）。
测试全离线：假服务器按 HTX 官方签名规则**独立复算签名**，路由与方法按官方文档写（不按客户端写法），
不 import 本包任何客户端代码。

**HTX 没有官方测试网**：`environment: 'testnet'` 且不传 `baseUrl` 会在构造时抛 `INVALID_PARAMS`；离线测试请显式传 `baseUrl` 指向假服务器。

## 两套 API（都必须知道的一件事实）

HTX 的合约私有接口分两代，账户模式不同，**互相拒绝**（QD 的真实生产痛点）：

| family | 端点前缀 | 账户 | 建单体字段 |
|---|---|---|---|
| `v5`（缺省） | `/v5/*` | 联合保证金（multi-assets） | `side` + `type` + `time_in_force` + `margin_mode` + `position_side` |
| `v1` | `/linear-swap-api/v1/swap_cross_*` | 交叉保证金（cross） | `direction` + `offset` + `lever_rate` + `order_price_type` |

`family` 由构造参数选（缺省 `v5`）。账户模式不匹配时本包**不偷偷切换资产模式**，直接把上游原文交回（3001）。
持仓模式不匹配（1499 / 1500）只重发一次、只翻 `position_side` / `offset`；平仓语义（`reduce_only`）在翻转前后保留。

## 端点与方法（官方事实）

| 用途 | v5 | v1 |
|---|---|---|
| 下单 | `POST /v5/trade/order` | `POST swap_cross_order` |
| 撤单 | `POST /v5/trade/cancel_order` | `POST swap_cross_cancel` |
| 全撤 | `POST /v5/trade/cancel_all_orders`（data 逐单 `code`） | `POST swap_cross_cancelall`（`data.errors` 逐单） |
| 订单 | `GET /v5/trade/order` | `POST swap_cross_order_info` |
| 挂单 | `GET /v5/trade/order/opens`（`from` 翻页，limit ≤ 100） | `POST swap_cross_openorders`（page_index） |
| 成交 | `GET /v5/trade/order/details`（回看 3 天） | `POST swap_cross_matchresults_exact`（`next_id` 翻页） |
| 持仓 | `GET /v5/trade/position/opens` | `POST swap_cross_position_info` |
| 余额 | `GET /v5/account/balance` | `POST swap_cross_account_info` |
| 杠杆 | `POST /v5/position/lever` | `POST swap_cross_switch_lever_rate`（无 margin_mode） |

**v1 全部私有接口都是 POST**，业务参数放 JSON body；v5 的读接口是 GET，写接口是 POST。
官方 `POST /v5/trade/position` 与 `POST /v5/trade/position_all` 是**市价平仓**（后者无参数地市价平掉全部持仓），
**本包任何路径都不调用它们**；持仓只读 `position/opens`，失败照抛。

## 签名（照官方《签名认证》）

```
参数：AccessKeyId / SignatureMethod=HmacSHA256 / SignatureVersion=2 / Timestamp（UTC ISO8601，秒级）
待签串：METHOD\nHost\nPath\n按参数名升序、URL 编码后以 & 连接的参数串
Signature = Base64(HMAC-SHA256(待签串, SecretKey))
```

`Timestamp` **不带毫秒、不带时区后缀**，直接用当前秒（不做自创的严格递增）。
鉴权参数放 query；GET 的业务参数也进 query，POST 的业务参数走 JSON body、**不进待签串**。
时间偏移用 v1 响应里的 `ts`（毫秒）校准，不额外发请求。

## 订单语义

1. **市价意图不发市价**：一律发「参考价 ± `maxSlippageBps` 的限价 + IOC」；缺 `maxSlippageBps` 回
   `INVALID_PARAMS`，报价陈旧回 `STALE_PRICE`。
2. **数量口径分两层**：对内核 `contractSize = '1'`、`venueSizeUnit = 'base'`（内核名义额 = size × 价 × 1）；
   真实面值只存在市场表的私有映射里，`size.step / size.min / size.decimals` 用面值（0.001 → 3 位）。
   下单体 `volume` = 币数量 ÷ 面值：v5 发 String，v1 发数字。
3. **数量不是面值整数倍**：`rounding: 'reject'`（缺省）→ `PRECISION` 并写明面值；`rounding: 'passive'` 向下截到整张。
4. **v1 不猜杠杆**：`lever_rate` 取 `opts.leverage ?? intent.leverage`，都没有就 `INVALID_PARAMS`
   （先 `setLeverage` 或显式传 `intent.leverage`）。
5. **v5 的 `type` 只有 `limit` / `post_only`**：IOC / FOK 走 `time_in_force`；`postOnly` / `alo` 发 `post_only`。
6. **触发单不声明**：`stop_*` / `take_*` / `trailing_stop` / `twap` 在能力表里是 `none`，调用回 1004。
7. **没有改单**：HTX 只有撤 + 下，`amend` 一律 1004（能力表 `amend: 'none'`）。

`client_order_id` 是 **int64**：内核的字符串 id 走 `numericClientOrderId()` 确定性映射
（有数字取最后 18 位，没有数字用 SHA-256 取模 2^62 + 1）。**映射不可逆**：对账时用同一函数把内核 id
换成 int64 再与场所的 `client_order_id` 比。v1 响应里 16 位以上的整数 id 在 `JSON.parse` 前先转成字符串，
避免丢精度。

## 结果未知（3006）与限频

非 GET 的 HTTP 408 / 5xx 与系统类码（1000 / 1001 / 1002 / 1003 / 1004 / 500 / 6021）一律
`3006 VENUE_OUTCOME_UNKNOWN`，ack 回 `status: 'unknown'`，由内核按 clientOrderId 对账；**不盲目重发**。
GET 的同类错误是 3003（可重试）。1032（限频）→ `3002 + retryable` 并对预算退避；
429 / 418 / 403+too frequent 同样是 3002 + `retryAfterMs`。1013 / 1014 → `INSTRUMENT_UNKNOWN`。

## 能力声明（老实写）

`market: emulated`（ioc_limit）· `limit: native` · 其余订单类型 `none` · `tpsl.attachToOrder: false`；
`tpsl.positionLevel` 仅 v1 为 true（v5 调 `setTpsl` 回 1004）· `amend: none` ·
`cancelAll: native`（v5 与 v1 各有官方全撤端点）· `deadman` 不声明：v5 官方有 `POST /v5/trade/cancel-after`
（`on_off` / `time_out` ≥ 5000 ms），**本包未实现** · `signers: api-key`，不可提现 · `clientOrderId: htx-int64`。
`marginModes`：v5 `cross / isolated`，v1 只有 `cross`。

## 已知限制

- 成交回补必须给合约：HTX 的成交端点要 `contract_code`，`fills()` 需要 `instrumentId` 或 `defaultSymbol`。
  v1 按 7 天窗口、最多 12 窗（84 天，官方只给 90 天内）；v5 窗口 2 天、最多回看 3 天。
  超出范围时 `fills()` 抛 `INVALID_PARAMS`，`startupSnapshot()` 置 `truncated`。
- v1 全撤未给 `instrumentId` 时先读当前挂单、按合约逐个 `cancelall`；不再「失败后逐张撤」。
- 本包不开 WebSocket：`subscribe()` 返回空退订函数，`status()` 老实报 `ws disconnected` / `source: none`。
- 提交阶段的「成交回报」不存在：建单只回订单号，IOC 的成交由成交记录 / 内核回查补上。
- 本包**未注册**进 CLI / 内核，也没有接真网。

## 测试

229 例全离线（假服务器 + 冻结时钟 + 注入预算）。签名断言在测试里用 `node:crypto` 独立重算一遍，
假服务器也独立复算；响应形状与路由按官方文档写，并与客户端断言分离。
另有一条静态断言：`src/` 文本里不出现 v5 市价平仓端点与猜测的杠杆缺省。

## 参照与许可

流程与校验参照 QuantDinger v5.6.5（Apache-2.0）`backend_api_python/app/services/live_trading/htx.py`、
`htx_v5.py`、`native_protection.py`；移植处逐个注明 `file:line`。端点、HTTP 方法、字段与响应形状以
HTX 官方文档为准（QD 在 v5 持仓回退与 v5 `type` 映射两处与官方相反，本包不照抄）。
本包自身按 CPAL-1.0 发布。
