// SPDX-License-Identifier: CPAL-1.0
// 插件 format.mjs 是库 src/format.ts 的副本：验证反斜杠转义（L5-05）并对两边输出做 parity（L5-12）。
import { describe, expect, it } from 'vitest'
import { escapeMarkdownV2 as libEscape, renderNotice as libRender } from '../../notify-telegram/src/format'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { escapeMarkdownV2 as pluginEscape, renderNotice as pluginRender } from '../format.mjs'

/** 含反斜杠 / 行尾反斜杠 / 反斜杠+保留字符的夹具。 */
const FIXTURES = [
  'plain',
  'a\\',
  '\\_bold_',
  'C:\\temp\\x',
  'a_b*c[d]',
  'x\\*y\\*',
  'back\\\\slash',
]

describe('escapeMarkdownV2：反斜杠自身也转义', () => {
  it('行尾单个反斜杠 → 两个', () => {
    expect(pluginEscape('a\\')).toBe('a\\\\')
    expect(libEscape('a\\')).toBe('a\\\\')
  })

  it('反斜杠不吞掉后一个保留字符的转义前缀', () => {
    expect(pluginEscape('\\_bold_')).toBe('\\\\\\_bold\\_')
    expect(libEscape('\\_bold_')).toBe('\\\\\\_bold\\_')
  })

  it('输出的反斜杠总数 = 输入反斜杠数 × 2 + 保留字符数', () => {
    const input = 'a\\_b*'
    const out = pluginEscape(input)
    expect(out.split('').filter((ch: string) => ch === '\\')).toHaveLength(2 * 1 + 2)
  })
})

describe('format.mjs 与库 src/format.ts 输出一致', () => {
  it('escapeMarkdownV2 对同一批输入逐字节相同', () => {
    for (const input of FIXTURES) expect(pluginEscape(input)).toBe(libEscape(input))
  })

  it('renderNotice 对含反斜杠的通知逐字节相同', () => {
    const notice = { title: 'a\\_b', lines: ['path C:\\temp\\x', 'tail\\'], level: 'warn' as const, ts: 1760000000000 }
    expect(pluginRender(notice)).toBe(libRender(notice))
  })
})
