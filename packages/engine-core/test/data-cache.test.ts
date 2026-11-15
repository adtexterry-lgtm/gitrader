// SPDX-License-Identifier: CPAL-1.0
// 宿主 K 线本地缓存：cacheDir / cacheKey / cachePath / readCache / writeCache，以及 loadCandles 的缓存与 files 按 kind 选文件。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostApi } from '../src/runtime/host-api'
import type { ResolvedSpec } from '../src/runtime/spec'
import { loadCandles } from '../src/runtime/data'
import { cacheDir, cacheKey, cachePath, cacheStats, readCache, writeCache } from '../src/runtime/candle-cache'
import { sha256Digest } from '../src/util/hash'

const CANDLES = [
  { t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 },
  { t: 2, o: 2, h: 2, l: 2, c: 2, v: 0 },
  { t: 3, o: 3, h: 3, l: 3, c: 3, v: 0 },
]

interface FakeHostResult { host: HostApi; calls: () => number }

function fakeHost(result: { candles: typeof CANDLES; source: string; complete: boolean } | Error): FakeHostResult {
  let calls = 0
  const host = {
    async history() {
      calls++
      if (result instanceof Error) throw result
      return result
    },
  } as unknown as HostApi
  return { host, calls: () => calls }
}

function resSpec(opts: { data?: Record<string, unknown>; from?: number; to?: number } = {}): ResolvedSpec {
  return {
    spec: { data: opts.data ?? { source: 'host' } },
    instrumentId: 'hyperliquid:BTC',
    interval: '1h',
    from: opts.from ?? 0,
    to: opts.to ?? 10_000,
  } as unknown as ResolvedSpec
}

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gitrader-cache-'))
  dirs.push(d)
  return d
}

