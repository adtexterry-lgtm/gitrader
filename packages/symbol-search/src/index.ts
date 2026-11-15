// SPDX-License-Identifier: CPAL-1.0
// 包入口：标的索引 / 搜索 / 过滤 / 挑选校验（全部纯函数，无 IO、无网络、无全局状态）。
export {
  buildIndex, dedupeKey, dedupeRecords, indexFromConnectors, mergeIndexes, recordOf,
} from './record'
export type { ConnectorLike, SymbolIndex, SymbolIndexInput, SymbolRecord } from './record'
export { MATCH_KINDS, findSymbol, flatten, fuzzyScore, rankOf, searchSymbols, suggestSymbols } from './search'
export type { MatchKind, SearchOptions, SymbolMatch } from './search'
export { SELECTION_PROBLEM_CODES, matchesFilter, normalizeSymbol, validateSelection } from './filter'
export type { SelectionProblem, SelectionProblemCode, SymbolFilter } from './filter'
