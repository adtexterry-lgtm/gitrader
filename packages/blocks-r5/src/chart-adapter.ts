// SPDX-License-Identifier: CPAL-1.0
// 图表库适配层：整个包只有这一个文件 import 图表库（KLineChart 10.1.0，Apache-2.0，NOTICE 随包）。
// 视图只认下面的 ChartHandle；换库只改这里与 model-chart.ts 里的「毫秒 ↔ 库时间」。
// 库在浏览器里才加载（动态 import）：它在模块顶层读 window，直接静态 import 会让 node 下的测试 / 构建脚本一 import 本包就崩；壳仍是单文件包（esbuild 把它折进同一文件、首次挂图表时才求值）。
// 库自己不画 DOM：全部是 canvas；标记与价格线是两个自注册的 overlay（W0 样稿验过的写法），悬停读数交回视图用 HTML 画。
import type { AxisCreateRangeParams, Chart, OverlayTemplate } from 'klinecharts'
import { axisTicks, chartStyles, clampLine, fmtNum, lineTextStyle, toLibPeriod, yRange, type Bar, type Interval, type MarkerSpec, type PriceLine, type TokenReader } from './model-chart'
import { t, getLang } from '@gitrader/workbench/i18n'

export interface MarkerHover { id: string; /** 标记中心，相对挂载元素左上角（像素）。 */ x: number; y: number }
export interface ChartHooks {
  onCrosshair(timestamp: number | null): void
}
export interface ChartHandle {
  /** 换标的 / 周期 / 整批重载：数据一次给齐。 */
  setSeries(s: { ticker: string; interval: Interval; bars: readonly Bar[]; pricePrecision: number }): void
  /** 实时：一根形成中或新收盘的 K 线。 */
  update(bar: Bar): void
  setMarkers(markers: readonly MarkerSpec[]): void
  /** 视口坐标 (x, y) 命中哪个成交标记（三角附近 ±9 / ±10 像素）；没有返回 null。坐标换算相对本图挂载元素。 */
  markerAt(clientX: number, clientY: number): MarkerHover | null
  /** fmt：价签文字（与记录 / 总览同一价格规则）；不给退回按 pricePrecision。 */
  setLines(lines: readonly PriceLine[], fmt?: (price: number) => string): void
  setVolume(on: boolean): void
  /** 令牌值变了（涨跌配色切换等）：重读令牌，重画样式与叠加层。 */
  restyle(): void
  resize(): void
  canvasCount(): number
  /** 画面状态快照（测试 / 排障用）：标记像素中心（页面视口坐标）、价格线（标签 / 价格 / 线色 / 字色）、当前涨跌色、数据根数。 */
  debug(): ChartDebug
  dispose(): void
}
export interface ChartDebug {
  bars: number
  markers: Array<{ id: string; x: number; y: number; hollow: boolean; color: string }>
  lines: Array<{ label: string; price: number; lineColor: string; textColor: string; dash: [number, number] | null }>
  upColor: string
  downColor: string
  volume: boolean
  /** 主窗格价轴当前范围。 */
  range: { from: number; to: number }
}

/** 浏览器里的令牌读取器：color 经探针元素解析成 rgb()/rgba()；raw 读 :root 上的原文。 */
export function browserTokens(host: HTMLElement): { reader: TokenReader; release(): void } {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.setAttribute('aria-hidden', 'true')
  host.appendChild(probe)
  const reader: TokenReader = {
    color(token) { probe.style.color = `var(${token})`; return getComputedStyle(probe).color },
    raw(token) { return getComputedStyle(document.documentElement).getPropertyValue(token).trim() },
  }
  return { reader, release: () => probe.remove() }
}

const MAIN = 'candle_pane'
const MARK_GAP = 6
const MARK_SIZE = 9
const MARK_HALF = 5
const VOLUME_PANE_H = 96
const VISIBLE_BARS = 170
const RIGHT_BARS = 8

type FillExtend = { id: string; buy: boolean; color: string; hollow: boolean }
type LineExtend = { color: string; dash: [number, number] | null; label: string; tag: string; priceText: string }

type Lib = typeof import('klinecharts')
let libPromise: Promise<Lib> | null = null
/** 动态 import 失败（离线 / 资源被拦 / 版本对不上）→ 带中文 message 的 Error，视图按 'error' 显示并可重试；失败后不缓存，重试会重新拉。 */
const loadLib = (): Promise<Lib> => {
  if (libPromise) return libPromise
  const p = import('klinecharts').then((m) => { registerOverlays(m); return m })
  libPromise = p.catch((e: unknown) => {
    libPromise = null
    throw new Error(t('图表库加载失败：{0}', e instanceof Error && e.message ? e.message : t('未知原因')))
  })
  return libPromise
}

