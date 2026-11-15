// SPDX-License-Identifier: CPAL-1.0
// GQ-11：策略页「可用」目录（engine.catalog）→ 表单校验 → strategy.start 命令。参数名与 engine-core 文档一致。
import { describe, expect, it } from 'vitest'
import { normalizeCatalog, paramSeed, readParams, startAccounts, startNewCmd, type ParamField } from '../src/model-strategies'
import { strategiesData } from '../fixtures/strategies'

const grid = () => normalizeCatalog(strategiesData.CATALOG).entries.find((e) => e.id === 'grid')!

describe('normalizeCatalog', () => {
  it('lists every loaded strategy per engine and keeps unavailable engines as failure rows', () => {
    const c = normalizeCatalog(strategiesData.CATALOG)
    expect(c.fail).toBeNull()
    expect(c.entries.map((e) => `${e.engineId}:${e.id}`)).toEqual(['ts-builtin:grid', 'ts-builtin:dca'])
    expect(c.entries[0]!.name).toBe('网格·只做多（教学示例）')
    expect(c.failures).toMatchObject([{ engineId: 'python-local', name: 'METHOD_NOT_FOUND' }])
  })
  it('keeps the documented grid parameter names (engine-core/examples/strategies/grid.ts)', () => {
    expect(grid().params.map((p) => p.key)).toEqual(['center', 'rangeRatio', 'grids', 'maxExposure', 'lowerPrice', 'upperPrice', 'gridMode', 'boundaryAction'])
  })
  it('a wire failure is a fail string, not an empty list (反例)', () => {
    expect(normalizeCatalog({ ok: false, error: { name: 'ENGINE_UNAVAILABLE', message: 'x' } }).fail).toBeTruthy()
    expect(normalizeCatalog({ nope: 1 }).fail).toBe('engine.catalog')
    expect(normalizeCatalog(undefined)).toEqual({ entries: [], failures: [], fail: null })
  })
})

describe('readParams', () => {
  it('seeds defaults and parses them back to typed values', () => {
    const r = readParams(grid().params, paramSeed(grid().params))
    expect(r).toEqual({ ok: true, params: { center: 0, rangeRatio: 0.1, grids: 8, maxExposure: 1, lowerPrice: 0, upperPrice: 0, gridMode: 'arithmetic', boundaryAction: 'pause' } })
  })
  it('names the field on every rejection (反例)', () => {
    const base = paramSeed(grid().params)
    expect(readParams(grid().params, { ...base, grids: '8.5' })).toMatchObject({ ok: false, key: 'grids', message: 'grids 需要整数' })
    expect(readParams(grid().params, { ...base, grids: '51' })).toMatchObject({ ok: false, key: 'grids', message: 'grids 必须在 2–50 之间' })
    expect(readParams(grid().params, { ...base, rangeRatio: 'abc' })).toMatchObject({ ok: false, key: 'rangeRatio' })
    expect(readParams(grid().params, { ...base, gridMode: 'fib' })).toMatchObject({ ok: false, key: 'gridMode', message: 'gridMode 只能是 arithmetic / geometric' })
    expect(readParams(grid().params, { ...base, lowerPrice: '200', upperPrice: '100' })).toMatchObject({ ok: false, key: 'upperPrice', message: 'upperPrice 必须大于 lowerPrice' })
  })
  it('booleans only accept true / false; empty text params are omitted', () => {
    const f: ParamField[] = [{ key: 'reduceOnly', label: 'r', type: 'boolean', default: false }, { key: 'size', label: 's', type: 'text', default: null }]
    expect(readParams(f, { reduceOnly: 'yes', size: '' })).toMatchObject({ ok: false, key: 'reduceOnly' })
    expect(readParams(f, { reduceOnly: 'true', size: '' })).toEqual({ ok: true, params: { reduceOnly: true } })
    expect(readParams(f, { reduceOnly: 'false', size: '-1' })).toMatchObject({ ok: false, key: 'size', message: 'size 需要正数' })
  })
})

describe('startNewCmd / startAccounts', () => {
  it('starts a new instance through engine.call without an instanceId', () => {
    const cmd = startNewCmd({ engineId: 'ts-builtin', id: 'grid' }, { accountId: 'acct_p', instruments: ['hyperliquid:BTC'], interval: '1h' }, { grids: 8 })
    expect(cmd).toEqual({ action: 'engine.call', params: { id: 'ts-builtin', method: 'strategy.start', params: { strategyId: 'grid', accountId: 'acct_p', instruments: ['hyperliquid:BTC'], interval: '1h', params: { grids: 8 } } } })
    expect(JSON.stringify(cmd)).not.toContain('instanceId')
  })
  it('offers only paper accounts bound to that engine (live goes through proposals)', () => {
    const accounts = [{ accountId: 'a_live', alias: 'L', mode: 'live' }, { accountId: 'a_p1', alias: 'P1', mode: 'paper' }, { accountId: 'a_p2', alias: 'P2', mode: 'paper' }] as never
    expect(startAccounts({ boundIds: ['a_live', 'a_p1'], bindings: null }, accounts).map((a) => a.accountId)).toEqual(['a_p1'])
    expect(startAccounts({ boundIds: [], bindings: [{ accountId: 'a_p2' }] as never }, accounts).map((a) => a.accountId)).toEqual(['a_p2'])
    expect(startAccounts(undefined, accounts)).toEqual([])
  })
})
