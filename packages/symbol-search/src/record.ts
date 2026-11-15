// SPDX-License-Identifier: CPAL-1.0
// 标的索引：把已注册数据连接器的 Instrument 清单收成可搜索的扁平记录（纯函数，无 IO、无状态）。
//
// 语义参照 QuantDinger 的 symbol_search.py / watchlist.py（Apache-2.0；本包只借鉴语义，不复制代码）：
//   - 去重键 `(market, symbol, exchange_id, market_type, instrument_id)`（symbol_search.py:dedupe_symbol_results）
//     → 这里等价于 `(venue, symbol 大写, kind, instrumentId)`：同一交易所 / 市场类型 / 标的只留一条。
//   - 缺 market 或 symbol 的记录丢弃（同上），不做「猜一个」。
//   - 展示名取名字（我们放在 Instrument.underlying.description），别名单独给（QD 用 qd_market_symbol_aliases 表，
//     这里由调用方以 instrumentId → 别名数组注入，保持纯函数）。
//   - sort_order 权重（QD 表上的排序列，越大越靠前）在这里是记录上的 sortOrder，缺省 0。
// 出处：参照仓库 backend_api_python/app/services/market/symbol_search.py 与 market_symbols_seed.py
// （Apache-2.0；只读参照，未复制代码）。
import type { AssetClass, Instrument, InstrumentKind, InstrumentStatus } from '@gitrader/protocol'

/** 一条可搜索的标记录（只有展示与过滤需要的字段，不带价格）。 */
export interface SymbolRecord {
  instrumentId: string
  venue: string
  /** 场所原生符号，原样保留大小写。 */
  symbol: string
  displaySymbol: string
  /** 展示名；没有就是空串（不编造）。 */
  name: string
  /** 别名（中文名、旧代码、常见简写等由调用方给）。 */
  aliases: readonly string[]
  kind: InstrumentKind
  assetClass: AssetClass
  quote: string
  settle: string
  status: InstrumentStatus
  /** 场所内子市场（交易所代码 / assetType），没有就 null。 */
  marketGroup: string | null
  /** 排序权重（对应 QD 的 sort_order，越大越靠前）。 */
  sortOrder: number
  /** 这份记录来自哪个数据连接器（同一 venue 有多个连接器时用来区分）。 */
  source: string
}

/** 建索引的输入：一个连接器的一次标的清单 + 可选的展示名 / 别名 / 权重覆盖。 */
export interface SymbolIndexInput {
  instruments: readonly Instrument[]
  /** 连接器名；缺省取 instrument.venue。 */
  source?: string
  /** instrumentId → 别名数组。 */
  aliases?: Record<string, readonly string[]>
  /** instrumentId → 展示名（覆盖 underlying.description）。 */
  names?: Record<string, string>
  /** instrumentId → 排序权重（对应 QD 的 sort_order）。 */
  sortOrder?: Record<string, number>
}

export interface SymbolIndex {
  readonly records: readonly SymbolRecord[]
  readonly byInstrumentId: ReadonlyMap<string, SymbolRecord>
  /** 参与建索引的连接器名（去重、升序）。 */
  readonly sources: readonly string[]
}

/** 只读连接器的最小形状（不依赖 VenueConnector 的全部方法，方便测试与其它数据源复用）。 */
export interface ConnectorLike {
  readonly venue: string
  listInstruments(opts?: { includeDelisted?: boolean }): Instrument[]
}

