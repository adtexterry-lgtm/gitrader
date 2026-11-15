// SPDX-License-Identifier: Apache-2.0
// v0.1.6：块清单形状裁决、浏览器安全子路径、risk.state.usage、account.summary.dayStartEquity。
import { join } from 'node:path'
import { build } from 'esbuild'
import type { VenueConnector } from '@gitrader/protocol/connector'
import { describe, expect, it } from 'vitest'
import {
  RISK_USAGE_KEYS, validateAccountSummary, validateBlockManifest, validatePluginManifest, validateRiskStateSnapshot,
} from '../src'
import { PKG_ROOT, contract, sample } from './helpers'

describe('BlockManifest 形状裁决', () => {
  it('vendor = {name, url?}，license = SPDX 字符串，fixtures = 数组', () => {
    const b = sample('BlockManifest')
    expect(b.vendor).toEqual({ name: 'Gitrader', url: null })
    expect(typeof b.license).toBe('string')
    expect(validateBlockManifest(b).ok).toBe(true)
    expect(validateBlockManifest({ ...b, vendor: { name: 'Acme', url: 'https://acme.example.org' } }).ok).toBe(true)
    expect(validateBlockManifest({ ...b, vendor: { name: 'Acme' } }).ok).toBe(true)
  })
  it('旧形状被拒：vendor 字符串、license 对象、fixtures 字符串、空 fixtures', () => {
    const b = sample('BlockManifest')
    expect(validateBlockManifest({ ...b, vendor: 'Gitrader' }).ok).toBe(false)
    expect(validateBlockManifest({ ...b, vendor: { id: 'gitrader' } }).ok).toBe(false)
    expect(validateBlockManifest({ ...b, license: { spdx: 'Apache-2.0' } }).ok).toBe(false)
    expect(validateBlockManifest({ ...b, license: '' }).ok).toBe(false)
    expect(validateBlockManifest({ ...b, fixtures: 'fixtures/btc.jsonl' }).ok).toBe(false)
    expect(validateBlockManifest({ ...b, fixtures: [] }).ok).toBe(false)
  })
  it('插件清单的 vendor 不受影响（仍是完整的 PluginVendor）', () => {
    const p = contract('plugin-nautilus')
    expect(validatePluginManifest(p).ok).toBe(true)
    expect(Object.keys(p.vendor).sort()).toEqual(['id', 'kind', 'name', 'url', 'verified'])
    expect(validatePluginManifest({ ...p, vendor: { name: 'Gitrader' } }).ok).toBe(false)
  })
})

