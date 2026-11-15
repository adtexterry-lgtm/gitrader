> 许可证：CPAL-1.0。

# @gitrader/connector-okx-data

OKX SWAP（USDT / USDC 线性永续）**公共行情**连接器：`OkxDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `okx data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'okx'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 20, 2000}]`、`history {300, 100}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://www.okx.com`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /api/v5/public/instruments?instType=SWAP` |
| `candles`（无 `from` 取最近 n 根，n ≤ 300；有 `from` 走 history 端点、每页 100 根、`after` 游标向前翻，最多 200 页） | `GET /api/v5/market/candles` · `GET /api/v5/market/history-candles` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /api/v5/market/ticker?instId=` |
| `book`（`sz` 钳到 1..400） | `GET /api/v5/market/books?instId=&sz=` |
| `context`（标记价 + 资金费率，两次请求） | `GET /api/v5/public/mark-price?instType=SWAP&instId=` · `GET /api/v5/public/funding-rate?instId=` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /api/v5/market/ticker?instId=` |

OKX 的 K 线是**倒序**返回，本连接器一律翻成升序并按 `t` 去重；周期按场所拼写发送（`1h → 1H`、`1d → 1D`、`1w → 1W`、`1M → 1M`）。

标的映射：`instId → okx:<instId>`（如 `okx:BTC-USDT-SWAP`）；只收 `settleCcy` 为 `USDT / USDC` 的线性永续，币本位（`settleCcy` = 标的币的 inverse）与其它结算币一律不收。`tickSz → price.tick`；数量一律换成币：`lotSz × ctVal → size.step`、`minSz × ctVal → size.min`、`venueSizeUnit: 'base'`，`contractSize` 保留 `ctVal` 只供展示；盘口 `size` 与 K 线 `v` 都是张 × `ctVal`（K 线拿不到 `ctVal` 时回落上游 `volCcy` 列）。`minNotional` 上游协议不给，留空不硬造。`state` 的 `live → trading`、`suspend / preopen / test → halted`、`expired → delisted`。

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，退而 `take(weight)`），成功后 `reportOk()`，缺省不限。HTTP 非 2xx 或信封 `code !== "0"` → `VENUE_UNAVAILABLE`（retryable；429 / 418 带 `Retry-After`）。

```ts
const conn = new OkxDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('okx:BTC-USDT-SWAP', '1h', { n: 300 })
const quote = await conn.refreshQuote('okx:BTC-USDT-SWAP')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；把 `OkxDataConnector` 注册进连接器表的改动由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-okx-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
