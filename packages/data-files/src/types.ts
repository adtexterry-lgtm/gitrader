// SPDX-License-Identifier: CPAL-1.0
// 报告结构（纯数据）。字段语义见 README「报告字段」。
import type { Candle } from '@gitrader/protocol/types'

export type FileFormat = 'csv' | 'json'
export type FileKind = 'candles' | 'funding'

/** 资金费点：t = 结算时间（毫秒），rate = 该期费率。 */
export interface FundingPoint {
  t: number
  rate: number
}

/** 解析结果：candles 与引擎 parseCsv / parseJson 同长，计数只用于报告。 */
export interface ParsedCandles {
  rows: number
  header: boolean
  candles: Candle[]
  duplicates: number
  skipped: number
}

export interface ParsedFunding {
  rows: number
  header: boolean
  points: FundingPoint[]
  duplicates: number
  skipped: number
  /** JSON 不是数组 / {points:[]} / 无法解析时为 true（引擎此时返回空数组）。 */
  invalid?: boolean
}

/** 由相邻 t 差众数推断出的周期。label 对齐 protocol 的 CANDLE_INTERVALS，对不上为 null（"1M" 无固定毫秒）。 */
export interface IntervalGuess {
  /** 众数间隔（毫秒）。 */
  ms: number
  /** CANDLE_INTERVALS 里的名字；无法对齐为 null。 */
  label: string | null
  /** 众数占比（0–1）。 */
  confidence: number
}

/** 缺口：from / to 是缺失 K 线的开盘时间（含两端，均为推断值），missing = 缺几根。 */
export interface Gap {
  from: number
  to: number
  missing: number
}

export interface CandleFileReport {
  path: string
  format: FileFormat
  sha256: string
  /** 非空行数（含表头行）；JSON 为数组项数。 */
  rows: number
  /** 成功解析的行数 / 项数（去重前）。可用根数 = parsed − duplicates，与引擎 parseCsv / parseJson 的结果同长。 */
  parsed: number
  /** 既不是表头也不是合法 K 线数据的行数 / 项数。 */
  skipped: number
  /** 首根开盘时间；无数据为 null。 */
  from: number | null
  to: number | null
  interval: IntervalGuess | null
  gaps: Gap[]
  duplicates: number
  ohlcViolations: number
  warnings: string[]
}

export interface FundingFileReport {
  path: string
  format: FileFormat
  sha256: string
  rows: number
  parsed: number
  skipped: number
  from: number | null
  to: number | null
  duplicates: number
  warnings: string[]
}

export interface ManifestEntry {
  path: string
  kind: FileKind
  format: FileFormat
  sha256: string
  bytes: number
}

export interface ManifestInput {
  path: string
  kind?: FileKind
}

export interface InspectOptions extends PathOptions {
  /** 最多列出多少个缺口，默认 50。 */
  maxGaps?: number
  /** 文件格式；给了就用它，没给才按扩展名推断。 */
  format?: FileFormat
}

/**
 * 路径约束（L5-06）：可选的 `root`。给了 `root` 时 `path` / 输出路径解析后必须落在它里面，
 * 越界（`../`、绝对路径、符号链接）直接抛错；没给 `root` 时不约束。
 * 任何把 data-files 接到 Agent / 插件 / 远程调用面的代码都必须传 `root`；CLI 用 `--root=<dir>`。
 */
export interface PathOptions {
  root?: string
}

export interface Io {
  stdout(text: string): void
  stderr(text: string): void
}
