> 许可证：CPAL-1.0。

> **未经真网验证，不得接实盘。**

# @gitrader/connector-bitget-trade

本包是 Bitget USDT 本位永续（`productType=USDT-FUTURES`）的交易连接器：只有假服务器上的单元测试，没有任何一条路径接过真网。本包目前**只能当库用**：内核已为它写了装配代码、**已注册进内核**（`packages/cli/src/connectors.ts` 的 `tradeFallback`），但当前行为是——配置里有这家场所的**主网 live 账户**时，内核一律退回只读行情连接器并在启动时打一条警告；只有**测试网 live 账户且凭据句柄能解析**时才会装配本连接器（标记为未验证），而内核的账户监听（`userFills`）尚未接通，实测会报错。**所以现在不要指望在内核里用它下真单。** 所有下单仍经风控闸门。当前仅支持 Classic 账户；UTA 凭据不能调用 Classic API，本包不支持 UTA。

## 它能做什么

- 下单：限价（`gtc` / `ioc` / `fok` / `post_only`）、触发类（`stop_market` / `stop_limit` / `take_market` / `take_limit`，走计划委托，执行方式写 `orderType market / limit`）、追踪（`track_plan` + `callbackRatio`）。
- 市价意图：**必须**带 `maxSlippageBps`，实际发「价带限价 + `force=ioc`」，所以能力位是 `market: emulated`（上游有原生市价单，但 Gitrader 的口径不允许无滑点上限的市价单）。
- 撤单（普通 + 计划委托回退）、全撤（按标的模拟：orders-pending + cancel-order 逐张，计划单 orders-plan-pending（三族）+ cancel-plan-order（带 orderIdList）逐张；不用 cancel-all-orders）、改单不支持（回 1004，撤单后重下）、设杠杆。
- 位置级保护单：`placeProtection()` 在成交后由内核调用，走 `place-tpsl-order`（`loss_plan` / `profit_plan` / `moving_plan`）。
- 只读：账户、持仓（持仓专用端点）、挂单、成交、单张订单状态、启动对账。

## 端点出处（以 QuantDinger v5.6.5 当前实现为准）

| 用途 | 端点 | 出处 |
|---|---|---|
| 普通委托 | `POST /api/v2/mix/order/place-order` | `live_trading/bitget.py:287-310,781-903` |
| 计划委托 | `POST /api/v2/mix/order/place-plan-order` | 官方 v2 字段（`orderType` · `price` · `callbackRatio`），QD 未调用，需真网核对 |
| 保护单 | `POST /api/v2/mix/order/place-tpsl-order` | `live_trading/native_protection.py:190-229` |
| 撤单 | `POST /api/v2/mix/order/cancel-order` | `live_trading/bitget.py:905-917` |
| 撤计划单 | `POST /api/v2/mix/order/cancel-plan-order` | 官方 v2 字段（`orderIdList` · `planType`），QD 未调用，需真网核对 |
| 全撤 | 按标的模拟：`orders-pending` + `cancel-order` 逐张；计划单 `orders-plan-pending`（三族）+ `cancel-plan-order`（带 `orderIdList`）逐张 | `live_trading/open_orders.py:62-70`、`live_trading/bitget.py:905-917`；不用 `cancel-all-orders`（官方按 productType 撤全部标的，QD 未调用） |
| 改单 | 不调用 `modify-order` | 官方 v2 是撤旧挂新、换新 orderId / clientOid（QD 未调用），内核改单按原 clientOrderId 追踪，接不上 |
| 单张详情 | `GET /api/v2/mix/order/detail` | `live_trading/bitget.py:919-937` |
| 挂单 | `GET /api/v2/mix/order/orders-pending`（`data.entrustedList` + `endId`） | `live_trading/open_orders.py:63-70,110-125` |
| 计划挂单 | `GET /api/v2/mix/order/orders-plan-pending` | 官方 v2 字段（`planType` 必填，三族 `normal_plan` / `track_plan` / `profit_loss`），QD 未调用，需真网核对 |
| 成交 | `GET /api/v2/mix/order/fills` | `live_trading/bitget.py:939-963` |
| 持仓 | `GET /api/v2/mix/position/all-position` | `live_trading/bitget.py:639-666` |
| 余额 | `GET /api/v2/mix/account/accounts` | `live_trading/bitget.py:633-637` |
| 持仓模式 | `GET /api/v2/mix/account/account` | `live_trading/bitget.py:360-402` |
| 设杠杆 | `POST /api/v2/mix/account/set-leverage` | `live_trading/bitget.py:686-779` |

