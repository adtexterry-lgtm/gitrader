// SPDX-License-Identifier: CPAL-1.0
// 核心：用只读数据连接器拉 K 线 → 写原文 CSV → 按 @gitrader/data-files 的 normalizeCandleFile 落规范 JSON
// → 生成 sha256 清单。翻页口径照 packages/connector-binance-data/src/market.ts:278-294：
// 游标 = 本页末根开盘时间 + 周期（月线取末根 + 1 ms，见 pageCandles）；本页为空 / 游标不前进 / 越过 to 即停；
// 硬上限 maxPages 次续拉调用，用满仍未停则返回值带 truncated: true。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { manifestFor, normalizeCandleFile } from '@gitrader/data-files'
import { stepMs } from './intervals.mjs'
import { closeConnector, createConnector, historyOf } from './venues.mjs'

/** 翻页硬上限缺省值（与连接器 MAX_PAGES 同口径）。 */
export const MAX_PAGES = 200

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 单根 K 线是否可用（t 为有限数、o/h/l/c 有限数、v 缺省 0）。 */
function saneCandle(c) {
  if (!c || typeof c !== 'object') return undefined
  const { t, o, h, l, c: close, v } = c
  if (![t, o, h, l, close].every(isNum)) return undefined
  return { t, o, h, l, c: close, v: isNum(v) ? v : 0 }
}

/**
 * 逐页拉到 to 为止。连接器自己会翻页，这一层只兜底「一次调用没取完」的场所（早停 / 单次上限小）：
 * 每页用上一页末根 + 周期作新游标；'1M' 是日历月、没有固定毫秒，游标取末根 + 1 ms（从「末根之后」开始），
 * 否则按 30 天近似推进会跳过整月。返回 { candles, pages, calls, truncated }，
 * truncated 只在用满 maxPages 仍未遇到停止条件时为 true。
 */
export async function pageCandles({ connector, instrumentId, interval, from, to, maxPages = MAX_PAGES }) {
  const step = stepMs(interval)
  if (step === undefined) throw new Error(`unsupported interval: ${interval}`)
  if (typeof connector?.candles !== 'function') throw new Error(`${instrumentId}: connector has no candles() method`)

  const seen = new Map()
  let cursor = from
  let pages = 0
  let calls = 0
  let truncated = true
  for (let page = 0; page < maxPages; page++) {
    calls++
    const batch = await connector.candles(instrumentId, interval, { from: cursor, to })
    if (!Array.isArray(batch)) throw new Error(`${instrumentId}: connector returned a non-array candle page`)
    pages++
    let last
    for (const raw of batch) {
      const candle = saneCandle(raw)
      if (!candle) continue
      if (candle.t < from || candle.t > to) continue
      seen.set(candle.t, candle)
      if (last === undefined || candle.t > last) last = candle.t
    }
    if (last === undefined) {
      truncated = false
      break
    }
    const next = interval === '1M' ? last + 1 : last + step
    if (next <= cursor || next > to) {
      truncated = false
      break
    }
    cursor = next
  }
  const candles = [...seen.values()].sort((a, b) => a.t - b.t)
  return { candles, pages, calls, truncated }
}

const num = (n) => String(n)

/** 原文 CSV：表头 `t,o,h,l,c,v`，一行一根（与 @gitrader/data-files 的 parseCandleCsv 同列序）。 */
export function candlesToCsv(candles) {
  const lines = ['t,o,h,l,c,v']
  for (const c of candles) lines.push([num(c.t), num(c.o), num(c.h), num(c.l), num(c.c), num(c.v)].join(','))
  return `${lines.join('\n')}\n`
}

/** 输出路径：<out 去扩展名>.csv / <out> / <out 去扩展名>.manifest.json。 */
export function outputPaths(out) {
  const jsonPath = resolve(out)
  const stem = jsonPath.slice(0, jsonPath.length - extname(jsonPath).length)
  return { jsonPath, csvPath: `${stem}.csv`, manifestPath: `${stem}.manifest.json` }
}

/**
 * 落盘三件套：原文 CSV → 规范 JSON（normalizeCandleFile）→ 清单 JSON。
 * 清单的 files[] 就是 BacktestSpec.data.files 能直接吃的形状（绝对路径 + 就地算出的 sha256）。
 */
export function writeCandleFiles({ candles, options, history = {}, truncated = false }) {
  const { jsonPath, csvPath, manifestPath } = outputPaths(options.out)
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(csvPath, candlesToCsv(candles), 'utf8')

  const report = normalizeCandleFile(csvPath, jsonPath)
  const files = manifestFor([{ path: jsonPath, kind: 'candles' }])
  const manifest = {
    version: 1,
    source: {
      venue: options.venue,
      instrumentId: options.instrumentId,
      instrument: options.instrumentId.slice(options.venue.length + 1),
      interval: options.interval,
      from: options.from,
      to: options.to,
      requestedPages: options.maxPages,
      truncated,
      ...(history.pageLimit === undefined ? {} : { pageLimit: history.pageLimit }),
      ...(history.maxCandles === undefined ? {} : { maxCandles: history.maxCandles }),
    },
    candles: report.parsed - report.duplicates,
    quality: {
      rows: report.rows,
      parsed: report.parsed,
      duplicates: report.duplicates,
      skipped: report.skipped,
      gaps: report.gaps.length,
      ohlcViolations: report.ohlcViolations,
      warnings: report.warnings,
    },
    files,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { jsonPath, csvPath, manifestPath, report, manifest }
}

/**
 * 全流程：构造连接器 → 拉 → 落盘 → 关连接器（关失败不影响已写文件）。
 * deps.createConnector 可注入假连接器工厂；deps.connectorOptions 原样传给真实构造器。
 */
export async function runFetch(options, deps = {}) {
  const create = deps.createConnector ?? createConnector
  const connector = await create(options.venue, deps.connectorOptions ?? {})
  try {
    const history = historyOf(connector)
    const { candles, pages, calls, truncated } = await pageCandles({ connector, ...options })
    const written = writeCandleFiles({ candles, options, history, truncated })
    return { ...written, count: candles.length, pages, calls, truncated, history }
  } finally {
    await closeConnector(connector)
  }
}
