// SPDX-License-Identifier: CPAL-1.0
// format.ts 的单元测试：MarkdownV2 转义、按行分块、固定模板渲染。
import { describe, expect, it } from 'vitest'
import { chunkMessage, escapeMarkdownV2, renderNotice } from '../src/format'

describe('escapeMarkdownV2', () => {
  it("'a_b*c[d]' → 'a\\_b\\*c\\[d\\]'", () => {
    expect(escapeMarkdownV2('a_b*c[d]')).toBe('a\\_b\\*c\\[d\\]')
  })

  it('18 个保留字符逐个加反斜杠', () => {
    const reserved = '_*[]()~`>#+-=|{}.!'
    expect(reserved).toHaveLength(18)
    expect(escapeMarkdownV2(reserved)).toBe(reserved.split('').map((c) => `\\${c}`).join(''))
  })

  it('普通文本原样返回', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world')
  })

  it('反斜杠自身也转义：行尾单个 \\ 变成两个（否则 400 can\'t parse entities）', () => {
    expect(escapeMarkdownV2('a\\')).toBe('a\\\\')
  })

  it('反斜杠不吞掉后一个保留字符的转义前缀', () => {
    // 输入：\ _ b o l d _  →  \\ \_ b o l d \_（开头的 _ 仍是转义状态）
    expect(escapeMarkdownV2('\\_bold_')).toBe('\\\\\\_bold\\_')
  })

  it('Windows 风格路径里的每个反斜杠都翻倍', () => {
    expect(escapeMarkdownV2('C:\\temp\\x')).toBe('C:\\\\temp\\\\x')
  })
})

describe('chunkMessage', () => {
  it("chunkMessage('l1\\nl2', 3) → ['l1', 'l2']", () => {
    expect(chunkMessage('l1\nl2', 3)).toEqual(['l1', 'l2'])
  })

  it('超长单行 10 个字符 max 4 → 硬切成三段', () => {
    expect(chunkMessage('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('空文本 → []', () => {
    expect(chunkMessage('')).toEqual([])
  })

  it('按行累加，不在行中间断', () => {
    expect(chunkMessage('aa\nbb\ncc', 6)).toEqual(['aa\nbb', 'cc'])
  })
})

describe('renderNotice', () => {
  it('模板含加粗 title、每行一条、末行 ISO 时间', () => {
    const out = renderNotice({ title: 'x', lines: ['a'], ts: 0, level: 'warn' })
    expect(out).toContain('*x*')
    expect(out).toContain('a')
    expect(out).toContain('1970-01-01T00:00:00.000Z')
    expect(out).not.toMatch(/QuantDinger|QD Signal|Gitrader/i)
  })

  it('第一行带 level 标记，无 ts 时没有时间行', () => {
    const out = renderNotice({ title: 't', lines: ['l1', 'l2'], level: 'critical' })
    const lines = out.split('\n')
    expect(lines[0]).toContain('\\[CRIT\\]') // 方括号已按 MarkdownV2 转义
    expect(lines).toHaveLength(3)
    expect(out).not.toContain('T00:')
  })

  it('动态文本走 MarkdownV2 转义', () => {
    const out = renderNotice({ title: 'a.b', lines: ['c(d)'] })
    expect(out).toContain('*a\\.b*')
    expect(out).toContain('c\\(d\\)')
  })
})
