// SPDX-License-Identifier: CPAL-1.0
// 图表卡（块 chart）：卡头 = 标的 + 场所（+未验证）+ 周期分段 + 指标 / 标记菜单 + 最新价与涨跌；一行 OHLCV 十字线读数 + 执行方图例；
// 主区 = KLineChart（canvas）：蜡烛 + 量柱 + 成交标记（形状 = 方向、颜色 = 执行方、回测空心）+ 四种价格线（开仓 / 止损止盈 / 待批 / 强平）。
// 数据只经桥：market.candles（≤ 1000 根 + 主题增量）、records.query {kind:'fill'}、account.* / proposal.list（价格线）；写联动 symbol / account。
// 指标：engine-core 的 ta 导出还没落地（K-r5-7），EMA / RSI 暂在菜单里写「未接通」、不画；量柱是原始数据，照画。
// 图表库只在 chart-adapter.ts 出现；本文件不 import 它。
import { KernelError, CODE_CONNECTION_LOST, CODE_TIMEOUT, type BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useLink, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { Menu } from '@gitrader/workbench/ui'
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { queryRetry, useOffline } from '../../../blocks-default/src/hooks'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import { createChart, type ChartHandle, type MarkerHover } from '../chart-adapter'
import { Card, Empty, Unwired, VenueIcon, wireState } from '../kit'
import {
  ACTOR_KINDS, ACTOR_LABEL, DEFAULT_INTERVAL, INTERVALS, barIndexAt, changePct, chartPhase, fmtNum, fmtPct, INTERVAL_MS, isInterval, lastClose, markerSpecs, mergeBars, normalizeCandles,
  candleEvent, pctTone, pricePrecision, priceLines, readout, sideWord, stringList, unverifiedVenues, venueOfInstrument,
  type ActorKind, type Bar, type Interval, type MarkerFill, type MarkerSpec,
} from '../model-chart'
import { UNVERIFIED_WHY } from '../model-config'
import { agentNames, fmtDay, fmtHms, fmtMoney, fmtQty, mergeRows, pageOf, queryParams, type FillRow } from '../model-records'
import { PausedFor, useInstrumentId, useInstruments, useOfflineSince, useSymbolSnapshot } from './symbol-positions'
import { usePriceDisplay } from '../../../blocks-default/src/price-display'
import { formatPrice } from '../../../blocks-default/src/display'
import './chart.css'
import { t as tr } from '@gitrader/workbench/i18n'

const LIMIT = 1000
/** 8 秒还没等到第一根 K 线 = slow（「行情加载慢」+「重试」）；断线重试最多 3 次，不再无限重试。 */
const SLOW_MS = 8000
const TIMEOUT_MS = 12000
const CANDLE_TRIES = 3
const errOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
const symbolName = (id: string): string => id.slice(id.indexOf(':') + 1)
/** 内核 Problem 名 → 一句中文概括；认不出的照原文。 */
const FAIL_WHY: Record<string, string> = {
  RATE_LIMITED: tr('请求过于频繁'), AUTH_FAILED: tr('连接未授权'), RULE_DENIED: tr('请求被拒绝'), CAPABILITY_UNSUPPORTED: tr('该场所没有 K 线数据'),
  ACCOUNT_NOT_BOUND: tr('行情没连上（离线或该场所未接入）'), VENUE_UNAVAILABLE: tr('行情没连上（离线或该场所未接入）'),
  DATA_UNAVAILABLE: tr('行情服务 10 秒内没有给出 K 线（场所限流排队或网络慢），可以重试'),
}
const whyText = (e: Error | null): string => {
  if (!e) return tr('原因未知')
  if (!(e instanceof KernelError)) return tr('图表组件没能加载')
  const named = e.problemName ? FAIL_WHY[e.problemName] : undefined
  if (named) return named
  if (e.code === CODE_TIMEOUT) return tr('行情服务超时')
  if (e.code === CODE_CONNECTION_LOST) return tr('行情连接中断')
  return tr('读取失败')
}

type Phase = 'loading' | 'ready' | 'nosource' | 'noperiod' | 'error' | 'unwired'
interface Load { key: string; phase: Phase; bars: Bar[]; error: Error | null; id: number; startedAt: number }
const idle = (key: string): Load => ({ key, phase: 'loading', bars: [], error: null, id: 0, startedAt: Date.now() })

const Chev = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>

const INDICATOR_ITEMS: ReadonlyArray<{ id: string; label: string; wired: boolean }> = [
  { id: 'vol', label: tr('成交量'), wired: true },
  { id: 'ema20', label: 'EMA 20', wired: false },
  { id: 'ema60', label: 'EMA 60', wired: false },
  { id: 'rsi14', label: 'RSI 14', wired: false },
]

function Swatch({ kind }: { kind: ActorKind }) {
  return <svg className={`g5-tri g5-sw-${kind === 'unknown' ? 'system' : kind}`} viewBox="0 0 16 16" aria-hidden="true">
    {kind === 'agent' ? <circle className="g5-swr" cx="8" cy="8.7" r="6.75" strokeWidth="1" /> : null}
    <path className="g5-swp" d="M8 4.5l4 7H4z" />
  </svg>
}

/** 成交读数卡的执行方圆点（图例同款）。 */
const dotClass = (k: ActorKind): string => `g5-ldot g5-${k === 'unknown' ? 'system' : k}`

export function ChartView({ config, setConfig }: BlockProps) {
  const bridge = useBridge()
  const off = useOffline()
  const since = useOfflineSince(off)
  const [link, setSymbolLink] = useLink<string>('symbol')
  const [, setAccountLink] = useLink<string>('account')
  const instrumentId = useInstrumentId(config)
  const [interval, setIntervalState] = useState<Interval>(isInterval(config?.interval) ? config.interval : DEFAULT_INTERVAL)
  const [indicators, setIndicators] = useState<string[]>(Array.isArray(config?.indicators) ? stringList(config.indicators) : ['vol'])
  const [shown, setShown] = useState<ActorKind[]>(Array.isArray(config?.markers) ? stringList(config.markers).filter((k): k is ActorKind => (ACTOR_KINDS as readonly string[]).includes(k)) : [...ACTOR_KINDS])
  const [nonce, setNonce] = useState(0)
  const source = config?.source === 'run' ? 'run' : 'live'
  const persist = (patch: Record<string, unknown>) => { try { setConfig?.({ ...(config ?? {}), ...patch }) } catch { /* 预览里没有宿主 */ } }

  // 没有任何来源指定标的时：取第一个持仓标的，再不行取品种表第一个，写回联动让同页其余卡跟上。
  const snap = useSymbolSnapshot(instrumentId)
  const prices = usePriceDisplay()
  const names = useInstruments()
  const fallback = useFallbackInstrument(instrumentId === null && source === 'live')
  useEffect(() => {
    if (instrumentId !== null || !fallback) return
    try { setSymbolLink(fallback) } catch { /* 清单没给联动写权限 */ }
  }, [instrumentId, fallback])
  const active = instrumentId ?? (link as string | undefined) ?? null

  // ---- K 线 -------------------------------------------------------------------------------
  const key = `${active}|${interval}`
  const [load, setLoad] = useState<Load>(() => idle(key))
  const barsRef = useRef<Bar[]>([])
  const [liveTick, setLiveTick] = useState(0)
  // 打开（或切到）一个标的时先打一枪 market.quote：让上游开始追踪这个标的的行情，冷标的的 K 线才不至于一直不来；失败忽略。
  useEffect(() => {
    if (!active || source !== 'live') return
    void (async () => { try { await bridge.query('market.quote', { instrumentId: active }) } catch { /* 只为触发追踪，错误忽略 */ } })()
  }, [bridge, active, source])
  useEffect(() => {
    if (!active || source !== 'live') return undefined
    let dead = false
    const startedAt = Date.now()
    setLoad((l) => (l.key === key && l.phase === 'ready' ? l : { ...idle(key), startedAt }))
    queryRetry<unknown>(bridge, 'market.candles', { instrumentId: active, interval, limit: LIMIT }, () => !dead, CANDLE_TRIES).then(
      (raw) => {
        if (dead) return
        const bars = normalizeCandles(raw)
        barsRef.current = bars
        setLoad((l) => ({ key, phase: bars.length ? 'ready' : 'noperiod', bars, error: null, id: l.id + 1, startedAt }))
      },
      (e: unknown) => {
        if (dead) return
        const err = errOf(e)
        barsRef.current = []
        const phase: Phase = e instanceof KernelError && e.problemName === 'CAPABILITY_UNSUPPORTED' ? 'nosource' : wireState(e) === 'off' ? 'unwired' : 'error'
        setLoad((l) => ({ key, phase, bars: [], error: err, id: l.id + 1, startedAt }))
      },
    )
    return () => { dead = true }
  }, [bridge, key, nonce, source])
  useOfflineBack(off, () => setNonce((n) => n + 1))

  // 8 秒还没第一根 K 线 = slow，12 秒 = timeout（当错误态）：只在 loading 里挂一个到下一个门槛的定时器，到点重算一次阶段。
  const [slowTick, setSlowTick] = useState(0)
  useEffect(() => {
    const age = Date.now() - load.startedAt
    if (load.phase !== 'loading' || age >= TIMEOUT_MS) return undefined
    const t = window.setTimeout(() => setSlowTick((n) => n + 1), (age < SLOW_MS ? SLOW_MS : TIMEOUT_MS) - age)
    return () => window.clearTimeout(t)
  }, [load.phase, load.key, load.startedAt, slowTick])

  // 前收（1d 的倒数第二根）→ 涨跌幅
  const [prevClose, setPrevClose] = useState<number | null>(null)
  useEffect(() => {
    if (!active || source !== 'live') return undefined
    let dead = false
    setPrevClose(null)
    queryRetry<unknown>(bridge, 'market.candles', { instrumentId: active, interval: '1d', limit: 2 }, () => !dead).then(
      (raw) => { const b = normalizeCandles(raw); if (!dead && b.length >= 2) setPrevClose(b[b.length - 2]!.close) },
      () => { /* 涨跌幅只是补充 */ },
    )
    return () => { dead = true }
  }, [bridge, active, source])

  const ready = load.phase === 'ready' && load.key === key
  const places = useMemo(() => pricePrecision(load.bars), [load.id])
  const [last, setLast] = useState<Bar | null>(null)
  useEffect(() => { setLast(load.bars.length ? load.bars[load.bars.length - 1]! : null) }, [load.id])
  useSubscribe('market.candles', (e) => {
    const ev = candleEvent(e.data)
    if (!ev || ev.instrumentId !== active || ev.interval !== interval || !ready || off) return
    barsRef.current = mergeBars(barsRef.current, ev.bars)
    for (const b of ev.bars) handleRef.current?.update(b)
    setLast(barsRef.current[barsRef.current.length - 1] ?? null)
    setLiveTick((t) => t + 1)
  })

  // ---- 成交标记 ---------------------------------------------------------------------------
  const marks = useFills(active, ready ? load.bars : null, load.id)
  const specs = useMemo(() => (ready ? markerSpecs(marks.rows, barsRef.current, interval, new Set(shown)) : []), [marks.rows, ready, load.id, shown, interval])
  const lastPx = lastClose(barsRef.current)
  const lines = useMemo(() => (ready && active ? priceLines({ instrumentId: active, positions: snap.positions, orders: snap.orders, proposals: snap.proposals, last: lastPx }) : []),
    [ready, active, snap.positions, snap.orders, snap.proposals, lastPx === null ? 0 : Math.round(lastPx)])

  // ---- 图表实例 ---------------------------------------------------------------------------
  const plotRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  /** 图表库是异步加载的：实例就绪后加 1，让下面「把数据送进图」的几条 effect 重跑。 */
  const [chartUp, setChartUp] = useState(0)
  /** 图表库自己加载失败（动态 import）：当成 'error' 显示，重试时清掉。 */
  const [chartErr, setChartErr] = useState<Error | null>(null)
  const [cross, setCross] = useState<number | null>(null)
  const [hoverAt, setHover] = useState<MarkerHover | null>(null)
  const hideTimer = useRef(0)
  const hover = useRef<MarkerHover | null>(null)
  useEffect(() => {
    const el = plotRef.current
    if (!ready || !el) return undefined
    let dead = false
    let h: ChartHandle | null = null
    setChartErr(null)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => h?.resize()) : null
    // 指针离开绘图区（不是进读数卡）= 收起读数卡；库只在标记之间移动时才发 onMouseLeave
    const leave = () => { clearTimeout(hideTimer.current); hideTimer.current = window.setTimeout(() => setHover(null), 180) }
    const move = (e: PointerEvent) => {
      const m = h?.markerAt(e.clientX, e.clientY) ?? null
      el.style.cursor = m ? 'pointer' : ''
      if (m) { clearTimeout(hideTimer.current); hideTimer.current = 0; setHover((cur) => (cur && cur.id === m.id && cur.x === m.x && cur.y === m.y ? cur : m)) } else if (hover.current && !hideTimer.current) leave()
    }
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointermove', move)
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => h?.restyle()) : null
    void createChart(el, {
      onCrosshair: (ts) => setCross(ts),
    }).then((made) => {
      if (dead) { made.dispose(); return }
      h = made
      handleRef.current = made
      ro?.observe(el)
      mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-updown', 'data-theme', 'data-ui'] })
      setChartUp((n) => n + 1)
    }, (e: unknown) => { if (!dead) setChartErr(errOf(e)) })
    return () => { dead = true; clearTimeout(hideTimer.current); el.removeEventListener('pointerleave', leave); el.removeEventListener('pointermove', move); ro?.disconnect(); mo?.disconnect(); h?.dispose(); if (handleRef.current === h) handleRef.current = null }
  }, [ready])
  useEffect(() => {
    if (!ready || !active) return
    handleRef.current?.setSeries({ ticker: symbolName(active), interval, bars: load.bars, pricePrecision: places })
    handleRef.current?.setVolume(indicators.includes('vol'))
  }, [ready, load.id, chartUp])
  useEffect(() => { if (ready) handleRef.current?.setVolume(indicators.includes('vol')) }, [ready, indicators, chartUp])
  useEffect(() => { if (ready) handleRef.current?.setMarkers(specs) }, [ready, specs, chartUp])
  // 持仓 / 挂单价签与记录页、总览同走标的价格规则（release-r1 P1-11）
  const lineRule = prices.rule(active ?? undefined)
  useEffect(() => { if (ready) handleRef.current?.setLines(lines, lineRule ? (p) => formatPrice(p, lineRule) : undefined) }, [ready, lines, chartUp, lineRule])

  // ---- 读数 -------------------------------------------------------------------------------
  const crossBar = cross !== null && ready ? barsRef.current[barIndexAt(barsRef.current, cross, INTERVAL_MS[interval])] ?? null : null
  const ro = readout(crossBar ?? last, places)
  const pct = changePct(prevClose, last?.close ?? null)
  const venue = active ? venueOfInstrument(active) : ''
  const venues = useVenues(bridge)
  const unverified = venue !== '' && venues.has(venue)

  const pickInterval = (i: Interval) => { setIntervalState(i); persist({ interval: i }) }
  const toggleInd = (id: string) => { const n = indicators.includes(id) ? indicators.filter((x) => x !== id) : [...indicators, id]; setIndicators(n); persist({ indicators: n }) }
  const toggleActor = (k: ActorKind) => { const n = shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k]; setShown(n); persist({ markers: n }) }
  const focusSearch = () => { window.dispatchEvent(new CustomEvent('gitrader:focus', { detail: { card: 'symbols-search' } })) }

  // ---- 卡头 -------------------------------------------------------------------------------
  const nameBlock = <>
    <h2 className="g5-symh g5-al" data-bl="hd">{active ? names.nameOf(active) : tr('图表')}</h2>
    {venue ? <VenueIcon venue={venue} label={VENUE_NAME[venue] ?? venue} size="lg" /> : null}
    {unverified ? <span className="g5-unv" title={UNVERIFIED_WHY}>{tr('未验证')}</span> : null}
  </>
  const head = <header className="g5-hd" data-geo="chart.head"><div className="g5-hrow">
    {nameBlock}
    {ready && !off ? <>
      <div className="g5-tabs" role="tablist" aria-label={tr('周期')}>
        {INTERVALS.map((i) => <button key={i} className="g5-tab" role="tab" data-iv={i} aria-selected={i === interval} data-bl={i === interval ? 'hd' : undefined} disabled={off} onClick={() => pickInterval(i)}>{i}</button>)}
      </div>
      <div className="g5-tools">
        <Menu label={tr('指标')} disabled={off} className="g5-menu g5-glass" trigger={<button className="g5-btn g5-btn-ghost" data-menu="indicators" disabled={off}>{tr('指标')}<Chev /></button>}
          items={INDICATOR_ITEMS.map((it) => ({
            id: it.id, disabled: !it.wired, onSelect: () => toggleInd(it.id),
            label: <span className={`g5-lbl${it.wired ? '' : ' g5-dis'}`}>{it.label}</span>,
            hint: it.wired ? <span className={`g5-sw${indicators.includes(it.id) ? ' g5-on' : ''}`} /> : <span className="g5-s12">{tr('未接通')}</span>,
          }))} />
        <Menu label={tr('标记')} disabled={off} className="g5-menu g5-glass" trigger={<button className="g5-btn g5-btn-ghost" data-menu="markers" disabled={off}>{tr('标记')}<Chev /></button>}
          items={ACTOR_KINDS.map((k) => ({
            id: k, onSelect: () => toggleActor(k),
            label: <span className="g5-mi g5-mi-bare"><Swatch kind={k} /><span className="g5-lbl">{ACTOR_LABEL[k]}</span></span>,
            hint: marks.error && k === ACTOR_KINDS[0] ? <span className="g5-s12 g5-danger" data-marks-err="">{wireState(marks.error) === 'off' ? tr('未接通') : tr('读取失败')}</span> : <span className={`g5-sw${shown.includes(k) ? ' g5-on' : ''}`} />,
          }))} />
      </div>
    </> : null}
    {ready ? <div className="g5-r">
      {off ? <PausedFor since={since} /> : null}
      <span className="g5-last" data-bl="hdp" data-n="last">{last ? fmtNum(last.close, places) : tr('未设')}</span>
      <span className={`g5-s12 ${off ? 'g5-t3' : pctTone(pct) === 'up' ? 'g5-up' : pctTone(pct) === 'down' ? 'g5-down' : 'g5-t2'}`} data-bl="hdp" data-redge="价格块" data-n="chg">{pct === null ? '' : fmtPct(pct)}</span>
    </div> : load.phase === 'loading' ? <div className="g5-r"><span className="g5-sk g5-sk-price" /></div> : null}
  </div></header>

  const shell = (children: ComponentChildren) => <Card head={head} className="g5-grow" data-page="chart" data-g5-page="chart" data-geo="chart.card">{children}</Card>

  // 加载阶段（nosource / noperiod / unwired 另有文案，先判）；error 压过 ready，图表库加载失败也算 error。
  const phase = chartPhase({ startedAt: load.startedAt, now: Date.now(), candles: load.bars.length > 0 ? load.bars.length : null, error: load.error?.message ?? chartErr?.message ?? null })
  // 重试 = 清错误 + 重置 startedAt（重新计 8 秒）+ 重新请求 market.candles。
  const retry = () => { setChartErr(null); setLoad((l) => ({ ...idle(key), id: l.id + 1 })); setNonce((n) => n + 1) }

  if (source === 'run') return shell(<div className="g5-pstate"><Unwired message={tr('回测图表（source: run）还没有接入')} /></div>)
  if (!active) return shell(<Empty message={tr('还没有选定标的')} />)
  if (load.key !== key) return shell(<>
    <div className="g5-ohlc"><span className="g5-sk g5-al g5-sk-ohlc" /></div><div className="g5-ghostplot" aria-busy="true" data-state="loading" />
  </>)
  if (load.phase === 'nosource') return shell(<div className="g5-pstate" data-state="nosource"><span className="g5-al">{tr('该场所没有 K 线数据')}</span><button className="g5-btn g5-btn-fill" data-act="change-symbol" onClick={focusSearch}>{tr('换标的')}</button></div>)
  if (load.phase === 'noperiod') return shell(<div className="g5-pstate" data-state="noperiod"><span className="g5-al">{tr('这个周期没有数据')}</span></div>)
  if (load.phase === 'unwired') return shell(<div className="g5-pstate"><Unwired message={load.error?.message ?? ''} /></div>)
  if (phase === 'error' || phase === 'timeout') {
    // fix-r4 D1：不再用「加载失败」红字大标题；人话原因在前，上游原文放进可展开的详情（不改写、不丢弃）。
    const why = load.error ?? chartErr
    const raw = why?.message ?? ''
    return shell(<div className="g5-pstate" data-state="error"><span className="g5-al">{tr('暂时取不到 K 线：')}{why ? whyText(why) : tr('行情服务 12 秒没有返回')}</span>
      {raw ? <details className="g5-msg" data-act="error-detail"><summary>{tr('详情')}</summary>{raw}</details> : null}
      <button className="g5-btn g5-btn-fill" data-act="retry" onClick={retry}>{tr('重试')}</button></div>)
  }
  if (phase === 'slow') return shell(<div className="g5-pstate" data-state="slow"><span className="g5-al">{tr('行情加载慢')}</span>
    <button className="g5-btn g5-btn-fill" data-act="retry" onClick={retry}>{tr('重试')}</button></div>)
  if (phase === 'loading') return shell(<>
    <div className="g5-ohlc"><span className="g5-sk g5-al g5-sk-ohlc" /></div><div className="g5-ghostplot" aria-busy="true" data-state="loading" />
  </>)

  hover.current = hoverAt
  const card = hoverAt ? specs.find((m) => m.id === hoverAt.id) ?? null : null
  const body = <>
    <div className="g5-ohlc" id="ohlc" data-live={liveTick} data-geo="chart.ohlc">
      <span className="g5-al"><b>O</b><i data-k="open" data-bl="r2">{ro.open}</i></span><span><b>H</b><i data-k="high">{ro.high}</i></span><span><b>L</b><i data-k="low">{ro.low}</i></span><span><b>C</b><i data-k="close">{ro.close}</i></span><span><b>V</b><i data-k="vol">{ro.vol}</i></span>
      <span className="g5-legend" aria-label={tr('成交标记执行方')}>
        {ACTOR_KINDS.map((k) => <span key={k} data-legend={k} data-bl={k === 'system' ? 'r2' : undefined} data-redge={k === 'system' ? tr('图例') : undefined}><i className={`${dotClass(k)}${shown.includes(k) ? '' : ' g5-off'}`} />{ACTOR_LABEL[k]}</span>)}
      </span>
    </div>
    <div className="g5-lwc-host" data-geo="chart.plot">
      <div className="g5-plot" ref={plotRef} data-chart-host="" />
      {card && hoverAt ? <MarkerCard priceText={prices.price(card.price, active ?? undefined)} spec={card} at={hoverAt} hostRef={plotRef} onEnter={() => clearTimeout(hideTimer.current)} onLeave={() => setHover(null)}
        onRecords={() => { try { setAccountLink(card.accountId) } catch { /* 无联动写权限 */ } location.hash = '#/records' }} /> : null}
    </div>
  </>
  return shell(<div className={`g5-pbody${off ? ' g5-off' : ''}`} data-state={off ? 'offline' : undefined}>{body}</div>)
}