let overlaysRegistered = false
function registerOverlays({ registerOverlay }: Lib): void {
  if (overlaysRegistered) return
  overlaysRegistered = true
  // 价格线：横贯 + 绘图区右端标签（名称 + 价格，线上方 4px）；价轴只留最新价一个价签，持仓价不再压住它（release-r1 P1-9）。
  const line: OverlayTemplate<LineExtend> = {
    name: 'g5Line', totalStep: 2, lock: true, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    createYAxisFigures: () => [],
    createPointFigures: (q) => {
      const e = q.overlay.extendData as LineExtend
      const { y, out } = clampLine(q.coordinates[0]!.y, q.bounding.height)
      const text = `${e.tag} ${e.priceText}${out ? (out === 'up' ? ' ↑' : ' ↓') : ''}`
      return [
        { type: 'line', attrs: { coordinates: [{ x: 0, y }, { x: q.bounding.width, y }] }, styles: { style: e.dash ? 'dashed' : 'solid', dashedValue: e.dash ?? [1, 3], size: 1, color: e.color }, ignoreEvent: true },
        { type: 'text', attrs: { x: q.bounding.width - 8, y: out ? y : y - 4, text, align: 'right', baseline: out ? 'middle' : 'bottom' }, styles: { style: 'fill', ...(q.overlay.styles?.text as object) }, ignoreEvent: true },
      ]
    },
  }
  registerOverlay(line)
  // 成交标记：三角，买 ▲ 在 K 线下、卖 ▼ 在上；实心 = 真实成交，空心 = 回测成交。悬停读数不走库的 overlay 事件（指针离开画布再回来时库不再补发 enter），
  // 由视图在绘图区的 pointermove 里调 markerAt() 自己命中。
  const fill: OverlayTemplate<FillExtend> = {
    name: 'g5Fill', totalStep: 2, lock: true, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    createPointFigures: (q) => {
      const c = q.coordinates[0]!
      const e = q.overlay.extendData as FillExtend
      const d = e.buy ? 1 : -1
      const y = c.y + MARK_GAP * d
      return {
        type: 'polygon',
        attrs: { coordinates: [{ x: c.x, y }, { x: c.x + MARK_HALF, y: y + MARK_SIZE * d }, { x: c.x - MARK_HALF, y: y + MARK_SIZE * d }] },
        styles: e.hollow ? { style: 'stroke', borderColor: e.color, borderSize: 1.5, borderStyle: 'solid' } : { style: 'fill', color: e.color },
        ignoreEvent: true,
      }
    },
  }
  registerOverlay(fill)
}

