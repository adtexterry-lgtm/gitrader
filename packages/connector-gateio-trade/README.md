> 许可证：CPAL-1.0。

# @gitrader/connector-gateio-trade

**未经真网验证，不得接实盘。** 本包是 Gate.io USDT 本位永续（`/api/v4/futures/usdt/*`）的交易连接器：只有假服务器上的单元测试，没有任何一条路径接过真网。本包目前**只能当库用**：内核已为它写了装配代码（`packages/cli/src/connectors.ts` 的 `tradeFallback`），但当前行为是——配置里有这家场所的**主网 live 账户**时，内核一律退回只读行情连接器并在启动时打一条警告；只有**测试网 live 账户且凭据句柄能解析**时才会装配本连接器（标记为未验证），而内核的账户监听（`userFills`）尚未接通，实测会报错。**所以现在不要指望在内核里用它下真单。** 所有下单仍经风控闸门。

## 它能做什么

- 下单：限价（`tif: gtc` / `ioc` / `poc`（只挂单，post-only）/ `fok`）；数量用**币数量**表达，内部按 `quanto_multiplier` 折成 Gate 的有符号张数（`size`），份额化合约自动带 `X-Gate-Size-Decimal: 1`。
- 市价意图：**必须**带 `maxSlippageBps`，实际发「价带限价 + `tif: ioc`」，所以能力位是 `market: emulated`（Gate 有原生市价 `price "0"` + `ioc`，但 Gitrader 的口径不允许无滑点上限的市价单）。
- 触发单：`stop_market` / `stop_limit` / `take_market` / `take_limit` 走 `POST /api/v4/futures/usdt/price_orders`，形状照 QD `native_protection.py:273-322`：`initial`（触发后市价是 `price "0"` + `ioc`，或限价单的定点价）+ `trigger{strategy_type 0, price_type last 0 / mark 1 / index 2, rule 1 = ≥、2 = ≤, expiration 30 天}` + `order_type`（reduce-only 带 `plan-close-long-position` / `plan-close-short-position`）；整数张的 `initial.size` 是数字，份额化合约改用字符串 `initial.amount`。回执 `status: untriggered`，`venueOrderId` 带 `po:` 前缀。
- 撤单：`DELETE /orders/{id}`、`DELETE /price_orders/{id}`；「单已不在场上」（`ORDER_NOT_FOUND` / `ORDER_FINISHED` …）按成功，由内核随后核实终态。全撤按合约原生 `DELETE /orders?contract=` + `DELETE /price_orders?contract=`（能力位 `native`）。
- 设杠杆：全仓 `leverage=0` + `cross_leverage_limit`、逐仓 `leverage=N`，**参数在 query**，回包按模式核对有效杠杆。
- 只读：账户、持仓（持仓专用端点）、挂单（普通单 + 触发单，翻页读全，读不全就报错）、成交（本地按 `sinceMs` 过滤、不发 `from`，去重键 = 成交号）、单张订单状态、启动对账、资金费流水、持仓模式。
- 私有流：只做**帧归一**（`normalizeGateEvent`）：`futures.usertrades` / `futures.orders` / `futures.positions`（零仓位行保留为 flat）/ `futures.balances`（只有总额与变动，不冒充可用），强平 / 自动减仓成交标 `liquidation`。本包不建 WebSocket 连接。

## 口径

- 数量一律**币**；张币乘数（`quanto_multiplier`）拿不到就报错，绝不按 1 折；缓存外合约按 `GET /contracts/{contract}` 补拉（QD `gate.py:701-723`）。对内核报的 `Instrument.contractSize` 恒为 `1`（内核名义额 = size × price × contractSize）。
- 手续费与 Gate 同号（正 = 付出、负 = 返佣；QD `normalizers.py` 的 `parse_gate` 不取反）。
- `equity` = `total` + `unrealised_pnl`（Gate 的 `total` 不含未实现盈亏）；维持保证金按持仓行 `maintenance_margin` / `maintenance_rate` × 名义额汇总。
- clientOrderId：内核的 32 位十六进制号编成 `t-` + base64url(16 字节)（24 字符），读回解码；其它字符串照 QD 的清洗规则（`gate.py:91-104`，只留 `[0-9A-Za-z-_.]`、补 `t-`）。
- 订单状态落成内核认得的词（普通单 open / partially_filled / filled / cancelled；触发单 untriggered / triggered / cancelled / expired / rejected），原文在 `raw`。
- 大整数 id 按源文本保留（不丢精度），优先 `id_string`。
- 测试网基址 `https://api-testnet.gateapi.io`（QD `factory.py:327`），`environment: 'testnet'` 时启用。
- 查询沿用数据包的 IP 口径 200 次 / 10 s（目标 ≤ 60%）；下单桶 10 次 / 1 s 是本连接器的**本地自定上限**，不是 Gate 公布值。

