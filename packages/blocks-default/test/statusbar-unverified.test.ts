// SPDX-License-Identifier: CPAL-1.0
import type { VNode } from 'preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ venues: [] as unknown[], status: null as unknown }))

vi.mock('preact/hooks', () => ({ useState: () => [true, () => undefined] }))
vi.mock('@gitrader/workbench/ui', async () => {
  const { h } = await import('preact')
  const shell = (tag: string) => (props: Record<string, unknown>) => h(tag, props, props.children as never)
  return {
    Button: shell('button'), F: { tone: () => 'flat', usd: (v: number) => String(v), signed: (v: number) => String(v), signedPct: (v: number) => String(v) },
    Icon: shell('i'), InfoTip: shell('i'), PopoverPanel: (props: Record<string, unknown>) => props.open ? h('section', {}, props.children as never) : null,
    RollingNumber: (props: Record<string, unknown>) => h('span', {}, String(props.value)),
  }
})
vi.mock('../src/hooks', () => ({
  focusCard: vi.fn(), useAccountsData: () => ({ accounts: [], summaries: {}, rows: [], reload: vi.fn() }), useNow: () => 100,
  useOffline: () => false, usePending: () => ({ cards: [], phase: 'ready', reload: vi.fn() }), useStatus: () => fixture.status,
  useFeedState: () => 'live', // statusbar 现在读壳的行情新鲜度（D1）；这里固定实时，保持原断言（单元不涉及陈旧提示）
}))
vi.mock('../src/risk', () => ({ TakeoverButtons: () => null, useTakeoverBusy: () => false }))
vi.mock('../src/shared', () => ({ useRunner: () => ({ run: vi.fn(), busy: false }) }))

import { statusBarBlock } from '../src/statusbar'
import { normalizeVenues } from '../src/model-risk'
import { VENUE_NAME } from '../src/labels'

type Node = VNode<any> | string | number | null | undefined | boolean | Node[]
function evaluate(node: Node): Node {
  if (Array.isArray(node)) return node.map(evaluate)
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node
  const vnode = node as VNode<any>
  if (typeof vnode.type === 'function') return evaluate((vnode.type as (props: any) => Node)(vnode.props))
  const children = vnode.props.children as Node
  return { ...vnode, props: { ...vnode.props, children: evaluate(children) } } as Node
}
function nodes(node: Node): VNode<any>[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object') return []
  const v = node as VNode<any>
  return [v, ...nodes(v.props.children as Node)]
}
function text(node: Node): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return text((node as VNode<any>).props.children as Node)
}

const raw = (venue: string, wsState: string, unverified?: boolean) => ({ venue, wsState, ...(unverified === undefined ? {} : { unverified }) })

describe('status bar unverified venue labels', () => {
  beforeEach(() => {
    fixture.venues = []
    fixture.status = {
      view: { primary: null, budgetLeft: null, state: 'ACTIVE', stateLabel: '正常交易', network: '测试网', latency: null },
      venues: fixture.venues, error: null, reload: vi.fn(),
    }
  })

  it('normalizes only strict true and provides the five venue display names', () => {
    const venues = normalizeVenues({ venues: [raw('binance', 'connected', true), raw('okx', 'connected', false), raw('bybit', 'connected')] })
    expect(venues.map((v) => v.unverified)).toEqual([true, false, false])
    expect(VENUE_NAME).toMatchObject({ binance: 'Binance', okx: 'OKX', bybit: 'Bybit', bitget: 'Bitget', gateio: 'Gate.io' })
  })

  it('renders the exact inline label for unverified venues independent of websocket state', () => {
    const venues = normalizeVenues({ venues: [raw('binance', 'connected', true), raw('okx', 'connecting', true), raw('bybit', 'disconnected', true), raw('bitget', 'connected', false), raw('gateio', 'connected')] })
    fixture.venues = venues
    fixture.status = { ...(fixture.status as object), venues, view: { primary: venues[0], budgetLeft: null, state: 'ACTIVE', stateLabel: '正常交易', network: '测试网', latency: null } }
    const vnode = evaluate(statusBarBlock.component!({} as never) as Node)
    const rows = nodes(vnode).filter((v) => v.type === 'li')
    expect(rows.map((v) => v.props['data-venue'])).toEqual(['binance', 'okx', 'bybit', 'bitget', 'gateio'])
    for (const row of rows.slice(0, 3)) {
      const label = nodes(row).find((v) => v.type === 'span' && v.props.className === 'gr-warn gr-small')
      expect(label).toBeDefined()
      expect(label?.props.title).toBe('未经真网验证，仅限测试网 / 模拟盘')
      expect(text(label ?? null)).toBe('未验证')
    }
    expect(nodes(rows[3]!).some((v) => v.props.className === 'gr-warn gr-small')).toBe(false)
    expect(nodes(rows[4]!).some((v) => v.props.className === 'gr-warn gr-small')).toBe(false)
  })
})
