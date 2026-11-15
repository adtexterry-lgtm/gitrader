// SPDX-License-Identifier: CPAL-1.0
// 内联 SVG 图表：权益曲线、回撤曲线、月度收益热力表。不依赖图表库、不引外部字体与脚本。
import { drawdownSeries, sampleCurveIndices, monthlyReturns } from './curve'
import { escapeHtml, fmtDate, fmtMoney, fmtPct } from './format'
import type { CurvePoint, MonthReturn } from './types'

const INK = '#0b1622'
const GRID = '#1e2b3a'
const AXIS = '#7d8fa3'
const SERIES = '#4fb3ff'
const SERIES_FILL = 'rgba(79, 179, 255, 0.16)'
const DD = '#f0883e'
const DD_FILL = 'rgba(240, 136, 62, 0.22)'
const TEXT = '#c9d6e2'

function round(x: number): string {
  return (Math.round(x * 100) / 100).toString()
}

interface Frame {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}

const DEFAULT_FRAME: Frame = { width: 880, height: 220, left: 64, right: 16, top: 14, bottom: 26 }

function inner(frame: Frame): { x0: number; x1: number; y0: number; y1: number; w: number; h: number } {
  const x0 = frame.left
  const x1 = frame.width - frame.right
  const y0 = frame.top
  const y1 = frame.height - frame.bottom
  return { x0, x1, y0, y1, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

function placeholder(width: number, height: number, label: string): string {
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(label)}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${width}" height="${height}" fill="${INK}" rx="6"/><text x="${width / 2}" y="${height / 2}" fill="${AXIS}" font-size="13" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">无数据</text></svg>`
}

/** 权益曲线：降采样后折线 + 面积 + 三条水平参考线。 */
export function equityChartSvg(points: readonly CurvePoint[], opts: { limit?: number; initial?: number } = {}): string {
  const frame = DEFAULT_FRAME
  if (points.length === 0) return placeholder(frame.width, frame.height, '权益曲线')
  const limit = opts.limit ?? 240
  const initial = opts.initial ?? points[0]!.v
  const idx = sampleCurveIndices(points.map((p) => p.v), Math.max(limit, 10), initial)
  const sampled = idx.map((i) => points[i]!)
  const t0 = sampled[0]!.t
  const t1 = sampled[sampled.length - 1]!.t
  let min = Math.min(...sampled.map((p) => p.v))
  let max = Math.max(...sampled.map((p) => p.v))
  if (min === max) {
    min -= 1
    max += 1
  }
  const pad = (max - min) * 0.08
  min -= pad
  max += pad
  const { x0, y0, w, h } = inner(frame)
  const xOf = (t: number): number => (t1 > t0 ? x0 + ((t - t0) / (t1 - t0)) * w : x0 + w / 2)
  const yOf = (v: number): number => y0 + (1 - (v - min) / (max - min)) * h

  const line = sampled.map((p) => `${round(xOf(p.t))},${round(yOf(p.v))}`).join(' ')
  const area = `${round(xOf(sampled[0]!.t))},${round(y0 + h)} ${line} ${round(xOf(sampled[sampled.length - 1]!.t))},${round(y0 + h)}`
  const grid: string[] = []
  for (let k = 0; k <= 2; k++) {
    const value = min + ((max - min) * k) / 2
    const y = round(yOf(value))
    grid.push(`<line x1="${x0}" y1="${y}" x2="${round(x0 + w)}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`)
    grid.push(`<text x="${x0 - 8}" y="${Number(y) + 4}" fill="${AXIS}" font-size="10" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeHtml(fmtMoney(value, 0))}</text>`)
  }
  return [
    `<svg class="chart" viewBox="0 0 ${frame.width} ${frame.height}" width="100%" height="${frame.height}" role="img" aria-label="权益曲线" xmlns="http://www.w3.org/2000/svg">`,
    `<rect x="0" y="0" width="${frame.width}" height="${frame.height}" fill="${INK}" rx="6"/>`,
    ...grid,
    `<polygon points="${area}" fill="${SERIES_FILL}"/>`,
    `<polyline points="${line}" fill="none" stroke="${SERIES}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    `<text x="${x0}" y="${frame.height - 8}" fill="${AXIS}" font-size="10" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeHtml(fmtDate(t0))}</text>`,
    `<text x="${round(x0 + w)}" y="${frame.height - 8}" fill="${AXIS}" font-size="10" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeHtml(fmtDate(t1))}</text>`,
    `<text x="${round(x0 + w)}" y="${y0 + 10}" fill="${TEXT}" font-size="10" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${sampled.length} / ${points.length} 点</text>`,
    '</svg>',
  ].join('')
}

/** 回撤曲线：与权益曲线共用同一批采样下标，从 0 基线向下填充。 */
export function drawdownChartSvg(points: readonly CurvePoint[], opts: { limit?: number; initial?: number } = {}): string {
  const frame = { ...DEFAULT_FRAME, height: 150 }
  if (points.length === 0) return placeholder(frame.width, frame.height, '回撤曲线')
  const limit = opts.limit ?? 240
  const initial = opts.initial ?? points[0]!.v
  const idx = sampleCurveIndices(points.map((p) => p.v), Math.max(limit, 10), initial)
  const all = drawdownSeries(points, initial)
  const sampled = idx.map((i) => ({ t: points[i]!.t, d: all[i]! }))
  const t0 = sampled[0]!.t
  const t1 = sampled[sampled.length - 1]!.t
  const worst = Math.min(...sampled.map((p) => p.d), -1e-6)
  const { x0, y0, w, h } = inner(frame)
  const xOf = (t: number): number => (t1 > t0 ? x0 + ((t - t0) / (t1 - t0)) * w : x0 + w / 2)
  const yOf = (d: number): number => y0 + (d / worst) * h
  const line = sampled.map((p) => `${round(xOf(p.t))},${round(yOf(p.d))}`).join(' ')
  const area = `${round(x0)},${round(y0)} ${line} ${round(x0 + w)},${round(y0)}`
  return [
    `<svg class="chart" viewBox="0 0 ${frame.width} ${frame.height}" width="100%" height="${frame.height}" role="img" aria-label="回撤曲线" xmlns="http://www.w3.org/2000/svg">`,
    `<rect x="0" y="0" width="${frame.width}" height="${frame.height}" fill="${INK}" rx="6"/>`,
    `<line x1="${x0}" y1="${round(y0)}" x2="${round(x0 + w)}" y2="${round(y0)}" stroke="${GRID}" stroke-width="1"/>`,
    `<polygon points="${area}" fill="${DD_FILL}"/>`,
    `<polyline points="${line}" fill="none" stroke="${DD}" stroke-width="1.6" stroke-linejoin="round"/>`,
    `<text x="${x0 - 8}" y="${round(y0) + 4}" fill="${AXIS}" font-size="10" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">0%</text>`,
    `<text x="${x0 - 8}" y="${round(y0 + h) + 4}" fill="${AXIS}" font-size="10" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeHtml(fmtPct(worst, 1))}%</text>`,
    `<text x="${x0}" y="${frame.height - 8}" fill="${AXIS}" font-size="10" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeHtml(fmtDate(t0))}</text>`,
    `<text x="${round(x0 + w)}" y="${frame.height - 8}" fill="${AXIS}" font-size="10" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeHtml(fmtDate(t1))}</text>`,
    '</svg>',
  ].join('')
}

