> 许可证：CPAL-1.0。

# @gitrader/connector-bybit-data

Bybit v5 **USDT 线性永续公共行情**连接器：`BybitDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `bybit data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'bybit'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 120, 5000}]`、`history {1000, 1000}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://api.bybit.com`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存，按 `nextPageCursor` 翻页） | `GET /v5/market/instruments-info?category=linear&limit=1000[&cursor=]` |
| `candles`（无 `from` 取最近 n 根，n ≤ 1000、缺省 300；有 `from` 按 `start`/`end` 窗口向前翻页，每页 1000 根，最多 200 页） | `GET /v5/market/kline?category=linear&symbol=&interval=&limit=[&start=&end=]` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /v5/market/tickers?category=linear&symbol=` |
| `book`（`limit` 钳到 1..500，缺省 20） | `GET /v5/market/orderbook?category=linear&symbol=&limit=` |
| `context`（标记价 / 资金费 / 持仓量，一次请求） | `GET /v5/market/tickers?category=linear&symbol=` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /v5/market/tickers?category=linear&symbol=` |

K 线：Bybit 每行 `[startTime(ms), o, h, l, c, volume, turnover]` 且**倒序**返回，本连接器一律翻成升序并按 `t` 去重。区间翻页不用「只传 start 靠场所决定取哪段」，而是显式窗口 `[start, start + 步长×1000 − 1]`（不越过 `end`），因此不依赖上游在区间内的取样方向。

周期映射（Bybit 无 8 小时、无 3 天，故这两个与表外周期都抛 `INVALID_PARAMS`）：

| 协议 | 1m | 3m | 5m | 15m | 30m | 1h | 2h | 4h | 12h | 1d | 1w | 1M |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bybit | 1 | 3 | 5 | 15 | 30 | 60 | 120 | 240 | 720 | D | W | M |

标的映射：`symbol → bybit:<symbol>`（如 `bybit:BTCUSDT`）；只收 `contractType === 'LinearPerpetual'` 且 `status` 为 `Trading` 或 `PendingOpen` 的条目：`PendingOpen`（官方 2026-09-01 新增，转 `Trading` 前不能下单）进表但 `status: 'halted'`；交割 / 反向 / 预上市（`PreLaunch`）/ 已下架在解析阶段丢弃，`includeDelisted` 不会让它们回来。`priceFilter.tickSize → price.tick`，`lotSizeFilter.qtyStep / minOrderQty → size.step / size.min`，`lotSizeFilter.minNotionalValue → minNotional`，数量单位是标的币（`venueSizeUnit: 'base'`、`contractSize: '1'`）；`fundingInterval`（**分钟**）× 60000 → `fundingIntervalMs`，缺失回落 8 小时。

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，退而 `take(weight)`），成功后 `reportOk()`，缺省不限；Bybit 公共端点是次数口径，一次请求记 1。HTTP 非 2xx 或信封 `retCode !== 0` → `VENUE_UNAVAILABLE`（retryable；429 / 418 带 `Retry-After` 并 `penalize`）。

```ts
const conn = new BybitDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('bybit:BTCUSDT', '1h', { n: 300 })
const quote = await conn.refreshQuote('bybit:BTCUSDT')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；把 `BybitDataConnector` 注册进连接器表的改动由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-bybit-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
