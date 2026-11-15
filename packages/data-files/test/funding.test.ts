// SPDX-License-Identifier: CPAL-1.0
// ⑥ 资金费：t,rate[,premium] 表头 + 坏行 → parsed / skipped 精确。
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectFundingFile } from '../src/index'
import { digestOf, dropTmpDir, HOUR, makeTmpDir, T0, writeFixture } from './helpers'

let dir = ''

beforeAll(() => {
  dir = makeTmpDir()
})
afterAll(() => {
  dropTmpDir(dir)
})

const CSV = [
  't,rate,premium',
  `${T0},0.0001,0.0002`,
  `${T0 + 8 * HOUR},-0.0002,0`,
  `${T0 + 16 * HOUR},0.0003,0.0001`,
  `${T0 + 24 * HOUR},0.00005,`,
  'oops,0.1',
].join('\n')

describe('inspectFundingFile / CSV', () => {
  it('表头 + 坏行：rows 6、parsed 4、skipped 1，from/to 正确', () => {
    const path = writeFixture(dir, 'funding.csv', `${CSV}\n`)
    const r = inspectFundingFile(path, { root: dir })
    expect(r.rows).toBe(6)
    expect(r.parsed).toBe(4)
    expect(r.skipped).toBe(1)
    expect(r.duplicates).toBe(0)
    expect(r.format).toBe('csv')
    expect(r.from).toBe(T0)
    expect(r.to).toBe(T0 + 24 * HOUR)
    expect(r.sha256).toBe(digestOf(readFileSync(path)))
    expect(r.warnings).toContain('first line treated as a header')
    expect(r.warnings).toContain('1 malformed row(s) skipped')
  })

  it('只有一列 / 缺 rate 的行也算坏行', () => {
    const path = writeFixture(
      dir,
      'funding-bad.csv',
      ['t,rate', `${T0}`, `${T0 + 8 * HOUR},not-a-rate`, `${T0 + 16 * HOUR},0.0002`].join('\n') + '\n',
    )
    const r = inspectFundingFile(path, { root: dir })
    expect(r.rows).toBe(4)
    expect(r.parsed).toBe(1)
    expect(r.skipped).toBe(2)
  })

  it('JSON 点列（{points:[...]} 与裸数组）与 rate 字串', () => {
    const wrapped = writeFixture(
      dir,
      'funding.json',
      JSON.stringify({ points: [{ t: T0, rate: 0.0001 }, { t: T0 + 8 * HOUR, rate: '0.0002' }] }),
    )
    const bare = writeFixture(dir, 'funding-bare.json', JSON.stringify([[T0, 0.0001], [T0 + 8 * HOUR, 0.0002]]))
    const a = inspectFundingFile(wrapped, { root: dir })
    const b = inspectFundingFile(bare, { root: dir })
    expect(a.format).toBe('json')
    expect(a.parsed).toBe(2)
    expect(a.skipped).toBe(0)
    expect(b.parsed).toBe(2)
    expect(a.path).toBe(wrapped)
  })

  it('无法解析的 JSON 给空报告并警告，不抛错', () => {
    const path = writeFixture(dir, 'funding-broken.json', '{"points": [')
    const r = inspectFundingFile(path, { root: dir })
    expect(r.parsed).toBe(0)
    expect(r.from).toBeNull()
    expect(r.warnings).toContain('JSON is not a funding point list; nothing parsed')
  })
})