describe('浏览器安全子路径', () => {
  const bundle = async (entry: string, platform: 'browser' | 'node' = 'browser') =>
    (await build({ absWorkingDir: PKG_ROOT, entryPoints: [entry], bundle: true, platform, format: 'esm', write: false, logLevel: 'silent', metafile: true }))
  it('constants：不含 ajv、不依赖任何 node: 模块，浏览器目标可打包', async () => {
    const r = await bundle('src/constants.ts')
    const inputs = Object.keys(r.metafile.inputs)
    expect(inputs.some((f) => /ajv/i.test(f)), 'no ajv in the module graph').toBe(false)
    expect(inputs.some((f) => f.endsWith('schema-registry.ts') || f.endsWith('validate.ts'))).toBe(false)
    const text = r.outputFiles[0]!.text
    expect(/from ["']node:/.test(text) || /require\(["']node:/.test(text)).toBe(false)
    expect(text).toContain('MCP_TOOLS')
    expect(text).toContain('RISK_USAGE_KEYS')
  })
  it('types：编译后是空模块（只有类型）', async () => {
    const r = await bundle('src/types.ts')
    expect(Object.keys(r.metafile.inputs).some((f) => /ajv/i.test(f))).toBe(false)
    expect(r.outputFiles[0]!.text.replace(/\s+/g, '')).not.toContain('MCP_TOOLS')
  })
  it('decimal、connector 子路径同样浏览器安全', async () => {
    for (const entry of ['src/decimal.ts', 'src/connector/index.ts']) {
      const r = await bundle(entry)
      expect(Object.keys(r.metafile.inputs).some((f) => /ajv/i.test(f)), entry).toBe(false)
    }
  })
  it('根入口仍带校验器（对照）', async () => {
    const r = await bundle('src/index.ts')
    expect(Object.keys(r.metafile.inputs).some((f) => /ajv/i.test(f))).toBe(true)
  })
  it('package.json 导出了 ./constants 与 ./types', async () => {
    const pj = JSON.parse((await import('node:fs')).readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { exports: Record<string, string> }
    expect(pj.exports['./constants']).toBe('./src/constants.ts')
    expect(pj.exports['./types']).toBe('./src/types.ts')
  })
})

describe('v0.1.8 连接器本地 L2 快照能力', () => {
  const book = { instrumentId: 'hyperliquid:BTC', ts: 1791549157661, bids: [{ price: 83064.5, size: 1.2 }], asks: [{ price: 83065, size: 0.8 }] }
  it('BookSnapshot：{book, asOf, stale} 都必填', async () => {
    const { validateBookSnapshot } = await import('../src')
    expect(validateBookSnapshot({ book, asOf: 1791549157661, stale: false }).ok).toBe(true)
    expect(validateBookSnapshot({ book, asOf: 1791549157661, stale: true }).ok).toBe(true)
    expect(validateBookSnapshot({ book, asOf: 1791549157661 }).ok).toBe(false)
    expect(validateBookSnapshot({ asOf: 1, stale: false }).ok).toBe(false)
    expect(validateBookSnapshot({ book: { ...book, bids: 'x' }, asOf: 1, stale: false }).ok).toBe(false)
  })
  it('能力位 VenueCapabilities.bookSnapshot：可选；有则 snapshot / refresh 必填', async () => {
    const { validateVenueCapabilities, connector } = await import('../src')
    const supportsBookSnapshot = connector.supportsBookSnapshot
    const caps = sample('VenueCapabilities')
    expect(caps.bookSnapshot).toEqual({ snapshot: true, refresh: true, staleAfterMs: 5000 })
    expect(validateVenueCapabilities(caps).ok).toBe(true)
    expect(supportsBookSnapshot(caps)).toEqual({ snapshot: true, refresh: true })
    const { bookSnapshot: _b, ...none } = caps
    expect(validateVenueCapabilities(none).ok).toBe(true)
    expect(supportsBookSnapshot(none)).toEqual({ snapshot: false, refresh: false })
    expect(validateVenueCapabilities({ ...caps, bookSnapshot: { snapshot: true } }).ok).toBe(false)
    expect(supportsBookSnapshot({ ...caps, bookSnapshot: { snapshot: false, refresh: true } })).toEqual({ snapshot: false, refresh: false })
    expect(supportsBookSnapshot({ ...caps, bookSnapshot: { snapshot: true, refresh: false } })).toEqual({ snapshot: true, refresh: false })
  })
  it('VenueConnector 的两个可选方法（编译期形状）：没有它们的连接器仍是合法实现', async () => {
    const withBook: Pick<VenueConnector, 'bookSnapshot' | 'refreshBook'> = {
      bookSnapshot: () => undefined,
      refreshBook: async (_id, opts) => { void opts?.maxWaitMs; return undefined },
    }
    const without: Pick<VenueConnector, 'bookSnapshot' | 'refreshBook'> = {}
    expect(typeof withBook.bookSnapshot).toBe('function')
    expect(without.bookSnapshot).toBeUndefined()
    expect(await withBook.refreshBook!('hyperliquid:BTC', { maxWaitMs: 500 })).toBeUndefined()
  })
})

describe('v0.1.7 连接器账户快照新鲜度', () => {
  it('asOf / stale / source 可选；旧快照（没有这三个字段）照样通过', async () => {
    const { validateConnectorAccountSnapshot, ACCOUNT_SNAPSHOT_SOURCES } = await import('../src')
    const snap = sample('ConnectorAccountSnapshot')
    expect(validateConnectorAccountSnapshot(snap).ok).toBe(true)
    const { asOf: _a, stale: _s, source: _o, ...legacy } = snap
    expect(validateConnectorAccountSnapshot(legacy).ok).toBe(true)
    expect([...ACCOUNT_SNAPSHOT_SOURCES]).toEqual(['ws', 'rest', 'replay', 'fixture'])
    for (const src of ACCOUNT_SNAPSHOT_SOURCES) expect(validateConnectorAccountSnapshot({ ...snap, source: src }).ok, src).toBe(true)
    expect(validateConnectorAccountSnapshot({ ...snap, source: 'carrier-pigeon' }).ok).toBe(false)
    expect(validateConnectorAccountSnapshot({ ...snap, stale: 'no' }).ok).toBe(false)
    expect(validateConnectorAccountSnapshot({ ...snap, asOf: -1 }).ok).toBe(false)
    expect(validateConnectorAccountSnapshot({ ...snap, accountModel: 'mystery' }).ok).toBe(false)
  })
})

describe('risk.state.usage 与 account.summary.dayStartEquity', () => {
  const usage = [
    { key: 'maxOrderNotional', used: '120.5', limit: '500', unit: 'USDC', ratio: '0.241', scope: 'mandate', window: 'now' },
    { key: 'maxDailyLoss', used: '12.3', limit: '50', unit: 'USDC', ratio: '0.246', window: 'day' },
    { key: 'maxOrdersPerMinute', used: '2', limit: '6', unit: 'count', window: 'minute' },
    { key: 'x-acme.custom', used: '1', limit: '2', unit: 'count' },
  ]
  it('risk.state 快照：usage 可选；有则每项已用 / 上限都是十进制字符串', () => {
    expect(validateRiskStateSnapshot({ tradingState: 'ACTIVE' }).ok).toBe(true)
    expect(validateRiskStateSnapshot({ tradingState: 'ACTIVE', policyVersion: 3, denyLlmLiveEntries: true, usage }).ok).toBe(true)
    expect(validateRiskStateSnapshot({ tradingState: 'PAUSED' }).ok).toBe(false)
    expect(validateRiskStateSnapshot({ tradingState: 'ACTIVE', usage: [{ ...usage[0]!, used: 120.5 }] }).ok).toBe(false)
    expect(validateRiskStateSnapshot({ tradingState: 'ACTIVE', usage: [{ ...usage[0]!, key: 'maxMadeUp' }] }).ok).toBe(false)
    expect(validateRiskStateSnapshot({ tradingState: 'ACTIVE', usage: [{ key: 'maxOrderNotional', used: '1', unit: 'USDC' }] }).ok).toBe(false)
    expect(RISK_USAGE_KEYS).toEqual(expect.arrayContaining(['maxDailyLossRatio', 'maxDailyOrders', 'maxCancelsPerMinute']))
  })
  it('account.summary：dayStartEquity 可选，十进制字符串', () => {
    const s = { accountId: 'acct_01JABAPAPER000000000000001', ts: 1791549157661, equity: '10120.5', available: '9900', positions: 1, openOrders: 0 }
    expect(validateAccountSummary(s).ok).toBe(true)
    expect(validateAccountSummary({ ...s, dayStartEquity: '10000' }).ok).toBe(true)
    expect(validateAccountSummary({ ...s, dayStartEquity: 10000 }).ok).toBe(false)
    expect(validateAccountSummary({ ...s, equity: undefined }).ok).toBe(false)
  })
})
