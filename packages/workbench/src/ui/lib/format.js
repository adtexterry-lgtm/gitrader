// SPDX-License-Identifier: CPAL-1.0
// 纯格式化函数（无 DOM 依赖）。数字一律 zh-CN 千分位；USDC 两位小数；币数量按 szDecimals。
// 统一交易模型的数量 / 价格是十进制字符串（契约 §1.3）：这里只做显示，入口先用 num() 转成数字；计算与下单一律不要用这些函数的结果。

import { t, getLang } from './i18n.js'

// 数字 / 日期的区域：英文界面用 en-US，中文界面用 zh-CN（语言在页面加载时就定了）
const LOC = getLang() === 'en' ? 'en-US' : 'zh-CN'
const MINUS = '−' // 排版用真减号

const nf = (min, max) => new Intl.NumberFormat(LOC, { minimumFractionDigits: min, maximumFractionDigits: max })
const cache = new Map()
function fmt(min, max) {
  const key = min + ':' + max
  let f = cache.get(key)
  if (!f) { f = nf(min, max); cache.set(key, f) }
  return f
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
/** 十进制字符串 → 数字（仅用于显示）；其它值原样返回。 */
export const num = (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v)

/** USDC 金额：两位小数、千分位；非数字显示 —。 */
export function usd(v) { v = num(v); return isNum(v) ? fmt(2, 2).format(v) : '—' }

/** 带符号：+1,234.56 / −1,234.56；0 不带符号。 */
export function signed(v, digits = 2) {
  v = num(v)
  if (!isNum(v)) return '—'
  const s = fmt(digits, digits).format(Math.abs(v))
  if (Number(s.replace(/[^\d.]/g, '')) === 0) return s
  return (v > 0 ? '+' : MINUS) + s
}

/** 带符号百分比（入参是「百分数」本身，如 -1.23 → −1.23%）。 */
export function signedPct(v, digits = 2) {
  v = num(v)
  return isNum(v) ? signed(v, digits) + '%' : '—'
}

/** 普通百分比（入参是小数，0.3 → 30%）。 */
export function pctOfFraction(v, digits = 0) {
  v = num(v)
  return isNum(v) ? fmt(0, digits).format(v * 100) + '%' : '—'
}

/** 价格：按量级取小数位（大价位少小数、小价位多小数），同量级位数固定，列内对得齐。 */
export function price(v) {
  v = num(v)
  if (!isNum(v)) return '—'
  const a = Math.abs(v)
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 5
  return fmt(d, d).format(v)
}

/** 币数量：按 szDecimals；未知就 4 位。 */
export function size(v, szDecimals) {
  v = num(v)
  if (!isNum(v)) return '—'
  const d = Number.isInteger(szDecimals) && szDecimals >= 0 && szDecimals <= 8 ? szDecimals : 4
  return fmt(d, d).format(v)
}

/** 大数紧凑显示：1.2万 / 3.4亿。 */
export function compact(v) {
  v = num(v)
  if (!isNum(v)) return '—'
  const a = Math.abs(v)
  if (getLang() === 'en') { // 英文按千分级：K / M / B（阈值与中文一致：1 万起压缩）
    if (a >= 1e9) return fmt(0, 2).format(v / 1e9) + 'B'
    if (a >= 1e6) return fmt(0, 2).format(v / 1e6) + 'M'
    if (a >= 1e4) return fmt(0, 2).format(v / 1e3) + 'K'
    return fmt(0, 0).format(v)
  }
  if (a >= 1e8) return t('{0}亿', (fmt(0, 2).format(v / 1e8)))
  if (a >= 1e4) return t('{0}万', (fmt(0, 2).format(v / 1e4)))
  return fmt(0, 0).format(v)
}

/** 资金费率（小数）→ 小时与 8 小时折算两段百分数文案。 */
export function funding(hourly) {
  hourly = num(hourly)
  if (!isNum(hourly)) return { h: '—', e8: '—', tone: 'flat' }
  const zero = (x) => Number(fmt(4, 4).format(Math.abs(x * 100)).replace(/,/g, '')) === 0 // 四位小数后是 0 的，不着色、不带符号
  const p = (x) => (zero(x) ? '' : x > 0 ? '+' : MINUS) + fmt(4, 4).format(Math.abs(x * 100)) + '%'
  return { h: p(hourly), e8: p(hourly * 8), tone: zero(hourly) ? 'flat' : tone(hourly) }
}

const timeFmt = new Intl.DateTimeFormat(LOC, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const timeShortFmt = new Intl.DateTimeFormat(LOC, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dateTimeFmt = new Intl.DateTimeFormat(LOC, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export const hms = (ts) => (isNum(ts) && ts > 0 ? timeFmt.format(ts) : '—')
export const hm = (ts) => (isNum(ts) && ts > 0 ? timeShortFmt.format(ts) : '—')
export const mdhm = (ts) => (isNum(ts) && ts > 0 ? dateTimeFmt.format(ts) : '—')

/** 订单号显示短号：o-000012 → #12；认不出形状就取末 6 位。 */
export function shortId(id) {
  if (typeof id !== 'string' || id === '') return ''
  const m = /(\d+)$/.exec(id)
  if (m) return '#' + String(parseInt(m[1], 10))
  return '#' + id.slice(-6)
}

export const sideWord = (s) => (s === 'buy' ? t('买入') : s === 'sell' ? t('卖出') : '—')
export const posSideWord = (s) => (s === 'long' ? t('多') : s === 'short' ? t('空') : '—')

/** 数值涨跌 → 语义 class 后缀。 */
export function tone(v) { v = num(v); return !isNum(v) || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down' } // 两位小数显示为 0.00 的不着色

/** 4 位有效数字：4.03601 → 4.036，13.28996 → 13.29（盘口数量用）。 */
const sigFmt = new Intl.NumberFormat(LOC, { maximumSignificantDigits: 4 })
export function sig4(v) { v = num(v); return isNum(v) ? sigFmt.format(v) : '\u2014' }


/** 固定小数位的千分位数字（坐标轴刻度用）。 */
export function fixed(v, d) { v = num(v); return isNum(v) ? fmt(d, d).format(v) : '—' }

/** 悬停用的完整日期时间。 */
const fullFmt = new Intl.DateTimeFormat(LOC, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
export const full = (ts) => (isNum(ts) && ts > 0 ? fullFmt.format(ts) : '')

/** 毫秒周期。 */
export const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }
export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d']

const mdFmt = new Intl.DateTimeFormat(LOC, { month: '2-digit', day: '2-digit' })
/** K 线横轴标签：日内周期显示 HH:mm，日线显示 MM/dd。 */
export function axisTime(ts, interval) { return interval === '1d' ? mdFmt.format(ts) : timeShortFmt.format(ts) }

/** 纵轴「好看」刻度步长。 */
export function niceStep(range, ticks) {
  const raw = range / Math.max(1, ticks)
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * pow
}
