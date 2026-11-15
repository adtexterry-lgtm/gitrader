// SPDX-License-Identifier: CPAL-1.0
// 图表页的纯逻辑（无 DOM、不碰图表库）：K 线规整与毫秒 ↔ 库时间、成交 → 标记（形状 = 方向、颜色 = 执行方、回测空心）、
// 仓位 / 挂单 / 待批 / 强平 → 价格线、令牌 → 库 options、标的卡列表、下单票据（十进制字符串，BigInt 定点）。
// 对账级数值（价格、数量、名义）一律十进制字符串；图上的像素级数值（K 线 OHLC）用 number，只用于显示与定位。
import { displayNameOf, isRec, listOf, str, symbolOf, toNum } from '../../blocks-default/src/util'
import { fmtMoney, fmtPrice, fmtQty, mulStr, type FillRow } from './model-records'
import { t as tr } from '@gitrader/workbench/i18n'

// ---- 周期与毫秒 ↔ 库时间 ---------------------------------------------------------------------

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Interval = (typeof INTERVALS)[number]
export const DEFAULT_INTERVAL: Interval = '15m'
export const INTERVAL_MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
export const isInterval = (v: unknown): v is Interval => typeof v === 'string' && (INTERVALS as readonly string[]).includes(v)

/**
 * K 线的加载阶段：有错 → error（压过一切）；已有数据 → ready；12 秒还没数据 → timeout（视图当错误态，C8）；8 秒 → slow；否则 loading。
 * 视图只拿这个判显示，计时 / 重试都在视图里，纯函数好测。
 */
export function chartPhase(s: { startedAt: number; now: number; candles: number | null; error: string | null }): 'loading' | 'slow' | 'timeout' | 'error' | 'ready' {
  if (s.error !== null) return 'error'
  if (s.candles !== null && s.candles > 0) return 'ready'
  if (s.now - s.startedAt >= 12000) return 'timeout'
  return s.now - s.startedAt >= 8000 ? 'slow' : 'loading'
}

/** KLineChart 的时间单位就是整数毫秒（和内核同口径）；统一经这两个函数过，换库只改这里。 */
export const toLibTime = (ms: number): number => Math.trunc(ms)
export const fromLibTime = (t: number): number => Math.trunc(t)

export interface LibPeriod { type: 'minute' | 'hour' | 'day'; span: number }
export function toLibPeriod(i: Interval): LibPeriod {
  if (i === '1d') return { type: 'day', span: 1 }
  if (i === '1h' || i === '4h') return { type: 'hour', span: INTERVAL_MS[i] / 3_600_000 }
  return { type: 'minute', span: INTERVAL_MS[i] / 60_000 }
}