签名：`base64(HMAC-SHA256(secret, timestamp + UPPER(method) + path(+sortedQuery) + body))`，头 `ACCESS-KEY / ACCESS-SIGN / ACCESS-TIMESTAMP / ACCESS-PASSPHRASE`（`live_trading/bitget.py:198-258`）。信封 `code === '00000'` 才算成功——业务错误以 `{code,msg}` 信封返回，HTTP 状态可能是 200 或 4xx，实现对任意状态都先解析信封。

## 用法

```ts
import { BitgetTradeConnector } from '@gitrader/connector-bitget-trade'

const connector = new BitgetTradeConnector({
  environment: 'mainnet',
  apiKey: process.env.BITGET_API_KEY!,
  apiSecret: process.env.BITGET_API_SECRET!,
  passphrase: process.env.BITGET_PASSPHRASE!,
})
await connector.start()                 // 拉一次合约清单
const [ack] = (await connector.submit(ctx, [intent])).acks
```

凭据只从构造参数进，放在 `#` 私有字段里：`JSON.stringify(connector)`、`util.inspect`、错误文本都看不到；错误消息统一过 `redactSecret`（含 base64 形态）。`ctx.signer` 在 Bitget 上无对应物，**不使用也不回调** `onSigned`。

## 已知限制（如实）

- 账户范围：仅支持 Classic 账户与 Classic USDT 永续，不支持 UTA 凭据。Bitget 官方[迁移通知](https://www.bitget.com/support/articles/12560603886018)确认 UTA 凭据不能访问 Classic API，并建议采用 UTA V3；该通知没有给出 Classic 下线日期，本包不推断下线时间。


- 没有 WebSocket 私有流：`normalizeBitgetEvent()` 只做**消息解析**，连不上游；成交靠 `fills()` 轮询对账。
- `tpsl` 不能挂在父单上：`submit` 对带 `tpsl` 的意图回 `1004`，保护单走 `placeProtection()` 两步。
- `amend` 不支持（能力位 `none`，回 `1004`）：`modify-order` 是撤旧挂新、换新 orderId / clientOid，内核改单按原 clientOrderId 追踪并查单，新单接不上；要改单请撤单后重下。
- 保证金快照里的初始 / 维持保证金由持仓的 `marginSize` 与 `keepMarginRate` **折算**，不是上游绝对值；`fundingSinceOpen` 一律 `0`（上游持仓不暴露）。
- 死人开关（定时全撤）上游没有：`scheduleCancel()` 抛 `5002`。
- 查单需要 `symbol`：本实例提交过的单自动记住（clientOid / orderId → 标的 + 通道）；进程重启后记忆表为空，内核 `lookup` 不带 `symbol` 会得到 `INVALID_PARAMS`。
- 保护单逐条回报结果：`placeProtection()` 返回每条 `ok` / `venueOrderId` / `problem`，一条失败不影响其余腿发送。
- 对冲模式下成交 / 挂单的 `side` 语义未经真网核对（下单字段照 QD `bitget.py:404-442`）。
- 批量下单未实现（`batch.maxOrders = 1`）。
- `marginMode` 只经 `set-leverage` 传，不单独调 `set-margin-mode`（QD 同）。
- 渠道码 `X-CHANNEL-API-CODE` 缺省不发：QD 自带一个，我们**不冒用**。

## 行情

行情 / 合约元数据**直接复用** `packages/connector-bitget-data`（`BitgetMarket` + `parse.ts`，CPAL-1.0）；本包只把它包成 `InstrumentRecord`（tick / step / minSize）并维护一份可注入的报价缓存。订阅只支持 `quote` 轮询——数据包的能力边界，不在这里假装更强。

## 测试

```bash
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-bitget-trade
node node_modules/typescript/bin/tsc -p packages/connector-bitget-trade --noEmit
```

全部离线：假服务器（`test/helpers/fake-bitget.ts`）在进程内复算签名、校验 HTTP 方法与必填参数，缺参回上游形态的参数错误码，方法不对回 405。