// ---- 成交读数卡 -----------------------------------------------------------------------------

function MarkerCard({ priceText, spec, at, hostRef, onEnter, onLeave, onRecords }: { priceText: string; spec: MarkerSpec; at: MarkerHover; hostRef: { current: HTMLElement | null }; onEnter(): void; onLeave(): void; onRecords(): void }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const c = el.current, host = hostRef.current
    if (!c || !host) return
    const w = c.offsetWidth, h = c.offsetHeight
    let left = at.x - 16 - w
    if (left < 8) left = at.x + 16
    c.style.left = `${Math.round(Math.min(left, host.clientWidth - w - 8))}px`
    c.style.top = `${Math.round(Math.max(8, Math.min(at.y - h / 2, host.clientHeight - h - 8)))}px`
  }, [at.x, at.y, spec.id])
  return <div ref={el} className="g5-mcard g5-glass g5-chart" role="tooltip" data-mcard={spec.id} onPointerEnter={onEnter} onPointerLeave={onLeave}>
    <div className="g5-m1"><i className={dotClass(spec.actor)} />{spec.actorName}{spec.hollow ? tr(' 回测') : ''}<span className="g5-tm">{fmtDay(spec.ts)} {fmtHms(spec.ts)}</span></div>
    <div className="g5-m2"><span className="g5-act" data-n="mp">{sideWord(spec.side)} {fmtQty(spec.size)} @ {priceText}</span><span className="g5-s12 g5-t3">{tr('费 ')}{spec.fee === '' ? tr('未设') : fmtMoney(spec.fee)}</span></div>
    <div className="g5-m3"><span>{spec.source}</span><button type="button" className="g5-btn g5-btn-ghost g5-lnk" data-act="in-records" onClick={onRecords}>{tr('在记录中查看')}</button></div>
  </div>
}

