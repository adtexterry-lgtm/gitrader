// SPDX-License-Identifier: CPAL-1.0
// 图表公共件：令牌读取、物理像素画布、漂亮刻度、时间轴刻度。canvas 里没有任何颜色字面量，全部从 :root 令牌取。
import * as F from '../lib/format.js'
import { t as tr, getLang } from '../lib/i18n.js'

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 读 :root 令牌：const tok = tokenReader(); tok('--gr-up') */
export function tokenReader() {
  const cs = getComputedStyle(document.documentElement)
  return (name) => cs.getPropertyValue(name).trim()
}

/**
 * 画布按「物理像素」准备：canvas 尺寸 = round(CSS 尺寸 × DPR)，变换矩阵恒为单位阵——
 * 之后所有坐标都是设备像素，1 px 线用 fillRect 或 +0.5 偏移的 stroke，边缘锐利无糊边。
 * 返回 { ctx, W, H, dpr }（W/H 为设备像素）或 null。
 */
export function prepareCanvas(canvas, wrap) {
  const cw = wrap.clientWidth
  const ch = wrap.clientHeight
  if (cw < 40 || ch < 24) return null
  const dpr = window.devicePixelRatio || 1
  const W = Math.round(cw * dpr)
  const H = Math.round(ch * dpr)
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, W, H)
  return { ctx, W, H, dpr }
}

/** 步长取 1 / 2 / 2.5 / 5 × 10^k 中不小于 range/ticks 的最小者。 */
export function niceStep(range, ticks) {
  const raw = Math.max(range, 1e-12) / Math.max(1, ticks)
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw - 1e-12) return m * pow
  return 10 * pow
}

/** 一个数需要的小数位（步长 0.25 → 2）。 */
export function decimalsOf(step) {
  for (let d = 0; d <= 10; d += 1) if (Math.abs(Number(step.toFixed(d)) - step) < step * 1e-6) return d
  return 8
}

/** 圆角矩形填充（设备像素坐标）。 */
export function fillRound(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h)
  ctx.fill()
}

const pad2 = (n) => String(n).padStart(2, '0')
const fmtHm = (t) => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
const fmtMd = (t) => { const d = new Date(t); return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) }

const TICK_MS = { '1m': 15 * 60e3, '5m': 60 * 60e3, '15m': 3 * 3600e3, '1h': 6 * 3600e3, '4h': 24 * 3600e3 }

/** 二分：第一个 t >= T 的下标，没有返回 -1。 */
function firstAtOrAfter(candles, start, end, T) {
  let lo = start; let hi = end - 1; let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].t >= T) { ans = mid; hi = mid - 1 } else lo = mid + 1
  }
  return ans
}

/**
 * 时间轴刻度。按周期选间隔（1m 每 15 分钟、5m 每小时、15m 每 3 小时、1h 每 6 小时、4h 每天、1d 每月），
 * 空间不够就加倍；跨日处（本地 00:00）单独标日期并画分隔线。
 * 返回 [{ i（相对可视起点的下标）, label, major（日期/月份刻度）}]，已做避让。
 */
export function timeTicks(candles, start, end, interval, stepCss) {
  if (end - start < 2) return []
  const ivMs = F.INTERVAL_MS[interval] || 60000
  const t0 = candles[start].t
  const t1 = candles[end - 1].t
  const found = []
  const push = (T, label, major) => {
    const idx = firstAtOrAfter(candles, start, end, T)
    if (idx < 0 || candles[idx].t - T >= ivMs) return
    found.push({ i: idx - start, label, major, t: T })
  }
  if (interval === '1d') {
    const d = new Date(t0)
    let y = d.getFullYear(); let m = d.getMonth() + 1
    for (let k = 0; k < 400; k += 1) {
      const T = new Date(y, m, 1).getTime()
      if (T > t1) break
      const mo = new Date(T).getMonth()
      push(T, mo === 0 ? String(new Date(T).getFullYear()) : (getLang() === 'en' ? MONTHS_EN[mo] : tr('{0}月', (mo + 1))), true)
      m += 1; if (m > 11) { m = 0; y += 1 }
    }
  } else {
    let tick = TICK_MS[interval] || 15 * 60e3
    while ((tick / ivMs) * stepCss < 64 && tick < 30 * 86400e3) tick *= 2
    const off = -new Date(t0).getTimezoneOffset() * 60000
    for (let T = Math.ceil((t0 + off) / tick) * tick - off; T <= t1; T += tick) {
      const mid = (((T + off) % 86400000) + 86400000) % 86400000 === 0
      push(T, mid ? fmtMd(T) : fmtHm(T), mid)
    }
    // 跨日分隔：所有本地午夜（含不在刻度上的）
    const dayStart = new Date(t0); dayStart.setHours(24, 0, 0, 0)
    for (let T = dayStart.getTime(); T <= t1; T += 86400000) {
      const dd = new Date(T); dd.setHours(0, 0, 0, 0)
      const Tm = dd.getTime()
      if (!found.some((f) => f.t === Tm)) push(Tm, fmtMd(Tm), true)
    }
  }
  found.sort((a, b) => a.i - b.i)
  // 避让：major 优先，其余需与已放置标签相距 ≥ 52 px
  const placed = []
  const ok = (f) => placed.every((p) => Math.abs(p.i - f.i) * stepCss >= 52)
  for (const f of found.filter((x) => x.major)) if (ok(f)) placed.push(f)
  for (const f of found.filter((x) => !x.major)) if (ok(f)) placed.push(f)
  return placed.sort((a, b) => a.i - b.i)
}
