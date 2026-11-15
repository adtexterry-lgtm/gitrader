// SPDX-License-Identifier: CPAL-1.0
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ConfigView } from '@gitrader/protocol'
import { FIRST_PARTY_ONLY_ACTIONS } from '@gitrader/blocks-sdk'
import { emptySettingsConfig, settingsConfig, venueStatusRows } from '../fixtures/venues'
import { StubBlockView } from '../src/kit'
import { notifyBlocks } from '../src/pages/notify'
import { venuesBlocks } from '../src/pages/venues'
import { AccountsCard, CatalogCard, DetailCard, VenuesCard } from '../src/views/venues'
import { ChannelDetailCard, ChannelsCard, RulesCard } from '../src/views/notify'
import {
  applyPatch, availableCatalog, channelHandles, channelKind, credentialRows, deletingLastEmergency, draftIssues, emergencyChannels, gate, isHandle, normalizeConfig, parseBalance,
  parseVenueStatus, patchAddAccount, patchAttachVenue, patchChannelLevel, patchCredentials, patchDeleteAccount, patchDeleteChannel, patchPaperBalance, patchRuleLevel, patchVenueEnabled,
  patchVenueEnv, testResultOf, venueRows,
} from '../src/model-config'

const here = dirname(fileURLToPath(import.meta.url))
const kernelSource = readFileSync(resolve(here, '../../kernel/src/api/view-config.ts'), 'utf8')
const base = settingsConfig
const clone = (): ConfigView => structuredClone(base)
const verifiedBinance = (): ConfigView => { const c = clone(); c.catalog.find((e) => e.venue === 'binance')!.verified = true; return c }

