// SPDX-License-Identifier: CPAL-1.0
// 0.1.1 客户体验修复第二批 B2（ux-fix2）：UX-10 设置页连接态、UX-21 表头单数、UX-24 新纸面账户计价币、UX-37 示例策略英文名与简介。
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigView } from '@gitrader/protocol'
import { setLang } from '@gitrader/workbench/i18n'
import { paperCcyFor, parseVenueStatus, patchAddAccount } from '../src/model-config'
import { normalizeCatalog } from '../src/model-strategies'

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const CJK = /[㐀-鿿]/
afterEach(() => setLang('zh'))

describe('UX-10 设置 · 交易所的连接态与顶栏同一规则', () => {
  it('connection=connected 但 wsState=disconnected → 已断开（不再一红一绿）', () => {
    expect(parseVenueStatus([{ venue: 'hyperliquid', connection: 'connected', wsState: 'disconnected' }]).hyperliquid!.state).toBe('disconnected')
    expect(parseVenueStatus([{ venue: 'hyperliquid', connection: 'connected', wsState: 'connected' }]).hyperliquid!.state).toBe('connected')
  })
  it('venue.status 读失败：清掉上一轮快照，不留旧的「已连接」', () => {
    expect(src('../src/views/venues.tsx')).toMatch(/\(\) => \{ if \(!dead\) setStatusRaw\(undefined\) \}/)
  })
})

describe('UX-24 新纸面账户的计价币', () => {
  const config = (accounts: unknown[]) => ({ venues: [{ id: 'hyperliquid', environment: 'testnet', enabled: true }, { id: 'binance', environment: 'testnet', enabled: true }], accounts }) as unknown as ConfigView
  it('跟同一交易所已有的纸面账户走；没有就按交易所结算币（Hyperliquid = USDC），其余 USDT', () => {
    expect(paperCcyFor(config([]), 'hyperliquid')).toBe('USDC')
    expect(paperCcyFor(config([]), 'binance')).toBe('USDT')
    expect(paperCcyFor(config([{ alias: 'p', venue: 'binance', mode: 'paper', paper: { initialBalance: '1', ccy: 'USDC' } }]), 'binance')).toBe('USDC')
    const added = patchAddAccount(config([]), { alias: 'p2', venue: 'hyperliquid', mode: 'paper', initialBalance: '500' }).accounts!.at(-1)!
    expect(added.paper?.ccy).toBe('USDC')
  })
  it('添加账户表单的单位跟着走（不再写死 USDT）', () => {
    expect(src('../src/views/venues.tsx')).not.toMatch(/unit="USDT"/)
  })
})

describe('UX-21 英文表头是单数 Exchange', () => {
  it('三张表的「交易所」列都经 venueCol()', () => {
    const v = src('../src/views/venues.tsx')
    expect(v).toMatch(/const venueCol = \(\): string => \(getLang\(\) === 'en' \? 'Exchange' : tr\('交易所'\)\)/)
    expect(v.match(/<th[^>]*>\{venueCol\(\)\}<\/th>/g)).toHaveLength(3)
    expect(v).not.toMatch(/<th[^>]*>\{tr\('交易所'\)\}<\/th>/)
  })
})

describe('UX-37 示例策略在英文界面', () => {
  const catalog = [{ engineId: 'gitrader-core', strategies: [{ id: 'grid', name: 'Grid, long-only (teaching example)', nameZh: '网格·只做多（教学示例）', version: '1.0.0',
    desc: '在「中心价 ± 区间」内等分成若干格：价格越低持仓越多、越高持仓越少，跌出区间满仓、涨出区间清仓。震荡里一格一格买卖，单边下跌时越买越亏。', params: [] }] }]
  it('中文界面取中文名；英文界面取英文名、简介翻译，没有中文残留', () => {
    expect(normalizeCatalog(catalog).entries[0]!.name).toBe('网格·只做多（教学示例）')
    setLang('en')
    const e = normalizeCatalog(catalog).entries[0]!
    expect(e.name).toBe('Grid, long-only (teaching example)')
    expect(CJK.test(e.name + e.desc)).toBe(false)
  })
})
