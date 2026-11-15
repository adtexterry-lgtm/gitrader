// SPDX-License-Identifier: CPAL-1.0
// 搜索：代码 / 名称 / 别名 → 排序命中的纯函数（无 IO、无缓存、无全局状态）。
//
// 排序语义照 QuantDinger market_symbols_seed.py:search_symbols 的 ORDER BY CASE（Apache-2.0，只读参照，未复制代码）：
//   0 代码精确 → 1 代码前缀 → 2 代码包含 → 3 名称包含 → 4 别名精确 → 5 别名包含 → 6 其他（本包 = 模糊命中）
//   之后 `sort_order DESC, LENGTH(symbol) ASC, symbol ASC`（本包再加上 venue / instrumentId 保证跨场所确定性）。
// 两处「差异」都在注释与 README 里写清：
//   1) QD 那条 SQL 的第 8 个占位符绑的是 prefix_pattern，导致「名称包含但不是前缀」落到 ELSE；
//      本包按注释意图实现（名称包含一律 rank 3）。
//   2) QD 只做 LIKE；本包在 6 档里补了模糊命中（子序列 / 编辑距离 ≤2），可用 `fuzzy: false` 关掉回到纯子串语义。
import type { SymbolIndex, SymbolRecord } from './record'
import { matchesFilter } from './filter'
import type { SymbolFilter } from './filter'

export const MATCH_KINDS = [
  'symbol-exact', 'symbol-prefix', 'symbol-contains', 'name-contains', 'alias-exact', 'alias-contains', 'fuzzy',
] as const
export type MatchKind = (typeof MATCH_KINDS)[number]

export interface SymbolMatch {
  record: SymbolRecord
  /** 0..6，越小越靠前（与 QD 的 CASE 编号一致）。 */
  rank: number
  matchKind: MatchKind
  matchedOn: 'symbol' | 'name' | 'alias'
  /** matchedOn = alias 时命中的那条别名。 */
  alias?: string
}

export interface SearchOptions {
  /** 最多返回几条，缺省 20（QD 的默认 limit）。 */
  limit?: number
  filter?: SymbolFilter
  /** 只要精确 / 前缀命中（自动补全语义）；缺省 false。 */
  prefixOnly?: boolean
  /** 是否允许模糊命中，缺省 true。 */
  fuzzy?: boolean
}

const RANK_OF: Record<MatchKind, number> = {
  'symbol-exact': 0, 'symbol-prefix': 1, 'symbol-contains': 2, 'name-contains': 3,
  'alias-exact': 4, 'alias-contains': 5, fuzzy: 6,
}

/** 命中的字段（排序编号之外，调用方展示「因为代码 / 名称 / 别名命中」时用）。 */
const MATCHED_ON: Record<MatchKind, SymbolMatch['matchedOn']> = {
  'symbol-exact': 'symbol', 'symbol-prefix': 'symbol', 'symbol-contains': 'symbol',
  'name-contains': 'name', 'alias-exact': 'alias', 'alias-contains': 'alias', fuzzy: 'symbol',
}

/** 模糊档的排序编号（rank 6）；它只在前五档一个都没命中时才进结果。 */
const FUZZY_RANK = RANK_OF.fuzzy

/** 归一化：全角转半角（NFKC）+ 去空白 + 大写（QD 的 UPPER(symbol)）。 */
const up = (s: string): string => s.normalize('NFKC').trim().toUpperCase()

/**
 * 「压平」写法：去掉 `/ - _ . 空格 :`。
 * QD 在 crypto 分支把 `/USDT` 与 `/` 去掉再比（symbol_search.py:_search_crypto_exchange），
 * 本包把这个归一化推广到所有符号，于是 `btc/usdt` 能命中 `BTCUSDT`、`brk-b` 能命中 `BRK.B`。
 */
export const flatten = (s: string): string => up(s).replace(/[\s/\-_.:]/g, '')