describe('放宽判定与内核 needsPin 一致（四条）', () => {
  it('内核源码里这三条放宽与「未验证主网硬拒」仍在（漂移即失败）', () => {
    expect(kernelSource).toContain("venue.environment === 'testnet' && after.venues.find((item) => item.id === venue.id)?.environment === 'mainnet'")
    expect(kernelSource).toContain("entry.venue === venue.id && entry.kind === 'trading'")
    expect(kernelSource).toContain('!before.venues.some((prior) => prior.id === venue.id && prior.enabled)')
    expect(kernelSource).toContain("account.mode === 'live' && (!prior || prior.mode !== 'live'")
    expect(kernelSource).toContain('Unverified mainnet trading venues cannot be enabled')
    expect(kernelSource).toContain('(nextIbkr.symbols ?? []).some((symbol) => !priorSymbols.has(symbol))')
  })

  it('① 测试网 → 主网要 PIN；主网 → 测试网（收紧）不要', () => {
    expect(gate(base, applyPatch(base, patchVenueEnv(base, 'hyperliquid', 'mainnet')))).toEqual({ kind: 'pin', why: '切到主网' })
    const onMain = clone()
    onMain.venues[0]!.environment = 'mainnet'
    expect(gate(onMain, applyPatch(onMain, patchVenueEnv(onMain, 'hyperliquid', 'testnet'))).kind).toBe('none')
  })

  it('② 启用一个新的交易类场所要 PIN；启用行情类、关闭场所、已启用的不要', () => {
    expect(gate(base, applyPatch(base, patchVenueEnabled(base, 'bybit', true)))).toEqual({ kind: 'pin', why: '启用交易场所' })
    expect(gate(base, applyPatch(base, patchAttachVenue(base, 'okx'))).kind).toBe('pin')
    expect(gate(base, applyPatch(base, patchAttachVenue(base, 'coinbase'))).kind).toBe('none')
    expect(gate(base, applyPatch(base, patchVenueEnabled(base, 'binance', false))).kind).toBe('none')
    expect(gate(base, applyPatch(base, patchVenueEnabled(base, 'hyperliquid', true))).kind).toBe('none')
  })

  it('③ 新增实盘账户 / 改实盘凭据要 PIN；新增纸面、删账户、改纸面资金不要', () => {
    const live = patchAddAccount(base, { alias: 'hl-2', venue: 'hyperliquid', mode: 'live' })
    expect(gate(base, applyPatch(base, live)).kind).toBe('pin')
    expect(gate(base, applyPatch(base, patchAddAccount(base, { alias: 'p2', venue: 'binance', mode: 'paper', initialBalance: '500' }))).kind).toBe('none')
    expect(gate(base, applyPatch(base, patchDeleteAccount(base, 2))).kind).toBe('none')
    expect(gate(base, applyPatch(base, patchPaperBalance(base, 1, '20000'))).kind).toBe('none')
    expect(gate(base, applyPatch(base, patchCredentials(base, 2, { apiKey: 'env:OTHER_KEY', apiSecret: 'env:BINANCE_TESTNET_API_SECRET' }))).kind).toBe('pin')
    expect(gate(base, applyPatch(base, patchCredentials(base, 2, { apiKey: 'env:BINANCE_TESTNET_API_KEY', apiSecret: 'env:BINANCE_TESTNET_API_SECRET' }))).kind).toBe('none')
  })

  it('④ 实盘 IBKR 新增标的要 PIN；同样的标的、删标的、IBKR 没有实盘账户、IBKR 未启用都不要', () => {
    const ibkr = (symbols: string[], opts: { live?: boolean; enabled?: boolean } = {}): ConfigView => {
      const c = clone()
      c.venues.push({ id: 'ibkr', environment: 'testnet', enabled: opts.enabled ?? true, symbols })
      c.catalog.push({ venue: 'ibkr', kind: 'trading', verified: false, credentials: [] })
      c.accounts.push({ alias: 'ib-main', venue: 'ibkr', environment: 'testnet', mode: opts.live === false ? 'paper' : 'live', ...(opts.live === false ? { paper: { initialBalance: '1000', ccy: 'USD' } } : {}) } as never)
      return c
    }
    const before = ibkr(['AAPL'])
    const symbolsPatch = (c: ConfigView, symbols: string[]) => ({ venues: c.venues.map((v) => (v.id === 'ibkr' ? { ...v, symbols } : v)) })
    expect(gate(before, applyPatch(before, symbolsPatch(before, ['AAPL', 'MSFT'])))).toEqual({ kind: 'pin', why: '实盘 IBKR 新增标的' })
    expect(gate(before, applyPatch(before, symbolsPatch(before, ['AAPL']))).kind).toBe('none')
    expect(gate(before, applyPatch(before, symbolsPatch(before, []))).kind).toBe('none')
    const paper = ibkr(['AAPL'], { live: false })
    expect(gate(paper, applyPatch(paper, symbolsPatch(paper, ['AAPL', 'MSFT']))).kind).toBe('none')
    const off = ibkr(['AAPL'], { enabled: false })
    expect(gate(off, applyPatch(off, symbolsPatch(off, ['AAPL', 'MSFT']))).kind).toBe('none')
  })

  it('实盘主网必须是目录里已验证的交易场所，否则内核直接拒（界面先拦）', () => {
    const toMain = (c: ConfigView): ConfigView => { const x = structuredClone(c); x.accounts[2]!.environment = 'mainnet'; x.venues[1]!.environment = 'mainnet'; return x }
    expect(gate(base, toMain(base))).toEqual({ kind: 'refuse', why: '未经真网验证，仅限测试网 / 模拟盘' })
    expect(gate(verifiedBinance(), toMain(verifiedBinance())).kind).toBe('pin')
    const dataKind = clone()
    dataKind.catalog.find((e) => e.venue === 'binance')!.kind = 'data'
    dataKind.catalog.find((e) => e.venue === 'binance')!.verified = true
    expect(gate(dataKind, toMain(dataKind)).kind).toBe('refuse')
  })
})

