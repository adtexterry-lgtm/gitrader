// SPDX-License-Identifier: CPAL-1.0
// 展示层格式化：数值、百分比、金额、时间、HTML 转义。所有函数对 NaN / ±Infinity / null 一律返回 '—'。
const EM_DASH = '—'

/** 2 位小数；不可算 → '—'。 */
export function fmt2(x: number | null | undefined): string {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : EM_DASH
}

/** 不定小数位（整数用 0 位）。 */
export function fmtNum(x: number | null | undefined, digits = 2): string {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : EM_DASH
}

/** 分数 → 百分数（不含 % 号）。 */
export function fmtPct(x: number | null | undefined, digits = 2): string {
  return typeof x === 'number' && Number.isFinite(x) ? (x * 100).toFixed(digits) : EM_DASH
}

/** 大额金额加千分位。 */
export function fmtMoney(x: number | null | undefined, digits = 2): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) return EM_DASH
  const fixed = x.toFixed(digits)
  const [intPart, frac] = fixed.split('.')
  const sign = intPart!.startsWith('-') ? '-' : ''
  const digitsOnly = sign ? intPart!.slice(1) : intPart!
  const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${frac}`
}

/** 毫秒时间戳 → 'YYYY-MM-DD HH:mm UTC'。 */
export function fmtTime(t: number | null | undefined): string {
  if (typeof t !== 'number' || !Number.isFinite(t)) return EM_DASH
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return EM_DASH
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

/** 毫秒 → 'YYYY-MM-DD'。 */
export function fmtDate(t: number | null | undefined): string {
  const full = fmtTime(t)
  return full === EM_DASH ? EM_DASH : full.slice(0, 10)
}

/** 时长（毫秒）→ '3 d 4 h' 这类粗粒度。 */
export function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return EM_DASH
  const day = 86_400_000
  const days = Math.floor(ms / day)
  const hours = Math.round((ms % day) / 3_600_000)
  if (days > 0) return `${days} d ${hours} h`
  const minutes = Math.round(ms / 60_000)
  return minutes > 0 ? `${minutes} min` : `${Math.round(ms / 1000)} s`
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** HTML 文本转义（属性与文本节点共用）。 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

/** Markdown 表格单元格转义：竖线与换行会破坏表格。 */
export function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
