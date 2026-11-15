> 许可证：CPAL-1.0。

# tools/data · 历史数据工具链

把某个交易所某个标的的 K 线拉成本地文件（`@gitrader/data-files` 的规范 JSON + sha256 清单），回测直接吃。
两个脚本：`fetch-candles.mjs`（会联网，拉数据）与 `inspect.mjs`（不联网，看文件）。

只用 Node 标准库 + 本仓工作区包，没有第三方依赖；需要默认开启 TypeScript 类型擦除的 Node（22.18 起）。
Node 22.13–22.17 请用 `node --experimental-strip-types tools/data/fetch-candles.mjs …`（`lib/ts-shim.mjs` 只补解析，靠 Node 自带类型擦除执行 `.ts`）。

## fetch-candles.mjs

```bash
node tools/data/fetch-candles.mjs \
  --venue binance --instrument BTCUSDT --interval 1h \
  --from 2024-01-01 --to 2024-03-01 \
  --out data/binance-btcusdt-1h.json
```

| 参数 | 说明 |
|---|---|
| `--venue` | `binance` `bitget` `bybit` `coinbase` `deribit` `dydx` `gateio` `kraken` `kucoin` `okx` |
| `--instrument` | 场所原生符号（`BTCUSDT` / `BTC-USDT-SWAP` …），或完整 id（`binance:BTCUSDT`，前缀必须与 `--venue` 一致） |
| `--interval` | `1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M`（名单来自 `@gitrader/protocol/constants` 的 `CANDLE_INTERVALS`） |
| `--from` / `--to` | Unix 毫秒，或 `2024-01-01` / `2024-03-01T00:00:00Z` 这类文本；`--to` 缺省 = 现在；区间含两端 |
| `--out` | 规范 JSON 路径（必须 `.json`） |
| `--max-pages` | 本工具在连接器之上的续拉调用次数上限，缺省 200（连接器一次 `candles()` 调用内部还会自己翻页，见「分页口径」） |

退出码：`0` 成功（含「区间内没有 K 线」与 `--max-pages` 到顶的截断——文件照样写、stderr 给 warn），
`1` 拉取 / 落盘失败，`2` 用法错误。

### 产出三件

以 `--out data/btcusdt-1h.json` 为例：

- `data/btcusdt-1h.csv` —— 原文，表头 `t,o,h,l,c,v`，一行一根，便于肉眼核对；
- `data/btcusdt-1h.json` —— `{ "candles": [{t,o,h,l,c,v}, …] }`，由 `normalizeCandleFile` 写出（升序、按 `t` 去重）；
- `data/btcusdt-1h.manifest.json` —— 清单，`files[]` 就是 `BacktestSpec.data.files` 的形状：

```json
{
  "version": 1,
  "source": { "venue": "binance", "instrumentId": "binance:BTCUSDT", "instrument": "BTCUSDT",
              "interval": "1h", "from": 1704067200000, "to": 1709251200000,
              "requestedPages": 200, "truncated": false, "pageLimit": 1500, "maxCandles": 1500 },
  "candles": 1417,
  "quality": { "rows": 1418, "parsed": 1417, "duplicates": 0, "skipped": 0, "gaps": 0, "ohlcViolations": 0, "warnings": [] },
  "files": [{ "path": "<绝对路径>", "kind": "candles", "format": "json", "sha256": "sha256:…", "bytes": 180235 }]
}
```

`sha256` 与 `@gitrader/data-files` 的 `manifestFor` 同口径（`sha256:<hex>`，对文件字节算），回测装载时按它校验。

### 会访问哪些主机（只在你显式运行本脚本时）

只发 `GET`，只取公共行情，不带任何密钥，不碰账户 / 下单接口：

| venue | 主机 |
|---|---|
| binance | `fapi.binance.com` |
| bitget | `api.bitget.com` |
| bybit | `api.bybit.com` |
| coinbase | `api.coinbase.com` |
| deribit | `www.deribit.com` |
| dydx | `indexer.dydx.trade` |
| gateio | `api.gateio.ws` |
| kraken | `futures.kraken.com` |
| kucoin | `api-futures.kucoin.com` |
| okx | `www.okx.com` |