let savedEnv: string | undefined
beforeEach(() => { savedEnv = process.env.GITRADER_ENGINE_CACHE_DIR })
afterEach(() => {
  if (savedEnv === undefined) delete process.env.GITRADER_ENGINE_CACHE_DIR
  else process.env.GITRADER_ENGINE_CACHE_DIR = savedEnv
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const MAX_BARS = 100

/** 200 根数值"不规则"的 K 线：压缩后仍明显超过 1 KB，用来验证总大小上限。 */
function bigCandles(): { t: number; o: number; h: number; l: number; c: number; v: number }[] {
  const pick = (i: number, s: number): number => {
    const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453
    return Number((x - Math.floor(x)).toFixed(10))
  }
  return Array.from({ length: 200 }, (_, i) => ({
    t: 1_700_000_000_000 + i * 3_600_000,
    o: pick(i, 1),
    h: pick(i, 2),
    l: pick(i, 3),
    c: pick(i, 4),
    v: pick(i, 5) * 1000,
  }))
}

describe('cacheKey / cacheDir / cachePath', () => {
  it('cacheKey 是 64 位十六进制，入参决定结果', () => {
    const k = cacheKey('hyperliquid:BTC', '1h', 0, 10)
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(cacheKey('hyperliquid:BTC', '1h', 0, 10)).toBe(k)
    expect(cacheKey('hyperliquid:ETH', '1h', 0, 10)).not.toBe(k)
    expect(cacheKey('hyperliquid:BTC', '4h', 0, 10)).not.toBe(k)
    expect(cacheKey('hyperliquid:BTC', '1h', 1, 10)).not.toBe(k)
    expect(cacheKey('hyperliquid:BTC', '1h', 0, 11)).not.toBe(k)
  })

  it('cacheDir 只认非空字符串', () => {
    expect(cacheDir({})).toBeNull()
    expect(cacheDir({ GITRADER_ENGINE_CACHE_DIR: '' })).toBeNull()
    expect(cacheDir({ GITRADER_ENGINE_CACHE_DIR: 'x' })).toBe('x')
    expect(cachePath('/tmp/d', 'k')).toBe(join('/tmp/d', 'candles', 'k.json.gz'))
  })
})

describe('loadCandles：宿主与缓存', () => {
  it('环境变量未设：直接走宿主，不缓存', async () => {
    delete process.env.GITRADER_ENGINE_CACHE_DIR
    const f = fakeHost({ candles: CANDLES, source: 'venue', complete: true })
    const r = await loadCandles(resSpec(), f.host, MAX_BARS)
    expect(f.calls()).toBe(1)
    expect(r.source).toBe('host:venue')
    expect(r.candles).toEqual(CANDLES)
  })

  it('环境变量指向临时目录：第一次写缓存，第二次命中缓存不再调宿主', async () => {
    const dir = tempDir()
    process.env.GITRADER_ENGINE_CACHE_DIR = dir
    const f = fakeHost({ candles: CANDLES, source: 'venue', complete: true })
    const first = await loadCandles(resSpec(), f.host, MAX_BARS)
    expect(f.calls()).toBe(1)
    expect(first.source).toBe('host:venue')
    expect(existsSync(cachePath(dir, cacheKey('hyperliquid:BTC', '1h', 0, 10_000)))).toBe(true)

    const bad = fakeHost(new Error('no host'))
    const second = await loadCandles(resSpec(), bad.host, MAX_BARS)
    expect(second.source).toBe('cache')
    expect(second.candles).toEqual(CANDLES)
    expect(bad.calls()).toBe(0)
  })

  it('宿主 complete=false：不写缓存', async () => {
    const dir = tempDir()
    process.env.GITRADER_ENGINE_CACHE_DIR = dir
    const f = fakeHost({ candles: CANDLES, source: 'venue', complete: false })
    const r = await loadCandles(resSpec(), f.host, MAX_BARS)
    expect(r.source).toBe('host:venue')
    expect(existsSync(cachePath(dir, cacheKey('hyperliquid:BTC', '1h', 0, 10_000)))).toBe(false)
  })

  it('to 在未来：不写缓存', async () => {
    const dir = tempDir()
    process.env.GITRADER_ENGINE_CACHE_DIR = dir
    const to = Date.now() + 86_400_000
    const f = fakeHost({ candles: CANDLES, source: 'venue', complete: true })
    const r = await loadCandles(resSpec({ to }), f.host, MAX_BARS)
    expect(r.source).toBe('host:venue')
    expect(existsSync(cachePath(dir, cacheKey('hyperliquid:BTC', '1h', 0, to)))).toBe(false)
  })

  it('坏缓存文件被忽略并被覆盖', async () => {
    const dir = tempDir()
    process.env.GITRADER_ENGINE_CACHE_DIR = dir
    const path = cachePath(dir, cacheKey('hyperliquid:BTC', '1h', 0, 10_000))
    mkdirSync(join(dir, 'candles'), { recursive: true })
    writeFileSync(path, 'not json', 'utf8')
    const f = fakeHost({ candles: CANDLES, source: 'venue', complete: true })
    const r = await loadCandles(resSpec(), f.host, MAX_BARS)
    expect(f.calls()).toBe(1)
    expect(r.source).toBe('host:venue')
    expect(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))).toEqual(CANDLES)
  })
})

describe('readCache', () => {
  it('不存在的 key、空数组、混入坏项', async () => {
    const dir = tempDir()
    expect(await readCache(dir, 'missing')).toBeNull()
    await writeCache(dir, 'empty', [])
    expect(await readCache(dir, 'empty')).toBeNull()
    writeFileSync(join(dir, 'candles', 'mixed.json'), JSON.stringify([{ t: 1, o: 1, h: 1, l: 1, c: 1 }, { t: 'x' }]), 'utf8')
    expect(await readCache(dir, 'mixed')).toEqual([{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }])
  })
})

