// SPDX-License-Identifier: CPAL-1.0
// 测试用构造器：只拼视图，不做任何判定。所有时间都相对 NOW 写死，保证用例可复现。
import type {
  AmendLink, LocalFillView, LocalOrderView, LocalPositionView, ReconcileInput, ReconcileOptions, ReconcileReport,
  VenueFillView, VenueOrderView, VenuePositionView, VenueView,
} from '../src/types'

export const NOW = 1_769_000_000_000
export const ACCOUNT = 'acct_01TEST'

export function localOrder(over: Partial<LocalOrderView> = {}): LocalOrderView {
  return {
    orderId: 'o-1',
    clientOrderId: 'gt-1',
    venueOrderId: 'v-1',
    instrumentId: 'test:BTC',
    side: 'buy',
    type: 'limit',
    size: '0.1',
    filledSize: '0',
    price: '100',
    status: 'open',
    createdAt: NOW - 60_000,
    ...over,
  }
}

export function localFill(over: Partial<LocalFillView> = {}): LocalFillView {
  return {
    venueFillId: 'f-1',
    orderId: 'o-1',
    clientOrderId: 'gt-1',
    venueOrderId: 'v-1',
    instrumentId: 'test:BTC',
    side: 'buy',
    price: '100',
    size: '0.05',
    ts: NOW - 30_000,
    ...over,
  }
}

export function venueOpen(over: Partial<VenueOrderView> = {}): VenueOrderView {
  return {
    venueOrderId: 'v-1',
    clientOrderId: 'gt-1',
    instrumentId: 'test:BTC',
    side: 'buy',
    type: 'Limit',
    size: '0.1',
    origSize: '0.1',
    filledSize: '0',
    price: '100',
    status: 'open',
    source: 'open',
    createdAt: NOW - 60_000,
    ...over,
  }
}

export function venueHistory(over: Partial<VenueOrderView> = {}): VenueOrderView {
  return venueOpen({ source: 'history', status: 'filled', filledSize: '0.1', size: '0', ...over })
}

export function venueFill(over: Partial<VenueFillView> = {}): VenueFillView {
  return {
    venueFillId: 'f-1',
    venueOrderId: 'v-1',
    clientOrderId: 'gt-1',
    instrumentId: 'test:BTC',
    side: 'buy',
    price: '100',
    size: '0.05',
    ts: NOW - 30_000,
    ...over,
  }
}

export function longPosition(over: Partial<LocalPositionView> = {}): LocalPositionView {
  return { instrumentId: 'test:BTC', side: 'long', size: '0.1', entryPrice: '100', marginMode: 'cross', ...over }
}

export function shortPosition(over: Partial<LocalPositionView> = {}): LocalPositionView {
  return { instrumentId: 'test:BTC', side: 'short', size: '0.1', entryPrice: '100', marginMode: 'cross', ...over }
}

export function venuePositionOf(pos: LocalPositionView): VenuePositionView {
  return { ...pos }
}

export function view(over: Partial<VenueView> = {}): VenueView {
  return { openOrders: [], historyOrders: [], fills: [], positions: [], asOf: NOW, ...over }
}

export function input(over: {
  orders?: LocalOrderView[]
  fills?: LocalFillView[]
  positions?: LocalPositionView[]
  venue?: Partial<VenueView>
  links?: AmendLink[]
  localAsOf?: number
} = {}): ReconcileInput {
  return {
    local: {
      accountId: ACCOUNT,
      orders: over.orders ?? [],
      fills: over.fills ?? [],
      positions: over.positions ?? [],
      asOf: over.localAsOf ?? NOW,
    },
    venue: view(over.venue),
    ...(over.links ? { links: over.links } : {}),
  }
}

export function options(over: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return { now: NOW, staleAfterMs: 10 * 60_000, ...over }
}

export function codes(report: ReconcileReport): string[] {
  return report.findings.map((f) => f.code)
}

export function finding(report: ReconcileReport, code: string) {
  return report.findings.find((f) => f.code === code)
}

export function findings(report: ReconcileReport, code: string) {
  return report.findings.filter((f) => f.code === code)
}
