// SPDX-License-Identifier: CPAL-1.0
// 标的卡（块 symbols）：搜索框 + 自选列表（持仓标的置顶 → 最近查看 → 手动加入），每行 名称 / 场所 / 最新价 / 当日涨跌；点行 = 写 symbol 联动。
// 数据只经桥：instruments.search（搜索）、market.quote（最新价，市场事件增量）、market.candles 1d 取 2 根（前收 → 涨跌幅）、account.* 只为找出持仓标的。
// 手动加入与最近查看存在块的 config（watch / recent），由宿主持久化；没有宿主（预览）时只在本页内有效。
import type { BlockProps } from '@gitrader/blocks-sdk'
import { useBridge, useLink, useSubscribe } from '@gitrader/blocks-sdk/preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { queryRetry, useOffline } from '../../../blocks-default/src/hooks'
import { VENUE_NAME } from '../../../blocks-default/src/labels'
import { normalizeAccounts, normalizePositions } from '../../../blocks-default/src/model-positions'
import { Card, Empty, VenueIcon } from '../kit'
import { addWatch, changePct, fmtPct, normalizeCandles, pctTone, pushRecent, quotePrice, searchHits, stringList, symbolRows, type SymbolRow } from '../model-chart'
import { fmtPrice } from '../model-records'
import { PausedFor, useInstruments, useOfflineSince } from './symbol-positions'
import './chart.css'
import { t as tr } from '@gitrader/workbench/i18n'

const SearchIcon = () => <svg className="g5-i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
const CloseIcon = () => <svg className="g5-i g5-i12" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>

/** 持仓标的（所有账户的并集）。事件只触发重读。 */
function usePositionInstruments(): string[] {
  const bridge = useBridge()
  const [ids, setIds] = useState<string[]>([])
  const [n, setN] = useState(0)
  const timer = useRef(0)
  useSubscribe('account.positions', () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => setN((x) => x + 1), 300) })
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    let dead = false
    ;(async () => {
      const accounts = normalizeAccounts(await queryRetry(bridge, 'account.list', undefined, () => !dead))
      const lists = await Promise.all(accounts.map((a) => queryRetry(bridge, 'account.positions', { accountId: a.accountId }, () => !dead).then(normalizePositions, () => [])))
      if (!dead) setIds([...new Set(lists.flat().map((p) => String(p.instrumentId)))])
    })().catch(() => { /* 持仓只决定置顶，读不到不挡列表 */ })
    return () => { dead = true }
  }, [bridge, n])
  return ids
}

interface Quote { px: string | null; ch: number | null }
/** 每行的最新价与当日涨跌。价格先查一次再收 market.quote 事件；前收取 1d 倒数第二根。单行读不到只是那行留空。 */
function useQuotes(ids: readonly string[]): Record<string, Quote> {
  const bridge = useBridge()
  const [prev, setPrev] = useState<Record<string, number | null>>({})
  const [px, setPx] = useState<Record<string, string | null>>({})
  const key = ids.join('|')
  useSubscribe('market.quote', (e) => {
    const d = e.data as { instrumentId?: string }
    const p = quotePrice(e.data)
    if (d?.instrumentId && p !== null && ids.includes(d.instrumentId)) setPx((m) => ({ ...m, [d.instrumentId!]: String(p) }))
  })
  useEffect(() => {
    let dead = false
    for (const id of ids) {
      queryRetry<unknown>(bridge, 'market.quote', { instrumentId: id }, () => !dead).then(
        (raw) => { const p = quotePrice(raw); const s = raw && typeof (raw as { price?: unknown }).price === 'string' ? (raw as { price: string }).price : p === null ? null : String(p); if (!dead) setPx((m) => ({ ...m, [id]: s })) },
        () => { if (!dead) setPx((m) => ({ ...m, [id]: null })) },
      )
      queryRetry<unknown>(bridge, 'market.candles', { instrumentId: id, interval: '1d', limit: 2 }, () => !dead).then(
        (raw) => { const b = normalizeCandles(raw); if (!dead) setPrev((m) => ({ ...m, [id]: b.length >= 2 ? b[b.length - 2]!.close : null })) },
        () => { if (!dead) setPrev((m) => ({ ...m, [id]: null })) },
      )
    }
    return () => { dead = true }
  }, [bridge, key])
  return useMemo(() => Object.fromEntries(ids.map((id) => [id, { px: px[id] ?? null, ch: changePct(prev[id], px[id] === undefined || px[id] === null ? null : Number(px[id])) }])), [ids, px, prev])
}

