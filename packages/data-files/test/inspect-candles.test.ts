// SPDX-License-Identifier: CPAL-1.0
// ① CSV 计数与周期、缺口、ohlc 违规。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** 12 行：表头 + 10 条合法（其中 1 条重复 t）+ 1 条坏行。 */
const MESSY = [
  't,o,h,l,c,v',
  `${T0},100,110,90,105,10`,
  `${T0 + HOUR},105,115,95,110,11`,
  `${T0 + 2 * HOUR},110,120,100,115,12`,
  `${T0 + 3 * HOUR},115,125,105,120,13`,
  `${T0 + 3 * HOUR},115,125,105,120,13`,
  `${T0 + 4 * HOUR},120,130,110,125,14`,
  'not-a-time,1,2,3,4',
  `${T0 + 5 * HOUR},125,135,115,130,15`,
  `${T0 + 6 * HOUR},130,140,120,135,16`,
  `${T0 + 7 * HOUR},135,145,125,140,17`,
  `${T0 + 8 * HOUR},140,150,130,145,18`,
].join('\n')

describe('inspectCandleFile / CSV', () => {
  it('表头 + 坏行 + 重复 t：rows / parsed / skipped / duplicates 精确，周期为 1h', () => {
    const path = writeFixture(dir, 'messy.csv', `${MESSY}\n`)
    const r = inspectCandleFile(path, { root: dir })
    expect(r.rows).toBe(12)
    expect(r.parsed).toBe(10)
    expect(r.skipped).toBe(1)
    expect(r.duplicates).toBe(1)
    expect(r.rows).toBe(1 + r.parsed + r.skipped)
    expect(r.format).toBe('csv')
    expect(r.from).toBe(T0)
    expect(r.to).toBe(T0 + 8 * HOUR)
    expect(r.sha256).toBe(digestOf(readFileSync(path)))
    expect(r.interval).toEqual({ ms: HOUR, label: '1h', confidence: 1 })
    expect(r.gaps).toEqual([])
    expect(r.ohlcViolations).toBe(0)
  })

  it('去掉中间 2 根后报一条缺口，missing = 2', () => {
    const lines = ['t,o,h,l,c,v']
    for (const i of [0, 1, 2, 3, 6, 7, 8, 9]) {
      const o = 100 + i
      lines.push(`${T0 + i * HOUR},${o},${o + 10},${o - 10},${o + 5},${10 + i}`)
    }
    const path = writeFixture(dir, 'gap.csv', `${lines.join('\n')}\n`)
    const r = inspectCandleFile(path, { root: dir })
    expect(r.parsed).toBe(8)
    expect(r.gaps).toEqual([{ from: T0 + 4 * HOUR, to: T0 + 5 * HOUR, missing: 2 }])
    expect(r.interval?.ms).toBe(HOUR)
    expect(r.warnings.some((w) => w.includes('1 gap'))).toBe(false)
  })

  it('一根 h < c 时 ohlcViolations === 1', () => {
    const path = writeFixture(
      dir,
      'bad-ohlc.csv',
      [
        't,o,h,l,c,v',
        `${T0},100,110,90,105,10`,
        `${T0 + HOUR},105,110,95,112,11`,
        `${T0 + 2 * HOUR},110,120,100,115,12`,
      ].join('\n') + '\n',
    )
    const r = inspectCandleFile(path, { root: dir })
    expect(r.parsed).toBe(3)
    expect(r.ohlcViolations).toBe(1)
    expect(r.warnings.some((w) => w.includes('o/h/l/c'))).toBe(true)
  })

  it('缺口数量超过上限时只列前 maxGaps 条并给出警告', () => {
    const path = writeFixture(
      dir,
      'many-gaps.csv',
      ['t,o,h,l,c,v', ...[0, 1, 2, 3, 4, 6, 8, 10].map((i) => `${T0 + i * HOUR},100,110,90,105,10`)].join('\n') + '\n',
    )
    const r = inspectCandleFile(path, { maxGaps: 2, root: dir })
    expect(r.interval?.ms).toBe(HOUR)
    expect(r.gaps).toHaveLength(2)
    expect(r.gaps.every((g) => g.missing === 1)).toBe(true)
    expect(r.warnings.some((w) => w.includes('3 gaps found'))).toBe(true)
  })

  it('报告路径是绝对路径', () => {
    const path = writeFixture(dir, 'abs.csv', `${MESSY}\n`)
    expect(inspectCandleFile(join(dir, '.', 'abs.csv'), { root: dir }).path).toBe(path)
  })

  it('扩展名不认识时可用 opts.format 指定 csv，不给则 reject', () => {
    const lines = [0, 1, 2, 3].map((i) => `${T0 + i * HOUR},100,110,90,105,10`)
    const path = writeFixture(dir, 'plain.txt', `${lines.join('\n')}\n`)
    const r = inspectCandleFile(path, { format: 'csv', root: dir })
    expect(r.format).toBe('csv')
    expect(r.parsed).toBe(lines.length)
    expect(() => inspectCandleFile(path, { root: dir })).toThrow('unsupported data file extension')
  })
})