/** 一根 K 线（库的输入形状：时间 = 开盘毫秒）。 */
export type Bar = { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

/** market.candles 回包 / 事件载荷 → 升序、按时间去重的 K 线；认不出的行丢弃。 */
export function normalizeCandles(raw: unknown): Bar[] {
  const out = new Map<number, Bar>()
  for (const c of listOf(raw, 'candles')) {
    if (!isRec(c)) continue
    const t = toNum(c.t), o = toNum(c.o), h = toNum(c.h), l = toNum(c.l), cl = toNum(c.c), v = toNum(c.v)
    if (t === null || o === null || h === null || l === null || cl === null) continue
    out.set(toLibTime(t), { timestamp: toLibTime(t), open: o, high: h, low: l, close: cl, volume: v ?? 0 })
  }
  return [...out.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** 增量并入：同一开盘时间覆盖（形成中的那根），否则追加。 */
export function mergeBars(prev: readonly Bar[], incoming: readonly Bar[]): Bar[] {
  if (!incoming.length) return prev as Bar[]
  const map = new Map(prev.map((b) => [b.timestamp, b]))
  for (const b of incoming) map.set(b.timestamp, b)
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** market.candles 事件：{instrumentId, interval, candles[]}。 */
export function candleEvent(data: unknown): { instrumentId: string; interval: string; bars: Bar[] } | null {
  if (!isRec(data)) return null
  const instrumentId = str(data.instrumentId)
  const interval = str(data.interval)
  if (!instrumentId || !interval) return null
  const bars = normalizeCandles(data.candles)
  return bars.length ? { instrumentId, interval, bars } : null
}

/** 价格小数位：取 K 线价格里出现的最多小数位（至少 1，至多 8）。 */
export function pricePrecision(bars: readonly Bar[]): number {
  let d = 1
  for (const b of bars.slice(-200)) {
    for (const v of [b.open, b.high, b.low, b.close]) {
      const s = String(v)
      if (s.includes('e')) { d = Math.max(d, 8); continue }
      const i = s.indexOf('.')
      if (i >= 0) d = Math.max(d, s.length - i - 1)
    }
  }
  return Math.min(8, d)
}

const group3 = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
/** 数字 → 千分位字符串（图上读数用，负号 U+2212）。 */
export function fmtNum(n: number | null | undefined, places: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return tr('未设')
  const s = Math.abs(n).toFixed(places)
  const [i, f] = s.split('.')
  return `${n < 0 && Number(s) !== 0 ? '−' : ''}${group3(i ?? '0')}${f ? `.${f}` : ''}`
}

/** 十字线读数一行：O H L C V。 */
export function readout(bar: Bar | null | undefined, places: number): { open: string; high: string; low: string; close: string; vol: string } {
  if (!bar) return { open: tr('未设'), high: tr('未设'), low: tr('未设'), close: tr('未设'), vol: tr('未设') }
  return { open: fmtNum(bar.open, places), high: fmtNum(bar.high, places), low: fmtNum(bar.low, places), close: fmtNum(bar.close, places), vol: fmtNum(bar.volume, 0) }
}

/** 涨跌幅（%）：相对前收；前收不是正数返回 null。 */
export function changePct(prevClose: number | null | undefined, last: number | null | undefined): number | null {
  if (typeof prevClose !== 'number' || typeof last !== 'number' || !(prevClose > 0)) return null
  return ((last - prevClose) / prevClose) * 100
}
export const fmtPct = (v: number | null): string => (v === null ? tr('未设') : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`)
export const pctTone = (v: number | null): 'up' | 'down' | 'flat' => (v === null || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down')

/** 已有 bars 里最后一根的收盘价。 */
export const lastClose = (bars: readonly Bar[]): number | null => (bars.length ? bars[bars.length - 1]!.close : null)

/** 行情回包（market.quote 回 {price} 十进制字符串；事件 / 协议 Quote 回 last 或 bid / ask）→ 价格。 */
export function quotePrice(raw: unknown): number | null {
  if (!isRec(raw)) return null
  const p = toNum(raw.price) ?? toNum(raw.last)
  if (p !== null && p > 0) return p
  const bid = toNum(raw.bid), ask = toNum(raw.ask)
  return bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null
}

// ---- 成交标记：形状 = 方向，颜色 = 执行方，回测成交空心 --------------------------------------------

export type ActorKind = 'human' | 'agent' | 'engine' | 'system' | 'unknown'
export const ACTOR_KINDS: readonly ActorKind[] = ['human', 'engine', 'agent', 'system']
export const ACTOR_LABEL: Record<ActorKind, string> = { human: tr('你'), engine: tr('引擎'), agent: 'Agent', system: tr('系统'), unknown: tr('未知') }
/** 执行方 → 颜色令牌（数据角色色，只出现在执行方小标与图表标记）。无法关联的写「未知」，用系统色，绝不归给人。 */
export const ACTOR_TOKEN: Record<ActorKind, string> = {
  human: '--gr-actor-human', agent: '--gr-actor-agent', engine: '--gr-actor-engine', system: '--gr-actor-system', unknown: '--gr-actor-system',
}

export interface MarkerSpec {
  id: string
  /** 成交时间（毫秒）与它落在的那根 K 线的开盘时间。 */
  ts: number
  barTs: number
  side: 'buy' | 'sell'
  /** 买 ▲ 在 K 线下方（贴最低价），卖 ▼ 在上方（贴最高价）。 */
  shape: 'up' | 'down'
  anchor: 'low' | 'high'
  /** 定位用的价格：买 = 那根的最低价，卖 = 最高价。 */
  value: number
  actor: ActorKind
  actorName: string
  colorToken: string
  hollow: boolean
  price: string
  size: string
  fee: string
  source: string
  accountId: string
  orderId: string
}

export type MarkerFill = Pick<FillRow, 'id' | 'ts' | 'side' | 'price' | 'size' | 'fee' | 'source' | 'accountId' | 'orderId' | 'actor'> & { backtest?: boolean }

/** 找 ts 落在哪根 K 线（最后一根开盘时间 ≤ ts 的；超过最后一根的一个周期之外 / 早于第一根 = 不在图上）。 */
export function barIndexAt(bars: readonly Bar[], ts: number, intervalMs: number): number {
  if (!bars.length || ts < bars[0]!.timestamp || ts >= bars[bars.length - 1]!.timestamp + intervalMs) return -1
  let lo = 0, hi = bars.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (bars[mid]!.timestamp <= ts) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function markerSpecs(fills: readonly MarkerFill[], bars: readonly Bar[], interval: Interval, show?: ReadonlySet<ActorKind>): MarkerSpec[] {
  const out: MarkerSpec[] = []
  for (const f of fills) {
    const actor = f.actor.kind
    if (show && !show.has(actor === 'unknown' ? 'system' : actor)) continue
    const i = barIndexAt(bars, f.ts, INTERVAL_MS[interval])
    if (i < 0) continue
    const bar = bars[i]!
    const buy = f.side === 'buy'
    out.push({
      id: f.id, ts: f.ts, barTs: bar.timestamp, side: f.side, shape: buy ? 'up' : 'down', anchor: buy ? 'low' : 'high', value: buy ? bar.low : bar.high,
      actor, actorName: f.actor.name, colorToken: ACTOR_TOKEN[actor], hollow: f.backtest === true,
      price: f.price, size: f.size, fee: f.fee, source: f.source, accountId: f.accountId, orderId: f.orderId,
    })
  }
  return out
}

// ---- 价格线 --------------------------------------------------------------------------------

export type LineKind = 'entry' | 'stop' | 'pending' | 'liq'
export interface PriceLine {
  id: string
  kind: LineKind
  price: number
  label: string
  /** null = 实线，否则虚线的 [线段, 间隔]。 */
  dash: [number, number] | null
  lineToken: '--gr-text-3' | '--gr-text-2'
  textToken: '--gr-text-body' | '--gr-down'
}

export interface ChartPosition {
  accountId: string; instrumentId: string; side: 'long' | 'short'; size: string; entryPrice: number | null; liquidationPrice: number | null; estimated: boolean
  markPrice: number | null; unrealizedPnl: string | null; leverage: number | null; notional: string | null
}
export interface OpenOrder {
  orderId: string; accountId: string; instrumentId: string; side: 'buy' | 'sell'; type: string; size: string
  price: string | null; triggerPrice: string | null; reduceOnly: boolean; status: string
}

const DEC = /^[+-]?\d+(\.\d+)?$/
const decStr = (v: unknown): string | null => (typeof v === 'string' && DEC.test(v.trim()) ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

export function toChartPosition(raw: unknown, accountId: string): ChartPosition | null {
  if (!isRec(raw)) return null
  const instrumentId = str(raw.instrumentId)
  const size = decStr(raw.size)
  const side = raw.side === 'long' || raw.side === 'short' ? raw.side : null
  if (!instrumentId || size === null || !side || Number(size) === 0) return null
  return {
    accountId, instrumentId, side, size, entryPrice: toNum(raw.entryPrice), liquidationPrice: toNum(raw.liquidationPrice), estimated: raw.estimated === true,
    markPrice: toNum(raw.markPrice), unrealizedPnl: decStr(raw.unrealizedPnl), leverage: toNum(raw.leverage), notional: decStr(raw.notional),
  }
}

export function toOpenOrder(raw: unknown): OpenOrder | null {
  if (!isRec(raw)) return null
  const orderId = str(raw.orderId), accountId = str(raw.accountId), instrumentId = str(raw.instrumentId), size = decStr(raw.size)
  const side = raw.side === 'buy' || raw.side === 'sell' ? raw.side : null
  if (!orderId || !accountId || !instrumentId || !side || size === null) return null
  return { orderId, accountId, instrumentId, side, type: str(raw.type) ?? '', size, price: decStr(raw.price), triggerPrice: decStr(raw.triggerPrice), reduceOnly: raw.reduceOnly === true, status: str(raw.status) ?? '' }
}

const OPEN_STATUS = new Set(['open', 'untriggered', 'partially_filled', 'new', 'submitted'])
/** 本标的的挂单行里「止损 / 止盈」只取 reduceOnly 且带触发价的单；其余挂单不画线。 */
export const isStopOrder = (o: OpenOrder): boolean => o.reduceOnly && o.triggerPrice !== null && OPEN_STATUS.has(o.status)
export const stopWord = (o: Pick<OpenOrder, 'type'>): string => (o.type.startsWith('take_profit') ? tr('止盈') : tr('止损'))
export const sideWord = (s: 'buy' | 'sell'): string => (s === 'buy' ? tr('买') : tr('卖'))

/** 待批提案里本标的的腿（取有价格的）：{id, side, size, price}。 */
export function pendingLegs(proposals: unknown, instrumentId: string): Array<{ id: string; side: 'buy' | 'sell'; size: string; price: number }> {
  const out: Array<{ id: string; side: 'buy' | 'sell'; size: string; price: number }> = []
  for (const p of listOf(proposals, 'proposals')) {
    if (!isRec(p) || p.status !== 'pending') continue
    const pid = str(p.proposalId) ?? ''
    const legs = Array.isArray(p.intents) ? p.intents : []
    legs.forEach((l, i) => {
      if (!isRec(l) || l.instrumentId !== instrumentId) return
      const side = l.side === 'buy' || l.side === 'sell' ? l.side : null
      const price = toNum(l.price) ?? toNum(l.triggerPrice)
      const size = decStr(l.size)
      if (side && price !== null && price > 0 && size !== null) out.push({ id: `${pid}:${i}`, side, size, price })
    })
  }
  return out
}

/** 距强平 ≤ 5% 换 down 字色（同 r4「近强平」阈值）。 */
export const NEAR_LIQ_PCT = 5
export function nearLiquidation(liq: number | null, last: number | null): boolean {
  return liq !== null && last !== null && last > 0 && (Math.abs(last - liq) / last) * 100 <= NEAR_LIQ_PCT
}

const DASH: [number, number] = [4, 4]
export function priceLines(i: { instrumentId: string; positions: readonly ChartPosition[]; orders: readonly OpenOrder[]; proposals: unknown; last: number | null }): PriceLine[] {
  const out: PriceLine[] = []
  for (const p of i.positions) {
    if (p.instrumentId !== i.instrumentId) continue
    if (p.entryPrice !== null) out.push({ id: `entry:${p.accountId}:${p.side}`, kind: 'entry', price: p.entryPrice, label: `${p.side === 'long' ? tr('多') : tr('空')} ${fmtQty(p.size)}`, dash: null, lineToken: '--gr-text-3', textToken: '--gr-text-body' })
    if (p.liquidationPrice !== null) {
      const near = nearLiquidation(p.liquidationPrice, i.last)
      out.push({ id: `liq:${p.accountId}:${p.side}`, kind: 'liq', price: p.liquidationPrice, label: p.estimated ? tr('强平 约') : tr('强平'), dash: DASH, lineToken: '--gr-text-3', textToken: near ? '--gr-down' : '--gr-text-body' })
    }
  }
  for (const o of i.orders) {
    if (o.instrumentId !== i.instrumentId || !isStopOrder(o)) continue
    out.push({ id: `stop:${o.orderId}`, kind: 'stop', price: Number(o.triggerPrice), label: stopWord(o), dash: DASH, lineToken: '--gr-text-3', textToken: '--gr-text-body' })
  }
  for (const l of pendingLegs(i.proposals, i.instrumentId)) {
    out.push({ id: `pending:${l.id}`, kind: 'pending', price: l.price, label: tr('待批 {0} {1}', sideWord(l.side), fmtQty(l.size)), dash: DASH, lineToken: '--gr-text-2', textToken: '--gr-text-body' })
  }
  return out
}

/** 价轴范围：在库给的默认范围上并入「离边缘不远」的价格线（边缘外各 REACH = 30% 跨度以内），越界的一侧留 3% 余量；更远的线（如远处的强平价）不拉伸价轴，画在窗格边缘并带箭头。 */
export const REACH = 0.3
export function yRange(range: { from: number; to: number }, lines: readonly Pick<PriceLine, 'price'>[]): { from: number; to: number } {
  const span = range.to - range.from
  const near = lines.map((l) => l.price).filter((p) => Number.isFinite(p) && p >= range.from - REACH * span && p <= range.to + REACH * span)
  if (!near.length) return range
  const from = Math.min(range.from, ...near)
  const to = Math.max(range.to, ...near)
  if (from === range.from && to === range.to) return range
  const pad = (to - from) * 0.03
  return { from: from - (from < range.from ? pad : 0), to: to + (to > range.to ? pad : 0) }
}

/** 价格线在窗格里的落点：窗格内照实画；越出上 / 下缘的钉在边缘内 EDGE 像素并标箭头（↑ / ↓），标签带上价格。 */
export const EDGE = 12
export function clampLine(y: number, height: number): { y: number; out: 'up' | 'down' | null } {
  if (y < EDGE) return { y: EDGE, out: 'up' }
  if (y > height - EDGE) return { y: height - EDGE, out: 'down' }
  return { y, out: null }
}

// ---- 令牌 → 库 options ----------------------------------------------------------------------

/** 令牌读取器（浏览器里读 getComputedStyle，测试里给假的）：color 回 rgb()/rgba()，raw 回令牌原文。 */
export interface TokenReader { color(token: string): string; raw(token: string): string }

/** 把 `rgb(r, g, b)` / `rgba(r, g, b, a)` 的透明度换成 a（图表库认逗号写法，不认 `/ alpha`）。 */
export function withAlpha(color: string, alpha: number): string {
  const m = color.match(/[\d.]+/g)
  if (!m || m.length < 3) return color
  return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${alpha})`
}

/** 横轴标签字号：与 xAxis.tickText.size 同源，宽度估算 / 右侧留白都读这一个常量。 */
export const AXIS_LABEL_SIZE = 11

/** 横轴时间标签：分钟 / 小时周期一律完整 `HH:mm`（5 字），日线及以上 `MM-DD`；按本地时区取，与卡片里的时间读数同口径。 */
export function axisTimeLabel(timestamp: number, interval: Interval): string {
  const d = new Date(timestamp)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return interval === '1d' ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * 标签宽度估算（纯函数，不在 node 下量 canvas）：无衬线字体里数字 / 冒号 / 短横约 0.6em 宽（取上界），
 * 用于算右侧留白；偏大只会多留几像素，不会算出会被裁的值。
 */
export function axisLabelWidth(text: string, size = AXIS_LABEL_SIZE): number {
  return Math.ceil(text.length * size * 0.6)
}

/** 横轴右侧留白：至少一个最长标签（`HH:mm` / `MM-DD` 都是 5 字）的宽度。 */
export function axisRightMargin(size = AXIS_LABEL_SIZE): number {
  return axisLabelWidth('HH:mm', size)
}

/**
 * 横轴刻度：文本一律完整 `HH:mm` / `MM-DD`。图表库把刻度文字按中心点画、不做边界收敛，
 * 右侧空档里的刻度会被画布右缘裁成「16:0」，所以右边留足一个标签宽度，落进留白区的刻度不画（宁缺不裁）。
 */
export function axisTicks(
  ticks: readonly { coord: number; value: number | string; text: string }[],
  o: { interval: Interval; width: number; size?: number },
): Array<{ coord: number; value: number | string; text: string }> {
  const size = o.size ?? AXIS_LABEL_SIZE
  const limit = o.width - axisRightMargin(size)
  return ticks
    .map((t) => ({ ...t, text: typeof t.value === 'number' ? axisTimeLabel(t.value, o.interval) : t.text }))
    .filter((t) => t.coord + axisLabelWidth(t.text, size) / 2 <= limit)
}

export function chartStyles(r: TokenReader) {
  const up = r.color('--gr-up'), dn = r.color('--gr-down'), flat = r.color('--gr-text-3')
  const va = Number(r.raw('--gr-vol-alpha')) || 0.28
  const family = r.raw('--gr-font')
  const tag = { backgroundColor: r.color('--gr-ink-3'), borderColor: r.color('--gr-ink-3'), borderSize: 1, borderRadius: 2, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3 }
  const axis = () => ({ show: true, size: 'auto', axisLine: { show: false }, tickLine: { show: false }, tickText: { show: true, color: flat, size: AXIS_LABEL_SIZE, family, weight: 'normal' } })
  const chair = () => ({ show: true, line: { show: true, style: 'dashed', size: 1, color: r.color('--gr-crosshair'), dashedValue: [4, 4] }, text: { show: true, style: 'fill', color: r.color('--gr-text-body'), size: 11, family, weight: 'normal', ...tag } })
  return {
    grid: { show: true, horizontal: { show: true, style: 'solid', size: 1, color: r.color('--gr-grid'), dashedValue: [2, 2] }, vertical: { show: false } },
    candle: {
      type: 'candle_solid',
      bar: { compareRule: 'current_open', upColor: up, downColor: dn, noChangeColor: flat, upBorderColor: up, downBorderColor: dn, noChangeBorderColor: flat, upWickColor: up, downWickColor: dn, noChangeWickColor: flat },
      priceMark: {
        show: true, high: { show: false }, low: { show: false },
        last: {
          show: true, compareRule: 'current_open', upColor: flat, downColor: flat, noChangeColor: flat,
          line: { show: true, style: 'dashed', dashedValue: [1, 3], size: 1, color: flat },
          text: { show: true, style: 'fill', size: 11, family, weight: 'normal', color: r.color('--gr-text'), ...tag },
        },
      },
      tooltip: { showRule: 'none' },
    },
    indicator: {
      ohlc: { compareRule: 'current_open', upColor: up, downColor: dn, noChangeColor: flat },
      bars: [{ style: 'fill', borderSize: 0, upColor: withAlpha(up, va), downColor: withAlpha(dn, va), noChangeColor: withAlpha(flat, va) }],
      lastValueMark: { show: false }, tooltip: { showRule: 'none' },
    },
    xAxis: axis(),
    yAxis: { ...axis(), size: 72 },
    separator: { size: 1, color: r.color('--gr-sep'), fill: true, activeBackgroundColor: r.color('--gr-sep') },
    crosshair: { show: true, horizontal: { ...chair(), features: [] }, vertical: chair() },
  }
}

/** 价格线价签与标签的字样式（每条线一份；强平近了只把字色换 down）。 */
export function lineTextStyle(r: TokenReader, line: Pick<PriceLine, 'textToken'>) {
  return { size: 12, family: r.raw('--gr-font'), weight: 'normal', color: r.color(line.textToken), backgroundColor: r.color('--gr-ink-3'), borderColor: r.color('--gr-ink-3'), borderSize: 1, borderRadius: 4, paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }
}

// ---- 标的卡 ---------------------------------------------------------------------------------

export interface SymbolRow { instrumentId: string; symbol: string; venue: string; pinned: boolean }
export const venueOfInstrument = (id: string): string => (id.includes(':') ? id.slice(0, id.indexOf(':')) : '')

/** 自选列表：持仓标的置顶 → 最近查看 → 手动加入；去重，保持先出现的位置。 */
export function symbolRows(i: { positions: readonly string[]; recent: readonly string[]; watch: readonly string[] }): SymbolRow[] {
  const seen = new Set<string>()
  const rows: SymbolRow[] = []
  const add = (id: unknown, pinned: boolean) => {
    if (typeof id !== 'string' || !id || seen.has(id)) return
    seen.add(id)
    rows.push({ instrumentId: id, symbol: symbolOf(id), venue: venueOfInstrument(id), pinned })
  }
  i.positions.forEach((id) => add(id, true))
  i.recent.forEach((id) => add(id, false))
  i.watch.forEach((id) => add(id, false))
  return rows
}

/** 最近查看：新的在前，去重，最多 5 个。 */
export function pushRecent(recent: readonly string[], id: string, max = 5): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, max)
}
export const addWatch = (watch: readonly string[], id: string): string[] => (watch.includes(id) ? [...watch] : [...watch, id])
export const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

/** instruments.search 回 {hits:[{id,name,venue}]}；market.instruments 回数组 [{instrumentId, displaySymbol, venue}]。 */
export function searchHits(raw: unknown): Array<{ instrumentId: string; symbol: string; venue: string }> {
  const list = isRec(raw) && Array.isArray(raw.hits) ? raw.hits : Array.isArray(raw) ? raw : []
  return list.flatMap((h) => {
    if (!isRec(h)) return []
    const id = str(h.id) ?? str(h.instrumentId)
    if (!id) return []
    return [{ instrumentId: id, symbol: displayNameOf(id, str(h.name) ?? str(h.displaySymbol)), venue: str(h.venue) ?? venueOfInstrument(id) }]
  })
}

/** 场所状态：venue.status 回数组，unverified 为真 = 「未经真网验证」。 */
export function unverifiedVenues(raw: unknown): Set<string> {
  return new Set(listOf(raw, 'venues').filter(isRec).flatMap((v) => (v.unverified === true && typeof v.venue === 'string' ? [v.venue] : [])))
}

// ---- 下单票据 -------------------------------------------------------------------------------

export type TicketSide = 'buy' | 'sell'
export type TicketType = 'limit' | 'market' | 'stop_market'
export const TICKET_TYPES: ReadonlyArray<{ id: TicketType; label: string }> = [{ id: 'limit', label: tr('限价') }, { id: 'market', label: tr('市价') }, { id: 'stop_market', label: tr('止损') }]

export interface TicketForm { accountId: string; instrumentId: string; side: TicketSide; type: TicketType; price: string; size: string; reduceOnly: boolean }

/** 输入框文本 → 正的十进制字符串（去千分位和空格）；认不出 / ≤ 0 返回 null。 */
export function cleanDec(text: string): string | null {
  const t = text.replace(/[,\s]/g, '')
  return /^\d+(\.\d+)?$/.test(t) && /[1-9]/.test(t) ? t : null
}

/** 名义 = 价 × 量（十进制字符串，BigInt 定点）。市价没有输入价，用 refPrice（最新价）估，返回 approx。 */
export function ticketNotional(f: Pick<TicketForm, 'type' | 'price' | 'size'>, refPrice?: string | null): { value: string; approx: boolean } | null {
  const size = cleanDec(f.size)
  const price = f.type === 'market' ? (refPrice ? cleanDec(refPrice) : null) : cleanDec(f.price)
  if (!size || !price) return null
  const value = mulStr(price, size)
  return value === null ? null : { value, approx: f.type === 'market' }
}

export type TicketCheck = { ok: true; intent: Record<string, unknown> } | { ok: false; message: string }

/** 表单 → 意图；本地只挡「不是数字 / ≤ 0 / 没选账户」，风控与场所规则一律交给内核，原文回显。 */
export function ticketIntent(f: TicketForm): TicketCheck {
  if (!f.accountId) return { ok: false, message: tr('先选账户') }
  const size = cleanDec(f.size)
  if (!size) return { ok: false, message: tr('数量要是大于 0 的数字') }
  const base = { accountId: f.accountId, instrumentId: f.instrumentId, side: f.side, size, reduceOnly: f.reduceOnly }
  if (f.type === 'market') return { ok: true, intent: { ...base, type: 'market' } }
  const price = cleanDec(f.price)
  if (!price) return { ok: false, message: f.type === 'stop_market' ? tr('触发价要是大于 0 的数字') : tr('价格要是大于 0 的数字') }
  return { ok: true, intent: f.type === 'stop_market' ? { ...base, type: 'stop_market', triggerPrice: price } : { ...base, type: 'limit', price } }
}

/** 提交前武装行写后果：「买 0.08 BTC-PERP @ 64,210.0 · 名义 5,136.80」。 */
export function ticketSummary(f: TicketForm, refPrice?: string | null, name?: string): string {
  const size = cleanDec(f.size)
  const sym = name ?? symbolOf(f.instrumentId)
  const n = ticketNotional(f, refPrice)
  const px = f.type === 'market' ? tr('市价') : f.type === 'stop_market' ? tr('触发 {0}', fmtPrice(cleanDec(f.price))) : fmtPrice(cleanDec(f.price))
  return `${sideWord(f.side)} ${size ? fmtQty(size) : '0'} ${sym} @ ${px}${n ? tr(' · 名义{0} {1}', n.approx ? tr(' 约') : '', fmtMoney(n.value)) : ''}`
}

/** 手续费估算 = 名义 × 费率（取吃单费率，是上限；限价单挂住成交会更低）。没有费率 / 名义返回 null。 */
export function ticketFee(notional: { value: string } | null, fees: { maker?: string; taker?: string } | null | undefined): string | null {
  const rate = fees?.taker ?? fees?.maker
  return notional && rate ? mulStr(notional.value, rate) : null
}

/** 按可用额的比例换数量：可用 × pct ÷ 价，向下截到 4 位小数；价 / 可用不可用返回 null。（不含杠杆，只是下限估算；实际可开仓位由内核风控裁。） */
export function sizeByPct(available: number | null, price: string | null, pct: number): string | null {
  const p = price ? Number(cleanDec(price)) : Number.NaN
  if (available === null || !(available > 0) || !(p > 0)) return null
  const n = Math.floor((available * pct * 10_000) / (100 * p)) / 10_000
  return n > 0 ? String(n) : null
}

/** 票据缺省账户：与标的同场所的实盘账户 → 纸面账户 → 第一个。 */
export function defaultAccount<T extends { accountId: string; mode: string; venue: string }>(accounts: readonly T[], instrumentId: string | null): T | null {
  const venue = instrumentId ? venueOfInstrument(instrumentId) : ''
  return accounts.find((a) => a.mode === 'live' && a.venue === venue) ?? accounts.find((a) => a.mode === 'paper') ?? accounts[0] ?? null
}
