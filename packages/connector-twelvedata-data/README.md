> 许可证：CPAL-1.0。

# @gitrader/connector-twelvedata-data

Twelve Data 公共行情（美股 / 全球股票）**只读**连接器：`TwelveDataDataConnector implements VenueConnector`。只做行情，不碰资金、不持有交易凭据。

## 密钥（必填）

端点全部要 API key，从环境变量读：

```bash
TWELVEDATA_API_KEY=<your key>
```

也可以构造参数 `apiKey` 显式传入（优先于环境变量）。没有密钥时构造即抛 `INVALID_PARAMS`，消息里只出现变量名 `TWELVEDATA_API_KEY`，不出现任何密钥内容。密钥只放在 `Authorization: apikey <key>` 请求头（官方支持的两种鉴权方式之一），**不进 URL、不进日志、不进错误信息**；上游若在错误体里回显密钥，出站前替换成 `<redacted>`。

## 免费档限流（官方）

- **8 API credits / 分钟**、**800 API credits / 天**——数字来自 pricing 页（`https://twelvedata.com/pricing`），官方文档页未写，以你账户控制台为准；普通端点一次调用消耗 1 个 credit，`describe().rateLimits` 两条都声明了（`{limit: 8, windowMs: 60000}` 与 `{limit: 800, windowMs: 86400000}`）。
- 超限时上游回 **429**（也可能是 HTTP 200 带 `{status:"error", code:429}`），本包一律映射成 `VENUE_UNAVAILABLE`（`retryable: true`，带 `retryAfterMs`）并让注入的预算退避。
- 计划覆盖不到的端点 / 标的回 **401 / 403** → `VENUE_AUTH`（不重试）；参数写错 **400**、标的或端点不存在 **404** → `INVALID_PARAMS`（不重试）。
- 每个请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，其次 `take(weight)`），成功后 `reportOk()`；预算缺省不限。

## 端点（基址可注入，缺省 `https://api.twelvedata.com`）

| 方法 | 端点 | 官方文档 |
| --- | --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /stocks?exchange=NASDAQ` | `https://twelvedata.com/docs#stocks-list` |
| `candles` | `GET /time_series?symbol=&interval=&outputsize=&order=&timezone=UTC`（分页用 `start_date` / `end_date`） | `https://twelvedata.com/docs#time-series` |
| `refreshQuote` / `quote`（`quote` 只读缓存） | `GET /quote?symbol=` | `https://twelvedata.com/docs#quote` |
| `marketState`（开市判断以它为准） | `GET /market_state?exchange=NASDAQ`（响应顶层是数组，按 `code` / `name` 匹配 exchange） | `https://twelvedata.com/docs#market-state` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /quote` | 同上 |
| `book` | 没有盘口端点 → `CAPABILITY_UNSUPPORTED` | — |

标的清单缺省只拉 `exchange=NASDAQ`；NYSE 等标的需构造参数 `exchange` 指定，否则 `getInstrument` 返回 undefined。

### 三个必须知道的口径

1. **报价没有买卖盘**：官方 `/quote` 只有 `close`（最新成交价），所以 `quote()` 的 `bid = ask = last`（能力声明 `'x-quote-basis': 'last-price'`）——**价差未知**，回测不得据此假设可成交价差。`book()` 直接拒绝（`'x-book': 'none'`），不拿成交价编一档盘口。
2. **没有交易日历**：`/market_state` 只给 `is_market_open` 与到开盘 / 收盘的倒计时，没有开收盘时间。所以 `sessions` 由 `buildSessions()` 按时段惯例生成（缺省周一至周五 09:30–16:00、`America/New_York`；`sessions.tz` / `regularOpen` / `regularClose` / `days` 可配，非美股市场请显式传所在时区）。权威开市判断走 `marketState()`。
3. **时间按 UTC 解释**：请求固定带 `timezone=UTC`，`datetime`（`YYYY-MM-DD HH:mm:ss` 或日线的 `YYYY-MM-DD`）按 UTC 转毫秒，输出的 `t` 是**开盘毫秒**。

### K 线口径

- 区间映射：`1m→1min`、`5m→5min`、`15m→15min`、`30m→30min`、`1h→1h`、`2h→2h`、`4h→4h`、`8h→8h`、`1d→1day`、`1w→1week`、`1M→1month`。协议里的 `3m`/`12h`/`3d` 官方没有写法 → `INVALID_PARAMS`（官方的 `45min` 协议没有对应区间，不使用）。
- 无 `from`：`outputsize = n`（钳到 1..5000，缺省 300），`order=desc` 取最近一页，本地排成升序。
- 有 `from`：每次请求覆盖 **5000 × interval** 的 UTC 时间窗（`start_date` / `end_date`，`order=asc`），向后推进直到越过 `to`（无 `to` 时推进到当前时刻），最多 200 页；返回升序、按 `t` 去重。
- 缺任意 OHLCV 字段的行跳过（指数 / 部分外汇没有 `volume`），不补 0。
- 输出形状就是协议 `Candle`：`{t, o, h, l, c, v}`，可直接喂 `@gitrader/data-files` 与回测。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `twelvedata data connector is read-only`），**不联网**。
- 无 WebSocket；`status().source` 恒为 `'rest'`，`subscribe` 是轮询。
- `describe()`：`venue 'twelvedata'`、`environments ['mainnet']`、`instrumentKinds ['spot']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`history {5000, 5000}`、`'x-data-only': true`。

```ts
const conn = new TwelveDataDataConnector({ fetchImpl, budget, pollMs: 5000 }) // TWELVEDATA_API_KEY 从环境读
await conn.start()
const candles = await conn.candles('twelvedata:AAPL', '1d', { n: 300 })
const quote = await conn.refreshQuote('twelvedata:AAPL')
const state = await conn.marketState()
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；注册由主会话另行完成。

测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-twelvedata-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现；夹具为按官方字段表手写，未经真网核对）。
