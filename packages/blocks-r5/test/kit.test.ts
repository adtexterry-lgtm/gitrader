// SPDX-License-Identifier: CPAL-1.0
import { h } from 'preact'
import { describe, expect, it } from 'vitest'
import { InlineConfirm } from '@gitrader/workbench/ui'
import { normalizeConfig } from '../src/model-config'
import { LabShapeError, readPage } from '../src/model-lab'
import { Actor, Amount, ArmRow, Card, CardHead, Empty, ErrorText, Offline, Skeleton, Unwired, VENUE_ICON_MAP, VenueIcon, wireState } from '../src/kit'

const textOf = (node: any): string => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const findClass = (node: any, className: string): any => {
  if (node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map((n) => findClass(n, className)).find(Boolean)
  if (typeof node.type === 'function') return findClass(node.type(node.props), className)
  if (node.props?.className === className) return node
  return findClass(node.props?.children, className)
}
const findComponent = (node: any, component: unknown): any => {
  if (node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map((n) => findComponent(n, component)).find(Boolean)
  if (node.type === component) return node
  if (typeof node.type === 'function') return findComponent(node.type(node.props), component)
  return findComponent(node.props?.children, component)
}
const findTag = (node: any, tag: string): any => {
  if (node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map((n) => findTag(n, tag)).find(Boolean)
  if (typeof node.type === 'function') return findTag(node.type(node.props), tag)
  if (node.type === tag) return node
  return findTag(node.props?.children, tag)
}
const hasProp = (node: any, key: string): boolean => {
  if (node == null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some((n) => hasProp(n, key))
  if (Object.hasOwn(node.props ?? {}, key)) return true
  return hasProp(node.props?.children, key)
}

describe('r5 shared kit', () => {
  it('renders card section, marker, head fallback, stale slot and data props', () => {
    const tree = h(Card, { title: '标题', stale: true, 'data-test': 'x' }, '内容')
    const section = findTag(tree, 'section')
    expect(section?.props.className).toBe('g5-card')
    expect(section?.props['data-g5']).toBe('card')
    expect(section?.props['data-test']).toBe('x')
    expect(textOf(section)).toContain('标题')
    expect(textOf(section)).toContain('内容')
    expect(findClass(section, 'g5-stale')).toBeDefined()
    const protectedMarker = findTag(h(Card, { 'data-g5': 'caller-value' }), 'section')
    expect(protectedMarker?.props['data-g5']).toBe('card')
  })
  it('renders explicit card head with right slot and stale marker', () => {
    const tree = h(CardHead, { title: '页头', right: '操作', stale: true })
    const header = findClass(tree, 'g5-hd')
    expect(textOf(header)).toContain('页头')
    expect(textOf(tree)).toContain('操作')
    expect(findClass(tree, 'g5-stale')).toBeDefined()
  })
  it('keeps the venue marker, requested size attributes and accessible name', () => {
    const tree = h(VenueIcon, { venue: 'Venue X', size: 'md', title: 'venue', 'data-g5': 'caller-value' })
    const outer = findClass(tree, 'g5-vchip')
    const name = findClass(tree, 'g5-vn')
    expect(outer?.props['data-g5']).toBe('venue')
    expect(outer?.props['data-size']).toBe('md')
    expect(outer?.props.size).toBe('md')
    expect(outer?.props.title).toBe('venue')
    expect(textOf(name)).toBe('Venue X')
    expect(findClass(tree, 'g5-venue g5-m g5-v-init')).toBeDefined()
    expect(findClass(VenueIcon({ venue: 'Venue Y' }), 'g5-vchip')?.props['data-size']).toBe('sm')
  })
  it('renders the 13 registered source marks with centralized variants in all three sizes', () => {
    const entries = {
      hyperliquid: ['hyperliquid.png', 'hyperliquid'], binance: ['binance.svg', 'dark'], okx: ['okx.svg', 'okx'],
      bitget: ['bitget-mark.png', 'dark'], coinbase: ['coinbase.svg', 'light'], htx: ['htx.png', 'htx'],
      dydx: ['dydx.png', 'full'], kraken: ['kraken.png', 'full'], kucoin: ['kucoin.svg', 'full'],
      deribit: ['deribit.png', 'light'], alpaca: ['alpaca.svg', 'full'], ibkr: ['ibkr.svg', 'light'],
      twelvedata: ['twelvedata.svg', 'light'],
    }
    for (const [venue, [file, variant]] of Object.entries(entries)) {
      expect(VENUE_ICON_MAP[venue as keyof typeof VENUE_ICON_MAP]).toMatchObject({ file, variant })
      for (const [size, markerClass] of [['sm', 'g5-v-'], ['md', 'g5-m'], ['lg', 'g5-l']] as const) {
        const tree = VenueIcon({ venue, size })
        const mark = findClass(tree, ['g5-venue', size === 'sm' ? '' : markerClass, `g5-v-${variant}`].filter(Boolean).join(' '))
        expect(mark).toBeDefined()
        const image = findTag(mark, 'img')
        expect(typeof image?.props.src).toBe('string')
        expect(String(image?.props.src)).toMatch(/^(data:image\/(?:png|svg\+xml)[;,]|\/)/)
        expect(image?.props.alt).toBe('')
        expect(findClass(tree, 'g5-vn')).toBeDefined()
        const outer = findClass(tree, 'g5-vchip')
        expect(outer?.props.size).toBe(size)
        expect(outer?.props['data-size']).toBe(size)
        expect(outer?.props['data-g5']).toBe('venue')
      }
    }
  })
  it('uses exact venue keys and preserves the venue and label strings', () => {
    const upper = VenueIcon({ venue: 'BINANCE' })
    const normal = VenueIcon({ venue: 'binance' })
    expect(findTag(upper, 'img')?.props.src).toBe(findTag(normal, 'img')?.props.src)
    expect(textOf(findClass(upper, 'g5-vn'))).toBe('BINANCE')
    expect(textOf(findClass(VenueIcon({ venue: ' Venue X ', label: 'Shown' }), 'g5-vn'))).toBe('Shown')
    expect(textOf(findClass(VenueIcon({ venue: 'Venue X', label: '' }), 'g5-vn'))).toBe('')
    expect(findClass(VenueIcon({ venue: 'binance-usdm' }), 'g5-venue g5-v-init')).toBeDefined()
  })
  it('keeps exactly 18 venues in the map: 13 with a registered original and 5 initial placeholders', () => {
    const entries = Object.entries(VENUE_ICON_MAP) as Array<[string, { file: string | null; source: unknown }]>
    expect(entries).toHaveLength(18)
    expect(entries.filter(([, asset]) => asset.file !== null && asset.source != null)).toHaveLength(13)
    const placeholders = entries.filter(([, asset]) => asset.file === null && asset.source === null).map(([venue]) => venue)
    expect(placeholders.sort()).toEqual(['alphavantage', 'bybit', 'finnhub', 'gate', 'polygon'])
  })
  it('uses initials for five explicit fallback marks and unknown keys without inventing a logo', () => {
    for (const venue of ['bybit', 'gate', 'alphavantage', 'finnhub', 'polygon']) {
      expect(VENUE_ICON_MAP[venue as keyof typeof VENUE_ICON_MAP]).toMatchObject({ file: null, source: null })
    }
    for (const venue of ['bybit', 'gate', 'alphavantage', 'finnhub', 'polygon', 'unknown venue', '__proto__', 'constructor', 'binance-usdm']) {
      const tree = VenueIcon({ venue })
      const mark = findClass(tree, 'g5-venue g5-v-init')
      expect(mark?.props['aria-hidden']).toBe('true')
      expect(textOf(mark)).toBe(venue.charAt(0).toUpperCase())
      expect(findTag(mark, 'img')).toBeUndefined()
      expect(textOf(findClass(tree, 'g5-vn'))).toBe(venue)
    }
    expect(textOf(findClass(VenueIcon({ venue: '' }), 'g5-venue g5-v-init'))).toBe('?')
  })
  it('renders human, engine and system marks from the source symbol geometry', () => {
    const human = h(Actor, { kind: 'human', name: 'Human' })
    const engine = h(Actor, { kind: 'engine', name: 'Engine' })
    const system = h(Actor, { kind: 'system', name: 'System' })
    expect(findClass(human, 'g5-mk g5-human')).toBeDefined()
    expect(findTag(human, 'circle')?.props).toMatchObject({ cx: '5', cy: '3.1', r: '1.9' })
    expect(findTag(engine, 'path')?.props.d).toBe('M5 1.6L8.4 5 5 8.4 1.6 5z')
    expect(findTag(system, 'path')?.props.d).toBe('M5 1.1l3.5 1.35v2.4c0 2.15-1.45 3.7-3.5 4.4-2.05-.7-3.5-2.25-3.5-4.4v-2.4z')
  })
  it('renders agents with the registered original logo, unframed, and a neutral circle for unregistered names', () => {
    const claude = h(Actor, { kind: 'agent', name: 'Claude Code' })
    const claudeLogo = findClass(claude, 'g5-alogo g5-provider-b')
    expect(findTag(claudeLogo, 'img')?.props).toMatchObject({ alt: '', width: 15, height: 15 })
    expect(String(findTag(claudeLogo, 'img')?.props.src)).toMatch(/^data:image\/svg\+xml/)
    expect(findClass(claude, 'g5-mk g5-agent')).toBeUndefined()
    expect(textOf(claude)).toContain('Claude Code')
    const openai = h(Actor, { kind: 'agent', name: 'Codex CLI' })
    expect(findTag(findClass(openai, 'g5-alogo g5-provider-a'), 'img')).toBeDefined()
    const unknown = h(Actor, { kind: 'agent', name: 'Agent X' })
    expect(findTag(unknown, 'span')?.props.className).toBe('g5-actor')
    expect(textOf(unknown)).toContain('Agent X')
    expect(findClass(unknown, 'g5-mk g5-agent')).toBeDefined()
    expect(findTag(unknown, 'img')).toBeUndefined()
    expect(findClass(unknown, 'g5-alogo')).toBeUndefined()
    const explicit = h(Actor, { kind: 'agent', name: 'Agent Y', logo: 'local-mark' })
    expect(findTag(explicit, 'img')?.props).toMatchObject({ src: 'local-mark', alt: '', width: 15, height: 15 })
  })
  it('preserves unwired and error text and amount strings', () => {
    const unwired = h(Unwired, { message: '暂不可用 <原因>' })
    expect(findTag(unwired, 'div')?.props['data-wire']).toBe('off')
    expect(findClass(unwired, 'g5-t3')).toBeDefined()
    expect(findClass(unwired, 'g5-msg')).toBeDefined()
    expect(textOf(unwired)).toContain('未接通')
    expect(textOf(unwired)).toContain('暂不可用 <原因>')
    expect(findTag(unwired, 'button')).toBeUndefined()
    expect(hasProp(unwired, 'data-act')).toBe(false)
    expect(textOf(h(ErrorText, { message: '源错误' }))).toContain('源错误')
    const amount = h(Amount, { value: '001.2300', tone: 'up' })
    expect(textOf(amount)).toContain('001.2300')
    expect(findClass(amount, 'g5-up')).toBeDefined()
  })
  it('classifies only the three existing unwired error shapes', () => {
    const labShapeError = (() => { try { readPage({}) } catch (error) { return error } })()
    expect(labShapeError).toBeInstanceOf(LabShapeError)
    expect(wireState({ code: -32601 })).toBe('off')
    expect(wireState(normalizeConfig({}))).toBe('off')
    expect(wireState(labShapeError)).toBe('off')
    for (const error of [
      null, undefined, new Error('missing field'), new Error('ordinary error'), { field: 'items' },
      { ok: true, missing: 'venues' }, { ok: false, missing: '' }, { name: 'LabShapeError', field: '' },
      { code: '-32601' }, { code: -1 },
    ]) expect(wireState(error)).toBe('error')
  })
  it('renders Empty as one fact line (no icon, no centred block) and leaves offline children unchanged', () => {
    const empty = Empty({ message: '没有内容' })
    expect(empty.props).toMatchObject({ className: 'g5-emp', 'data-state': 'empty' })
    expect(textOf(empty)).toBe('没有内容')
    expect(findTag(empty, 'svg')).toBeUndefined()
    const withNote = Empty({ message: '没有内容', description: '稍后再试', children: h('button', null, '去配置') })
    expect(textOf(withNote)).toBe('没有内容稍后再试去配置')
    expect(findClass(withNote, 'g5-src')).toBeDefined()
    expect(findTag(withNote, 'button')).toBeDefined()
    const offline = Offline({ children: h('strong', null, '原警示') })
    const wrapper = findTag(offline, 'div')
    expect(wrapper?.props).toMatchObject({ className: 'g5-off', 'data-state': 'offline' })
    expect(findTag(wrapper, 'strong')).toBeDefined()
    expect(textOf(wrapper)).toBe('原警示')
  })
  it('wraps InlineConfirm and forwards the existing Skeleton export', () => {
    const tree = h(ArmRow, { label: '确认', dataAct: 'act' })
    const armed = findTag(tree, 'div')
    expect(armed?.props.className).toBe('g5-armed')
    const inline = findComponent(tree, InlineConfirm)
    expect(inline?.props).toMatchObject({ label: '确认', dataAct: 'act' })
    expect(Skeleton).toBeDefined()
  })
})

