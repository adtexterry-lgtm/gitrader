> 许可证：CPAL-1.0。

# @gitrader/connector-gateio-data

Gate.io v4 USDT 永续**公共行情**连接器：`GateioDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `gateio data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'gateio'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 200, 10000}]`、`history {maxCandles 2000, pageLimit 2000}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://api.gateio.ws`，前缀 `/api/v4/futures/usdt`）

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /api/v4/futures/usdt/contracts` |
| `candles`（无 `from`：`limit=n`，n ≤ 2000，缺省 300） | `GET /api/v4/futures/usdt/candlesticks?contract=&interval=&limit=` |
| `candles`（有 `from`：`from=cursor`（+`to`）翻页，每页 ≤ 2000 根，最多 200 页） | 同上，**不带 `limit`** |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /api/v4/futures/usdt/tickers?contract=` |
| `book`（`limit` 钳到 1..100，缺省 20） | `GET /api/v4/futures/usdt/order_book?contract=&limit=` |
| `context`（标记价 / 资金费率 / 持仓量 / 资金间隔 / 下次资金时间） | `GET /api/v4/futures/usdt/tickers?contract=`（资金字段取合约清单） |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /api/v4/futures/usdt/tickers?contract=` |

**翻页口径**：Gate.io 的 `/candlesticks` 不允许 `limit` 与 `from`/`to` 同时出现（400 `INVALID_PARAM_VALUE`，真网 2026-10-20 复核）。所以区间模式只发 `from`（+可选 `to`），一页最多 2000 根，游标推到本页最新一根 + 一个周期，直到越过 `to`、不满一页、无进展或满 200 页。上游会把 `from` 向下对齐到所在 K 线（可能多给一根早于 `from` 的），本连接器按 `t >= from` 再过滤一次。

**时间与顺序**：K 线 `t` 上游是**秒**，统一 ×1000 成开盘毫秒；上游升序，这里仍按 `t` 排序去重。`v` 上游是**张数**，按 `quanto_multiplier` 折成**币数量**再返回（合约清单未加载时先拉一次清单）。

**标的映射**：`name → gateio:<name>`（原生下划线原样保留，如 `gateio:BTC_USDT`）；`order_price_round → price.tick`；数量一律用**币数量**：`size.step = quanto_multiplier`（一张即一个步长）、`size.min = order_size_min（张）× quanto_multiplier`（为 0 / 缺失回落一张），`quanto_multiplier → contractSize`（每张多少个标的币，留作展示）、`venueSizeUnit: 'base'`；`funding_interval`（秒）→ `fundingIntervalMs`、`funding_next_apply`（秒）→ `context()` 的 `nextFundingTime`；`leverage_max → maxLeverage`。`in_delisting === true` 的条目**整体丢弃**（`includeDelisted` 也拿不到）。

**盘口单位**：`/order_book` 的 `s` 是张数，按合约清单里的 `quanto_multiplier` 折成币数（清单未加载时先拉一次；清单里没有该标的时按 1 处理，即原样张数）。`context` 的 `openInterest` 由 `total_size`（张）× `quanto_multiplier` 得到。

**资金字段**：`context()` 的 `fundingIntervalMs` 取合约清单的 `funding_interval`（秒 → 毫秒），`nextFundingTime` 取 `funding_next_apply`（秒 → 毫秒）。协议 `MarketContext` 暂无「下次资金时间」字段，这里以扩展字段 `nextFundingTime` 一并返回，其余字段语义不变。

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，退而 `take(weight)`，权重恒 1），成功后 `reportOk()`，缺省不限。HTTP 非 2xx（Gate.io 的业务错误也是非 2xx + `{label, message}`）→ `VENUE_UNAVAILABLE`（retryable，`venue.code` 带 label；429 带 `Retry-After`）。

```ts
const conn = new GateioDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('gateio:BTC_USDT', '1h', { n: 300 })
const quote = await conn.refreshQuote('gateio:BTC_USDT')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；把 `GateioDataConnector` 注册进连接器表的改动由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-gateio-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现）。
