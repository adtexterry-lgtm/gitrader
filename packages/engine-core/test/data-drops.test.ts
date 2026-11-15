// SPDX-License-Identifier: CPAL-1.0
// GQ-14：files 源的坏行 / 重复 / 秒级时间戳不再静默丢弃，结果 warnings 要说明丢了几行、首个位置。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostApi } from '../src/runtime/host-api'
import { loadCandles, parseCsv, parseCsvWithReport, parseJsonWithReport } from '../src/runtime/data'
import type { ResolvedSpec } from '../src/runtime/spec'
import { sha256Digest } from '../src/util/hash'

const T0 = 1_790_000_000_000
const H = 3_600_000
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

/** 200 根 1h 数据，物理行号：表头是第 1 行，第 k 根（0 起）在第 k+2 行。 */
const rows = (): string[] => Array.from({ length: 200 }, (_, i) => `${T0 + i * H},100,101,99,100,10`)
const csv = (lines: string[]): string => ['t,o,h,l,c,v', ...lines].join('\n') + '\n'

async function load(text: string, format: 'csv' | 'json' = 'csv') {
  const dir = mkdtempSync(join(tmpdir(), 'gitrader-drops-'))
  dirs.push(dir)
  const path = join(dir, `c.${format}`)
  writeFileSync(path, text)
  const r = {
    spec: { data: { source: 'files', files: [{ path, sha256: sha256Digest(Buffer.from(text, 'utf8')), format }] } },
    instrumentId: 'hyperliquid:BTC', interval: '1h', intervalMs: H, from: T0, to: T0 + 200 * H,
  } as unknown as ResolvedSpec
  return loadCandles(r, new HostApi(() => null), 1_000_000)
}

describe('GQ-14 坏行 / 重复 / 秒级时间戳要告警', () => {
  it('干净文件：不告警（含表头不算坏行）', async () => {
    const out = await load(csv(rows()))
    expect(out.candles).toHaveLength(200)
    expect(out.warnings).toEqual([])
  })

  it('3 行 NaN：丢 3 行，warning 写明行数与首个物理行号 51', async () => {
    const lines = rows()
    for (const k of [49, 99, 149]) lines[k] = `${T0 + k * H},NaN,NaN,NaN,NaN,0`
    const out = await load(csv(lines))
    expect(out.candles).toHaveLength(197)
    expect(out.warnings.join('|')).toMatch(/dropped 3 malformed row\(s\).*first at line 51/)
  })

  it('3 个重复时间戳：丢 3 行并告警，保留先出现的那行', async () => {
    const lines = rows()
    lines.splice(11, 0, lines[10]!.replace(',100,', ',777,'), lines[20]!, lines[30]!)   // 重复 3 个 t
    const out = await load(csv(lines))
    expect(out.candles).toHaveLength(200)
    expect(out.warnings.join('|')).toMatch(/dropped 3 duplicate timestamp\(s\)/)
    expect(out.candles.find((c) => c.t === T0 + 10 * H)!.o).toBe(100)    // 先出现的保留
  })

  it('3 行秒级时间戳：告警「像 Unix 秒」，不是静默少 3 根', async () => {
    const lines = rows()
    for (const k of [49, 99, 149]) lines[k] = `${Math.floor((T0 + k * H) / 1000)},100,101,99,100,10`
    const out = await load(csv(lines))
    expect(out.candles).toHaveLength(197)
    expect(out.warnings.join('|')).toMatch(/3 row\(s\) have t that looks like Unix seconds/)
  })

  it('反例：窗口外的正常毫秒行不误报成秒级，也不当坏行', async () => {
    const lines = [...rows(), `${T0 + 500 * H},100,101,99,100,10`]            // 比 to 晚，正常毫秒
    const out = await load(csv(lines))
    expect(out.candles).toHaveLength(200)
    expect(out.warnings).toEqual([])
  })

  it('JSON 同样：坏项给数组下标', async () => {
    const items = rows().map((l) => { const [t, o, h, lo, c, v] = l.split(',').map(Number); return { t, o, h, l: lo, c, v } })
    ;(items[7] as { o: unknown }).o = 'abc'
    const out = await load(JSON.stringify(items), 'json')
    expect(out.candles).toHaveLength(199)
    expect(out.warnings.join('|')).toMatch(/dropped 1 malformed row\(s\).*first at item #7/)
  })
})

describe('parseCsv / parseJson 导出行为不变', () => {
  it('parseCsv 仍返回按 t 升序去重的 K 线数组', () => {
    expect(parseCsv('t,o,h,l,c,v\n2,1,1,1,1,0\n1,1,1,1,1,0\n2,9,9,9,9,0\n').map((c) => c.t)).toEqual([1, 2])
  })
  it('表头不计入坏行；NaN 行计入且行号含表头', () => {
    const p = parseCsvWithReport('t,o,h,l,c,v\n1,1,1,1,1,0\nx,1,1,1,1,0\n')
    expect(p.drops).toEqual({ malformed: 1, firstMalformed: 3, duplicates: 0, firstDuplicateT: null })
    expect(parseJsonWithReport('[[1,1,1,1,1,0],[2,"a",1,1,1,0]]').drops.firstMalformed).toBe(1)
  })
})
