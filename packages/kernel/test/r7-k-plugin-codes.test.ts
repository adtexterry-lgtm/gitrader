// SPDX-License-Identifier: CPAL-1.0
// r7 WP-K GQ-57：用户文档 07-插件.md §9 的拒绝码表里每个码都必须是代码里真有的清单问题码（PLUGIN_ISSUE_CODES）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_ISSUE_CODES } from '@gitrader/protocol'

const section = (file: string): string => {
  const text = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'user', file), 'utf8')
  const start = text.indexOf('## 9.')
  return text.slice(start, text.indexOf('## 10.', start))
}
const codesIn = (md: string): string[] => [...md.matchAll(/^\| `([A-Z][A-Z_]+)` \|/gm)].map(m => m[1]!)

describe('GQ-57 文档拒绝码表与代码一致', () => {
  for (const file of ['07-插件.md', join('en', '07-插件.md')]) {
    it(`${file} §9 的码全部存在于 PLUGIN_ISSUE_CODES`, () => {
      const codes = codesIn(section(file))
      expect(codes.length).toBeGreaterThanOrEqual(7)
      expect(codes.filter(c => !(PLUGIN_ISSUE_CODES as readonly string[]).includes(c))).toEqual([])
    })
  }

  it('反例：解析器确实能认出不存在的码（旧文档的写法会被抓到）', () => {
    expect(codesIn('| `SCHEMA_INVALID` | x | y |\n| `SIGNATURE_UNTRUSTED` | x | y |').filter(c => !(PLUGIN_ISSUE_CODES as readonly string[]).includes(c))).toEqual(['SCHEMA_INVALID', 'SIGNATURE_UNTRUSTED'])
  })
})
