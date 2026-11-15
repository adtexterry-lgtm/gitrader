// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error The shell hook is JavaScript and has no declaration file.
import { go, parseRoute } from '../src/shell/hooks.js'
import * as presets from '../src/core/presets'

type Page = 'workbench' | 'chart' | 'records' | 'funds' | 'plugins' | 'strategies' | 'lab' | 'lab-detail' | 'venues' | 'notify'
type PageItem = { instanceId: string; block: string; config: Record<string, unknown> }
type PageWorkspaceApi = {
  pageWorkspace?: (page: string) => { id: string; items: Array<{ instanceId: string; block: string; config?: Record<string, unknown> }> }
  PAGE_AREAS?: Record<Page, Record<string, 'left' | 'right' | 'full'>>
  PAGE_LAYOUT?: Record<Page, 'two' | 'single'>
  PAGE_COLUMNS?: Record<Page, { left: string[]; right: string[]; full: string[] }>
}
const pageApi = presets as unknown as PageWorkspaceApi
const pageItem = (instanceId: string, block: string, config: Record<string, unknown> = {}): PageItem => ({
  instanceId, block: `block.gitrader.${block}@0.1.0`, config,
})

const PAGE_ITEMS: Record<Page, PageItem[]> = {
  workbench: [
    pageItem('bi_positions_1', 'positions'), pageItem('bi_agent_feed_1', 'agent-activity', { view: 'feed' }),
    pageItem('bi_agent_keys_1', 'agent-activity', { view: 'keys' }), pageItem('bi_risk_1', 'risk'),
  ],
  chart: [
    pageItem('bi_chart_1', 'chart', { source: 'live', interval: '15m', indicators: [] }), pageItem('bi_symbols_1', 'symbols'),
    pageItem('bi_symbol_positions_1', 'positions', { view: 'symbol' }), pageItem('bi_ticket_1', 'positions', { view: 'ticket' }),
  ],
  records: [pageItem('bi_audit_1', 'audit')],
  funds: [
    pageItem('bi_equity_accounts_1', 'equity', { view: 'accounts' }), pageItem('bi_equity_curve_1', 'equity', { view: 'curve' }),
    pageItem('bi_equity_assets_1', 'equity', { view: 'assets' }), pageItem('bi_equity_margin_1', 'equity', { view: 'margin' }),
    pageItem('bi_equity_changes_1', 'equity', { view: 'changes' }), pageItem('bi_equity_portfolio_1', 'equity', { view: 'portfolio' }),
  ],
  plugins: [pageItem('bi_plugins_1', 'plugins')],
  strategies: [
    pageItem('bi_strategies_1', 'strategies', { view: 'list' }), pageItem('bi_engines_1', 'strategies', { view: 'engines' }),
    pageItem('bi_strategy_events_1', 'strategies', { view: 'events' }),
  ],
  lab: [pageItem('bi_lab_list_1', 'lab', { view: 'list' })],
  'lab-detail': [
    pageItem('bi_lab_head_1', 'lab', { view: 'head' }), pageItem('bi_lab_forward_1', 'lab', { view: 'tier', tier: 'forward' }),
    pageItem('bi_lab_holdout_1', 'lab', { view: 'tier', tier: 'holdout' }), pageItem('bi_lab_backtest_1', 'lab', { view: 'tier', tier: 'backtest' }),
    pageItem('bi_lab_assumptions_1', 'lab', { view: 'assumptions' }), pageItem('bi_lab_bias_1', 'lab', { view: 'bias' }),
    pageItem('bi_lab_data_1', 'lab', { view: 'data' }),
  ],
  venues: [
    pageItem('bi_venues_1', 'venues', { view: 'venues' }), pageItem('bi_accounts_1', 'venues', { view: 'accounts' }),
    pageItem('bi_catalog_1', 'venues', { view: 'catalog' }), pageItem('bi_venue_detail_1', 'venues', { view: 'detail' }),
  ],
  notify: [
    pageItem('bi_notify_channels_1', 'notify', { view: 'channels' }), pageItem('bi_notify_rules_1', 'notify', { view: 'rules' }),
    pageItem('bi_notify_detail_1', 'notify', { view: 'detail' }),
  ],
}
const PAGE_COLUMNS: Record<Page, { left: string[]; right: string[]; full: string[] }> = {
  workbench: { left: ['bi_positions_1', 'bi_agent_feed_1'], right: ['bi_risk_1', 'bi_agent_keys_1'], full: [] },
  chart: { left: ['bi_chart_1'], right: ['bi_symbols_1', 'bi_ticket_1', 'bi_symbol_positions_1'], full: [] },
  records: { left: [], right: [], full: ['bi_audit_1'] },
  funds: { left: ['bi_equity_accounts_1', 'bi_equity_curve_1', 'bi_equity_portfolio_1'], right: ['bi_equity_assets_1', 'bi_equity_margin_1', 'bi_equity_changes_1'], full: [] },
  plugins: { left: [], right: [], full: ['bi_plugins_1'] },
  strategies: { left: ['bi_strategies_1'], right: ['bi_engines_1', 'bi_strategy_events_1'], full: [] },
  lab: { left: [], right: [], full: ['bi_lab_list_1'] },
  'lab-detail': { left: ['bi_lab_forward_1', 'bi_lab_holdout_1', 'bi_lab_backtest_1'], right: ['bi_lab_assumptions_1', 'bi_lab_bias_1', 'bi_lab_data_1'], full: ['bi_lab_head_1'] },
  venues: { left: ['bi_venues_1', 'bi_accounts_1', 'bi_catalog_1'], right: ['bi_venue_detail_1'], full: [] },
  notify: { left: ['bi_notify_channels_1', 'bi_notify_rules_1'], right: ['bi_notify_detail_1'], full: [] },
}

