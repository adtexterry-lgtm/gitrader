> 许可证：CPAL-1.0。

# @gitrader/connector-finnhub-data

Finnhub 公共行情（美股 / 全球股票）**只读**连接器：`FinnhubDataConnector implements VenueConnector`。只做行情，不碰资金、不持有交易凭据。

## 密钥（必填）

端点全部要 API key，从环境变量读：

```bash
FINNHUB_API_KEY=<your key>
```

也可以构造参数 `apiKey` 显式传入（优先于环境变量）。没有密钥时构造即抛 `INVALID_PARAMS`，消息里只出现变量名 `FINNHUB_API_KEY`，不出现任何密钥内容。密钥只放在 `X-Finnhub-Token` 请求头，**不进 URL、不进日志、不进错误信息**；上游若在错误体里回显密钥，出站前替换成 `<redacted>`。

## 免费档限流（官方）

- **60 次 API 调用 / 分钟**（`https://finnhub.io/docs/api/rate-limit`），按调用次数计，不按权重；`describe().rateLimits` 声明为 `{ scope: 'ip', model: 'count', limit: 60, windowMs: 60000 }`。
- 超限时上游回 **429**，本包把它映射成 `VENUE_UNAVAILABLE`（`retryable: true`，带 `retryAfterMs`），并让注入的预算整体退避。
- 免费档覆盖不到的端点 / 标的回 **403**，本包映射成 `VENUE_AUTH`（不重试）。`candles()`（`/stock/candle`）与 `book()` / `bidAsk()`（`/stock/bidask`）官方标为 Premium Access Required：**免费 key 拿不到 K 线**，上游回 403 → 本包 `VENUE_AUTH`（不重试）。免费档可用：标的清单、`quote`、`marketStatus`、`marketHolidays`。
- 每个请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，其次 `take(weight)`），成功后 `reportOk()`；预算缺省不限。

## 端点（基址可注入，缺省 `https://finnhub.io/api/v1`）

| 方法 | 端点 | 官方文档 |
| --- | --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /stock/symbol?exchange=US` | `https://finnhub.io/docs/api/stock-symbols` |
| `candles`（付费档） | `GET /stock/candle?symbol=&resolution=&from=&to=`（`t` 是秒，本包 ×1000） | `https://finnhub.io/docs/api/stock-candles` |
| `refreshQuote` / `quote`（`quote` 只读缓存） | `GET /quote?symbol=` | `https://finnhub.io/docs/api/quote` |
| `book` / `bidAsk`（最优一档，付费档） | `GET /stock/bidask?symbol=` | `https://finnhub.io/docs/api/bidask` |
| `marketStatus`（开市判断以它为准） | `GET /stock/market-status?exchange=US` | `https://finnhub.io/docs/api/market-status` |
| `marketHolidays`（休市 / 提前收盘 `tradingHour`） | `GET /stock/market-holiday?exchange=US` | `https://finnhub.io/docs/api/market-holiday` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /quote` | 同上 |

### 两个必须知道的口径

1. **报价没有买卖盘**：官方 `/quote` 只给最新成交价 `c`，所以 `quote()` 的 `bid = ask = last`（能力声明 `'x-quote-basis': 'last-price'`）——**价差未知**，回测不得据此假设可成交价差。真实 NBBO 只能走 `bidAsk()`，且该端点属于付费档。
2. **没有交易日历**：Finnhub 不给带开收盘时间的日历，所以 `sessions` 是美股常规时段（周一至周五 09:30–16:00，`America/New_York`，可配；盘前盘后可用 `sessions.extendedHours` 另列为 `thin`）。日期级例外（休市、提前收盘 13:00）用 `marketHolidays()` 原样暴露，`marketStatus()` 给权威的 `isOpen` / `session`。

### K 线口径

- 区间映射：`1m→1`、`5m→5`、`15m→15`、`30m→30`、`1h→60`、`1d→D`、`1w→W`、`1M→M`。协议里的 `3m`/`2h`/`4h`/`8h`/`12h`/`3d` 官方没有写法 → `INVALID_PARAMS`，不静默近似。
- 无 `from`：取最近 `n` 根（钳到 1..5000，缺省 300），一次请求。
- 有 `from`：官方未声明单次根数上限，本包每次请求覆盖 **5000 × interval** 的时间窗并向后推进，直到越过 `to`（无 `to` 时推进到当前时刻），最多 200 页；返回升序、按 `t` 去重。
- 输出形状就是协议 `Candle`：`{t, o, h, l, c, v}`，`t` 为**开盘毫秒**，可直接喂 `@gitrader/data-files` 与回测。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `finnhub data connector is read-only`），**不联网**。
- 无 WebSocket、无私有端点；`status().source` 恒为 `'rest'`，`subscribe` 是轮询。
- `describe()`：`venue 'finnhub'`、`environments ['mainnet']`、`instrumentKinds ['spot']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`history {5000, 5000}`、`'x-data-only': true`。

```ts
const conn = new FinnhubDataConnector({ fetchImpl, budget, pollMs: 5000 }) // FINNHUB_API_KEY 从环境读
await conn.start()
const candles = await conn.candles('finnhub:AAPL', '1d', { n: 300 }) // /stock/candle 需付费档
const quote = await conn.refreshQuote('finnhub:AAPL')
const state = await conn.marketStatus()
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；注册由主会话另行完成。

测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-finnhub-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现；夹具为按官方字段表手写，未经真网核对）。