/** 正负色阶：以最大绝对值为基准，从深底渐变到绿 / 红。 */
function heatColor(ret: number, maxAbs: number): string {
  if (!Number.isFinite(ret) || ret === 0 || maxAbs <= 0) return '#16222f'
  const ratio = Math.min(1, Math.abs(ret) / maxAbs)
  const base = 30
  const span = Math.round(120 * ratio) + 30
  const g = Math.round(base + (ret > 0 ? span : span * 0.25))
  const r = Math.round(base + (ret > 0 ? span * 0.25 : span))
  const b = Math.round(base + span * 0.35)
  return `rgb(${r}, ${g}, ${b})`
}

/** 月度收益热力表：行=年，列=1..12 月，格子是内联 SVG rect + 文本。 */
export function monthlyHeatmapSvg(monthly: readonly MonthReturn[]): string {
  const cellW = 58
  const cellH = 22
  const gap = 3
  const labelW = 52
  const headH = 18
  const years = [...new Set(monthly.map((m) => m.year))].sort((a, b) => a - b)
  const width = labelW + 12 * (cellW + gap)
  const height = headH + Math.max(1, years.length) * (cellH + gap) + 6
  if (monthly.length === 0) return placeholder(Math.max(width, 320), 120, '月度收益热力表')
  const maxAbs = Math.max(...monthly.map((m) => Math.abs(m.ret)), 0)
  const parts: string[] = [
    `<svg class="chart heatmap" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="月度收益热力表" xmlns="http://www.w3.org/2000/svg">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${INK}" rx="6"/>`,
  ]
  for (let m = 1; m <= 12; m++) {
    parts.push(`<text x="${labelW + (m - 1) * (cellW + gap) + cellW / 2}" y="12" fill="${AXIS}" font-size="10" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${m}月</text>`)
  }
  years.forEach((year, rowIndex) => {
    const y = headH + rowIndex * (cellH + gap)
    parts.push(`<text x="${labelW - 10}" y="${y + cellH - 7}" fill="${TEXT}" font-size="11" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${year}</text>`)
    for (let m = 1; m <= 12; m++) {
      const x = labelW + (m - 1) * (cellW + gap)
      const bucket = monthly.find((mm) => mm.year === year && mm.month === m)
      const fill = bucket ? heatColor(bucket.ret, maxAbs) : '#111b26'
      const label = bucket ? `${fmtPct(bucket.ret, 1)}%` : '·'
      const textColor = bucket && Math.abs(bucket.ret) > maxAbs * 0.55 ? '#f4f9ff' : TEXT
      parts.push(`<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" fill="${fill}" stroke="${GRID}" stroke-width="0.5"/>`)
      parts.push(`<text x="${x + cellW / 2}" y="${y + cellH - 7}" fill="${textColor}" font-size="10" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${escapeHtml(label)}</text>`)
    }
  })
  parts.push('</svg>')
  return parts.join('')
}

/** 供测试直接用的月度分桶（避免测试重复实现分桶规则）。 */
export function monthlyFor(points: readonly CurvePoint[]): MonthReturn[] {
  return monthlyReturns(points)
}