// ---- 数据钩子 -------------------------------------------------------------------------------

/** 没有任何标的时的缺省：品种表第一个（持仓标的由快照给，这里只在完全空白时才查）。 */
function useFallbackInstrument(need: boolean): string | null {
  const bridge = useBridge()
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    if (!need) return undefined
    let dead = false
    queryRetry<unknown>(bridge, 'market.instruments', { limit: 1 }, () => !dead).then(
      (raw) => { const l = Array.isArray(raw) ? raw : []; const f = l[0] as { instrumentId?: string } | undefined; if (!dead && f?.instrumentId) setId(f.instrumentId) },
      () => { /* 缺省只是补充 */ },
    )
    return () => { dead = true }
  }, [bridge, need])
  return id
}

/** 离线 → 在线时补一次重读。 */
function useOfflineBack(off: boolean, back: () => void): void {
  const was = useRef(off)
  useEffect(() => { if (was.current && !off) back(); was.current = off }, [off])
}

function useVenues(bridge: ReturnType<typeof useBridge>): Set<string> {
  const [set, setSet] = useState<Set<string>>(new Set())
  useEffect(() => {
    let dead = false
    queryRetry<unknown>(bridge, 'venue.status', undefined, () => !dead).then((raw) => { if (!dead) setSet(unverifiedVenues(raw)) }, () => { /* 场所状态只是补充 */ })
    return () => { dead = true }
  }, [bridge])
  return set
}

