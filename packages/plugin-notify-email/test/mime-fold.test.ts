// SPDX-License-Identifier: CPAL-1.0
// 批 11 主题二 ⑥：插件里的 mime.mjs 是库 src/mime.ts 的手抄副本（L5-12），折行改在两处必须一致。
// 这里既验插件自己的输出（每行 ≤78、解码回原文），也逐字比对库与插件的整个 MIME 报文。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { buildMime as pluginBuildMime } from '../mime.mjs'
import { buildMime as libBuildMime } from '../../notify-email/src/mime'

const FROM = 'bot@localhost'
const TO = ['ops@localhost']
const OPTS = { date: new Date(0), messageId: '<fixed@localhost>' }

const pluginBuild = (subject: string): string => pluginBuildMime({ to: TO, subject, text: 'body' }, FROM, OPTS)
const libBuild = (subject: string): string => libBuildMime({ to: TO, subject, text: 'body' }, FROM, OPTS)

function subjectBlock(mime: string): string[] {
  const lines = mime.split('\r\n\r\n')[0]!.split('\r\n')
  const start = lines.findIndex((l) => /^Subject:/.test(l))
  expect(start).toBeGreaterThanOrEqual(0)
  const out = [lines[start]!]
  for (const line of lines.slice(start + 1)) {
    if (!/^[ \t]/.test(line)) break
    out.push(line)
  }
  return out
}

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

const SUBJECTS = [
  'hello',
  '资金费率告警',
  'A'.repeat(300),
  'risk.denials account acc_1 instrument BTC-USD rule RULE_DENIED '.repeat(5).trim(),
  '异常告警：账户 acc_1 的规则 RULE_DENIED 已连续触发 12 次，请检查风控阈值。'.repeat(4),
]

describe('插件 mime.mjs 的长头折行（与库同一实现）', () => {
  for (const [i, subject] of SUBJECTS.entries()) {
    it(`夹具 ${i + 1}（${subject.length} 字符）：头块每行 ≤78，解码回原文，且与库逐字相同`, () => {
      const mime = pluginBuild(subject)
      const head = mime.split('\r\n\r\n')[0]!
      for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
      expect(decodedSubject(subjectBlock(mime))).toBe(subject)
      // 手抄副本不许漂移（L5-12）：整个报文逐字比对
      expect(mime).toBe(libBuild(subject))
    })
  }

  it('首个单词恰好放不进首行（70–77 字符）时每行仍 ≤78，解码后与原文一致', () => {
    for (const n of [69, 70, 73, 77, 78]) {
      const subject = 'A'.repeat(n)
      const mime = pluginBuild(subject)
      const block = subjectBlock(mime)
      for (const line of block) expect(line.length, `${n} 字符主题：${line}`).toBeLessThanOrEqual(78)
      for (const word of encodedWordsOf(mime)) expect(word.length, `${n} 字符主题：${word}`).toBeLessThanOrEqual(75)
      expect(decodedSubject(block)).toBe(subject)
      expect(mime).toBe(libBuild(subject))
    }
  })

  it('300 字符 ASCII 主题在插件侧也是多行（修前单行 309 字节）', () => {
    const block = subjectBlock(pluginBuild('A'.repeat(300)))
    expect(block.length).toBeGreaterThan(1)
    expect(block[0]!.startsWith('Subject: =?UTF-8?B?')).toBe(true)
    for (const line of block.slice(1)) expect(line.startsWith(' ')).toBe(true)
  })

  it('长 ASCII 主题（无空格）：每个编码词 ≤75 字符（RFC 2047 §2；修前是 76）', () => {
    const words = encodedWordsOf(pluginBuild('A'.repeat(300)))
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) expect(word.length, word).toBeLessThanOrEqual(75)
  })

  it('长中文：每个编码词 ≤75 字符（RFC 2047 §2；修前是 76）', () => {
    const subject = '异常告警：账户 acc_1 的规则 RULE_DENIED 已连续触发 12 次，请检查风控阈值。'.repeat(4)
    const words = encodedWordsOf(pluginBuild(subject))
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) expect(word.length, word).toBeLessThanOrEqual(75)
  })
})