describe('r5 routes', () => {
  it('accepts the supported pages and keeps lab identifiers as params', () => {
    for (const id of ['workbench', 'chart', 'records', 'funds', 'plugins', 'strategies', 'lab', 'settings', 'popout']) {
      expect(parseRoute(`#/${id}`, 'r5').id).toBe(id)
    }
    expect(parseRoute('#/lab/run%2F42', 'r5')).toMatchObject({ id: 'lab', param: 'run/42' })
  })

  it('normalizes about and marks its canonical hash', () => {
    expect(parseRoute('#/about', 'r5')).toMatchObject({ id: 'settings', param: 'about', canonicalHash: '#/settings/about' })
  })

  it('safely returns to overview for malformed escapes and unknown pages', () => {
    expect(parseRoute('#/lab/%E0%A4%A', 'r5').id).toBe('workbench')
    expect(parseRoute('#/unknown/page', 'r5')).toMatchObject({ id: 'workbench', param: '' })
  })

  it('encodes route params and canonicalizes about in go', () => {
    const loc = { hash: '' }
    vi.stubGlobal('location', loc)
    go('lab', 'run/42 x', 'r5')
    expect(loc.hash).toBe('#/lab/run%2F42%20x')
    go('about', undefined, 'r5')
    expect(loc.hash).toBe('#/settings/about')
    go('about')
    expect(loc.hash).toBe('#/about')
  })

  it('keeps the r4 parser limited to its legacy routes', () => {
    expect(parseRoute('#/about', 'r4')).toEqual({ id: 'about', param: '', parts: ['about'] })
    expect(parseRoute('#/chart/sample', 'r4')).toEqual({ id: 'workbench', param: 'sample', parts: ['chart', 'sample'] })
    expect(parseRoute('#/chart/sample', 'r5')).toEqual({ id: 'chart', param: 'sample', parts: ['chart', 'sample'] })
  })

  it('builds every r5 page workspace from its fixed instances and view config', () => {
    const make = pageApi.pageWorkspace
    expect(make).toBeTypeOf('function')
    if (!make) return
    for (const [page, want] of Object.entries(PAGE_ITEMS) as Array<[Page, PageItem[]]>) {
      const ws = make(page)
      expect(ws.id).toBe(`ws_page_${page}`)
      expect(ws.items.map(({ instanceId, block, config }) => ({ instanceId, block, config: config ?? {} }))).toEqual(want)
      expect(pageApi.PAGE_COLUMNS?.[page]).toEqual(PAGE_COLUMNS[page])
      expect(pageApi.PAGE_LAYOUT?.[page]).toBe(page === 'records' || page === 'plugins' || page === 'lab' ? 'single' : 'two')
      expect(pageApi.PAGE_AREAS?.[page]).toEqual(Object.fromEntries([
        ...PAGE_COLUMNS[page].left.map((id) => [id, 'left']),
        ...PAGE_COLUMNS[page].right.map((id) => [id, 'right']),
        ...PAGE_COLUMNS[page].full.map((id) => [id, 'full']),
      ]))
      expect(ws.items.some((item) => item.instanceId === 'bi_agent_1' || item.config?.view === 'pending')).toBe(false)
    }
  })

  it('keeps the r4 fixed workspace snapshot unchanged', () => {
    expect(presets.fixedWorkspace()).toEqual({
      schema: 'gitrader-workspace/1', id: 'ws_default', name: '检阅', grid: { cols: 24, rowHeight: 24 },
      channels: { A: { symbol: 'hyperliquid:BTC' } },
      items: [
        { instanceId: 'bi_positions_1', block: 'block.gitrader.positions@0.1.0', x: 0, y: 0, w: 15, h: 11, channel: 'A', config: {} },
        { instanceId: 'bi_agent_feed_1', block: 'block.gitrader.agent-activity@0.1.0', x: 0, y: 11, w: 15, h: 15, channel: 'A', config: { view: 'feed' }, pinned: true },
        { instanceId: 'bi_agent_1', block: 'block.gitrader.agent-activity@0.1.0', x: 15, y: 0, w: 9, h: 10, channel: 'A', config: { view: 'pending' }, pinned: true },
        { instanceId: 'bi_agent_keys_1', block: 'block.gitrader.agent-activity@0.1.0', x: 15, y: 10, w: 9, h: 6, channel: 'A', config: { view: 'keys' }, pinned: true },
        { instanceId: 'bi_risk_1', block: 'block.gitrader.risk@0.1.0', x: 15, y: 16, w: 9, h: 10, channel: 'A', config: {}, pinned: true },
      ],
      statusBar: { block: 'block.gitrader.statusbar@0.1.0', pinned: true, takeover: ['halt_new', 'cancel_all', 'flatten_all'] },
      popouts: [],
    })
  })

  it('returns isolated workspace objects and falls back to overview for unknown pages', () => {
    const make = pageApi.pageWorkspace
    expect(make).toBeTypeOf('function')
    if (!make) return
    const first = make('workbench')
    const second = make('workbench')
    expect(first).not.toBe(second)
    expect(first.items).not.toBe(second.items)
    expect(first.items[1]?.config).not.toBe(second.items[1]?.config)
    first.items[1]!.config!.view = 'changed'
    expect(second.items[1]?.config).toEqual({ view: 'feed' })
    expect(make('unknown-page').id).toBe('ws_page_workbench')
  })
})

afterEach(() => vi.unstubAllGlobals())
