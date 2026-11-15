> 许可证：CPAL-1.0。

# @gitrader/connector-deribit-data

Deribit **v2 公共行情**连接器：`DeribitDataConnector implements VenueConnector`。只读数据源，不碰资金。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `deribit data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- 只收**线性（USDC 结算）**合约：`settlement_currency === 'USDC'`（缺失时看 `quote_currency`）的永续 / 交割才进清单；币本位（`settlement_currency` 为标的币，如 `BTC-PERPETUAL` 的 BTC）一律排除。
- `describe()`：`venue 'deribit'`、`environments ['mainnet']`、`instrumentKinds ['perp', 'future']`（协议 `InstrumentKind` 有 `future`，交割合约按它声明）、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 20, 1000}]`、`history {1000, 1000}`、`'x-data-only': true`。

## 端点（基址可注入，缺省 `https://www.deribit.com`）

响应一律是 `{ jsonrpc, result, error? }`；`error` 存在（含 HTTP 4xx）→ `VENUE_UNAVAILABLE`，消息与 `venue.code` 带 `error.code` / `error.message`。

| 方法 | 端点 |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉 `currency=BTC` + `ETH` + `USDC` 三次并合并去重） | `GET /api/v2/public/get_instruments?currency=&kind=future` |
| `candles`（无 `from` 取最近 n 根；有 `from` 按 1000 根 × 周期的毫秒窗口推进到 `to`，最多 200 页，一页不满 1000 根提前停） | `GET /api/v2/public/get_tradingview_chart_data` |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /api/v2/public/ticker` |
| `book`（`depth` 钳到 1..10000） | `GET /api/v2/public/get_order_book` |
| `context`（标记价、指数价、资金费率、未平仓数量（张折币）） | `GET /api/v2/public/ticker` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /api/v2/public/ticker` |

## 数量单位

协议里数量一律用币：`venueSizeUnit` 为 `'base'`。Deribit 清单的 `lot_size` / `min_trade_amount` 与盘口 `amount` 都是以「张」计，一律 × `contract_size` 折成币（如 `BTC_USDC-PERPETUAL` 的 `contract_size = 0.001`：步长 1 张 → `0.001 BTC`，盘口 6000 张 → `6 BTC`）。面值本身留在 `contractSize`（协议 `Instrument` 没有 `x-` 扩展键槽位，不另发 `'x-contract-size'`）。清单尚未缓存（未 `start()`）时盘口拿不到面值，按原值透传。

K 线 `v` 按 Deribit 文档（`public/get_tradingview_chart_data` 的 `volume`）就是基础币数量，直接透传、不再乘面值。ticker 里以张计的数量字段 `open_interest` 在 `context()` 里同样 × `contract_size` 折成币；`best_bid_amount` / `best_ask_amount` / `stats.volume` 不进 `Quote`，`refreshQuote` 只回价格。

## 周期映射

`1m→1 3m→3 5m→5 15m→15 30m→30 1h→60 2h→120 4h→240 12h→720 1d→1D`。
`8h`（Deribit 无 8 小时 resolution）、`3d`、`1w`、`1M` 一律 `INVALID_PARAMS`，不发请求。K 线 `ticks` 已是毫秒，列式转行式后按 `t` 升序去重。有 `from` 翻页时，一页不满 1000 根即视为已到末尾，提前停（不把 200 页上限跑满）。

每次请求前先向注入的 `budget` 要额度（计数模型：一请求 1 次；优先 `RateBudget.acquire`，否则 `take`），成功回 `reportOk`，缺省不限。非 2xx / `error` 信封 → `VENUE_UNAVAILABLE`（retryable；429 / 418 带 `Retry-After` 并 `penalize`）。

```ts
const conn = new DeribitDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('deribit:BTC_USDC-PERPETUAL', '1h', { n: 300 })
const quote = await conn.refreshQuote('deribit:BTC_USDC-PERPETUAL')
const ctx = await conn.context('deribit:BTC_USDC-PERPETUAL')
```

## 注册到内核

内核 CLI 目前把连接器写死为 hyperliquid，本包**尚未接线**；注册与配置装配由主会话另行完成。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-deribit-data`（全离线，HTTP 由注入的 `fetchImpl` 假实现，假基址 `http://deribit.example.test`）。
