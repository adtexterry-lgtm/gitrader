// SPDX-License-Identifier: CPAL-1.0
// 小图表：Sparkline（SVG 迷你折线）与 AreaChart（canvas 面积曲线，权益 / 回测权益 / 24h 走势通用）。
import { useEffect, useRef } from 'preact/hooks'
import * as F from '../lib/format.js'
import { chartDrawIn, reduced } from '../motion.js'
import { prepareCanvas, tokenReader } from './chartkit.js'
import { t as tr } from '../lib/i18n.js'

const cx = (...a) => a.filter(Boolean).join(' ')

/**
 * 迷你折线（SVG）。values: number[]（可含 null，会被忽略）；tone: 'auto'(涨绿跌红) | 'up' | 'down' | 'flat' | 'accent'。
 * 少于 2 个点不渲染（返回 null）。fill=true 在线下加淡淡的填充。
 */
export function Sparkline({ values, width = 56, height = 18, tone = 'auto', fill = false, className = '' }) {
  if (!Array.isArray(values)) return null
  const v = values.filter(F.isNum)
  if (v.length < 2) return null
  const lo = Math.min(...v); const hi = Math.max(...v)
  const pts = v.map((x, i) => [(i / (v.length - 1)) * width, height - 1 - ((x - lo) / (hi - lo || 1)) * (height - 2)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')
  const dir = tone === 'auto' ? (v[v.length - 1] >= v[0] ? 'up' : 'down') : tone
  return (
    <svg className={cx('gr-spark', 'gr-spark--' + dir, className)} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {fill ? <path d={`${d}L${width} ${height}L0 ${height}Z`} fill="currentColor" opacity="0.14" stroke="none" /> : null}
      <path d={d} fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  )
}

const asPoints = (points) => (Array.isArray(points) ? points : [])
  .map((p) => (p ? { t: F.isNum(p.t) ? p.t : p.ts, v: F.isNum(p.v) ? p.v : (F.isNum(p.equity) ? p.equity : p.value) } : null))
  .filter((p) => p && F.isNum(p.t) && F.isNum(p.v))
  .sort((a, b) => a.t - b.t)

/**
 * 面积曲线（canvas，物理像素对齐，渐变填充 + 线上光晕，首次出数据自左向右绘入）。
 * points: [{t,v}]（也接受 v0 的 {ts,equity}）；tone 已废弃（曲线一律中性白线 + 真渐变 + 末端橙点）。
 * axis=true 显示最高/最低值与首尾时间；baseline：画一条虚线基准（如初始资金）；format(v) 控制轴文字。
 */
export function AreaChart({ points, height = 56, tone = 'auto', axis = false, baseline, format = (v) => F.fixed(v, 2), label = tr('曲线'), className = '' }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const pts = asPoints(points)
  const progress = useRef(1)
  const played = useRef(false)

  const draw = () => {
    const wrap = wrapRef.current; const canvas = canvasRef.current
    if (!wrap || !canvas || pts.length < 2) return
    const prep = prepareCanvas(canvas, wrap)
    if (!prep) return
    const { ctx, W, H, dpr } = prep
    const tok = tokenReader()
    const first = pts[0]; const last = pts[pts.length - 1]
    const color = tok('--gr-text') // 曲线一律中性白线；盈亏颜色只在数字上。tone 属性已废弃
    const accent = tok('--gr-accent')
    let lo = Math.min(...pts.map((p) => p.v)); let hi = Math.max(...pts.map((p) => p.v))
    if (F.isNum(baseline)) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline) }
    if (hi - lo < Math.abs(hi) * 0.0004) { const c = (hi + lo) / 2; const d = Math.max(Math.abs(c) * 0.002, 1); lo = c - d; hi = c + d }
    const padL = axis ? 4 * dpr : 2 * dpr; const padR = 6 * dpr
    const padT = (axis ? 16 : 6) * dpr; const padB = (axis ? 18 : 6) * dpr
    const t0 = first.t; const t1 = last.t
    const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (W - padL - padR)
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB)
    const p = progress.current
    ctx.save()
    ctx.beginPath(); ctx.rect(0, 0, Math.max(1, W * p), H); ctx.clip()
    // 真渐变填充（顶部 .12 → 底部透明）
    ctx.save()
    ctx.beginPath(); ctx.moveTo(X(first.t), H - padB)
    pts.forEach((q) => ctx.lineTo(X(q.t), Y(q.v)))
    ctx.lineTo(X(last.t), H - padB); ctx.closePath(); ctx.clip()
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB)
    grad.addColorStop(0, color); grad.addColorStop(1, 'transparent')
    ctx.fillStyle = grad; ctx.globalAlpha = 0.12; ctx.fillRect(0, padT, W, H - padT - padB)
    ctx.restore(); ctx.globalAlpha = 1
    // 基准虚线
    if (F.isNum(baseline)) {
      ctx.globalAlpha = 1; ctx.strokeStyle = tok('--gr-grid-major'); ctx.lineWidth = 1; ctx.setLineDash([4 * dpr, 4 * dpr])
      const by = Math.round(Y(baseline)) + 0.5
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(W, by); ctx.stroke(); ctx.setLineDash([])
    }
    // 中性白细线（无辉光）
    ctx.strokeStyle = color; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5 * dpr
    ctx.beginPath(); pts.forEach((q, i) => { const x = X(q.t); const y = Y(q.v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) }); ctx.stroke(); ctx.globalAlpha = 1
    ctx.restore()
    // 末点
    if (p >= 0.999) {
      // 末端橙点（能量）：7px 光晕 .16 + 3px 实点
      ctx.fillStyle = accent; ctx.globalAlpha = 0.16
      ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 7 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
      ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 3 * dpr, 0, Math.PI * 2); ctx.fill()
    }
    if (axis) {
      ctx.fillStyle = tok('--gr-text-3'); ctx.font = `${11 * dpr}px ${tok('--gr-font')}`; ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'; ctx.fillText(format(hi), padL, 11 * dpr)
      ctx.fillText(F.hm(t0), padL, H - 4 * dpr)
      ctx.textAlign = 'right'; ctx.fillText(format(lo), W - padR, H - padB - 4 * dpr)
      ctx.fillText(F.hm(t1), W - padR, H - 4 * dpr)
    }
  }

  const sig = pts.length ? pts.length + ':' + pts[pts.length - 1].t + ':' + pts[pts.length - 1].v : ''
  useEffect(() => {
    if (pts.length < 2) return undefined
    if (!played.current && !reduced()) {
      played.current = true
      progress.current = 0
      const c = chartDrawIn((p) => { progress.current = p; draw() }, { duration: 0.7 })
      return () => c.kill()
    }
    progress.current = 1
    draw()
    return undefined
  }, [sig, tone, baseline, axis])
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => draw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [sig, tone, baseline, axis])

  if (pts.length < 2) return <div className={cx('gr-area gr-area--empty', className)} style={{ height: height + 'px' }}>{tr('曲线积累中')}</div>
  return <div ref={wrapRef} className={cx('gr-area', className)} style={{ height: height + 'px' }}><canvas ref={canvasRef} role="img" aria-label={label} /></div>
}
