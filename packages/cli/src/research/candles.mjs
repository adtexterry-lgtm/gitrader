// SPDX-License-Identifier: CPAL-1.0
// K 线文件读取：格式与 @gitrader/data-files 的 parseCandleCsv / parseCandleJson 一致
// （packages/data-files/src/parse.ts:35-104）：CSV 列 t,o,h,l,c[,v]，JSON 为
// [{t,o,h,l,c,v?}] / [[t,o,h,l,c,v?]] / { "candles": [...] }；t 为 Unix 毫秒，
// 坏行跳过，按 t 升序去重（保留先出现的那根）。这里不 import 工作区包：本目录是无构建的 .mjs。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

/** 按 \n 切分、trim、跳过空行（与引擎同，不处理其它转义）。 */
function nonEmptyLines(text) {
  const out = []
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    const line = text.slice(start, end).trim()
    start = end + 1
    if (line !== '') out.push(line)
  }
  return out
}

/** 首行首列不是数值即视为表头。 */
function hasHeader(lines) {
  const first = lines[0]
  if (first === undefined) return false
  const cell = first.split(',')[0]
  return cell === undefined || !Number.isFinite(Number(cell))
}

function dedupe(raw) {
  const sorted = [...raw].sort((a, b) => a.t - b.t)
  const candles = sorted.filter((c, i) => i === 0 || c.t !== sorted[i - 1].t)
  return { candles, duplicates: raw.length - candles.length }
}

/** CSV K 线：`t,o,h,l,c[,v]`。 */
export function parseCandleCsv(text) {
  const lines = nonEmptyLines(text)
  const header = hasHeader(lines)
  const raw = []
  let skipped = 0
  for (let i = header ? 1 : 0; i < lines.length; i++) {
    const f = lines[i].split(',')
    if (f.length < 5) {
      skipped++
      continue
    }
    const t = Number(f[0])
    const o = Number(f[1])
    const h = Number(f[2])
    const l = Number(f[3])
    const c = Number(f[4])
    const v = f.length > 5 ? Number(f[5]) : 0
    if (![t, o, h, l, c, v].every(Number.isFinite)) {
      skipped++
      continue
    }
    raw.push({ t, o, h, l, c, v })
  }
  const { candles, duplicates } = dedupe(raw)
  return { format: 'csv', rows: lines.length, header, skipped, duplicates, candles }
}

/** JSON K 线：数组或 `{ candles: [...] }`；非法 JSON 抛错（与引擎一致）。 */
export function parseCandleJson(text) {
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('data file is not valid JSON')
  }
  const arr = Array.isArray(j)
    ? j
    : j && typeof j === 'object' && Array.isArray(j.candles)
      ? j.candles
      : null
  if (arr === null) throw new Error('JSON data must be an array of candles or { "candles": [...] }')
  const raw = []
  let skipped = 0
  for (const x of arr) {
    const v = Array.isArray(x)
      ? x
      : x && typeof x === 'object'
        ? [x.t, x.o, x.h, x.l, x.c, x.v ?? 0]
        : null
    if (!v || v.length < 5) {
      skipped++
      continue
    }
    const n = [v[0], v[1], v[2], v[3], v[4], v[5] ?? 0]
    if (!n.every((y) => typeof y === 'number' && Number.isFinite(y))) {
      skipped++
      continue
    }
    raw.push({ t: n[0], o: n[1], h: n[2], l: n[3], c: n[4], v: n[5] })
  }
  const { candles, duplicates } = dedupe(raw)
  return { format: 'json', rows: arr.length, header: false, skipped, duplicates, candles }
}

/** 按扩展名（无扩展名时按首字符）判格式后解析。 */
export function parseCandleText(text, path = '') {
  const ext = extname(path).toLowerCase()
  if (ext === '.json') return parseCandleJson(text)
  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') return parseCandleCsv(text)
  const head = text.trimStart()[0]
  return head === '[' || head === '{' ? parseCandleJson(text) : parseCandleCsv(text)
}

/** 读文件并返回解析结果 + 全文 sha256（用于报告的数据摘要）。 */
export function readCandleFile(path) {
  const buf = readFileSync(path)
  const text = buf.toString('utf8')
  const parsed = parseCandleText(text, path)
  return {
    ...parsed,
    path,
    sha256: createHash('sha256').update(buf).digest('hex'),
  }
}

/** 毫秒时间戳 → ISO（UTC），非有限数返回「—」。 */
export function isoTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString()
}
