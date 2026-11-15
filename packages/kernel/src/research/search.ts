// SPDX-License-Identifier: CPAL-1.0
// research.search：标的搜索。目录用内核已加载的场所目录（k.bus.instruments()），拿不到网就是空目录；排序 / 过滤用 @gitrader/symbol-search。
import { buildIndex, searchSymbols } from '@gitrader/symbol-search'
import type { InstrumentKind } from '../proto'
import type { Kernel } from '../kernel'
import { page, positiveInt } from './args'

export function searchInstruments(k: Kernel, args: Record<string, unknown>): { items: unknown[]; total: number; next?: string } {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { items: [], total: 0 }
  const instruments = k.bus.instruments()
  const base = new Map(instruments.map((i) => [i.instrumentId, i.base]))
  const venues = typeof args.venue === 'string' && args.venue ? [args.venue] : undefined
  const kinds = typeof args.kind === 'string' && args.kind ? [args.kind as InstrumentKind] : undefined
  const hits = searchSymbols(buildIndex({ instruments }), query, { limit: 1_000_000, filter: { ...(venues ? { venues } : {}), ...(kinds ? { kinds } : {}) } })
  const p = page(hits.length, args.cursor, positiveInt(args.limit, 20, 200))
  return {
    items: hits.slice(p.from, p.to).map((h) => ({
      instrumentId: h.record.instrumentId, venue: h.record.venue, symbol: h.record.symbol, base: base.get(h.record.instrumentId) ?? '', quote: h.record.quote, kind: h.record.kind,
      score: Number((1 - h.rank / 7).toFixed(3)), match: h.matchKind,
    })),
    total: hits.length,
    ...(p.to < hits.length ? { next: String(p.to) } : {}),
  }
}
