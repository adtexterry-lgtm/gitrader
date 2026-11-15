// SPDX-License-Identifier: CPAL-1.0
// ④ manifestFor：两文件 → 两条目；path 绝对、format 按扩展名、kind 原样、sha256 与独立摘要一致。
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { manifestFor } from '../src/index'
import { digestOf, dropTmpDir, HOUR, makeTmpDir, T0, writeFixture } from './helpers'

let dir = ''

beforeAll(() => {
  dir = makeTmpDir()
})
afterAll(() => {
  dropTmpDir(dir)
})

describe('manifestFor', () => {
  it('每条目带绝对路径、sha256、format、kind', () => {
    const candles = writeFixture(
      dir,
      'candles.csv',
      ['t,o,h,l,c,v', `${T0},100,110,90,105,10`, `${T0 + HOUR},105,115,95,110,11`].join('\n') + '\n',
    )
    const funding = writeFixture(dir, 'funding.json', JSON.stringify({ points: [{ t: T0, rate: 0.0001 }] }))

    const entries = manifestFor([
      { path: candles, kind: 'candles' },
      { path: funding, kind: 'funding' },
    ], { root: dir })
    expect(entries).toHaveLength(2)
    const [first, second] = entries
    expect(first?.path).toBe(candles)
    expect(isAbsolute(first!.path)).toBe(true)
    expect(first?.format).toBe('csv')
    expect(first?.kind).toBe('candles')
    expect(first?.sha256).toBe(digestOf(readFileSync(candles)))
    expect(first?.bytes).toBe(statSync(candles).size)
    expect(second?.path).toBe(funding)
    expect(isAbsolute(second!.path)).toBe(true)
    expect(second?.format).toBe('json')
    expect(second?.kind).toBe('funding')
    expect(second?.sha256).toBe(digestOf(readFileSync(funding)))
  })

  it('相对路径绝对化，kind 缺省 candles', () => {
    writeFixture(dir, 'relative.csv', ['t,o,h,l,c,v', `${T0},1,2,0.5,1.5,1`].join('\n') + '\n')
    const entries = manifestFor([{ path: join(dir, '.', 'relative.csv') }], { root: dir })
    expect(entries[0]?.path).toBe(join(dir, 'relative.csv'))
    expect(entries[0]?.kind).toBe('candles')
    expect(entries[0]?.format).toBe('csv')
  })

  it('扩展名不认识时抛错，不猜格式', () => {
    const path = writeFixture(dir, 'notes.txt', 'hello\n')
    expect(() => manifestFor([{ path }], { root: dir })).toThrow(/unsupported data file extension/)
  })
})
