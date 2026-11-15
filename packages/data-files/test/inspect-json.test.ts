// SPDX-License-Identifier: CPAL-1.0
// ② JSON：{candles:[...]} 与裸数组都能读，sha256 与独立摘要一致。
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectCandleFile } from '../src/index'
import { digestOf, dropTmpDir, HOUR, makeTmpDir, T0, writeFixture } from './helpers'

let dir = ''

beforeAll(() => {
  dir = makeTmpDir()
})
afterAll(() => {
  dropTmpDir(dir)
})

const ROWS = [
  { t: T0, o: 100, h: 110, l: 90, c: 105, v: 10 },
  { t: T0 + HOUR, o: 105, h: 115, l: 95, c: 110, v: 11 },
  { t: T0 + 2 * HOUR, o: 110, h: 120, l: 100, c: 115, v: 12 },
]

describe('inspectCandleFile / JSON', () => {
  it('{ candles: [...] } 与裸数组解析结果一致', () => {
    const wrapped = writeFixture(dir, 'wrapped.json', JSON.stringify({ candles: ROWS }))
    const bare = writeFixture(dir, 'bare.json', JSON.stringify(ROWS))
    const a = inspectCandleFile(wrapped, { root: dir })
    const b = inspectCandleFile(bare, { root: dir })
    expect(a.format).toBe('json')
    expect(a.parsed).toBe(3)
    expect(a.rows).toBe(3)
    expect(a.skipped).toBe(0)
    expect(a.duplicates).toBe(0)
    expect(a.interval).toEqual({ ms: HOUR, label: '1h', confidence: 1 })
    expect(a.from).toBe(T0)
    expect(a.to).toBe(T0 + 2 * HOUR)
    expect(b.parsed).toBe(3)
    expect(b.path).toBe(bare)
    expect(a.sha256).toBe(digestOf(readFileSync(wrapped)))
    expect(b.sha256).toBe(digestOf(readFileSync(bare)))
    expect(a.sha256).not.toBe(b.sha256)
  })

  it('可缺 v；坏项跳过；重复 t 去重', () => {
    const path = writeFixture(
      dir,
      'mixed.json',
      JSON.stringify({
        candles: [
          { t: T0 + HOUR, o: 1, h: 2, l: 0.5, c: 1.5 },
          [T0, 1, 2, 0.5, 1.5, 7],
          { t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 },
          { t: 'x', o: 1, h: 2, l: 0.5, c: 1.5 },
          { o: 1, h: 2, l: 0.5, c: 1.5 },
          null,
        ],
      }),
    )
    const r = inspectCandleFile(path, { root: dir })
    expect(r.rows).toBe(6)
    expect(r.parsed).toBe(3)
    expect(r.skipped).toBe(3)
    expect(r.duplicates).toBe(1)
    expect(r.interval).toEqual({ ms: HOUR, label: '1h', confidence: 1 })
    expect(r.warnings).toContain('3 malformed row(s) skipped')
  })

  it('只有一根时无法推断周期，interval 为 null', () => {
    const path = writeFixture(dir, 'single.json', JSON.stringify({ candles: [{ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }] }))
    const r = inspectCandleFile(path, { root: dir })
    expect(r.parsed).toBe(1)
    expect(r.interval).toBeNull()
    expect(r.gaps).toEqual([])
    expect(r.warnings).toContain('not enough candles to infer an interval')
  })

  it('非法 JSON 抛错；结构不对也抛错', () => {
    const broken = writeFixture(dir, 'broken.json', '{"candles": [')
    expect(() => inspectCandleFile(broken, { root: dir })).toThrow(/not valid JSON/)
    const wrong = writeFixture(dir, 'wrong.json', JSON.stringify({ rows: [] }))
    expect(() => inspectCandleFile(wrong, { root: dir })).toThrow(/array of candles/)
  })
})
