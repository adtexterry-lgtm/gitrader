// SPDX-License-Identifier: CPAL-1.0
// 资金费装载：normalize / CSV / JSON 解析，宿主与本地文件两条路径，以及降级行为。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostApi, normalizeFunding, type HostLink } from '../src/runtime/host-api'
import { loadFunding, parseFundingCsv, parseFundingJson } from '../src/runtime/data'
import type { ResolvedSpec } from '../src/runtime/spec'
import { sha256Digest } from '../src/util/hash'

interface FakeHost { host: HostApi; calls: { method: string; params: unknown }[] }

function fakeHost(handler: (method: string, params: unknown) => unknown = () => { throw new Error('unexpected call') }): FakeHost {
  const calls: { method: string; params: unknown }[] = []
  const link: HostLink = {
    async call<T = unknown>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params })
      return (await handler(method, params)) as T
    },
    notify(): void {},
  }
  return { host: new HostApi(() => link), calls }
}

function resSpec(opts: { funding?: boolean; data?: Record<string, unknown> } = {}): ResolvedSpec {
  return {
    spec: {
      assumptions: { funding: opts.funding ?? true, fees: 'venue', slippageBps: 0, fillModel: 'next-bar-open', liquidation: false },
      data: opts.data ?? { source: 'host' },
    },
    instrumentId: 'hyperliquid:BTC',
    interval: '1h',
    intervalMs: 3_600_000,
    from: 0,
    to: 10_000,
  } as unknown as ResolvedSpec
}

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gitrader-funding-'))
  dirs.push(d)
  return d
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('normalizeFunding / parseFundingCsv / parseFundingJson', () => {
  it('规整对象与数组混排：字符串转 number、升序、去重保留先出现、坏项丢弃', () => {
    expect(normalizeFunding([{ t: 2, rate: '0.0001' }, [1, 0.0002], { t: 2, rate: 0.5 }, { t: 'x', rate: 1 }]))
      .toEqual([{ t: 1, rate: 0.0002 }, { t: 2, rate: 0.0001 }])
  })

  it('CSV 跳坏行与表头；JSON 支持 points 包装并升序去重', () => {
    expect(parseFundingCsv('t,rate,premium\n1,0.0001,0.00001\n2,abc\n3,0.0002\n'))
      .toEqual([{ t: 1, rate: 0.0001 }, { t: 3, rate: 0.0002 }])
    expect(parseFundingJson('{"points":[[3,0.0003],{"t":1,"rate":"0.0001"}]}'))
      .toEqual([{ t: 1, rate: 0.0001 }, { t: 3, rate: 0.0003 }])
  })
})

describe('loadFunding：宿主路径', () => {
  it('取 host.market.fundingHistory，过滤区间外，source=host，params 正确', async () => {
    const { host, calls } = fakeHost(() => ({
      points: [{ t: 5, rate: '0.0001' }, { t: 20_000, rate: 0.1 }, { t: 1, rate: 0.2 }],
      complete: true,
    }))
    const out = await loadFunding(resSpec(), host)
    expect(out.applied).toBe(true)
    expect(out.source).toBe('host')
    expect(out.points).toEqual([{ t: 1, rate: 0.2 }, { t: 5, rate: 0.0001 }])
    expect(out.warnings).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('host.market.fundingHistory')
    expect(calls[0]!.params).toEqual({ instrumentId: 'hyperliquid:BTC', from: 0, to: 10_000 })
  })

  it('宿主抛错时降级为 none，不抛', async () => {
    const { host } = fakeHost(() => { throw new Error('method not found') })
    const out = await loadFunding(resSpec(), host)
    expect(out.applied).toBe(false)
    expect(out.source).toBe('none')
    expect(out.points).toEqual([])
    expect(out.warnings[0]!.startsWith('host.market.fundingHistory unavailable:')).toBe(true)
  })

  it('宿主返回空数组：applied=false，warning 含区间内无点', async () => {
    const { host } = fakeHost(() => [])
    const out = await loadFunding(resSpec(), host)
    expect(out.applied).toBe(false)
    expect(out.warnings).toContain('no funding points in range')
  })

  it('spec 未请求资金费：不调用宿主', async () => {
    const { host, calls } = fakeHost()
    const out = await loadFunding(resSpec({ funding: false }), host)
    expect(out).toEqual({ points: [], source: 'none', applied: false, warnings: [] })
    expect(calls).toHaveLength(0)
  })

  it('宿主未连接：降级为 none，不抛', async () => {
    const host = new HostApi(() => null)
    const out = await loadFunding(resSpec(), host)
    expect(out.applied).toBe(false)
    expect(out.source).toBe('none')
    expect(out.warnings[0]!.startsWith('host.market.fundingHistory unavailable:')).toBe(true)
  })
})

describe('loadFunding：文件路径', () => {
  it('读取 kind="funding" 的 CSV 并校验 sha256', async () => {
    const dir = tempDir()
    const path = join(dir, 'funding.csv')
    writeFileSync(path, 't,rate\n1,0.0001\n2,0.0002\n')
    const buf = readFileSync(path)
    const { host, calls } = fakeHost()
    const r = resSpec({ data: { source: 'files', files: [{ path, sha256: sha256Digest(buf), format: 'csv', kind: 'funding' }] } })
    const out = await loadFunding(r, host)
    expect(out.applied).toBe(true)
    expect(out.source).toBe('files:csv')
    expect(out.points).toEqual([{ t: 1, rate: 0.0001 }, { t: 2, rate: 0.0002 }])
    expect(calls).toHaveLength(0)
  })

  it('sha256 不符时抛 DATA_UNAVAILABLE', async () => {
    const dir = tempDir()
    const path = join(dir, 'funding.csv')
    writeFileSync(path, 't,rate\n1,0.0001\n')
    const { host } = fakeHost()
    const r = resSpec({ data: { source: 'files', files: [{ path, sha256: sha256Digest(Buffer.from('other')), format: 'csv', kind: 'funding' }] } })
    let err: unknown
    try { await loadFunding(r, host) } catch (e) { err = e }
    expect(err).toBeDefined()
    const name = (err as { problem?: { name?: string } }).problem?.name
    expect(name === 'DATA_UNAVAILABLE' || (err instanceof Error && err.message.includes('DATA_UNAVAILABLE'))).toBe(true)
  })

  it('files 里没有 kind="funding" 的条目：applied=false 并给出 warning', async () => {
    const { host } = fakeHost()
    const r = resSpec({ data: { source: 'files', files: [{ path: 'unused.csv', sha256: sha256Digest(Buffer.from('')), format: 'csv' }] } })
    const out = await loadFunding(r, host)
    expect(out.applied).toBe(false)
    expect(out.warnings.some((w) => w.includes('kind "funding"'))).toBe(true)
  })
})
