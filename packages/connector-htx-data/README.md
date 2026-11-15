> 许可证：CPAL-1.0。

# @gitrader/connector-htx-data

HTX（原火币）**USDT 本位永续公共行情**连接器：`HtxDataConnector implements VenueConnector`。只读数据源，不碰资金。
端点、字段、K 线周期与分页上限一律照 HTX 官方 USDT-M 合约 API v1 文档（<https://huobiapi.github.io/docs/usdt_swap/v1/en/>，2026-10-21 查阅），源码里逐端点注释了对应节名。

## 边界

- 只读：`submit / cancel / cancelAll / amend / setLeverage / scheduleCancel` 与 `accountState / openOrders / fills / orderStatus / startupSnapshot` 一律同步抛 `CAPABILITY_UNSUPPORTED`（消息 `htx data connector is read-only`），不联网。
- 无 WebSocket、无私有端点、不需要 API Key；`status().source` 恒为 `'rest'`。
- `describe()`：`venue 'htx'`、`environments ['mainnet']`、`instrumentKinds ['perp']`、orderTypes 全 `'none'`、`tif []`、`triggerPriceTypes []`、`rateLimits [{ip, count, 800, 1000}]`、`history {maxCandles 2000, pageLimit 2000}`、`'x-data-only': true`。
- 只做 USDT / USDC 结算的**线性永续**；币本位（反向）合约走另一套 coin-swap 主机，本包不碰。

## 端点（基址可注入，缺省 `https://api.hbdm.com`）

| 方法 | 端点（官方节名） |
| --- | --- |
| `listInstruments` / `getInstrument`（`start()` 拉一次并缓存） | `GET /linear-swap-api/v1/swap_contract_info?business_type=swap&contract_type=swap`（§Query Swap Info） |
| `candles`（无 `from`：`size=n`，n ≤ 2000，缺省 300） | `GET /linear-swap-ex/market/history/kline`（§Get KLine Data） |
| `candles`（有 `from`：`from`/`to` 秒级窗口翻页，一页 ≤ 2000 根，最多 200 页） | 同上，**不带 `size`** |
| `refreshQuote` / `quote`（`quote` 只读缓存，未拉过返回 `undefined`） | `GET /linear-swap-ex/market/detail/merged?contract_code=`（§Get Market Data Overview） |
| `book`（≤20 档用 `type=step6`，更多用 `step0`） | `GET /linear-swap-ex/market/depth?contract_code=&type=`（§Get Market Depth） |
| `context`（标记价 / 资金费率 / 下次资金时间） | `GET /index/market/history/linear_swap_mark_price_kline?period=1min&size=1` + `GET /linear-swap-api/v1/swap_funding_rate?contract_code=` |
| `subscribe({channel:'quote'})`（按 `pollMs` 轮询，缺省 5000） | `GET /linear-swap-ex/market/detail/merged?contract_code=` |

**K 线周期**：官方 period 只有 `1min, 5min, 15min, 30min, 60min, 1hour, 4hour, 1day, 1mon`，映射 `1m→1min / 5m→5min / 15m→15min / 30m→30min / 1h→60min / 4h→4hour / 1d→1day / 1M→1mon`；`3m / 2h / 8h / 12h / 3d / 1w` 不在官方表内，调用即 `INVALID_PARAMS`（不发请求）。

**翻页口径**：官方要求 `from` 与 `to` 同时给（秒），且「`from`、`to`、`size` 三者都填时 `from`/`to` 会被忽略」「一次最多 2000 根」，所以区间模式只发 `from`+`to`，按每段 ≤2000 根切窗口逐段请求；官方注明该接口大致只能取最近两年，更早的区间会返回空页，按空页结束。

**时间与数量单位**：K 线 `id` 是**秒**，统一 ×1000 成开盘毫秒；成交量优先取「以币计」的 `amount`（Trade Amount(Coin)），缺失时用 `vol`（张）× 每张面值。盘口 `vol` 是**张数**，同样折成币数后返回（`venueSizeUnit: 'base'`）。面值 `contract_size` 的语义按官方 K 线示例反推并交叉核对：`vol=4` 张、`amount=0.004` 币、`trade_turnover=52.3072`＝4 × 0.001 × 13076.8，即 1 张 = 0.001 BTC（官方字段表把 `contract_size` 写成「Contract Value (USDT of one contract)」，与示例数字不符，这里以可验算的示例为准，REPORT 已记）。

**标的映射**：`contract_code → htx:<contract_code>`（原生连字符原样保留，如 `htx:BTC-USDT`）；`price_tick → price.tick`；数量一律用币数量：`size.step = size.min = contract_size`（一张即一个步长；官方公开接口没有「最小下单张数」，按一张算）、`contractSize` 留作展示；`contract_status`：1 → `trading`，0/5/6/7/8 → `delisted`，其余（2/3/4 及未知）→ `halted`。

**资金与标记价**：`context()` 的 `fundingRate` 取 `swap_funding_rate.data.funding_rate`，`nextFundingTime`（扩展字段，协议 `MarketContext` 暂无此字段）取 `next_funding_time`，`fundingIntervalMs` 固定 8 h（官方示例 `funding_time` → `next_funding_time` 差 28 800 000 ms）。HTX 没有公开的 REST 实时标记价端点（只有标记价 K 线与 WS），所以 `markPrice` 取最新 1 分钟标记价 K 线的收盘价，**最多落后 1 分钟**；拿不到时留协议缺省 0，不拿指数价冒充标记价。

每次请求前先向注入的 `budget` 要额度（优先 `acquire(weight)`，退而 `take(weight)`，权重恒 1），成功后 `reportOk()`，缺省不限。HTTP 非 2xx **或** HTX 的业务错误（HTTP 200 + `status:"error"` + `err_code/err_msg`）一律转成异常，`venue.code` 带官方 `err_code`、`venue.message` 带 `err_msg`；业务错误按官方码表分类：1013 / 1014（合约不存在）→ `INSTRUMENT_UNKNOWN`、1030 Input error / 1033 Incorrect field of contract period → `INVALID_PARAMS`（两者都 `retryable: false`），1032 访问超限 → `VENUE_RATE_LIMITED`（`retryable: true`、`retryAfterMs: 3000` 并 `penalize(3000)`），其余码与无码仍为 `VENUE_UNAVAILABLE`（retryable）；HTTP 429 带 `Retry-After`。

```ts
const conn = new HtxDataConnector({ fetchImpl, budget, pollMs: 5000 })
await conn.start()
const candles = await conn.candles('htx:BTC-USDT', '1h', { n: 300 })
const quote = await conn.refreshQuote('htx:BTC-USDT')
```

## 夹具与测试

测试全离线：HTTP 由注入的 `fetchImpl` 假实现提供（`test/helpers/fake-htx.ts`），**不 import 客户端 src**，按官方文档独立实现参数校验（period 取值、`from` 必须与 `to` 同用、`size ∈ [1,2000]`）与错误信封（1030 / 1033 / 1013）。应答字段取自官方文档 Response 示例（K 线、市场概览、盘口、资金费率、标记价 K 线），只把示例时间戳换成固定「现在」；没有抓过真网响应，字段以文档为准。

## 注册到内核

本包**尚未接线**：内核 CLI 的第一方连接器表在 `packages/cli/src/connectors.ts` 的 `CONNECTOR_FACTORIES`（`id` → 工厂）。接 HTX 只需在该表加一条 `{ id: 'htx', kind: 'data', create … }` 并在 `packages/cli/package.json` 加本包的工作区依赖——两处都在本标段边界之外，由主会话另行施工，本包不改已有文件。测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/connector-htx-data`。