describe('gzip 存储 / 旧格式兼容 / 总大小上限', () => {
  it('写入 <key>.json.gz，不再写明文 <key>.json，readCache 返回原 K 线', async () => {
    const dir = tempDir()
    const key = cacheKey('hyperliquid:BTC', '1h', 0, 10)
    await writeCache(dir, key, CANDLES)
    expect(existsSync(join(dir, 'candles', `${key}.json.gz`))).toBe(true)
    expect(existsSync(join(dir, 'candles', `${key}.json`))).toBe(false)
    expect(await readCache(dir, key)).toEqual(CANDLES)
  })

  it('兼容旧格式：手写的 <key>.json（JSON 数组）能读', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'candles'), { recursive: true })
    writeFileSync(join(dir, 'candles', 'legacy.json'), JSON.stringify(CANDLES), 'utf8')
    expect(await readCache(dir, 'legacy')).toEqual(CANDLES)
  })

  it('总大小上限：超限后删最旧的文件，保留最新一份', async () => {
    const dir = tempDir()
    const saved = process.env.GITRADER_ENGINE_CACHE_MAX_MB
    process.env.GITRADER_ENGINE_CACHE_MAX_MB = '0.001'
    try {
      const capBytes = Math.floor(0.001 * 1024 * 1024)
      const big = bigCandles()
      for (const k of ['a', 'b', 'c']) await writeCache(dir, k, big)
      const newest = join(dir, 'candles', 'c.json.gz')
      expect(existsSync(newest)).toBe(true)
      expect(statSync(newest).size).toBeGreaterThan(1024)
      const removed = ['a', 'b'].filter((k) => !existsSync(join(dir, 'candles', `${k}.json.gz`)))
      expect(removed.length).toBeGreaterThanOrEqual(1)
      const stats = await cacheStats(dir)
      expect(stats.bytes).toBeLessThanOrEqual(Math.max(capBytes, statSync(newest).size))
    } finally {
      if (saved === undefined) delete process.env.GITRADER_ENGINE_CACHE_MAX_MB
      else process.env.GITRADER_ENGINE_CACHE_MAX_MB = saved
    }
  })

  it('readCache 命中后刷新 mtime（LRU）', async () => {
    const dir = tempDir()
    const key = 'touched'
    await writeCache(dir, key, CANDLES)
    const path = join(dir, 'candles', `${key}.json.gz`)
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(path, old, old)
    const before = Date.now()
    expect(await readCache(dir, key)).toEqual(CANDLES)
    expect(statSync(path).mtimeMs).toBeGreaterThanOrEqual(before)
  })
})

describe('loadCandles：files 按 kind 选文件', () => {
  it('跳过 kind=funding，取 candles 文件', async () => {
    const dir = tempDir()
    const fundingPath = join(dir, 'funding.csv')
    const candlesPath = join(dir, 'candles.csv')
    writeFileSync(fundingPath, 't,rate\n1,0.0001\n', 'utf8')
    writeFileSync(candlesPath, 't,o,h,l,c,v\n1,1,1,1,1,0\n2,2,2,2,2,0\n', 'utf8')
    const r = await loadCandles(resSpec({
      data: {
        source: 'files',
        files: [
          { path: fundingPath, sha256: sha256Digest(readFileSync(fundingPath)), format: 'csv', kind: 'funding' },
          { path: candlesPath, sha256: sha256Digest(readFileSync(candlesPath)), format: 'csv' },
        ],
      },
    }), fakeHost(new Error('no host')).host, MAX_BARS)
    expect(r.candles).toEqual([
      { t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 2, o: 2, h: 2, l: 2, c: 2, v: 0 },
    ])
    expect(r.source).toBe('files:csv')
  })

  it('只有一个无 kind 的 csv 文件：行为不变', async () => {
    const dir = tempDir()
    const candlesPath = join(dir, 'candles.csv')
    writeFileSync(candlesPath, 't,o,h,l,c,v\n1,1,1,1,1,0\n2,2,2,2,2,0\n', 'utf8')
    const r = await loadCandles(resSpec({
      data: {
        source: 'files',
        files: [{ path: candlesPath, sha256: sha256Digest(readFileSync(candlesPath)), format: 'csv' }],
      },
    }), fakeHost(new Error('no host')).host, MAX_BARS)
    expect(r.candles).toEqual([
      { t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 2, o: 2, h: 2, l: 2, c: 2, v: 0 },
    ])
    expect(r.source).toBe('files:csv')
  })
})
