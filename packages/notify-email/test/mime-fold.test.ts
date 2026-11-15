// SPDX-License-Identifier: CPAL-1.0
// 批 11 主题二 ⑥（OSS-ADOPTION #12）：长邮件头折行。
//   修前：300 字符 ASCII 主题输出单行 `Subject: …`（309 字节）；RFC 5322 硬上限 998 不违规，
//         但超过 78 字符的行在部分 MUA 上显示异常。
//   修后：每行 ≤78；ASCII 在空格处折（展开后逐字相同），无空格长词 / 非 ASCII 走 RFC 2047 编码词分段
//         （段间空白解码时忽略，原文一字不差）。
import { describe, expect, it } from 'vitest'
import { buildMime } from '../src/mime'

const FROM = 'bot@localhost'
const TO = ['ops@localhost']
const DATE = new Date(0)
const MESSAGE_ID = '<fixed@localhost>'

const build = (subject: string): string =>
  buildMime({ to: TO, subject, text: 'body' }, FROM, { date: DATE, messageId: MESSAGE_ID })

/** 头块（第一个空行之前）里的 Subject 字段，含折叠的续行。 */
function subjectBlock(mime: string): string[] {
  const head = mime.split('\r\n\r\n')[0]!
  const lines = head.split('\r\n')
  const start = lines.findIndex((l) => /^Subject:/.test(l))
  expect(start, '没有 Subject 头').toBeGreaterThanOrEqual(0)
  const out = [lines[start]!]
  for (const line of lines.slice(start + 1)) {
    if (!/^[ \t]/.test(line)) break
    out.push(line)
  }
  return out
}

/** 展开（去掉 CRLF + 续行缩进）后解码：编码词逐段 base64 解码并直接拼回原文（段间空白按 RFC 2047 丢弃）。 */
function decodedSubject(block: string[]): string {
  const unfolded = block.join('\r\n').replace(/\r\n[ \t]+/g, ' ').replace(/^Subject:[ \t]*/, '')
  if (!unfolded.includes('=?UTF-8?B?')) return unfolded
  return unfolded.split(/\s+/).filter((w) => w.length > 0).map((word) => {
    const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(word)
    expect(m, `不是 RFC 2047 编码词：${word}`).not.toBeNull()
    return Buffer.from(m![1]!, 'base64').toString('utf8')
  }).join('')
}

/** 头块里所有 RFC 2047 编码词（含 `=?UTF-8?B?` 与 `?=` 外壳）：RFC 2047 §2 限 75 字符。 */
function encodedWordsOf(mime: string): string[] {
  return mime.split('\r\n\r\n')[0]!.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=/g) ?? []
}

const ALERT = 'risk.denials account acc_1 instrument BTC-USD rule RULE_DENIED '.repeat(5).trim()

describe('长 ASCII 主题（无空格）按 RFC 5322 折行', () => {
  const subject = 'A'.repeat(300)

  it('每行 ≤78 字符（修前是单行 309 字节）', () => {
    const block = subjectBlock(build(subject))
    expect(block.length).toBeGreaterThan(1)
    for (const line of block) expect(line.length).toBeLessThanOrEqual(78)
  })

  it('整个头块每行 ≤78，且没有裸 LF（行尾一律 CRLF）', () => {
    const mime = build(subject)
    const head = mime.split('\r\n\r\n')[0]!
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
    expect(/(^|[^\r])\n/.test(head)).toBe(false)
  })

  it('展开 + 解码后与原文逐字相同（没有为了折行插空格）', () => {
    expect(decodedSubject(subjectBlock(build(subject)))).toBe(subject)
  })

  it('每个编码词 ≤75 字符（RFC 2047 §2；修前是 76）', () => {
    const words = encodedWordsOf(build(subject))
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) expect(word.length, word).toBeLessThanOrEqual(75)
  })
})

describe('长 ASCII 主题（有空格）只在原有空格处折', () => {
  it('保持纯文本（不编码）、每行 ≤78、展开后与原文一致', () => {
    const block = subjectBlock(build(ALERT))
    expect(block.length).toBeGreaterThan(1)
    for (const line of block) expect(line.length).toBeLessThanOrEqual(78)
    expect(block.join('')).not.toContain('=?UTF-8?B?')
    expect(decodedSubject(block)).toBe(ALERT)
  })
})

describe('短主题与非 ASCII 主题不回归', () => {
  it('短 ASCII：单行原样 `Subject: hello`', () => {
    const block = subjectBlock(build('hello'))
    expect(block).toEqual(['Subject: hello'])
  })

  it('短中文：仍是单个 RFC 2047 编码词（与批 10 之前一致）', () => {
    const block = subjectBlock(build('资金费率告警'))
    expect(block).toHaveLength(1)
    expect(block[0]).toBe(`Subject: =?UTF-8?B?${Buffer.from('资金费率告警', 'utf8').toString('base64')}?=`)
    expect(decodedSubject(block)).toBe('资金费率告警')
  })

  it('长中文：折成多个编码词，每行 ≤78，解码后一字不差（不切开多字节字符）', () => {
    const subject = '异常告警：账户 acc_1 的规则 RULE_DENIED 已连续触发 12 次，请检查风控阈值。'.repeat(4)
    const block = subjectBlock(build(subject))
    expect(block.length).toBeGreaterThan(1)
    for (const line of block) expect(line.length).toBeLessThanOrEqual(78)
    for (const line of block.slice(1)) expect(line.startsWith(' ')).toBe(true)
    expect(decodedSubject(block)).toBe(subject)
  })

  it('长中文：每个编码词 ≤75 字符（RFC 2047 §2；修前是 76）', () => {
    const subject = '异常告警：账户 acc_1 的规则 RULE_DENIED 已连续触发 12 次，请检查风控阈值。'.repeat(4)
    const words = encodedWordsOf(build(subject))
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) expect(word.length, word).toBeLessThanOrEqual(75)
  })
})

describe('首个单词恰好放不进首行（70–77 字符）', () => {
  it('首个单词恰好放不进首行（70–77 字符）时每行仍 ≤78，解码后与原文一致', () => {
    for (const n of [69, 70, 73, 77, 78]) {
      const subject = 'A'.repeat(n)
      const mime = build(subject)
      const block = subjectBlock(mime)
      for (const line of block) expect(line.length, `${n} 字符主题：${line}`).toBeLessThanOrEqual(78)
      for (const word of encodedWordsOf(mime)) expect(word.length, `${n} 字符主题：${word}`).toBeLessThanOrEqual(75)
      expect(decodedSubject(block)).toBe(subject)
    }
  })
})

describe('头注入防护不因折行回归', () => {
  it('主题里的 CRLF + 伪头被压成空格，不产生新头行', () => {
    const mime = build('a\r\nBcc: someone@example.com')
    const head = mime.split('\r\n\r\n')[0]!
    expect(head).not.toMatch(/\r\nBcc:/)
    expect(subjectBlock(mime)).toEqual(['Subject: a Bcc: someone@example.com'])
  })
})