export async function createChart(host: HTMLElement, hooks: ChartHooks): Promise<ChartHandle> {
  const { init, dispose } = await loadLib()
  const chart = init(host, { locale: getLang() === 'en' ? 'en-US' : 'zh-CN', zoomAnchor: 'last_bar' }) as Chart
  const { reader, release } = browserTokens(host)
  let pending: readonly Bar[] = []
  let push: ((b: Bar) => void) | null = null
  let markers: readonly MarkerSpec[] = []
  let lines: readonly PriceLine[] = []
  let lineFmt: ((price: number) => string) | undefined
  let ticker = ''
  let interval: Interval = '15m'
  let precision = 1
  let alive = true

  const applyStyles = () => chart.setStyles(chartStyles(reader) as never)
  applyStyles()
  // 横轴刻度文本自己给（完整 HH:mm / MM-DD），并给右侧留一个标签宽度的空白：库按中心点画、不收敛边界，
  // 右侧空档里的刻度会被画布右缘裁成半截。
  chart.overrideXAxis({ createTicks: (q) => axisTicks(q.defaultTicks, { interval, width: q.bounding.width }) })
  chart.setDataLoader({
    getBars: (p) => { p.callback(p.type === 'init' ? (pending as Bar[]) : [], false) },
    subscribeBar: (p) => { push = p.callback as (b: Bar) => void },
    unsubscribeBar: () => { push = null },
  })
  const createRange = (q: AxisCreateRangeParams) => {
    const r = yRange({ from: q.defaultRange.from, to: q.defaultRange.to }, lines)
    if (r.from === q.defaultRange.from && r.to === q.defaultRange.to) return q.defaultRange
    const range = r.to - r.from
    return { ...q.defaultRange, from: r.from, to: r.to, range, realFrom: r.from, realTo: r.to, realRange: range, displayFrom: r.from, displayTo: r.to, displayRange: range }
  }
  chart.overrideYAxis({ paneId: MAIN, createRange } as never)
  const onCross = (c: { kLineData?: { timestamp?: number } } | undefined) => hooks.onCrosshair(c?.kLineData?.timestamp ?? null)
  chart.subscribeAction('onCrosshairChange', onCross as never)

  const drawMarkers = () => {
    chart.removeOverlay({ name: 'g5Fill' })
    chart.createOverlay(markers.map((m) => ({
      name: 'g5Fill', points: [{ timestamp: m.barTs, value: m.value }],
      extendData: { id: m.id, buy: m.side === 'buy', color: reader.color(m.colorToken), hollow: m.hollow } satisfies FillExtend,
    })) as never)
  }
  const drawLines = () => {
    chart.removeOverlay({ name: 'g5Line' })
    chart.createOverlay(lines.map((l) => ({
      name: 'g5Line', points: [{ value: l.price }],
      extendData: { color: reader.color(l.lineToken), dash: l.dash, label: l.label, tag: l.kind === 'entry' ? t('持仓') : l.label, priceText: lineFmt ? lineFmt(l.price) : fmtNum(l.price, precision) } satisfies LineExtend,
      styles: { text: { ...lineTextStyle(reader, l), ...(l.kind === 'entry' ? { color: reader.color('--gr-text-2') } : {}) } },
    })) as never)
  }

  /** 各标记三角中心的视口坐标（只含落在窗格内的）。 */
  const markerPixels = (): Array<{ id: string; x: number; y: number }> => {
    const pane = chart.getDom(MAIN, 'main')?.getBoundingClientRect()
    if (!pane) return []
    return markers.flatMap((m) => {
      const p = chart.convertToPixel({ timestamp: m.barTs, value: m.value }, { paneId: MAIN }) as { x?: number; y?: number }
      if (p.x === undefined || p.y === undefined || p.x < 0 || p.x > pane.width) return []
      return [{ id: m.id, x: pane.left + p.x, y: pane.top + p.y + (MARK_GAP + MARK_SIZE / 2) * (m.side === 'buy' ? 1 : -1) }]
    })
  }

  const fit = () => {
    const plot = chart.getSize(MAIN, 'main')
    if (!plot || !plot.width) return
    const bs = plot.width / (VISIBLE_BARS + RIGHT_BARS + 1)
    chart.setBarSpace(bs)
    chart.setOffsetRightDistance(RIGHT_BARS * bs)
    chart.scrollToRealTime()
  }

  const handle: ChartHandle = {
    setSeries(s) {
      pending = s.bars
      ticker = s.ticker
      interval = s.interval
      precision = s.pricePrecision
      chart.setSymbol({ ticker: s.ticker, pricePrecision: s.pricePrecision, volumePrecision: 0 })
      chart.setPeriod(toLibPeriod(s.interval) as never)
      requestAnimationFrame(() => { if (alive) { fit(); drawMarkers(); drawLines() } })
    },
    update(bar) { push?.(bar) },
    markerAt(cx, cy) {
      let best: { id: string; x: number; y: number; d: number } | null = null
      for (const p of markerPixels()) {
        const dx = Math.abs(cx - p.x), dy = Math.abs(cy - p.y)
        if (dx > 9 || dy > 10) continue
        const d = dx * dx + dy * dy
        if (!best || d < best.d) best = { ...p, d }
      }
      if (!best) return null
      const hb = host.getBoundingClientRect()
      return { id: best.id, x: best.x - hb.left, y: best.y - hb.top }
    },
    setMarkers(m) { markers = m; if (ticker) drawMarkers() },
    setLines(l, fmt) {
      lines = l
      lineFmt = fmt
      // 价轴范围要并入新的线：重新 override 才会让库重算刻度（resize 不会）
      if (ticker) { drawLines(); chart.overrideYAxis({ paneId: MAIN, createRange } as never) }
    },
    setVolume(on) {
      const has = chart.getIndicators({ name: 'VOL' }).length > 0
      if (on && !has) {
        chart.createIndicator({ name: 'VOL', calcParams: [] } as never, false)
        const id = chart.getIndicators({ name: 'VOL' })[0]?.paneId
        if (id) chart.setPaneOptions({ id, height: VOLUME_PANE_H })
      } else if (!on && has) chart.removeIndicator({ name: 'VOL' })
    },
    restyle() { applyStyles(); if (ticker) { drawMarkers(); drawLines() } },
    resize() { chart.resize() },
    canvasCount: () => host.querySelectorAll('canvas').length,
    debug() {
      const px = markerPixels().map((p) => { const m = markers.find((x) => x.id === p.id)!; return { ...p, hollow: m.hollow, color: reader.color(m.colorToken) } })
      const st = chart.getStyles()
      return {
        bars: chart.getDataList().length, markers: px,
        lines: chart.getOverlays({ name: 'g5Line' }).map((o) => ({
          label: (o.extendData as LineExtend).label, price: o.points[0]?.value ?? Number.NaN, lineColor: (o.extendData as LineExtend).color,
          textColor: String((o.styles as { text?: { color?: string } } | null)?.text?.color ?? ''), dash: (o.extendData as LineExtend).dash,
        })),
        upColor: (st.candle.bar as { upColor: string }).upColor, downColor: (st.candle.bar as { downColor: string }).downColor, volume: chart.getIndicators({ name: 'VOL' }).length > 0,
        range: (() => { const r = chart.getYAxes({ paneId: MAIN } as never)[0]?.getRange(); return { from: r?.from ?? Number.NaN, to: r?.to ?? Number.NaN } })(),
      }
    },
    dispose() {
      alive = false
      try { chart.unsubscribeAction('onCrosshairChange', onCross as never) } catch { /* 已卸 */ }
      release()
      dispose(chart)
    },
  }
  // 排障 / 浏览器用例从挂载元素上取到句柄（只读诊断用：debug()）；卸载时随元素一起消失。
  ;(host as HTMLElement & { __g5?: ChartHandle }).__g5 = handle
  return handle
}
