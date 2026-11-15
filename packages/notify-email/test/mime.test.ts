// SPDX-License-Identifier: CPAL-1.0
// mime.ts 的单元测试：RFC 2047 主题、CRLF、dot-stuffing、multipart/alternative、Message-ID 形态。全部离线。
import { describe, expect, it } from 'vitest'
import { buildMime, dotStuff, escapeHtml } from '../src/mime'

const FROM = 'bot@localhost'
const TO = 'one@localhost'

describe('buildMime 头字段', () => {
  it('中文主题走 RFC 2047 base64 编码，且能解回原文', () => {
    const mime = buildMime({ to: TO, subject: '资金费率告警', text: 'body' }, FROM)
    expect(mime).toContain('Subject: =?UTF-8?B?')
    expect(mime).toContain('?=')

    const encoded = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mime)
    expect(encoded).not.toBeNull()
    expect(Buffer.from(encoded?.[1] ?? '', 'base64').toString('utf8')).toBe('资金费率告警')
  })

  it('Message-ID 形如 <…@…>，可注入且写进头', () => {
    const fixed = buildMime({ to: TO, subject: 's', text: 't' }, FROM, { messageId: '<deadbeef@localhost>' })
    expect(fixed).toContain('Message-ID: <deadbeef@localhost>')

    const generated = /Message-ID: (<?[^\r\n]+>?)/.exec(buildMime({ to: TO, subject: 's', text: 't' }, FROM))
    expect(generated?.[1]).toMatch(/^<[^@\s]+@[^>\s]+>$/)
  })

  it('头里带 To / From / Date；行尾只有 CRLF，没有裸 LF', () => {
    const mime = buildMime({ to: TO, subject: 's', text: 'line1\nline2' }, FROM, { date: new Date(0) })
    expect(mime).toContain(`To: ${TO}`)
    expect(mime).toContain(`From: ${FROM}`)
    expect(mime).toContain('Date: Thu, 01 Jan 1970 00:00:00 +0000')
    expect(mime).toContain('line1\r\nline2')
    expect(/(?<!\r)\n/.test(mime)).toBe(false)
  })

  it('Subject 里的 CR/LF 被压掉（防头注入）', () => {
    const mime = buildMime({ to: TO, subject: 'a\r\nBcc: someone', text: 't' }, FROM)
    expect(mime).not.toContain('\r\nBcc:')
    expect(mime).toContain('Subject: a Bcc: someone')
  })
})

describe('dot-stuffing', () => {
  it('正文行首的 . 变 ..（buildMime 原样，投递阶段由 send 调用 dotStuff）', () => {
    const mime = buildMime({ to: TO, subject: 's', text: '.hidden line\nnormal' }, FROM)
    expect(mime).toContain('\r\n.hidden line')
    expect(dotStuff(mime)).toContain('\r\n..hidden line')
    expect(dotStuff(mime)).toContain('\r\nnormal')
  })
})

describe('multipart/alternative', () => {
  it('有 html 时两段结构，boundary 声明与正文一致', () => {
    const mime = buildMime({ to: TO, subject: 's', text: 'plain', html: '<p>rich</p>' }, FROM)

    expect(mime).toContain('Content-Type: multipart/alternative; boundary="')
    const boundary = /boundary="([^"]+)"/.exec(mime)?.[1] ?? ''
    expect(boundary.length).toBeGreaterThan(0)

    // 两个分段 + 一个结束行
    expect(mime.split(`--${boundary}`).length - 1).toBe(3)
    expect(mime).toContain(`--${boundary}--`)
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8')
    expect(mime).toContain('Content-Type: text/html; charset=utf-8')
    expect(mime).toContain('plain')
    expect(mime).toContain('<p>rich</p>')
  })

  it('无 html 时是单段 text/plain，没有 boundary', () => {
    const mime = buildMime({ to: TO, subject: 's', text: 'only text' }, FROM)
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8')
    expect(mime).not.toContain('multipart')
    expect(mime).not.toContain('boundary=')
  })

  it('数组收件人用逗号并进 To', () => {
    const mime = buildMime({ to: ['one@localhost', 'two@localhost'], subject: 's', text: 't' }, FROM)
    expect(mime).toContain('To: one@localhost, two@localhost')
  })
})

describe('escapeHtml', () => {
  it("转义 & < > \" '", () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;')
    expect(escapeHtml(`"x'`)).toBe('&quot;x&#39;')
  })
})
