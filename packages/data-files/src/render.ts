// SPDX-License-Identifier: CPAL-1.0
// 人读文本：多行、无颜色、无表情、无品牌。字段顺序固定，便于 diff 与本地存档。
import type { CandleFileReport, FundingFileReport, ManifestEntry } from './types'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function iso(t: number | null): string {
  return t === null ? 'none' : new Date(t).toISOString()
}

/** 毫秒 → `1w` / `3d` / `2h` / `15m` / `30s`；不能整除时退回毫秒数。 */
function humanDuration(ms: number): string {
  const units: readonly (readonly [number, string])[] = [
    [7 * DAY, 'w'],
    [DAY, 'd'],
    [HOUR, 'h'],
    [MIN, 'm'],
    [1000, 's'],
  ]
  for (const [unit, label] of units) {
    if (ms >= unit && ms % unit === 0) return `${ms / unit}${label}`
  }
  return `${ms}ms`
}

function span(from: number | null, to: number | null): string {
  return from === null || to === null ? 'none' : humanDuration(to - from)
}

function warningsBlock(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return []
  return ['warnings:', ...warnings.map((w) => `  - ${w}`)]
}

function renderCandles(r: CandleFileReport): string[] {
  const interval = r.interval
  const lines = [
    `path: ${r.path}`,
    `format: ${r.format}`,
    `sha256: ${r.sha256}`,
    `kind: candles`,
    `rows: ${r.rows}`,
    `parsed: ${r.parsed}`,
    `kept: ${r.parsed - r.duplicates}`,
    `skipped: ${r.skipped}`,
    `duplicates: ${r.duplicates}`,
    `from: ${iso(r.from)}`,
    `to: ${iso(r.to)}`,
    `span: ${span(r.from, r.to)}`,
    interval === null
      ? 'interval: unknown'
      : `interval: ${interval.label ?? `unmapped`} (${humanDuration(interval.ms)}, confidence ${interval.confidence.toFixed(3)})`,
  ]
  lines.push(`gaps: ${r.gaps.length === 0 ? 'none' : r.gaps.length}`)
  for (const g of r.gaps) lines.push(`  - ${iso(g.from)} .. ${iso(g.to)} missing ${g.missing}`)
  lines.push(`ohlc violations: ${r.ohlcViolations}`)
  return [...lines, ...warningsBlock(r.warnings)]
}

function renderFunding(r: FundingFileReport): string[] {
  const lines = [
    `path: ${r.path}`,
    `format: ${r.format}`,
    `sha256: ${r.sha256}`,
    `kind: funding`,
    `rows: ${r.rows}`,
    `parsed: ${r.parsed}`,
    `kept: ${r.parsed - r.duplicates}`,
    `skipped: ${r.skipped}`,
    `duplicates: ${r.duplicates}`,
    `from: ${iso(r.from)}`,
    `to: ${iso(r.to)}`,
    `span: ${span(r.from, r.to)}`,
  ]
  return [...lines, ...warningsBlock(r.warnings)]
}

function renderManifest(entries: readonly ManifestEntry[]): string[] {
  const lines = [`manifest: ${entries.length} file(s)`]
  for (const e of entries) {
    lines.push(`- path: ${e.path}`)
    lines.push(`  format: ${e.format}`)
    lines.push(`  kind: ${e.kind}`)
    lines.push(`  bytes: ${e.bytes}`)
    lines.push(`  sha256: ${e.sha256}`)
  }
  return lines
}

/** 报告 → 人读文本（不含结尾换行）。 */
export function renderReport(r: CandleFileReport | FundingFileReport | readonly ManifestEntry[]): string {
  if (Array.isArray(r)) return (renderManifest(r as readonly ManifestEntry[])).join('\n')
  const report = r as CandleFileReport | FundingFileReport
  return ('interval' in report ? renderCandles(report) : renderFunding(report)).join('\n')
}