## 保证金模式（主会话裁定）

下单绝不切换保证金模式。开仓意图带 `leverage` / `marginMode` 时先读 `GET /positions/{contract}`：模式不符 → `INVALID_PARAMS`（带 `set margin mode explicitly first`），合约还没有设置 → 同样拒；只在杠杆不同时按现有模式改杠杆。reduce-only 平仓不碰账户设置。只有显式 `setLeverage(instrumentId, leverage, marginMode)` 会切模式。

## 做不到的 / 已知限制

| 项 | 状态 | 说明 |
|---|---|---|
| 追踪单 `trailing_stop` | `none`，回 1004 | QD 的 Gate 追踪由策略运行时管（`managed_by: strategy_runtime`），不是原生端点 |
| twap | `none`，回 1004 | 未实现 |
| `amend` | `none`，回 1004 | QD 没有 amend；Gate 的 `PUT /orders/{id}` 未纳入本包 |
| 批量下单 | `batch.maxOrders: 1` | 一次只发一张，不假装原子批量 |
| 父子单 tpsl（`attachToOrder` / `positionLevel`） | 都 `false` | 触发单要单独提交，保护由内核自己安排 |
| 双仓 / 分仓账户（`dual` / `dual_plus`） | 回 5002 | 只建模单向持仓，不猜双仓字段 |
| 统一 / 组合保证金账户 | 未建模 | 只声明 `standard` |
| 死人开关 | 未实现 | Gate 有 `POST /futures/{settle}/countdown_cancel_all`，QD 未用；`scheduleCancel` 回 5002，撤单循环留在内核 |
| 私有 WebSocket 连接 | 未实现 | 只提供帧归一函数，由内核侧接自己的 WS |

另外几条（接真网前逐条核）：

1. **触发单没有客户端单号**：QD 不给触发单发 `text`，本包同样不发。触发单结果未知（3006）只能按本进程记下的指纹（合约 / rule / 触发价 / 张数）找回；普通单按本进程记下的下单合约缩小 `status=finished` 的扫描范围。两张备忘各最多 10000 条、重启即失忆；精确对账请传 `venueOrderId`。
2. **触发单触发后的成交**挂在 Gate 新建的普通单上（`text` 为 `ao-…`），内核按触发单的 `venueOrderId` 连不回去。
3. **`realizedPnl` 恒 0**：`my_trades` 不给逐笔已实现盈亏。
4. **`fundingSinceOpen` 恒 0**：持仓行不暴露累计资金费，资金费另走 `account_book`。
5. **`point_fee`（点卡抵扣）不并入现金手续费**。
6. 手续费符号这条假设**未经真网确认**。

## 端点出处（以 QuantDinger v5.6.5 当前实现为准）

出处都在 `backend_api_python/app/` 下；`gate.py` 在 `services/live_trading/`，`position_activity.py` 在 `services/quick_trade/`，`quick_trade.py` 在 `routes/`。QD 没用的端点如实标「QD 未用」，不编行号。

