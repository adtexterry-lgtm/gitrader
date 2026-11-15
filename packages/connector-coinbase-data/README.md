> 许可证：CPAL-1.0。

# @gitrader/connector-coinbase-data

Coinbase **Advanced Trade 公共现货行情**连接器：`CoinbaseDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `coinbase data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'coinbase'`、`environments ['mainnet']`、`instrumentKinds ['spot']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 10, 1000}]`、`history {350, 350}`、`'x-data-only': true`。
- 现货没有标记价 / 资金费：现货无标记价，以最新成交价代——`context()` 的 `markPrice` 取缓存报价的 `last`（没有则 bid/ask 中价）；无缓存时先 `refreshQuote` 一次，仍拿不到则抛 `VENUE_UNAVAILABLE`（retryable）。资金费相关键一律缺省，并补 `midPrice`。

## 端点（基址可注入，缺省 `https://api.coinbase.com`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存，只收 `status === 'online'`） | `GET /api/v3/brokerage/market/products?product_type=SPOT` |
| `candles`（无 `from` 取最近 n 根；有 `from` 以 `start` 秒游标按 350 根一窗推进，最多 200 页） | `GET /api/v3/brokerage/market/products/{product_id}/candles?granularity=&start=&end=` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /api/v3/brokerage/market/products/{product_id}/ticker?limit=1` |
| `book`（`limit` 钳到 1..250） | `GET /api/v3/brokerage/market/product_book?product_id=&limit=` |
| `context`（现货无标记价，以缓存报价的最新成交价代；无缓存先拉一次 ticker） | 无缓存时 `GET /api/v3/brokerage/market/products/{product_id}/ticker?limit=1` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /api/v3/brokerage/market/products/{product_id}/ticker` |

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，其次 `take`），成功后 `reportOk`；缺省不限。HTTP 非 2xx / 200 带 `{ error }` → `VENUE_UNAVAILABLE`（retryable，429 带 `Retry-After`）。

K 线周期映射（其余周期一律 `INVALID_PARAMS`）：`1m → ONE_MINUTE`、`5m → FIVE_MINUTE`、`15m → FIFTEEN_MINUTE`、`30m → THIRTY_MINUTE`、`1h → ONE_HOUR`、`2h → TWO_HOUR`、`1d → ONE_DAY`。`start` 是**秒**，统一 ×1000 成开盘毫秒；上游倒序，返回前翻成升序并按 `t` 去重。

```ts
const conn = new CoinbaseDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('coinbase:BTC-USD', '1h', { n: 300 })
const quote = await conn.refreshQuote('coinbase:BTC-USD')
```

## 注册到内核

内核 CLI 按配置注册表装配连接器（见 `packages/cli/src/connectors.ts`）。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-coinbase-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
