> 许可证：CPAL-1.0。

# @gitrader/connector-kucoin-data

KuCoin Futures（USDT 永续，`perp`）**公共行情**连接器：`KucoinDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `kucoin data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'kucoin'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 30, 3000}]`、`history {200, 200}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://api-futures.kucoin.com`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /api/v1/contracts/active` |
| `candles`（无 `from` 取最新一页的末尾 n 根，n ≤ 200；有 `from` 每页 200 根、`from` 游标向前推进，最多 200 页） | `GET /api/v1/kline/query?symbol=&granularity=&from=&to=` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /api/v1/ticker?symbol=` |
| `book`（≤ 20 档走 `depth20`，21..100 档走 `depth100`） | `GET /api/v1/level2/depth20` · `GET /api/v1/level2/depth100` |
| `context`（标记价 + 资金费率，两次请求） | `GET /api/v1/mark-price/{symbol}/current` · `GET /api/v1/funding-rate/{symbol}/current` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /api/v1/ticker?symbol=` |

响应信封 `{ code, data }`：`code !== '200000'`（业务错误同样走 HTTP 200，例如 `200003 Invalid symbol.`）→ `VENUE_UNAVAILABLE`（`retryable: true`，消息带 code 与 msg）；HTTP 非 2xx 同样 `VENUE_UNAVAILABLE`，429 / 418 带 `Retry-After`。

K 线周期按分钟发送：`1m→1`、`5m→5`、`15m→15`、`30m→30`、`1h→60`、`2h→120`、`4h→240`、`8h→480`、`12h→720`、`1d→1440`、`1w→10080`；**3m / 3d / 1M → `INVALID_PARAMS`**（工单表不含这三个周期，不发请求）。行格式 `[time(毫秒), o, h, l, c, volume(张), turnover]`，升序返回；本连接器仍按 `t` 排序去重。

时间戳单位不统一：`/ticker` 与 `/level2/*` 给**纳秒**，K 线与标记价给毫秒；`msOf()` 按量级统一归一到毫秒。

## 字段映射

- `symbol → kucoin:<symbol>`（如 `kucoin:XBTUSDTM`，原生 symbol 原样保留）。
- `tickSize → price.tick`（`maxDecimals` = tick 小数位）；`lotSize → size.step / size.min`（单位是**张**），`multiplier → contractSize`，`venueSizeUnit: 'contract'`。
- `isInverse === true`（反向 / 币本位）与 `status !== 'Open'`（`CancelOnly` / `Init` / `Closed` / `Settled`）的合约**不进目录**。
- `fundingRateGranularity → fundingIntervalMs`（缺省 8h）。
- `book` 每个价位是 `[price, size(张)]`，按 `multiplier` 折成**标的币数**（`size × contractSize`，保留 12 位有效数字去掉浮点尾巴）；合约清单未加载时 `contractSize` 按 1 处理，此时 size 仍是张。
- 无 `minNotional`（上游不提供）；`nextFundingRateTime` 是「距今毫秒」而非绝对时间，`MarketContext` 没有对应字段，故不下发。

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，退而 `take(weight)`），成功后 `reportOk()`，缺省不限。

```ts
const conn = new KucoinDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('kucoin:XBTUSDTM', '1h', { n: 200 })
const quote = await conn.refreshQuote('kucoin:XBTUSDTM')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；把 `KucoinDataConnector` 注册进连接器表的改动由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-kucoin-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现，假基址 `http://kucoin.example.test`）。
