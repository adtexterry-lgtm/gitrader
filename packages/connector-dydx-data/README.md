> 许可证：CPAL-1.0。

# @gitrader/connector-dydx-data

dYdX v4（Indexer 公共 API）**永续行情**连接器：`DydxDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `dydx data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'dydx'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 100, 10000}]`、`history {1000, 1000}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://indexer.dydx.trade`，路径前缀 `/v4`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /v4/perpetualMarkets` |
| `candles`（无 `from` 取最近 n 根，n ≤ 1000；有 `from` 走 `toISO` 游标向前翻页、每页 1000 根，最多 200 页） | `GET /v4/candles/perpetualMarkets/{ticker}?resolution=&fromISO=&toISO=&limit=` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /v4/orderbooks/perpetualMarket/{ticker}` + `GET /v4/trades/perpetualMarket/{ticker}?limit=1` |
| `book`（Indexer 一次给整本，本地截断到 1..500 档） | `GET /v4/orderbooks/perpetualMarket/{ticker}` |
| `context`（标记价 / 资金费率 / 持仓，读 `perpetualMarkets` 缓存，不发请求；未 `start` 时先拉一次） | `GET /v4/perpetualMarkets` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | 同 `refreshQuote` |

K 线的 `startedAt` 是 **ISO 字符串**，本连接器统一转成开盘毫秒；Indexer **整页倒序**（最新在前），一律翻成升序并按 `t` 去重。`resolution` 只认 7 个：`1MIN / 5MINS / 15MINS / 30MINS / 1HOUR / 4HOURS / 1DAY`（`3m / 2h / 8h / 1w / 1M` 等 Indexer 没有的周期直接 `INVALID_PARAMS`）。

翻页语义：`fromISO` 闭、`toISO` 开（不含该时刻那根）。所以有 `to` 时首游标取 `to + 1 ms`；每页取「`toISO` 之前最近 1000 根」，把本页最早一根的开盘时间作为下一页 `toISO`，直到不满一页或越过 `from`。

标的映射：`ticker → dydx:<ticker>`（如 `dydx:BTC-USD`，大小写原样保留）；`tickSize → price.tick`，`stepSize → size.step / size.min`（单位是**标的币**，`venueSizeUnit: 'base'`、`contractSize: '1'`）；`settle: 'USDC'`、`settlement: 'linear'`；`status === 'ACTIVE' → trading`，其余（如 `FINAL_SETTLEMENT`）→ `delisted`，默认列表不展示、`includeDelisted` 可见。Indexer 不给 `minNotional`，故省略。

资金费：`oraclePrice` 作标记价、`nextFundingRate` 作资金费率、`openInterest` 作持仓；dYdX v4 **每小时整点结算**一次，`fundingIntervalMs` 固定 3 600 000。Indexer 不提供「下次资金时间」与指数价改名后的字段，协议缺省留空。

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，退而 `take(weight)`），成功后 `reportOk()`，缺省不限。HTTP 非 2xx、响应里带 `errors`、或 JSON 解析失败 → `VENUE_UNAVAILABLE`（retryable；429 读 `Retry-After` 并 `penalize`）。

```ts
const conn = new DydxDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('dydx:BTC-USD', '1h', { n: 1000 })
const quote = await conn.refreshQuote('dydx:BTC-USD')
const ctx = await conn.context('dydx:BTC-USD')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；把 `DydxDataConnector` 注册进连接器表的改动由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-dydx-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
