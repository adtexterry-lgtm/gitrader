// SPDX-License-Identifier: CPAL-1.0
// format.ts 单测：Markdown 子集转义、2000 字符分块（按行 / 按码点硬切）、固定模板渲染。
import { describe, expect, it } from 'vitest'
import { MAX_CONTENT, chunkContent, escapeDiscordMarkdown, renderNotice } from '../src/format'

describe('escapeDiscordMarkdown', () => {
  it("'a*b_c[d]' 的格式字符加反斜杠", () => {
    expect(escapeDiscordMarkdown('a*b_c[d]')).toBe('a\\*b\\_c\\[d\\]')
  })

  it('反斜杠本身也转义（保证输出可逆、不出现半个转义）', () => {
    expect(escapeDiscordMarkdown('a\\b')).toBe('a\\\\b')
  })

  it('普通文本原样返回', () => {
    expect(escapeDiscordMarkdown('account acct_x 1200 > 1000')).toBe('account acct\\_x 1200 \\> 1000')
    expect(escapeDiscordMarkdown('')).toBe('')
  })

  it('不会改动竖线、波浪线与代码标记以外的字符', () => {
    expect(escapeDiscordMarkdown('|~`')).toBe('\\|\\~\\`')
    expect(escapeDiscordMarkdown('中文与数字 123')).toBe('中文与数字 123')
  })
})

describe('chunkContent', () => {
  it('按行累加，不在行中间断', () => {
    expect(chunkContent('aa\nbb\ncc', 6)).toEqual(['aa\nbb', 'cc'])
  })

  it('超长单行硬切成多段，每段不超过上限', () => {
    expect(chunkContent('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('硬切按码点走，不切开代理对（emoji 不出现半个字符）', () => {
    const chunks = chunkContent('😀😀😀', 4)
    expect(chunks).toEqual(['😀😀', '😀'])
    for (const chunk of chunks) expect(chunk).toBe([...chunk].join(''))
  })

  it('空文本 → []，max 非法 → RangeError', () => {
    expect(chunkContent('')).toEqual([])
    expect(() => chunkContent('x', 0)).toThrow(RangeError)
  })

  it('缺省上限是 2000：正文 2000 字符一块，2001 字符两块', () => {
    expect(MAX_CONTENT).toBe(2000)
    expect(chunkContent('x'.repeat(2000))).toHaveLength(1)
    expect(chunkContent('x'.repeat(2001))).toHaveLength(2)
  })
})

describe('renderNotice', () => {
  it('第一行 level 标记 + title，逐行正文，末行 Discord 时间戳', () => {
    const out = renderNotice({ title: 'Risk denial', lines: ['account acct_x', 'notional 1200'], ts: 1760000000000, level: 'warn' })
    const lines = out.split('\n')
    expect(lines[0]).toBe('**[WARN]** Risk denial')
    expect(lines[1]).toBe('account acct\\_x')
    expect(lines[2]).toBe('notional 1200')
    expect(lines[3]).toBe('<t:1760000000:f>')
  })

  it('没有 ts 就没有时间戳行；level 缺省是 info', () => {
    const lines = renderNotice({ title: 't', lines: ['l1'] }).split('\n')
    expect(lines[0]).toBe('**[INFO]** t')
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).not.toContain('<t:')
  })

  it('critical 用 [CRIT]；空 title 只剩标记（不留尾随空格）', () => {
    expect(renderNotice({ title: '', lines: [], level: 'critical' })).toBe('**[CRIT]**')
  })

  it('渲染结果不带品牌文案与表情（只搬事实字段）', () => {
    const out = renderNotice({ title: 'Risk denial', lines: ['rule Y'], level: 'info' })
    expect(out).not.toMatch(/Gitrader|QuantDinger|QD Signal/i)
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
  })
})
