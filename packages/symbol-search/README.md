> 许可证：CPAL-1.0。

# @gitrader/symbol-search

跨**已注册数据连接器**的标的搜索：纯函数，无 IO、无网络、无全局状态、无第三方依赖。输入是一组 `Instrument`（或若干个只读连接器的 `listInstruments()`），输出排好序的命中。

## 用它做什么

- 搜索框 / 自选股：按代码、名称、别名搜，按市场类型 / 场所 / 资产类别 / 报价货币过滤。
- 自动补全：只要精确与前缀命中（`suggestSymbols`）。
- 挑选校验：把一条记录当作「要加自选 / 要下单」的目标，按 QD 自选的四条规则判（`validateSelection`）。

## 语义出处（Apache-2.0，只借鉴语义，未复制代码）

参照 QuantDinger `backend_api_python/app/services/market/symbol_search.py`、
`app/data/market_symbols_seed.py:search_symbols`、`app/services/market/watchlist.py`：

| 参照的行为 | 本包对应 |
| --- | --- |
| 去重键 `(market, symbol, exchange_id, market_type, instrument_id)`，缺 market / symbol 的记录丢弃 | `dedupeKey` = `(venue, 大写 symbol, kind, instrumentId)`；`recordOf` 丢弃缺 symbol / venue 的记录 |
| 排序 `CASE 0 代码精确 / 1 代码前缀 / 2 代码包含 / 3 名称包含 / 4 别名精确 / 5 别名包含 / 6 其他`，再 `sort_order DESC, LENGTH(symbol) ASC, symbol ASC` | 同 0..5 档 + 第 6 档 = 模糊命中；再 `sortOrder` 降序、代码长度升序、代码、场所、instrumentId |
| crypto 分支把 `/USDT` 与 `/` 去掉再比 | `flatten()`：去掉 `/ - _ . 空格 :` 后比较，于是 `btc/usdt` 命中 `BTCUSDT`、`brk-b` 命中 `BRK.B` |
| `is_active = 1`（默认不含下架） | 缺省过滤 `status === 'delisted'`，要看得显式 `includeDelisted: true` |
| `validate_watchlist_pair`：空 symbol / 六位数字必须是 A 股 / `.HK` 必须是港股 / Crypto 必须是 BASE-QUOTE 对 | `validateSelection`：`EMPTY_SYMBOL` / `CN_CODE_NOT_STOCK` / `HK_CODE_NOT_STOCK` / `CRYPTO_NOT_A_PAIR`（我们没有「市场名」，改用 assetClass 与 quote 货币判） |

两处**有意偏离**（都写在这里，别当成参照的照抄）：

1. QD 那条排序 SQL 的第 8 个占位符绑的是 `prefix_pattern`，导致「名称包含但不是前缀」落到 ELSE；本包按注释意图实现（名称包含一律第 3 档）。
2. QD 只有 `LIKE`；本包多一档模糊（子序列 / 编辑距离 ≤2），并且**只作兜底**：只要还有前五档命中，就不把模糊结果混进列表。`searchSymbols(index, q, { fuzzy: false })` 可完全关掉。

## API

```ts
import { indexFromConnectors, searchSymbols, suggestSymbols, findSymbol, validateSelection } from '@gitrader/symbol-search'

// 已注册的只读数据连接器（它们自己负责 start()；本包不替任何人发请求）
const index = indexFromConnectors([binanceData, polygonData], {
  aliases: { 'polygon:AAPL': ['苹果', 'AAPL.US'] },   // instrumentId → 别名
  sortOrder: { 'binance:BTCUSDT': 10 },              // instrumentId → 权重（QD 的 sort_order）
})

searchSymbols(index, 'btc', { limit: 10, filter: { kinds: ['perp'], quote: 'USDT' } })
// → [{ record, rank: 1, matchKind: 'symbol-prefix', matchedOn: 'symbol' }, …]

suggestSymbols(index, 'aapl', 5)          // 只回精确 / 前缀
findSymbol(index, 'apple')                // 第一条命中的记录（QD find_market_symbol）
validateSelection(record)                 // undefined = 可以挑；否则 { code, message }
```

- `buildIndex({ instruments, source?, aliases?, names?, sortOrder? })`：单个连接器的一次清单 → 索引。
- `mergeIndexes([...])`：多份索引合并去重；`indexFromConnectors([...])`：一次搞定。
- `searchSymbols(index, query, { limit = 20, filter, prefixOnly, fuzzy })`：空查询 / 纯空白返回 `[]`（QD 行为）。
- `SymbolFilter`：`venues` / `kinds` / `assetClass` / `quote` / `sources` / `includeDelisted`，单值或数组都行，`quote` 大小写不敏感。
- `SymbolRecord` 只带展示与过滤需要的字段（无价格），所以索引可以长期缓存，行情另取。

## 边界

- 不读文件、不联网、不读环境变量、不 `start()` 连接器；连接器是否已 `start()` 由调用方保证（未 start 就是空清单，本包不替它拉）。
- 不做拼音 / 中文分词：中文名靠调用方以别名注入（`aliases`），本包只做大写化与 `flatten` 归一化。
- 不做排序持久化：权重由调用方给（QD 存在数据库里）。

测试：`node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/symbol-search`（全离线、无 IO）。