describe('句柄不含值', () => {
  it('凭据行只有句柄名与是否就位；config.view 里混进的值字段不会出现在行里', () => {
    const c = clone() as unknown as { handles: Array<Record<string, unknown>> }
    c.handles[0]!.value = 'sk-planted-secret-value'
    c.handles[0]!.secret = 'planted-2'
    const rows = credentialRows(c as unknown as ConfigView, 2)
    expect(rows.map((r) => [r.key, r.handle, r.state])).toEqual([['apiKey', 'env:BINANCE_TESTNET_API_KEY', 'ready'], ['apiSecret', 'env:BINANCE_TESTNET_API_SECRET', 'missing']])
    expect(JSON.stringify(rows)).not.toContain('planted')
    expect(JSON.stringify(channelHandles(c as unknown as ConfigView, 'connector.gitrader.notify-email'))).not.toContain('planted')
  })

  it('signerRef 只给钥匙库名，不替内核说「已就位」', () => {
    expect(credentialRows(base, 0)).toEqual([{ key: 'signerRef', handle: 'keystore:hl-api', path: 'accounts[0].signerRef', state: 'unknown' }])
    expect(credentialRows(base, 1)).toEqual([])
  })

  it('只认 env:VAR 句柄（与内核同一条正则）；填了别的东西 = 疑似密钥值，标出来、不发', () => {
    for (const ok of ['env:BINANCE_TESTNET_API_KEY', 'env:_x1']) expect(isHandle(ok)).toBe(true)
    for (const bad of ['', 'sk-live-123', 'env:', 'env:1ABC', 'ENV:X', 'env:A B', 'keystore:x']) expect(isHandle(bad)).toBe(false)
    expect(draftIssues({ '2:apiKey': 'env:OK_KEY', '2:apiSecret': 'plain-secret-value', '3:x': '' })).toEqual(['2:apiSecret'])
  })

  it('补丁里的凭据只来自句柄草稿，且不改原配置（整段替换的是拷贝）', () => {
    const before = JSON.stringify(base)
    const p = patchCredentials(base, 2, { apiKey: 'env:NEW_KEY', apiSecret: 'env:BINANCE_TESTNET_API_SECRET' })
    expect(p.accounts![2]!.credentials).toEqual({ apiKey: 'env:NEW_KEY', apiSecret: 'env:BINANCE_TESTNET_API_SECRET' })
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('紧急通道计数与删除', () => {
  it('夹具里被紧急级别规则点名的通道 = tg-main / mail / wecom-ops 共 3 个', () => {
    expect(emergencyChannels(base.notify).sort()).toEqual(['mail', 'tg-main', 'wecom-ops'])
  })

  it('没有任何规则时，内核向所有通道广播，所有通道都算紧急通道；没有通道时为 0', () => {
    const n = { ...structuredClone(base.notify), rules: undefined }
    expect(emergencyChannels(n)).toHaveLength(6)
    expect(emergencyChannels(emptySettingsConfig.notify)).toEqual([])
  })

  it('只数仍存在的通道（规则里点名了已删除的通道不算）', () => {
    const n = structuredClone(base.notify)
    n.rules = [{ match: 'takeover.*', level: 'critical', channels: ['tg-main', 'ghost'] }]
    expect(emergencyChannels(n)).toEqual(['tg-main'])
  })

  it('删最后一个紧急通道 = 急停将不通知任何人（走武装行）；还有别的紧急通道则不是', () => {
    expect(deletingLastEmergency(base.notify, 'tg-main')).toBe(false)
    const one = structuredClone(base.notify)
    one.rules = [{ match: 'takeover.*', level: 'critical', channels: ['tg-main'] }, { match: 'risk.denied', level: 'warn', channels: ['slack-ops'] }]
    expect(deletingLastEmergency(one, 'tg-main')).toBe(true)
    expect(deletingLastEmergency(one, 'slack-ops')).toBe(false)
    expect(deletingLastEmergency(emptySettingsConfig.notify, 'x')).toBe(false)
  })

  it('删通道同时把它从规则里摘掉，其余原样', () => {
    const p = patchDeleteChannel(base.notify, 'tg-main')
    expect(p.channels.map((c) => c.id)).not.toContain('tg-main')
    expect(p.rules!.every((r) => !r.channels.includes('tg-main'))).toBe(true)
    expect(p.rules!.find((r) => r.match === 'takeover.*')!.channels).toEqual(['mail', 'wecom-ops'])
    expect(base.notify.rules![0]!.channels).toContain('tg-main')
  })

  it('改级别只动被点的那一条', () => {
    expect(patchChannelLevel(base.notify, 'hook-ops', 'critical').channels.map((c) => c.minLevel)).toEqual(['warn', 'critical', 'critical', 'warn', 'warn', 'critical'])
    expect(patchRuleLevel(base.notify, 4, 'warn').rules.map((r) => r.level)).toEqual(['critical', 'critical', 'warn', 'warn', 'warn'])
  })
})

describe('规整与行', () => {
  it('缺登记字段 = 未接通并写出字段名；回包 ok:false = 失败并给原文', () => {
    expect(normalizeConfig(settingsConfig).ok).toBe(true)
    expect(normalizeConfig(undefined)).toEqual({ ok: false, missing: 'config.view' })
    expect(normalizeConfig({ venues: [], accounts: [], notify: { channels: [] }, handles: [] })).toEqual({ ok: false, missing: 'catalog' })
    expect(normalizeConfig({ venues: [], accounts: [], notify: {}, handles: [], catalog: [] })).toEqual({ ok: false, missing: 'notify.channels' })
    expect(normalizeConfig({ ok: false, error: { message: 'The local fixture cannot provide this view.' } })).toMatchObject({ ok: false, failure: 'The local fixture cannot provide this view.' })
  })

  it('场所行：类型 / 验证 / 账户数 / 连接态；可接入 = 目录里还没配置的', () => {
    const rows = venueRows(base, parseVenueStatus(venueStatusRows))
    expect(rows.map((r) => [r.id, r.kind, r.verified, r.accounts, r.conn?.state])).toEqual([
      ['hyperliquid', 'trading', true, 2, 'connected'], ['binance', 'trading', false, 2, 'disconnected'], ['bybit', 'trading', false, 0, undefined],
    ])
    expect(rows[0]!.conn!.p50).toBe(42)
    expect(rows[1]!.conn!.detail).toBe('ECONNRESET venue endpoint:443')
    expect(availableCatalog(base).map((c) => c.venue)).toEqual(['okx', 'bitget', 'coinbase'])
    expect(availableCatalog(emptySettingsConfig)).toEqual([])
  })

  it('每家只许一个实盘的集合与内核一致', () => {
    const src = readFileSync(resolve(here, '../../kernel/src/config.ts'), 'utf8')
    expect(src).toContain("new Set(['binance', 'okx', 'bybit', 'bitget', 'gateio', 'alpaca', 'ibkr'])")
  })

  it('小数字符串：去千分位、正数、最多 8 位小数', () => {
    expect(parseBalance('10,000.00')).toBe('10000.00')
    for (const bad of ['', '0', '-1', 'abc', '1.123456789', '1e3']) expect(parseBalance(bad)).toBeNull()
  })

  it('通道插件 → 显示名', () => {
    expect(channelKind('connector.gitrader.notify-email')).toEqual({ name: '邮件', logo: 'mail' })
    expect(channelKind('connector.gitrader.notify-telegram').logo).toBe('telegram')
    expect(channelKind('connector.gitrader.notify-wecom').name).toBe('企业微信')
    expect(channelKind('foo.bar')).toEqual({ name: 'foo.bar', logo: 'hook' })
  })

  it('发测试：送达给耗时；失败给内核原文（detail 优先）', () => {
    expect(testResultOf({ results: [{ channelId: 'a', ok: true }] }, 'a', 812, 1)).toEqual({ at: 1, ms: 812, ok: true, text: '0.8 s' })
    expect(testResultOf({ results: [{ channelId: 'a', ok: false, reason: 'invalid_params', retryable: false, detail: 'missing secret handle: SMTP_PASS' }] }, 'a', 5, 1).text).toBe('missing secret handle: SMTP_PASS')
    expect(testResultOf({ results: [{ channelId: 'a', ok: false, reason: 'unknown_channel', retryable: false }] }, 'a', 5, 1).text).toBe('unknown_channel')
  })
})

describe('块清单与视图分流（venues / notify）', () => {
  const props = (view?: string) => ({ config: view === undefined ? {} : { view } }) as never
  const typeOf = (block: { component?: (p: never) => unknown }, view?: string) => (block.component!(props(view)) as { type: unknown }).type

  it('清单：一方 inline、权限为空、声明的查询与命令够用，写命令都在「只许一方」名单里', () => {
    for (const [block, id, queries, actions] of [
      [venuesBlocks[0]!, 'block.gitrader.venues', ['config.view', 'venue.status'], ['config.venues.set', 'venue.reconnect']],
      [notifyBlocks[0]!, 'block.gitrader.notify', ['config.view', 'plugin.list'], ['config.notify.set', 'notify.test']],
    ] as const) {
      const m = block.manifest
      expect([m.id, m.version, m.isolation, m.permissions]).toEqual([id, '0.1.0', 'inline', []])
      expect(m.inputs?.queries).toEqual(queries)
      expect(m.actions).toEqual(actions)
      expect(m.fixtures?.length).toBeGreaterThan(0)
    }
    expect(FIRST_PARTY_ONLY_ACTIONS).toEqual(expect.arrayContaining(['config.venues.set', 'config.notify.set']))
  })

  it('没配 view = 桩（未接通）；配了 view 就是对应的卡；未知 view 仍是桩', () => {
    expect(typeOf(venuesBlocks[0]!)).toBe(StubBlockView)
    expect(typeOf(venuesBlocks[0]!, 'nope')).toBe(StubBlockView)
    expect(typeOf(venuesBlocks[0]!, 'venues')).toBe(VenuesCard)
    expect(typeOf(venuesBlocks[0]!, 'accounts')).toBe(AccountsCard)
    expect(typeOf(venuesBlocks[0]!, 'catalog')).toBe(CatalogCard)
    expect(typeOf(venuesBlocks[0]!, 'detail')).toBe(DetailCard)
    expect(typeOf(notifyBlocks[0]!)).toBe(StubBlockView)
    expect(typeOf(notifyBlocks[0]!, 'channels')).toBe(ChannelsCard)
    expect(typeOf(notifyBlocks[0]!, 'rules')).toBe(RulesCard)
    expect(typeOf(notifyBlocks[0]!, 'detail')).toBe(ChannelDetailCard)
  })
})
