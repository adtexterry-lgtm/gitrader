// SPDX-License-Identifier: CPAL-1.0
// format.ts 单测：字节计量、按字节分块（不切开码位 / 行不跨块）、markdown 与 text 两种渲染。
// 上限取官方文档值（markdown 4096 字节 / text 2048 字节），断言用独立的 TextEncoder 复算，不引用被测常量。
import { describe, expect, it } from 'vitest'
import {
  chunkByBytes,
  MARKDOWN_MAX_BYTES,
  escapeMarkdownStructure,
  renderNoticeMarkdown,
  renderNoticeText,
  sanitizeField,
  TEXT_MAX_BYTES,
  utf8Bytes,
} from '../src/format'

const encoder = new TextEncoder()
const bytes = (s: string): number => encoder.encode(s).length

describe('utf8Bytes', () => {
  it('中文按 3 字节计（与 String.length 不同）', () => {
    expect(utf8Bytes('资金费率告警')).toBe(18)
    expect('资金费率告警'.length).toBe(6)
  })

  it('ASCII 1 字节、表情 4 字节、空串 0', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('🚀')).toBe(4)
    expect(utf8Bytes('')).toBe(0)
  })
})

describe('官方长度上限', () => {
  it('markdown 4096 字节 / text 2048 字节', () => {
    expect(MARKDOWN_MAX_BYTES).toBe(4096)
    expect(TEXT_MAX_BYTES).toBe(2048)
  })
})

describe('chunkByBytes', () => {
  it('空文本 → []', () => {
    expect(chunkByBytes('', 100)).toEqual([])
  })

  it('非法上限抛 RangeError', () => {
    expect(() => chunkByBytes('x', 0)).toThrow(RangeError)
    expect(() => chunkByBytes('x', Number.NaN)).toThrow(RangeError)
  })

  it('短文本只有一块，原样返回（含换行）', () => {
    const text = 'line one\nline two\nline three'
    expect(chunkByBytes(text, 4096)).toEqual([text])
  })

  it('中文正文按字节切：每块 ≤ 上限，拼回来一字不丢', () => {
    const text = Array.from({ length: 120 }, (_, i) => `第 ${i} 行：资金费率接近阈值，已记录事实`).join('\n')
    expect(bytes(text)).toBeGreaterThan(4096)
    const parts = chunkByBytes(text, 4096)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(4096)
    expect(parts.join('\n')).toBe(text)
  })

  it('超长单行硬切也不切开汉字与表情（每块可无损往返）', () => {
    const line = '中文🚀'.repeat(1200)
    const parts = chunkByBytes(line, 4096)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(bytes(part)).toBeLessThanOrEqual(4096)
      // 解码再编码必须一致：切开代理对会得到 U+FFFD
      expect(new TextDecoder().decode(encoder.encode(part))).toBe(part)
      expect(part.includes('\uFFFD')).toBe(false)
    }
    expect(parts.join('')).toBe(line)
  })

  it('行不跨块：有分块时每块都不以换行开头/结尾', () => {
    const text = Array.from({ length: 200 }, () => 'a'.repeat(60)).join('\n')
    const parts = chunkByBytes(text, 256)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.startsWith('\n')).toBe(false)
      expect(part.endsWith('\n')).toBe(false)
      expect(bytes(part)).toBeLessThanOrEqual(256)
    }
  })
})

describe('sanitizeField', () => {
  it('换行折成空格并 trim', () => {
    expect(sanitizeField('  a\r\nb\nc  ')).toBe('a b c')
  })

  it('去掉控制字符，保留正常标点与中文', () => {
    expect(sanitizeField('a\u0000b\u0007c\u001fd，金额 1200')).toBe('abcd，金额 1200')
  })

  it('非字符串输入返回空串', () => {
    expect(sanitizeField(undefined as unknown as string)).toBe('')
  })
})

describe('renderNoticeMarkdown', () => {
  it('标题按 ### [级别] 渲染，正文逐行，时间用行内代码', () => {
    const text = renderNoticeMarkdown({
      title: '资金费率告警',
      lines: ['account acct_x', 'rule FR-1', 'value 0.0031 limit 0.0030'],
      ts: 1760000000000,
      level: 'warn',
    })
    expect(text.split('\n')).toEqual([
      '### [WARN] 资金费率告警',
      'account acct_x',
      'rule FR-1',
      'value 0.0031 limit 0.0030',
      '`2025-10-09T08:53:20.000Z`',
    ])
  })

  it('level 缺省 info，critical 用 CRIT', () => {
    expect(renderNoticeMarkdown({ title: 't', lines: [] })).toBe('### [INFO] t')
    expect(renderNoticeMarkdown({ title: 't', lines: [], level: 'critical' })).toBe('### [CRIT] t')
  })

  it('空标题只留级别标记；无 ts 不留时间行', () => {
    expect(renderNoticeMarkdown({ title: '  ', lines: ['x'] })).toBe('### [INFO]\nx')
    expect(renderNoticeMarkdown({ title: 't', lines: ['x'] })).not.toContain('`')
  })

  it('一行里的换行被折平：正文不能靠换行伪造额外标题行', () => {
    const text = renderNoticeMarkdown({ title: 't', lines: ['ok', '### 伪造标题\n第二行'] })
    expect(text.split('\n')).toEqual(['### [INFO] t', 'ok', '＃＃＃ 伪造标题 第二行'])
  })

  it('渲染结果不做自由文本：不追加说明段、不追加品牌文案', () => {
    const text = renderNoticeMarkdown({ title: 't', lines: ['a'] })
    expect(text).toBe('### [INFO] t\na')
  })
})

describe('renderNoticeText', () => {
  it('纯文本形态：首行 [级别] 标题，末行裸 ISO 时间', () => {
    const text = renderNoticeText({ title: '连接断开', lines: ['venue okx', 'state down'], ts: 1760000000000, level: 'critical' })
    expect(text.split('\n')).toEqual(['[CRIT] 连接断开', 'venue okx', 'state down', '2025-10-09T08:53:20.000Z'])
  })

  it('中文正文的纯文本形态也在 2048 字节上限内可分块', () => {
    const text = renderNoticeText({ title: 't', lines: Array.from({ length: 60 }, () => '中文事实行') })
    const parts = chunkByBytes(text, TEXT_MAX_BYTES)
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(TEXT_MAX_BYTES)
    expect(parts.join('\n')).toBe(text)
  })
})

describe('escapeMarkdownStructure（L5-14）', () => {
  it('结构字符换成同形全角，行首 # 单独处理', () => {
    expect(escapeMarkdownStructure('[x](https://evil.example)')).toBe('［x］（https://evil.example）')
    expect(escapeMarkdownStructure('<font color="red">y</font>')).toBe('＜font color="red">y＜/font>')
    expect(escapeMarkdownStructure('# 假标题')).toBe('＃ 假标题')
    expect(escapeMarkdownStructure('issue #12')).toBe('issue #12')
    expect(escapeMarkdownStructure('')).toBe('')
  })
})