| 用途 | 端点 | 出处 |
|---|---|---|
| 签名（HMAC-SHA512 + payload 槽位是 SHA512(body) hex） | — | `gate.py:1-11`、`:78-83` |
| 请求头 / 客户端订单号 `text` | `KEY` / `Timestamp`(秒) / `SIGN` / `X-Gate-Size-Decimal` | `gate.py:85-89`、`:91-104` |
| 签名请求（query 排序、时间戳秒） | — | `gate.py:106-138` |
| 定点价格文本（禁科学计数法） | — | `gate.py:32-38` |
| 下单（市价） | `POST /api/v4/futures/usdt/orders`（`price:"0"`, `tif:ioc`） | `gate.py:930-964` |
| 下单（限价） | `POST /api/v4/futures/usdt/orders`（`tif:gtc`） | `gate.py:966-1007` |
| 撤单 | `DELETE /api/v4/futures/usdt/orders/{id}` | `gate.py:1009-1012` |
| 单张订单 | `GET /api/v4/futures/usdt/orders/{id}` | `gate.py:1014-1017` |
| 挂单列表 | `GET /api/v4/futures/usdt/orders?status=open` | `gate.py:1019-1026` |
| 按合约全撤普通单 | `DELETE /api/v4/futures/usdt/orders?contract=` | QD 未用（Gate apiv4 原生端点） |
| 触发单下单 | `POST /api/v4/futures/usdt/price_orders` | `native_protection.py:273-322`（请求在 `:315`） |
| 触发单列表（挂单） | `GET /api/v4/futures/usdt/price_orders?status=open&contract=` | `position_activity.py:123` |
| 触发单撤单 | `DELETE /api/v4/futures/usdt/price_orders/{id}` | `quick_trade.py:1941` |
| 按合约全撤触发单 | `DELETE /api/v4/futures/usdt/price_orders?contract=` | QD 未用（Gate apiv4 原生端点） |
| 触发单详情 | `GET /api/v4/futures/usdt/price_orders/{id}` | QD 未用（同表的 id 口径） |
| 成交 | `GET /api/v4/futures/usdt/my_trades`（翻页 offset） | `gate.py:1032-1044` |
| 持仓（专用端点） | `GET /api/v4/futures/usdt/positions` | `gate.py:860-870` |
| 单合约保证金设置 | `GET /api/v4/futures/usdt/positions/{contract}` | QD 未用（杠杆仍走 `gate.py:872-910`） |
| 账户 | `GET /api/v4/futures/usdt/accounts` | `gate.py:820-821` |
| 持仓模式 | 同 accounts 的 `position_mode` / `in_dual_mode` | `gate.py:823-858` |
| 合约元数据 | `GET /api/v4/futures/usdt/contracts/{contract}` | `gate.py:701-723` |
| 设杠杆 | `POST /api/v4/futures/usdt/positions/{contract}/leverage`（query 参数） | `gate.py:872-910` |
| 资金费流水 | `GET /api/v4/futures/usdt/account_book?type=fund` | `gate.py:673-694` |
| 张数换算 | `size = base / quanto_multiplier`，份额化按 `order_size_min` 精度截断 | `gate.py:730-782` |
| 持仓张数 → 币数 | `|size| × quanto_multiplier` | `gate.py:796-818` |
| 测试网基址 | `https://api-testnet.gateapi.io` | `factory.py:327` |

行情（合约目录 / K 线 / 盘口 / 报价 / 标记价）**复用 `packages/connector-gateio-data`**，本包只补交易需要的 `InstrumentRecord`（tick / `order_size_min` / `quanto_multiplier`）与报价缓存。

## 用法（离线）

```ts
import { GateioTradeConnector } from '@gitrader/connector-gateio-trade'

const connector = new GateioTradeConnector({
  apiKey: process.env.GATE_API_KEY ?? '',
  apiSecret: process.env.GATE_API_SECRET ?? '',
})
await connector.start()
const caps = connector.describe() // 先看能力位，再决定怎么下单
```

密钥只从构造参数 / 环境变量进，放 `#` 私有字段：`JSON.stringify(connector)`、`util.inspect(connector)`、`String(err)` 都不含密钥（有测试断言）。本包不使用 `ctx.signer`，也不回调 `ctx.onSigned`——Gate 用 HMAC 签名，没有可写账本的载荷摘要。

## 测试

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-gateio-trade
node node_modules/typescript/bin/tsc -p packages/connector-gateio-trade --noEmit
```

测试全离线：`test/helpers/fake-gate.ts` 是进程内假服务器，**复算 HMAC-SHA512 签名**、按方法表回 405、缺必填参数回 Gate 真实形状的 `400 {"label":"INVALID_PARAM_VALUE"}`、未知订单回 `404 ORDER_NOT_FOUND`。不会访问任何网络主机。
