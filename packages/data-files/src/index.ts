// SPDX-License-Identifier: CPAL-1.0
// @gitrader/data-files 入口：本地历史数据文件（K 线 / 资金费）的导入、校验、清单与缺口报告。纯函数 + 可导入的 CLI。
export { sha256Digest, formatFromPath, labelForInterval, guessInterval, findGaps, countOhlcViolations, inspectCandleFile, inspectFundingFile, normalizeCandleFile } from './inspect'
export { manifestFor } from './manifest'
export { resolveDataPath, resolveWithin } from './root'
export { renderReport } from './render'
export { run, runCaptured } from './cli'
export { parseCandleCsv, parseCandleJson, parseFundingCsv, parseFundingJson } from './parse'
export type {
  CandleFileReport,
  FileFormat,
  FileKind,
  FundingFileReport,
  FundingPoint,
  Gap,
  InspectOptions,
  IntervalGuess,
  Io,
  ManifestEntry,
  ManifestInput,
  ParsedCandles,
  PathOptions,
  ParsedFunding,
} from './types'