/** `Instrument` → `SymbolRecord`（缺 symbol / venue 的返回 undefined：QD 同样丢弃这类记录）。 */
export function recordOf(instrument: Instrument, source: string, extra: {
  aliases?: Record<string, readonly string[]>
  names?: Record<string, string>
  sortOrder?: Record<string, number>
} = {}): SymbolRecord | undefined {
  const symbol = typeof instrument.symbol === 'string' ? instrument.symbol.trim() : ''
  const venue = typeof instrument.venue === 'string' ? instrument.venue.trim() : ''
  if (symbol === '' || venue === '') return undefined
  const name = extra.names?.[instrument.instrumentId] ?? instrument.underlying?.description ?? ''
  return {
    instrumentId: instrument.instrumentId,
    venue,
    symbol,
    displaySymbol: instrument.displaySymbol !== '' ? instrument.displaySymbol : symbol,
    name: name.trim(),
    // 存拷贝：调用方事后改自己的数组，不影响索引
    aliases: [...(extra.aliases?.[instrument.instrumentId] ?? [])],
    kind: instrument.kind,
    assetClass: instrument.assetClass,
    quote: instrument.quote,
    settle: instrument.settle,
    status: instrument.status,
    marketGroup: instrument.marketGroup ?? null,
    sortOrder: extra.sortOrder?.[instrument.instrumentId] ?? 0,
    source,
  }
}

/** QD dedupe 键的等价物：(venue, SYMBOL, kind, instrumentId)。 */
export function dedupeKey(record: SymbolRecord): string {
  return `${record.venue}|${record.symbol.normalize('NFKC').toUpperCase()}|${record.kind}|${record.instrumentId}`
}

/** 一组记录 → 去重后的记录（同键保留先出现的，等价 QD 的「先到先留」）。 */
export function dedupeRecords(records: readonly SymbolRecord[]): SymbolRecord[] {
  const seen = new Set<string>()
  const out: SymbolRecord[] = []
  for (const record of records) {
    const key = dedupeKey(record)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(record)
  }
  return out
}

function indexOf(records: readonly SymbolRecord[], sources: readonly string[]): SymbolIndex {
  const byInstrumentId = new Map<string, SymbolRecord>()
  for (const record of records) if (!byInstrumentId.has(record.instrumentId)) byInstrumentId.set(record.instrumentId, record)
  return {
    records,
    byInstrumentId,
    sources: [...new Set(sources)].sort(),
  }
}

/** 单个连接器的标的清单 → 索引。 */
export function buildIndex(input: SymbolIndexInput): SymbolIndex {
  const records: SymbolRecord[] = []
  for (const instrument of input.instruments) {
    // source 缺省取 instrument.venue：一个连接器通常只给一个场所，但同一个 index 里混了多个场所时也不会张冠李戴
    const record = recordOf(instrument, input.source ?? instrument.venue, input)
    if (record) records.push(record)
  }
  const deduped = dedupeRecords(records)
  return indexOf(deduped, deduped.map((r) => r.source))
}

/** 多份索引合并（跨连接器）并去重；sources 取并集。 */
export function mergeIndexes(indexes: readonly SymbolIndex[]): SymbolIndex {
  const records: SymbolRecord[] = []
  const sources: string[] = []
  for (const index of indexes) {
    records.push(...index.records)
    sources.push(...index.sources)
  }
  return indexOf(dedupeRecords(records), sources)
}

/**
 * 已注册数据连接器数组 → 一份跨场所索引（同步调它们的 listInstruments，不联网、不 start）。
 * 连接器各自 start() 由调用方负责：本包不替调用方发请求，也不缓存行情。
 */
export function indexFromConnectors(
  connectors: readonly ConnectorLike[],
  opts: {
    includeDelisted?: boolean
    aliases?: Record<string, readonly string[]>
    names?: Record<string, string>
    sortOrder?: Record<string, number>
  } = {},
): SymbolIndex {
  const indexes: SymbolIndex[] = []
  for (const connector of connectors) {
    const instruments = connector.listInstruments({ includeDelisted: opts.includeDelisted === true })
    indexes.push(buildIndex({
      instruments,
      source: connector.venue,
      ...(opts.aliases !== undefined ? { aliases: opts.aliases } : {}),
      ...(opts.names !== undefined ? { names: opts.names } : {}),
      ...(opts.sortOrder !== undefined ? { sortOrder: opts.sortOrder } : {}),
    }))
  }
  return mergeIndexes(indexes)
}
