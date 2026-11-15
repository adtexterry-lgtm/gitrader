> 许可证：CPAL-1.0。未经真网验证，不得接实盘；注册进内核由主会话另行决定。

# @gitrader/connector-alpaca-data

Alpaca **美股只读行情**连接器：`AlpacaDataConnector implements VenueConnector`。只读数据源，不碰资金、不下单、不持有账户状态。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `alpaca data connector is read-only`），不联网。
- 无 WebSocket：`subscribe({channel:'quote'})` 按 `pollMs`（缺省 5000）轮询快照；`status().source` 恒为 `'rest'`。
- 只收 `class === 'us_equity'` 的资产（加密资产不在本包范围）。标的形状照 `packages/protocol/src/model/instrument.ts`：`kind 'spot'`、`assetClass 'stocks'`、`quote / settle 'USD'`、`venueSizeUnit 'base'`、`contractSize '1'`、数量按整数股（`step '1'`）。
- 没有标记价 / 资金费 / 永续强平价：`context()` 的 `markPrice` 取最新成交价（没有则 bid/ask 中价），另给 `midPrice` 与 `prevDayPrice`（快照里昨日日线收盘）。没有 L2 盘口：`book()` 只返回最优一档（真实 NBBO bid/ask 与其挂单量），`depth` 被忽略，`describe()['x-book'] = 'top-of-book'`。
- 公司行动（拆股 / 分红调整）不在本包范围：K 线固定 `adjustment=raw`，要复权请用上游 `all` 自行处理。

## 端点（每个端点都在 `src/parse.ts` 顶部写了出处；本机离线，未联网核验）

基址分两个主机：**交易主机**（`/v2/assets`、`/v2/calendar`、`/v2/clock`）随环境声明（`paper` → `paper-api.alpaca.markets`，`live` → `api.alpaca.markets`），**数据主机** `data.alpaca.markets`（paper / live 共用，源由 `feed` 决定）。

| 方法 | 端点 |
| --- | --- |
| `start()` / `refreshAssets`（缓存标的，`asset_class=us_equity&status=active`） | `GET /v2/assets` |
| `refreshCalendar()` / `tradingCalendar()` / `sessionsTemplate()` | `GET /v2/calendar?start=&end=`（纽约本地日期） |
| `refreshMarketClock()` / `marketClock()` | `GET /v2/clock` |
| `candles(id, interval, {n\|from,to})` | `GET /v2/stocks/{symbol}/bars?timeframe=&limit=&start=&end=&adjustment=raw&feed=&sort=&page_token=` |
| `refreshQuote()` / `quote()` / `book()` | `GET /v2/stocks/{symbol}/snapshot?feed=` |

- **行情源**：`feed` 可选 `iex`（缺省，免费）/ `sip`（需订阅）/ `otc` / `boats`；不认识的源在构造时就拒绝，**不会**静默回落到 IEX。免费计划查 SIP 时上游 403 → `VENUE_AUTH` 并提示核对订阅。
- **时段**：`sessions.tz = 'America/New_York'`。常规窗口来自 `/v2/calendar` 的 `open / close`（按星期几取出现次数最多的一组），**代码里不写死 09:30–16:00**；日历为空直接 `VENUE_UNAVAILABLE`。盘前 04:00–09:30、盘后 16:00–20:00 另列 `quality 'thin'` 窗口（`sessions.extendedHours=false` 可关，起止可配；`/v2/calendar` 行里有 `session_open` / `session_close`，但官方未定义其语义（社区实例 0700 / 1900 与扩展时段不符），本包不采用；盘前盘后窗口取官方 Orders 文档的扩展时段 04:00–09:30 / 16:00–20:00 ET，可配）。`isOpenAt(ms)` 按**日历当天**的 open / close 判断：节假日（日历里没有这一天）→ 休市，提前收盘日按当天 close 收盘。
- **碎股 / 可借**：协议 `Instrument` 没有 `fractionable`、`shortable`、`borrow_status`、`marginable` 字段，本包不自行加字段，改由 `assetFlags(id)` 原样给出（`tradable / marginable / shortable / borrowStatus / easyToBorrow / fractionable / exchange / marginRequirementLong / marginRequirementShort / maintenanceMarginRequirement`）。Alpaca 官方 changelog（2026-07-16 条）宣布旧字段 `easy_to_borrow`、`maintenance_margin_requirement` 于 2026-09-22 移除，改用 `borrow_status`（`easy_to_borrow` / `hard_to_borrow`）与 `margin_requirement_long / _short`：本包优先读新字段、旧字段只作回落；借券状态拿不到时 `borrowStatus = null`、`easyToBorrow = false`（不当作可借），保证金要求拿不到时为 `null`（不可得，不当作 0）。
- **密钥（可选）**：SIP 订阅与更高速率需要密钥，从构造参数 `keyId / secretKey` 或环境变量 `ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY` 进（`env` 可注入，测试不读真环境）。请求头是 `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`（不是 HMAC）；密钥存私有字段，不打印、不落盘、不进错误信息。`PK` 前缀 = 模拟、`AK` = 实盘：前缀与显式声明的 `environment` 不符、或只有一半密钥 → **构造时拒绝**；`tradingBaseUrl` 覆盖到另一个环境的官方主机也拒绝（paper / live 不混）。

K 线周期映射：`1m/3m/5m/15m/30m` → `NMin`，`1h/2h/4h/8h/12h` → `NHour`，`1d/1w/1M` → `1Day/1Week/1Month`；其余（如 `3d`）→ `INVALID_PARAMS` 且不发请求。无 `from` 取最近 n 根（钳到 1..10000，缺省 300），有 `from` 按 `next_page_token` 翻页（每页 10000 根，最多 200 页），返回升序去重、时间一律开盘毫秒。

```ts
const conn = new AlpacaDataConnector({ environment: 'paper', feed: 'iex', fetchImpl, budget })
await conn.start()
const bars = await conn.candles('alpaca:AAPL', '1m', { n: 300 })
const quote = await conn.refreshQuote('alpaca:AAPL')
const calendar = conn.tradingCalendar()   // 含 isEarlyClose / isLateOpen
const flags = conn.assetFlags('alpaca:AAPL')   // fractionable / shortable ...
```

## 协议缺口（本包不自行加字段，交主会话决定）

1. 节假日与提前收盘：`sessions` 是周模板，装不下日期级例外；本包在 `tradingCalendar()` / `isOpenAt()` 里按接口处理，协议若要表达需新增字段。
2. 碎股与可借：见 `assetFlags()`。
3. 最小报价单位随价格档位变化（≥$1 为 $0.01，<$1 为 $0.0001），协议 `price` 没有分档字段，本包只填 `maxDecimals: 4`，不写 `tick`。

## 测试

`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-alpaca-data`（全离线：HTTP 由注入的假 `fetchImpl` 回答，夹具手写、未经真网核验）。