/** 本标的的成交（records.query {kind:'fill'}，游标续读到图上最早一根为止，最多 5 页）。标记层失败不拖垮主图，只把原文留给标记菜单。 */
function useFills(instrumentId: string | null, bars: readonly Bar[] | null, tick: number): { rows: MarkerFill[]; error: Error | null } {
  const bridge = useBridge()
  const [st, setSt] = useState<{ rows: FillRow[]; error: Error | null }>({ rows: [], error: null })
  const [n, setN] = useState(0)
  const timer = useRef(0)
  useSubscribe('account.fills', () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => setN((x) => x + 1), 500) })
  useEffect(() => () => clearTimeout(timer.current), [])
  const since = bars?.[0]?.timestamp
  useEffect(() => {
    if (!instrumentId || since === undefined) { setSt({ rows: [], error: null }); return undefined }
    let dead = false
    ;(async () => {
      const keys = await queryRetry<unknown>(bridge, 'agentkey.list', undefined, () => !dead).catch(() => [])
      const names = agentNames(keys)
      let rows: FillRow[] = []
      let cursor: string | undefined
      const now = Date.now()
      for (let page = 0; page < 5; page += 1) {
        const raw = await queryRetry<unknown>(bridge, 'records.query', { ...queryParams('fill', { range: 'all', instrumentId }, now, cursor, 200), sinceTs: since }, () => !dead)
        const p = pageOf('fills', raw, { names })
        if (p.error !== null) throw new Error(p.error)
        rows = mergeRows(rows, p.rows as FillRow[])
        if (!p.next) break
        cursor = p.next
      }
      if (!dead) setSt({ rows, error: null })
    })().catch((e: unknown) => { if (!dead) setSt({ rows: [], error: errOf(e) }) })
    return () => { dead = true }
  }, [bridge, instrumentId, since, tick, n])
  const rows = useMemo<MarkerFill[]>(() => st.rows, [st.rows])
  return { rows, error: st.error }
}

