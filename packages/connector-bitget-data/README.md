> 许可证：CPAL-1.0。

# @gitrader/connector-bitget-data

Bitget v2 **USDT 永续公共行情**连接器：`BitgetDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `bitget data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'bitget'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 20, 1000}]`、`history {maxCandles 200, pageLimit 200}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://api.bitget.com`，全部带 `productType=USDT-FUTURES`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /api/v2/mix/market/contracts` |
| `candles`（无 `from` 取最近 n 根，n ≤ 200） | `GET /api/v2/mix/market/candles?granularity=&limit=` |
| `candles`（有 `from`，每页 200 根按 `startTime` 游标推进，最多 200 页） | `GET /api/v2/mix/market/history-candles` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /api/v2/mix/market/ticker` |
| `book` | `GET /api/v2/mix/market/merge-depth?limit=`（1 / 5 / 15 / 50 / max） |
| `context`（标记价、指数价、资金费率、持仓量） | `GET /api/v2/mix/market/ticker` + `GET /api/v2/mix/market/current-fund-rate` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /api/v2/mix/market/ticker` |

响应外层 `{ code, msg, requestTime, data }`：`code !== '00000'` → `VENUE_UNAVAILABLE`（retryable，`venue.code` 带业务码、`venue.message` 带 `msg`）。
每次请求前先向注入的 `budget` 要 1 次额度（优先 `RateBudget.acquire`，其次 `take`），成功后 `reportOk()`；非 2xx → `VENUE_UNAVAILABLE`（429 / 418 带 `Retry-After`）。

## 字段映射（上游只有精度位数，没有 tick / step 文本）

- 价格：`tick = priceEndStep × 10^-pricePlace`（BTCUSDT：`1 × 10^-1 = 0.1`），`maxDecimals = pricePlace`；推不出来回落 `{sigFigs: 5, maxDecimals: 8}`。
- 数量：`step = 10^-volumePlace`、`decimals = volumePlace`、`min = minTradeNum`；`minNotional = minTradeUSDT`。
- 资金间隔：`fundingIntervalMs = fundInterval（小时）× 3600000`，缺省 8h。上游 `nextUpdate` 在协议 `MarketContext` 里没有对应字段，不外露。
- 合约清单只收 `symbolStatus === 'normal'` 且 `symbolType === 'perpetual'`，所以 `listInstruments({includeDelisted: true})` 也拿不到停牌条目。
- `granularity` 按工单：`1m 3m 5m 15m 30m 1H 2H 4H 12H 1D 3D 1W 1M`（`2h` 上游实测认）；`8h` 不在表内 → `INVALID_PARAMS`（不发请求）。

```ts
const conn = new BitgetDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('bitget:BTCUSDT', '1h', { n: 300 })
const quote = await conn.refreshQuote('bitget:BTCUSDT')
```

## 注册到内核

本包**尚未接线**；把 `BitgetDataConnector` 注册进连接器表由主会话另行完成。
测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-bitget-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