/** 子序列命中（q 的字符按序出现在 s 里），返回紧凑度 0..1；不命中返回 -1。 */
function subsequenceScore(q: string, s: string): number {
  if (q === '') return -1
  let i = 0
  let first = -1
  let last = -1
  for (let j = 0; j < s.length; j++) {
    if (s[j] === q[i]) {
      if (i === 0) first = j
      i += 1
      last = j
      if (i === q.length) break
    }
  }
  if (i < q.length) return -1
  const span = last - first + 1
  return Math.min(1, q.length / span)
}

/** 有界编辑距离（超过 max 就提前返回 max+1）。 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = new Array<number>(b.length + 1)
  let cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]!
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[b.length]!
}

/** 模糊命中：子序列命中（按紧凑度）或编辑距离 ≤ 2（查询 ≥ 5 个字） / ≤ 1（更短）。返回罚分，越小越好；不命中 -1。 */
export function fuzzyScore(query: string, text: string): number {
  const q = flatten(query)
  const s = flatten(text)
  if (q === '' || s === '') return -1
  const sub = subsequenceScore(q, s)
  if (sub >= 0) return 1 - sub // 0 最好（完全连续）
  const max = q.length >= 5 ? 2 : 1
  const dist = editDistance(q, s, max)
  if (dist <= max) return dist / (max + 1)
  return -1
}

interface Scored {
  match: SymbolMatch
  penalty: number
}

/** 单条记录的命中档位；没有命中返回 undefined。`on` 只对模糊档有意义（说明是代码还是名称撞上的）。 */
export function rankOf(
  record: SymbolRecord,
  query: string,
  opts: { fuzzy?: boolean } = {},
): { kind: MatchKind; alias?: string; penalty: number; on?: 'symbol' | 'name' } | undefined {
  const q = up(query)
  if (q === '') return undefined
  const fq = flatten(q)
  const symbol = up(record.symbol)
  const display = up(record.displaySymbol)
  const name = up(record.name)

  const symbolHit = (): 0 | 1 | 2 | undefined => {
    if (symbol === q || display === q || flatten(symbol) === fq) return 0
    if (symbol.startsWith(q) || display.startsWith(q) || flatten(symbol).startsWith(fq)) return 1
    if (symbol.includes(q) || display.includes(q) || flatten(symbol).includes(fq)) return 2
    return undefined
  }

  const hit = symbolHit()
  if (hit !== undefined) {
    const kind: MatchKind = hit === 0 ? 'symbol-exact' : hit === 1 ? 'symbol-prefix' : 'symbol-contains'
    return { kind, penalty: 0 }
  }

  if (name !== '' && (name.includes(q) || flatten(name).includes(fq))) {
    return { kind: 'name-contains', penalty: 0 }
  }

  let aliasContains: string | undefined
  for (const alias of record.aliases) {
    const a = up(alias)
    if (a === q || flatten(a) === fq) return { kind: 'alias-exact', alias, penalty: 0 }
    if (a.includes(q) || flatten(a).includes(fq)) aliasContains = aliasContains ?? alias
  }
  if (aliasContains !== undefined) return { kind: 'alias-contains', alias: aliasContains, penalty: 0 }

  if (opts.fuzzy !== false) {
    const bySymbol = fuzzyScore(q, record.symbol)
    const byName = name === '' ? -1 : fuzzyScore(q, record.name)
    const best = Math.max(bySymbol, byName)
    if (best >= 0) return { kind: 'fuzzy', penalty: best, on: bySymbol >= byName ? 'symbol' : 'name' }
  }
  return undefined
}

/** 非主市场：有市场组（dex），或显示名里带 `a:b` 前缀。同名同分时主市场排在前面。 */
const isSecondary = (record: SymbolRecord): boolean =>
  (typeof record.marketGroup === 'string' && record.marketGroup.trim() !== '') || record.displaySymbol.includes(':')

