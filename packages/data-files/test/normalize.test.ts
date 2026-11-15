// SPDX-License-Identifier: CPAL-1.0
// ③ normalizeCandleFile：升序去重写规范 JSON，再检查输出文件无重复。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectCandleFile, normalizeCandleFile } from '../src/index'
import { dropTmpDir, HOUR, makeTmpDir, T0, writeFixture } from './helpers'

let dir = ''

beforeAll(() => {
  dir = makeTmpDir()
})
afterAll(() => {
  dropTmpDir(dir)
})

/** 乱序 + 重复 + 坏行，用来验证归一化后的顺序与根数。 */
const MESSY = [
  't,o,h,l,c,v',
  `${T0 + 2 * HOUR},110,120,100,115,12`,
  `${T0},100,110,90,105,10`,
  `${T0 + HOUR},105,115,95,110,11`,
  `${T0 + HOUR},105,115,95,110,11`,
  'broken,1,2,3,4',
  `${T0 + 3 * HOUR},115,125,105,120,13`,
].join('\n')

describe('normalizeCandleFile', () => {
  it('输出升序、根数 = parsed − duplicates，再 inspect 时 duplicates 为 0', () => {
    const source = writeFixture(dir, 'source.csv', `${MESSY}\n`)
    const out = join(dir, 'nested', 'out.json')
    const before = inspectCandleFile(source, { root: dir })
    expect(before.parsed).toBe(5)
    expect(before.duplicates).toBe(1)
    expect(before.skipped).toBe(1)

    const after = normalizeCandleFile(source, out, { root: dir })
    expect(after.path).toBe(out)
    expect(after.format).toBe('json')
    expect(after.parsed).toBe(before.parsed - before.duplicates)
    expect(after.duplicates).toBe(0)
    expect(after.skipped).toBe(0)
    expect(after.rows).toBe(before.parsed - before.duplicates)
    expect(after.interval?.ms).toBe(HOUR)
    expect(after.gaps).toEqual([])

    const body = JSON.parse(readFileSync(out, 'utf8')) as { candles: { t: number; o: number; h: number; l: number; c: number; v: number }[] }
    expect(Array.isArray(body.candles)).toBe(true)
    expect(body.candles).toHaveLength(before.parsed - before.duplicates)
    const ts = body.candles.map((c) => c.t)
    expect(ts).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR])
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
    expect(new Set(ts).size).toBe(ts.length)
    expect(body.candles[0]).toEqual({ t: T0, o: 100, h: 110, l: 90, c: 105, v: 10 })

    const again = inspectCandleFile(out, { root: dir })
    expect(again.duplicates).toBe(0)
    expect(again.parsed).toBe(body.candles.length)
  })

  it('JSON 进、JSON 出：二次归一化幂等（摘要相同）', () => {
    const source = writeFixture(dir, 'source.csv', `${MESSY}\n`)
    const first = join(dir, 'first.json')
    const second = join(dir, 'second.json')
    const a = normalizeCandleFile(source, first, { root: dir })
    const b = normalizeCandleFile(first, second, { root: dir })
    expect(b.sha256).toBe(a.sha256)
    expect(b.parsed).toBe(a.parsed)
  })
})
