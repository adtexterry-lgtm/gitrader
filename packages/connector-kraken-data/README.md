> 许可证：CPAL-1.0。

# @gitrader/connector-kraken-data

Kraken Futures **公共行情**连接器（永续 `PF_`）：`KrakenDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `kraken data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'kraken'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 500, 10000}]`、`history {5000, 5000}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://futures.kraken.com`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /derivatives/api/v3/instruments` |
| `candles`（无 `from` 取最近 n 根，n ≤ 5000，缺省 300；有 `from` 以秒级 `from` 游标向前翻页，靠 `more_candles` 决定是否继续，最多 200 页） | `GET /api/charts/v1/trade/{symbol}/{resolution}?from=&to=` |
| `refreshQuote` / `quote`（一次响应含全部标的，整批写缓存；`quote` 只读缓存，未拉过返回 `undefined`） | `GET /derivatives/api/v3/tickers` |
| `book`（上游不带 depth，本地截断，上限 500；size 折成标的币数量） | `GET /derivatives/api/v3/orderbook?symbol=` |
| `context`（标记价 / 相对资金费率 / 指数价 / 未平仓，一个请求） | `GET /derivatives/api/v3/tickers` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /derivatives/api/v3/tickers` |

标的映射：`symbol → kraken:<symbol>`（如 `kraken:PF_XBTUSD`，大写原样）。只收 `PF_` 前缀且 `tradeable === true` 的永续；`FF_` / `PI_` 等交割条目与 `tradeable:false` 的下架条目一律跳过。

- `tickSize → price.tick`（`1 → {tick:'1', maxDecimals:0}`），缺失 / 0 → `{sigFigs:5, maxDecimals:8}`
- `contractValueTradePrecision → size.step`（4 → `0.0001`，0 → `1`，负值如 -3 → `1000`）；`size.min` 取同值。Kraken 的数量按张给，这里按 `contractSize` 折成标的币：1 张 = `contractSize` 个基础币单位（缺省按 1），故 `venueSizeUnit: 'base'`
- `contractSize` 保留每张面值（缺省 `'1'`）；`minNotional` 上游不给，留空
- 计价币非 `USDT` / `USDC` 时按 `settlement: 'inverse'`，结算币取标的币；`suspended → halted`、`isExpired → delisted`
- `fundingIntervalMs: 3_600_000` —— Kraken 永续资金费按小时计提；ticker 的 `fundingRate` 是绝对额（quote / 张），`context()` 按 `fundingRate / markPrice` 换算成相对费率；下次资金时间该所不给

K 线解析：`time` 已是毫秒（秒级时间戳也会 ×1000 归一），OHLCV 是字符串，`volume` 与盘口 size 同口径按 `contractSize` 折成标的币；结果**升序、按 `t` 去重**。

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，退而 `take(weight)`；Kraken 按次计，权重恒为 1），成功后 `reportOk()`，缺省不限。HTTP 非 2xx 或信封 `result === 'error'` → `VENUE_UNAVAILABLE`（retryable；429 带 `Retry-After`）。

```ts
const conn = new KrakenDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('kraken:PF_XBTUSD', '1h', { n: 300 })
const quote = await conn.refreshQuote('kraken:PF_XBTUSD')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；把 `KrakenDataConnector` 注册进连接器表的改动由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-kraken-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
