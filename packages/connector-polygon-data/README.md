> 许可证：CPAL-1.0。

# @gitrader/connector-polygon-data

Polygon **美股行情**只读连接器：`PolygonDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `polygon data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不下任何单；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'polygon'`、`environments ['mainnet']`、`instrumentKinds ['spot']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{account, count, 5, 60000}]`、`history {50000, 50000}`、`'x-data-only': true`、`'x-book': 'top-of-book'`、`'x-quote': 'nbbo'`、`'x-intervals'`（14 个协议周期全支持）。

## API Key 与免费档限流

- Key 从环境变量 `POLYGON_API_KEY` 读，也可由构造参数 `apiKey` 直接给；都没有 → 构造期抛 `VENUE_AUTH`。鉴权只走 `Authorization: Bearer <key>` **请求头**（官方也支持 `apiKey` query 参数，本包不用它，免得密钥进 URL / 日志），Key 不打印、不进错误信息（错误出口按原文 / base64 形态脱敏）。
- 免费档 **5 次 / 分钟**，含近 2 年历史与分钟聚合（数据为收盘后更新）。超出或无权限时上游给 429 / 403 → 本包分别映射 `VENUE_UNAVAILABLE`（带 `Retry-After`）与 `VENUE_AUTH`（不重试）。
- 每次请求前向注入的 `budget` 要额度（优先 `acquire(weight)`，否则 `take`），成功回调 `reportOk`。

## 主机

Polygon 已更名 Massive（2025-10-30），本包缺省基址改为 `https://api.massive.com`；旧主机 `https://api.polygon.io` 仍可经构造参数 `baseUrl` 指定，过渡期结束后会失效。

## 端点

| 方法 | 端点（`GET https://api.massive.com`） |
| --- | --- |
| `start()` → `listInstruments` / `getInstrument`（按 cursor 翻页，缓存） | `/v3/reference/tickers?market=stocks&active=true&limit=1000&cursor=` |
| `candles` | `/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}?adjusted=true&sort=asc&limit=50000` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}`；快照端点，免费档不含（上游 403 → `VENUE_AUTH`） |
| `book`（一档 NBBO，`depth` 被忽略） | 同上（`lastQuote` 的 `p` / `P` / `s` / `S`）；快照端点，免费档不含（上游 403 → `VENUE_AUTH`） |
| `context` | 同上：`lastTrade.p` → `markPrice`、买卖中价 → `midPrice`、`prevDay.c` → `prevDayPrice`、`day.v × day.vw` → `dayNotionalVolume`；快照端点，免费档不含（上游 403 → `VENUE_AUTH`） |
| `subscribe({channel:'quote'})` | 按 `pollMs`（缺省 5000）轮询快照；快照端点，免费档不含（上游 403 → `VENUE_AUTH`） |

`candles(id, interval, {n, from, to})`：

- 周期映射：14 个协议周期全部可表达（`1m/3m/5m/15m/30m` → `minute`，`1h/2h/4h/8h/12h` → `hour`，`1d/3d` → `day`，`1w` → `week`，`1M` → `month`；multiplier 取协议周期的倍数）。
- 无 `from`：按 `n × 周期长度 × 4 + 7 天` 的回看窗口取一页，再取尾部 `n` 根（`n` 钳到 1..50000，缺省 300）。窗口留四倍余量是给周末与节假日；休市 / 成交稀疏时可能少于 `n` 根，要精确用 `from`。
- 有 `from`：`from` / `to` 以**毫秒时间戳**进路径（官方两种写法都接受）；一页取满 `limit=50000` 就把「最后一根 + 1 ms」当作新 `from` 继续，最多 200 页，每页再按 `[from, to]` 过滤，升序去重。
- **不写死各周期的「最长区间」**：Polygon 文档按 multiplier 给上限，施工时离线没核到确切表，所以改用上面的「翻页推进」；上游若拒绝过长区间，按错误码原样返回（`VENUE_AUTH` / `VENUE_UNAVAILABLE` / `INVALID_PARAMS`）。

## 时间口径

- 聚合 K 线的 `t` 本来就是**毫秒**开盘时间，直接用。
- 快照的 `updated` / `lastTrade.t` / `lastQuote.t` 是**纳秒**，解析处 ÷ 1e6 折成毫秒（纳秒 epoch 超过 2^53，靠 round 到毫秒消掉 JSON 往返的误差）；报价的 `ts` 优先取 `lastQuote.t`，其次 `lastTrade.t`，最后 `updated`。
- `StampedQuote.ageMs` 按**本地拉取时刻**算（不是上游时间戳），与其它只读行情包一致。

## 已知限制（照实写明，不当成能力）

- 只有最优一档（NBBO），没有 L2 深度；`book()` 的 `depth` 参数被忽略，某一侧没有数量就留空。
- 标的清单只收 `market: "stocks"`、`locale: "us"` 的行（外汇 / 加密 / 期权是别的端点）；`primary_exchange`（XNAS / XNYS …）放 `Instrument.marketGroup`。
- `start()` 会按 `instrumentPages`（缺省 100 页 × 1000 支）翻清单；免费档 5 次/分钟，标的很多时首启会耗时较久，可把 `instrumentPages` 调小，或直接 `getInstrument()` 用已知代码。
- 无标记价、无资金费率、无未平仓量（现货行情源本来就没有）。

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；注册由主会话另行完成。

```ts
const conn = new PolygonDataConnector({ fetchImpl, pollMs: 5000 }) // Key 从 POLYGON_API_KEY 读
await conn.start()
const candles = await conn.candles('polygon:AAPL', '1m', { from, to })
const quote = await conn.refreshQuote('polygon:AAPL')
```

测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-polygon-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现；假响应的字段名照官方文档手写，未取真网响应）。
