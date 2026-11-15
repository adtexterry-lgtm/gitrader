> 许可证：CPAL-1.0。

# @gitrader/connector-alphavantage-data

Alpha Vantage **美股行情**只读连接器：`AlphaVantageDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `alphavantage data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不下任何单；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'alphavantage'`、`environments ['mainnet']`、`instrumentKinds ['spot']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 25, 86400000}]`、`history {20000, 100}`、`'x-data-only': true`、`'x-book': 'none'`、`'x-quote': 'last-only'`、`'x-intervals'`。

## API Key 与免费档限流

- Key 从环境变量读：`ALPHAVANTAGE_API_KEY`（其次 `ALPHA_VANTAGE_API_KEY`），也可由构造参数 `apiKey` 直接给；两者都没有 → 构造期抛 `VENUE_AUTH`，**不会**退回无 key 请求。Key 只走 query 参数 `apikey`，不打印、不进错误信息（错误出口按原文 / base64 形态脱敏）。
- 免费档：**25 次/天**（官方 Support 页）。免费 key 只能用：日线 `compact`（最近 100 根）、周线 / 月线（直接给全历史）、`GLOBAL_QUOTE`、`LISTING_STATUS`。以下在免费 key 下都会拿到付费提示（本包抛 `VENUE_AUTH`，见下一节）：任何盘中周期（`1m/5m/15m/30m/1h`，`TIME_SERIES_INTRADAY` 整个端点标 Premium）、日线 `n > 100`、日线带 `from`（本包会发 `outputsize=full`）。
- 超限时上游**仍返回 HTTP 200**，body 是 `{"Information": …}` 或 `{"Note": …}`：文本含 `premium`（不区分大小写）→ 付费门槛，本包映射为 `VENUE_AUTH`（不重试、不罚预算）；其余按限流映射为 `VENUE_UNAVAILABLE`（`retryable: true`，`retryAfterMs: 60000`）并让预算退避。参数 / 标的错误是 `{"Error Message": …}` → `INVALID_PARAMS`（不重试）。
- 每次请求前向注入的 `budget` 要额度（优先 `acquire(weight)`，否则 `take`），响应确认不是失败体后才回调 `reportOk`。

## 端点

| 方法 | 端点（`GET https://www.alphavantage.co`） |
| --- | --- |
| `start()` → `listInstruments` / `getInstrument`（拉一次并缓存） | `/query?function=LISTING_STATUS&datatype=csv`（CSV：symbol,name,exchange,assetType,ipoDate,delistingDate,status） |
| `candles` 盘中（1m / 5m / 15m / 30m / 1h） | `/query?function=TIME_SERIES_INTRADAY&interval=1min\|5min\|15min\|30min\|60min`（免费 key 会拿到付费提示） |
| `candles` 日 / 周 / 月（1d / 1w / 1M） | `/query?function=TIME_SERIES_DAILY\|TIME_SERIES_WEEKLY\|TIME_SERIES_MONTHLY`（`outputsize` 只给日线；周 / 月线没有这个参数） |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `/query?function=GLOBAL_QUOTE` |
| `book` | 不提供：免费档没有买卖价，直接抛 `CAPABILITY_UNSUPPORTED`（不造档位） |
| `context` | 复用 `GLOBAL_QUOTE`：`markPrice` / `midPrice` = 最新价，`prevDayPrice` = 昨收；无资金费率（现货） |
| `subscribe({channel:'quote'})` | 按 `pollMs`（缺省 5000）轮询 `GLOBAL_QUOTE` |

`candles(id, interval, {n, from, to})`：

- 无 `from`：取最近 `n` 根（1..20000，缺省 100）。日线 `n ≤ 100` 用 `outputsize=compact`（官方：最近 100 根），否则 `full`（免费 key 会拿到付费提示）；盘中一律带 `outputsize`（免费 key 仍会拿到付费提示）；周 / 月线只带 `datatype`，直接取全历史。
- 有 `from`：盘中按月切片（`month=YYYY-MM`，美东自然月）从 `from` 的月份推进到 `to` 的月份，最多 200 页；日线一次 `outputsize=full` 拉回（免费 key 会拿到付费提示）；周 / 月线一次全历史拉回；都在本地过滤 `[from, to]`；升序去重。
- 周期不在 `1m/5m/15m/30m/1h/1d/1w/1M` 内 → `INVALID_PARAMS`，不发请求。

## 时间口径

- 盘中时间戳是**美东挂钟**（官方 `Meta Data` 的 `6. Time Zone: US/Eastern`），按美东折成 UTC 毫秒（EDT = UTC−4，EST = UTC−5，夏令时由 `Intl` 时区数据解出）。
- 日线只有交易日**日期**，取该日期在美东的 **00:00** 作为 `Candle.t`。周线的键是该周最后一个交易日，`Candle.t` 取该日期所在周的**周一** 00:00 美东；月线的键是该月最后一个交易日，取该月 **1 日** 00:00 美东（夏令时按折算后的那一天算）。下游若按「交易日」分组，请按美东日期归组，别按 UTC 日期。

## 已知限制（照实写明，不当成能力）

- **没有买卖价**：`GLOBAL_QUOTE` 只给 `05. price`，所以 `quote()` 的 `bid` 与 `ask` 都等于最新价，**不是真实价差**，别用它估点差、也别用它做模拟撮合的价差依据；`book()` 直接拒绝。
- 标的清单只有 CSV（`LISTING_STATUS`），没有分页参数；`assetType`（Stock / ETF …）放 `Instrument.marketGroup`，`delistingDate` 只用来判 `delisted`。
- 免费档的付费门槛：盘中整个端点（`TIME_SERIES_INTRADAY`）、日线 `outputsize=full`（含带 `from` 的请求）只有付费 key 可用；超限 / 无权限统一按上游失败体返回（含 `premium` → `VENUE_AUTH`，否则按限流），不猜权限。
- 无标记价、无资金费率、无未平仓量（现货行情源本来就没有）。

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；注册由主会话另行完成。

```ts
const conn = new AlphaVantageDataConnector({ fetchImpl, pollMs: 5000 }) // Key 从环境变量读
await conn.start()
const candles = await conn.candles('alphavantage:AAPL', '5m', { n: 100 })
const quote = await conn.refreshQuote('alphavantage:AAPL')
```

测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-alphavantage-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现；假响应的字段名照官方文档手写，未取真网响应）。
