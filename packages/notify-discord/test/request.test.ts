// SPDX-License-Identifier: CPAL-1.0
// request.ts 单测：wait / thread_id 查询参数、body 只有 content / username / allowed_mentions、
// allowed_mentions.parse 恒为空（通知正文不得触发提及）、2000 字符上限。
import { describe, expect, it } from 'vitest'
import { USER_AGENT, buildExecuteRequest, buildMessageBody } from '../src/request'

const ID = '123456789012345678'
const TOKEN = 'fixture-webhook-token-0123456789'
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`

describe('buildMessageBody', () => {
  it('body 只有 content 与 allowed_mentions，parse 是空数组（谁都不 @）', () => {
    const body = buildMessageBody('**[WARN]** Risk denial\nrule Y')
    expect(Object.keys(body)).toEqual(['content', 'allowed_mentions'])
    expect(body.allowed_mentions).toEqual({ parse: [] })
  })

  it('空文本 / 超过 2000 字符都抛 RangeError', () => {
    expect(() => buildMessageBody('')).toThrow(RangeError)
    expect(() => buildMessageBody('   ')).toThrow(RangeError)
    expect(() => buildMessageBody('x'.repeat(2001))).toThrow(/2000/)
    expect(() => buildMessageBody('x'.repeat(2000))).not.toThrow()
  })

  it('username 只在显式给出时出现（不写就不覆盖 webhook 名字）', () => {
    expect(buildMessageBody('t', { username: 'gitrader' }).username).toBe('gitrader')
    expect('username' in buildMessageBody('t', { username: '   ' })).toBe(false)
  })
})

describe('buildExecuteRequest', () => {
  it('URL 带 wait=true，不带其它查询参数', () => {
    const request = buildExecuteRequest(URL_OK, 'hello')
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe(URL_OK)
    expect([...url.searchParams.keys()]).toEqual(['wait'])
    expect(url.searchParams.get('wait')).toBe('true')
  })

  it('给了 threadId 才加 thread_id；非 snowflake 抛 RangeError', () => {
    const request = buildExecuteRequest(URL_OK, 'hello', { threadId: '987654321098765432' })
    expect(new URL(request.url).searchParams.get('thread_id')).toBe('987654321098765432')
    expect(() => buildExecuteRequest(URL_OK, 'hello', { threadId: 'abc' })).toThrow(RangeError)
  })

  it('请求头是 JSON + 官方要求的 DiscordBot User-Agent', () => {
    const request = buildExecuteRequest(URL_OK, 'hello')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['user-agent']).toBe(USER_AGENT)
    expect(request.headers['user-agent']).toMatch(/^DiscordBot \(.+\)$/)
  })

  it('body 是 JSON 字符串，可直接被服务端解析，且不含任何密钥以外的东西', () => {
    const request = buildExecuteRequest(URL_OK, 'line1\nline2')
    expect(JSON.parse(request.body)).toEqual({ content: 'line1\nline2', allowed_mentions: { parse: [] } })
  })

  it('非法 webhook URL 在构造请求时就被拒（不会带着坏 URL 发出去）', () => {
    expect(() => buildExecuteRequest(`https://example.test/api/webhooks/${ID}/${TOKEN}`, 'x')).toThrow(/主机/)
    expect(() => buildExecuteRequest(`http://discord.com/api/webhooks/${ID}/${TOKEN}`, 'x')).toThrow(/https/)
  })
})