export function SymbolsView({ config, setConfig }: BlockProps) {
  const bridge = useBridge()
  const off = useOffline()
  const since = useOfflineSince(off)
  const [current, setSymbol] = useLink<string>('symbol')
  const held = usePositionInstruments()
  const names = useInstruments()
  const [watch, setWatch] = useState<string[]>(stringList(config?.watch))
  const [recent, setRecent] = useState<string[]>(stringList(config?.recent))
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Array<{ instrumentId: string; symbol: string; venue: string }>>([])
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const persist = useCallback((patch: Record<string, unknown>) => { try { setConfig?.({ ...(config ?? {}), ...patch }) } catch { /* 预览里没有宿主 */ } }, [config, setConfig])

  // 当前标的（路由 / 别的卡写进来的）也进「最近查看」，这样直接打开 #/chart/<id> 时列表里能看到它。
  useEffect(() => {
    if (typeof current !== 'string' || !current) return
    setRecent((r) => { if (r[0] === current) return r; const n = pushRecent(r, current); persist({ recent: n }); return n })
  }, [current])

  const rows = useMemo(() => symbolRows({ positions: held, recent, watch }), [held, recent, watch])
  const quotes = useQuotes(useMemo(() => rows.map((r) => r.instrumentId), [rows.map((r) => r.instrumentId).join('|')]))
  const searchRef = useRef<HTMLInputElement>(null)

  // 「换标的」把焦点交给搜索框
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<{ card?: string }>).detail?.card === 'symbols-search') searchRef.current?.focus() }
    window.addEventListener('gitrader:focus', on)
    return () => window.removeEventListener('gitrader:focus', on)
  }, [])

  useEffect(() => {
    const text = q.trim()
    if (!text) { setHits([]); setSearchErr(null); return undefined }
    let dead = false
    const t = setTimeout(() => {
      queryRetry<unknown>(bridge, 'instruments.search', { q: text, limit: 8 }, () => !dead).then(
        (raw) => { if (!dead) { setHits(searchHits(raw)); setSearchErr(null) } },
        (e: unknown) => { if (!dead) { setHits([]); setSearchErr(e instanceof Error ? e.message : String(e)) } },
      )
    }, 200)
    return () => { dead = true; clearTimeout(t) }
  }, [bridge, q])

  const pick = (id: string) => { try { setSymbol(id) } catch { /* 清单没给联动写权限 */ } }
  const pickHit = (id: string) => {
    const w = addWatch(watch, id)
    setWatch(w)
    persist({ watch: w })
    setQ('')
    pick(id)
  }
  const remove = (id: string) => { const w = watch.filter((x) => x !== id); const r = recent.filter((x) => x !== id); setWatch(w); setRecent(r); persist({ watch: w, recent: r }) }

  const head = <header className="g5-hd" data-geo="symbols.head"><h2 className="g5-al">{tr('标的')}</h2>
    <div className="g5-r">
      {off ? <PausedFor since={since} /> : null}
      <label className="g5-inp g5-s g5-l g5-srch"><SearchIcon /><input ref={searchRef} value={q} placeholder={tr('搜索标的')} aria-label={tr('搜索标的')} disabled={off} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
    </div>
  </header>

  const list = rows.length === 0
    ? <Empty message={tr('没有自选标的')} />
    : <div className={`g5-slist${off ? ' g5-off' : ''}`} role="listbox" aria-label={tr('自选标的')} data-state={off ? 'offline' : undefined}>
      {rows.map((r, i) => <Row key={r.instrumentId} geo={i === 0} name={names.nameOf(r.instrumentId)} row={r} quote={quotes[r.instrumentId]} selected={r.instrumentId === current} off={off} removable={!r.pinned && (watch.includes(r.instrumentId) || recent.includes(r.instrumentId))} onPick={() => pick(r.instrumentId)} onRemove={() => remove(r.instrumentId)} />)}
    </div>
  const results = q.trim() ? <div className="g5-hits" role="listbox" aria-label={tr('搜索结果')} data-hits="">
    {searchErr ? <span className="g5-msg g5-danger" role="alert">{searchErr}</span>
      : hits.length === 0 ? <span className="g5-t3 g5-s12">{tr('没有匹配的标的')}</span>
        : hits.map((h) => <button key={h.instrumentId} type="button" role="option" className="g5-hit" data-hit={h.instrumentId} onClick={() => pickHit(h.instrumentId)}>
          <span className="g5-sym">{h.symbol}</span><VenueIcon venue={h.venue} label={VENUE_NAME[h.venue] ?? h.venue} /></button>)}
  </div> : null
  return <Card head={head} data-page="chart" data-g5-page="chart-symbols" data-geo="symbols.card">{results}{list}</Card>
}

function Row({ row, name, geo, quote, selected, off, removable, onPick, onRemove }: { row: SymbolRow; name: string; geo: boolean; quote: Quote | undefined; selected: boolean; off: boolean; removable: boolean; onPick(): void; onRemove(): void }) {
  const t = off ? 'flat' : pctTone(quote?.ch ?? null)
  return <div className="g5-srow" role="option" aria-selected={selected} tabIndex={0} data-sym={row.instrumentId} data-geo={geo ? 'symbols.row1' : undefined} onClick={onPick}
    onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick() } }}>
    <span className="g5-nm"><span className="g5-sym g5-al">{name}</span>{row.venue ? <VenueIcon venue={row.venue} label={VENUE_NAME[row.venue] ?? row.venue} /> : null}
      {removable ? <button type="button" className="g5-rm" aria-label={tr('移除')} data-act="remove" onClick={(e) => { e.stopPropagation(); onRemove() }}><CloseIcon /></button> : null}</span>
    <span className="g5-px" data-n="px">{quote?.px ? fmtPrice(quote.px) : ''}</span>
    <span className={`g5-ch ${t === 'up' ? 'g5-up' : t === 'down' ? 'g5-down' : 'g5-t2'}`} data-n="ch">{quote?.ch === null || quote === undefined ? '' : fmtPct(quote.ch)}</span>
  </div>
}
