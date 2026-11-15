> 许可证：CPAL-1.0。

# @gitrader/connector-binance-data

Binance USDⓈ-M 期货**公共行情**连接器：`BinanceDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `binance data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'binance'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, weight, 2400, 60000}]`、`history {1500, 1500}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://fapi.binance.com`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /fapi/v1/exchangeInfo` |
| `candles`（无 `from` 取最近 n 根；有 `from` 每页 1500 根翻页，最多 200 页） | `GET /fapi/v1/klines` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /fapi/v1/ticker/bookTicker` |
| `book` | `GET /fapi/v1/depth?limit=` |
| `context`（标记价、指数价、资金费率） | `GET /fapi/v1/premiumIndex` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /fapi/v1/ticker/bookTicker` |

每次请求前先向注入的 `budget` 要权重（优先 `take(weight)`，否则 `RateBudget.acquire`），缺省不限。HTTP 非 2xx → `VENUE_UNAVAILABLE`（retryable，429 / 418 带 `Retry-After`）。

```ts
const conn = new BinanceDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('binance:BTCUSDT', '1h', { n: 300 })
const quote = await conn.refreshQuote('binance:BTCUSDT')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；把 `BinanceDataConnector` 注册进连接器表的改动由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-binance-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
