// SPDX-License-Identifier: CPAL-1.0
// url.ts 单测：官方 execute 路由解析、主机 / 协议 / 兼容路由 / 查询串拒绝、token 脱敏。
import { describe, expect, it } from 'vitest'
import { DISCORD_HOSTS, WebhookUrlError, isAllowedHost, parseWebhookUrl, redactText, redactWebhookUrl, scrubWebhookUrls } from '../src/url'

const ID = '123456789012345678'
const TOKEN = 'fixture-webhook-token-0123456789'
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`

function problemOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookUrlError)
    return (error as WebhookUrlError).problem
  }
  throw new Error('expected a WebhookUrlError')
}

describe('parseWebhookUrl', () => {
  it('解析官方 execute 路由，id / token / 规范化 URL 都对', () => {
    const target = parseWebhookUrl(URL_OK)
    expect(target).toEqual({ id: ID, token: TOKEN, url: URL_OK })
  })

  it('允许 discordapp.com 与 canary / ptb 子域；主机名统一小写', () => {
    for (const host of DISCORD_HOSTS) {
      const target = parseWebhookUrl(`https://${host.toUpperCase()}/api/webhooks/${ID}/${TOKEN}`)
      expect(target.url.startsWith(`https://${host}/api/webhooks/`)).toBe(true)
    }
  })

  it('http 直接拒绝（token 是密钥，明文传输不接受）', () => {
    expect(problemOf(() => parseWebhookUrl(`http://discord.com/api/webhooks/${ID}/${TOKEN}`))).toBe('insecure_scheme')
  })

  it('非官方主机拒绝，防把通知发到别处', () => {
    expect(problemOf(() => parseWebhookUrl(`https://example.test/api/webhooks/${ID}/${TOKEN}`))).toBe('host_not_allowed')
    // 后缀相同的伪域名也不算
    expect(problemOf(() => parseWebhookUrl(`https://discord.com.example.test/api/webhooks/${ID}/${TOKEN}`))).toBe('host_not_allowed')
  })

  it('/slack 与 /github 兼容路由不接受（本通道只实现原生 JSON execute）', () => {
    expect(problemOf(() => parseWebhookUrl(`${URL_OK}/slack`))).toBe('unsupported_route')
    expect(problemOf(() => parseWebhookUrl(`${URL_OK}/github`))).toBe('unsupported_route')
  })

  it('带查询串拒绝：wait / thread_id 由客户端加，避免与用户配置打架', () => {
    expect(problemOf(() => parseWebhookUrl(`${URL_OK}?wait=true`))).toBe('query_not_allowed')
  })

  it('路径形状不对（缺 token、id 非数字、多一段）一律拒绝', () => {
    expect(problemOf(() => parseWebhookUrl('https://discord.com/api/webhooks/123456789012345678'))).toBe('bad_path')
    expect(problemOf(() => parseWebhookUrl('https://discord.com/api/webhooks/abc/fixture-webhook-token-0123456789'))).toBe('bad_path')
    expect(problemOf(() => parseWebhookUrl(`${URL_OK}/extra`))).toBe('bad_path')
  })

  it('空值 / 非字符串 / 乱写 → not_a_url', () => {
    expect(problemOf(() => parseWebhookUrl(''))).toBe('not_a_url')
    expect(problemOf(() => parseWebhookUrl(undefined))).toBe('not_a_url')
    expect(problemOf(() => parseWebhookUrl('not a url'))).toBe('not_a_url')
  })

  it('主机允许清单是精确匹配，不做后缀放行', () => {
    expect(isAllowedHost('discord.com')).toBe(true)
    expect(isAllowedHost('DISCORD.COM')).toBe(true)
    expect(isAllowedHost('evil-discord.com')).toBe(false)
    expect(isAllowedHost('discord.com.evil.test')).toBe(false)
  })
})

describe('脱敏', () => {
  it('redactWebhookUrl 保留 id、隐藏 token；乱写的输入不回显原值', () => {
    expect(redactWebhookUrl(URL_OK)).toBe(`https://discord.com/api/webhooks/${ID}/<redacted>`)
    expect(redactWebhookUrl('not a url')).toBe('<invalid webhook url>')
  })

  it('redactText 抹掉 token 与整条 URL，并压成一行', () => {
    const text = redactText(`failed for ${URL_OK} token=${TOKEN}\nline2`, [TOKEN, URL_OK])
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(`/api/webhooks/${ID}/${TOKEN}`)
    expect(text).toContain('<redacted>')
    expect(text).not.toContain('\n')
  })

  it('scrubWebhookUrls 只动 webhook URL，普通链接原样保留', () => {
    const out = scrubWebhookUrls(`see ${URL_OK} and https://discord.com/developers/docs/resources/webhook`)
    expect(out).toContain(`/api/webhooks/${ID}/<redacted>`)
    expect(out).toContain('https://discord.com/developers/docs/resources/webhook')
  })

  it('redactText 截断到上限，且短密钥（<4 字符）不参与替换以免误伤数字', () => {
    const long = redactText('x'.repeat(400), [], 300)
    expect(long.length).toBe(301)
    expect(redactText('value 12 34', ['12'])).toBe('value 12 34')
  })
})
