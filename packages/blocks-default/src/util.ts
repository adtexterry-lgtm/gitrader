// SPDX-License-Identifier: CPAL-1.0
// 无 DOM 的小工具：宽松取值、十进制字符串→数字（只用于显示与比例，计算与下单从不走这里）。
import { t } from '@gitrader/workbench/i18n'
export type Rec = Record<string, unknown>
export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 十进制字符串 / 数字 → 数字；认不出返回 null。 */
export function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** 列表型结果：数组本身，或 {key: 数组}。 */
export function listOf(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw
  if (isRec(raw) && Array.isArray(raw[key])) return raw[key] as unknown[]
  return []
}

/** 标的显示名：`hyperliquid:BTC` → `BTC`；`hyperliquid:xyz:TSLA` → `xyz:TSLA`。 */
export function symbolOf(instrumentId: string): string {
  const i = instrumentId.indexOf(':')
  return i >= 0 ? instrumentId.slice(i + 1) : instrumentId
}

/** 显示名：优先标的表里的 displaySymbol；没有就由 instrumentId 推：去掉场所前缀，剩下若含 dex 前缀（a:b）保留之。 */
export function displayNameOf(instrumentId: string, displaySymbol?: string | null): string {
  const named = typeof displaySymbol === 'string' ? displaySymbol.trim() : ''
  return named !== '' ? named : symbolOf(instrumentId)
}

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 })
/** 规则命中里的数字：保留原精度的千分位。 */
export function fmtLoose(v: unknown): string {
  const n = toNum(v)
  return n === null ? String(v ?? '—') : nf.format(n)
}

export function utcDayStart(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** 倒计时文案：mm:ss；≥1 小时 h:mm:ss；到点 / 已过 = 已过期。 */
export function formatCountdown(ms: number): string {
  if (!(ms > 0)) return t('已过期')
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`
}