/** 稳定排序：rank → 模糊罚分 → 主市场优先 → sortOrder 降序 → 代码长度 → 代码 → 场所 → instrumentId。 */
function compare(a: Scored, b: Scored): number {
  if (a.match.rank !== b.match.rank) return a.match.rank - b.match.rank
  if (a.penalty !== b.penalty) return a.penalty - b.penalty
  const ma = isSecondary(a.match.record) ? 1 : 0
  const mb = isSecondary(b.match.record) ? 1 : 0
  if (ma !== mb) return ma - mb
  if (a.match.record.sortOrder !== b.match.record.sortOrder) return b.match.record.sortOrder - a.match.record.sortOrder
  const la = a.match.record.symbol.length
  const lb = b.match.record.symbol.length
  if (la !== lb) return la - lb
  const sa = a.match.record.symbol.toUpperCase()
  const sb = b.match.record.symbol.toUpperCase()
  if (sa !== sb) return sa < sb ? -1 : 1
  if (a.match.record.venue !== b.match.record.venue) return a.match.record.venue < b.match.record.venue ? -1 : 1
  const ia = a.match.record.instrumentId
  const ib = b.match.record.instrumentId
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

/**
 * 搜索：空查询返回 []（QD 的行为），limit 缺省 20，`prefixOnly` 时只留 rank ≤ 1（自动补全）。
 * 过滤在任何排序前做，命中数按过滤后的集合算。
 */
export function searchSymbols(index: SymbolIndex, query: string, opts: SearchOptions = {}): SymbolMatch[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const requested = opts.limit
  // 非有限数（NaN / Infinity）回落到 20，避免 slice(0, NaN) 之类的空结果
  const limit = Math.max(1, Math.floor(requested !== undefined && Number.isFinite(requested) ? requested : 20))
  const scored: Scored[] = []
  // 缺省就把已下架的标的挡在外面（QD 的 is_active = 1），要看得显式给 includeDelisted
  const filter = opts.filter ?? {}
  for (const record of index.records) {
    if (!matchesFilter(record, filter)) continue
    const hit = rankOf(record, trimmed, { ...(opts.fuzzy !== undefined ? { fuzzy: opts.fuzzy } : {}) })
    if (hit === undefined) continue
    if (opts.prefixOnly === true && hit.kind !== 'symbol-exact' && hit.kind !== 'symbol-prefix') continue
    const match: SymbolMatch = {
      record,
      rank: RANK_OF[hit.kind],
      matchKind: hit.kind,
      matchedOn: hit.kind === 'fuzzy' ? (hit.on ?? 'symbol') : MATCHED_ON[hit.kind],
      ...(hit.alias !== undefined ? { alias: hit.alias } : {}),
    }
    scored.push({ match, penalty: hit.penalty })
  }
  // 模糊只做兜底：只要还有 rank ≤ 5（精确 / 前缀 / 包含 / 名称 / 别名）的命中，就不把「拼错也能撞上」的结果混进来
  const strong = scored.filter((s) => s.match.rank < FUZZY_RANK)
  const kept = strong.length > 0 ? strong : scored
  kept.sort(compare)
  return kept.slice(0, limit).map((s) => s.match)
}

/** 精确查找（QD find_market_symbol：优先精确，找不到才走前缀 / 子串的第一条）。 */
export function findSymbol(index: SymbolIndex, query: string, opts: { filter?: SymbolFilter } = {}): SymbolRecord | undefined {
  const hits = searchSymbols(index, query, { limit: 1, ...(opts.filter !== undefined ? { filter: opts.filter } : {}) })
  return hits[0]?.record
}

/** 自动补全：只回精确 / 前缀命中（缺省 10 条）。 */
export function suggestSymbols(index: SymbolIndex, prefix: string, limit = 10, filter?: SymbolFilter): SymbolMatch[] {
  return searchSymbols(index, prefix, { limit, prefixOnly: true, ...(filter !== undefined ? { filter } : {}) })
}