交易所可能在响应里指到别的 CDN / 备份域（重定向或分页 URL 由各连接器自己处理）。`inspect.mjs` 与全部测试**不联网**。

### 分页口径

分页由 `packages/connector-<venue>-data` 的只读连接器负责：`candles(id, interval, { from, to })`
（签名见 `packages/connector-binance-data/src/market.ts:261`），单页上限取各包 `describe().history.pageLimit`
（binance 1500 / gateio 2000 / kraken 5000 / okx 100 / kucoin 200 …）。

本工具在连接器之上再做一层续拉兜底：游标 = 本页末根开盘时间 + 周期，本页为空 / 游标不前进 / 越过 `--to` 即停，
续拉调用次数硬上限 `--max-pages`（缺省 200）。用满仍未停时返回值与清单的 `source.truncated` 为 `true`，
CLI 往 stderr 写一行 warn（退出码仍 `0`），文件可能没拉到 `--to`。结果统一按 `t` 去重升序。

「翻页硬上限」有两层：连接器一次 `candles()` 调用内部自己会翻页（binance 等包内上限 200 页，
见 `packages/connector-binance-data/src/market.ts:19`）；`--max-pages` 限的是本工具在连接器之上的**续拉调用次数**。

`1M` 是日历月、没有固定毫秒，月线续拉游标取「末根开盘时间 + 1 ms」（从末根之后开始），
避免按固定毫秒推进时在页边界漏掉整月；最终仍按 `t <= --to` 过滤。

## inspect.mjs

`@gitrader/data-files` 的 `run(argv)` 薄封装（不联网、不改文件，`normalize` 除外）：

```bash
node tools/data/inspect.mjs inspect data/btcusdt-1h.json        # 行数 / 周期 / 缺口 / 重复 / ohlc 违规
node tools/data/inspect.mjs manifest data/btcusdt-1h.json      # 绝对路径 + sha256 + format + kind
node tools/data/inspect.mjs normalize raw.csv out.json         # 规范 JSON
node tools/data/inspect.mjs --help
```

退出码与 `run` 一致：`0` 成功，`2` 用法 / 读文件 / 格式错误。参数细节见 `packages/data-files/README.md`。

## 测试（离线）

```bash
node --test tools/data/test/*.test.mjs
# 或在 tools/data 目录下：node --test
```

39 例：参数校验 / 分页拼接（含 1M 续拉与 `maxPages` 到顶）/ 落盘格式 / manifest sha256 / 10 个连接器注册表 / CLI 退出码。
全部用假连接器与临时目录，不联网、不读仓库外的真实数据。

> 注意：在 `tools/data` 目录下直接 `node --test` 会把 `helpers.mjs` 也当测试文件，多计 1 个（40 例）。

> 注意：本机 Node 22.23 的测试运行器不接「目录参数」（`node --test tools/data/test/` 会把目录当模块解析并报
> `Cannot find module`，对任何目录都一样，与本目录无关）。用上面的 glob 形式或在该目录下直接 `node --test`。

## 实现说明

- `lib/ts-shim.mjs`：解析钩子。仓库里的包都按 tsc 口径写源码（相对导入不带扩展名、`schemas/*.json` 裸导入），
  普通 `node` 直接 import 会失败。钩子只补解析（`.ts` / `/index.ts` / `.js` / 目录、`.json` 补 `type: 'json'`），
  不做转译、不改源码，靠 Node 22 自带的类型擦除执行 `.ts`。所以不构建 `dist` 也能用，也就不用引第三方运行器。
- `lib/venues.mjs`：venue → 连接器类的注册表（含基址），连接器只读（`describe()['x-data-only'] === true`、下单能力全 `none`）。
- `lib/fetch-candles.mjs`：续拉 + 落盘 + 清单。`lib/cli.mjs`：参数 → 摘要，返回退出码（不 `process.exit`，便于测试直接调）。
- 本目录没有任何下单路径、不读密钥、不写仓库外文件（除 `--out` 指定的位置）。
