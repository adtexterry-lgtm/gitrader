// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { buildWebhookRequest } from '../src/index'

const FEISHU_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaa'
const DING_URL = 'https://oapi.dingtalk.com/robot/send?access_token=abc'
const WECOM_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k'
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/xxxx'
const DISCORD_URL = 'https://discord.com/api/webhooks/1/abc'
const GENERIC_URL = 'https://notify.internal.example/ingest'

const FEISHU_SECRET = 'feishu-test-secret'
const FEISHU_SIGN_1700000000 = 'e3MJ8Q5llVxGJ8pVkGPBhexDAgjvYqpjPP1GkY9XceI='
const DING_SECRET = 'SECdingtalktest'
const DING_SIGN_1700000000000 = 'JHmrURd46Kkp6pS8FyLjKUOx6g2z9LRclNTxxhiUoig%3D'
const NOW = 1700000000000

const parse = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>

describe('请求构造', () => {
  it('飞书纯文本：msg_type text，content.text 带标题；有密钥时 body 带秒级 timestamp 与 sign', () => {
    const req = buildWebhookRequest('feishu', FEISHU_URL, 'BTC 0.3%', { secret: FEISHU_SECRET, title: '资金费率告警', now: NOW })
    const body = parse(req.body)
    expect(req.url).toBe(FEISHU_URL)
    expect(req.headers['Content-Type']).toContain('application/json')
    expect(body.msg_type).toBe('text')
    expect((body.content as Record<string, unknown>).text).toBe('资金费率告警\nBTC 0.3%')
    expect(body.timestamp).toBe('1700000000')
    expect(body.sign).toBe(FEISHU_SIGN_1700000000)
    expect(req.body).not.toContain(FEISHU_SECRET)
  })

  it('飞书 Markdown：改发 interactive 卡片，lark_md 里标题加粗', () => {
    const req = buildWebhookRequest('feishu', FEISHU_URL, 'BTC 0.3%', { title: '资金费率告警', markdown: true, now: NOW })
    const body = parse(req.body)
    expect(body.msg_type).toBe('interactive')
    const card = body.card as { elements: Array<{ text: { tag: string; content: string } }> }
    expect(card.elements[0]?.text.tag).toBe('lark_md')
    expect(card.elements[0]?.text.content).toBe('**资金费率告警**\nBTC 0.3%')
    // 无密钥时不应出现签名字段
    expect(body.timestamp).toBeUndefined()
    expect(body.sign).toBeUndefined()
  })

  it('钉钉 Markdown：msgtype markdown，title 取标题，text 以 `### 标题` 开头', () => {
    const req = buildWebhookRequest('dingtalk', DING_URL, 'BTC 0.3%', { title: '资金费率告警', now: NOW })
    const body = parse(req.body)
    expect(body.msgtype).toBe('markdown')
    const markdown = body.markdown as { title: string; text: string }
    expect(markdown.title).toBe('资金费率告警')
    expect(markdown.text).toBe('### 资金费率告警\n\nBTC 0.3%')
    expect(req.url).toBe(DING_URL)
  })

  it('钉钉纯文本形态：msgtype text，content 带标题首行', () => {
    const req = buildWebhookRequest('dingtalk', DING_URL, 'BTC 0.3%', { title: '资金费率告警', markdown: false })
    const body = parse(req.body)
    expect(body.msgtype).toBe('text')
    expect((body.text as Record<string, unknown>).content).toBe('资金费率告警\nBTC 0.3%')
  })

  it('钉钉签名：timestamp / sign 拼到已有查询串之后（& 连接）', () => {
    const req = buildWebhookRequest('dingtalk', DING_URL, 'x', { secret: DING_SECRET, now: NOW })
    expect(req.url).toBe(`${DING_URL}&timestamp=1700000000000&sign=${DING_SIGN_1700000000000}`)
    expect(req.body).not.toContain(DING_SECRET)
  })

  it('钉钉 URL 无查询串时用 ? 连接；无密钥时 URL 原样', () => {
    const plainUrl = 'https://oapi.dingtalk.com/robot/send'
    const signed = buildWebhookRequest('dingtalk', plainUrl, 'x', { secret: DING_SECRET, now: NOW })
    expect(signed.url.startsWith(`${plainUrl}?timestamp=1700000000000&sign=`)).toBe(true)
    const unsigned = buildWebhookRequest('dingtalk', DING_URL, 'x', { now: NOW })
    expect(unsigned.url).toBe(DING_URL)
  })

  it('钉钉 markdown 的 title 字段按 64 字符截断', () => {
    const longTitle = 'T'.repeat(70)
    const body = parse(buildWebhookRequest('dingtalk', DING_URL, 'x', { title: longTitle }).body)
    expect((body.markdown as { title: string }).title).toBe('T'.repeat(64))
  })

  it('企业微信：msgtype markdown，markdown.content 带三级标题；secret 不改变 URL', () => {
    const md = parse(buildWebhookRequest('wecom', WECOM_URL, 'BTC 0.3%', { title: '资金费率告警', secret: 'wecom-secret' }).body)
    expect(md.msgtype).toBe('markdown')
    expect((md.markdown as { content: string }).content).toBe('### 资金费率告警\n\nBTC 0.3%')
    const req = buildWebhookRequest('wecom', WECOM_URL, 'BTC 0.3%', { secret: 'wecom-secret' })
    expect(req.url).toBe(WECOM_URL)
    expect(req.body).not.toContain('wecom-secret')
    const text = parse(buildWebhookRequest('wecom', WECOM_URL, 'BTC 0.3%', { title: '资金费率告警', markdown: false }).body)
    expect(text.msgtype).toBe('text')
    expect((text.text as { content: string }).content).toBe('资金费率告警\nBTC 0.3%')
  })

  it('slack / discord / generic 各自的字段与加粗语法', () => {
    const slack = parse(buildWebhookRequest('slack', SLACK_URL, 'BTC 0.3%', { title: '资金费率告警' }).body)
    expect(slack.text).toBe('*资金费率告警*\nBTC 0.3%')
    const slackPlain = parse(buildWebhookRequest('slack', SLACK_URL, 'BTC 0.3%', { title: '资金费率告警', markdown: false }).body)
    expect(slackPlain.text).toBe('资金费率告警\nBTC 0.3%')
    const discord = parse(buildWebhookRequest('discord', DISCORD_URL, 'BTC 0.3%', { title: '资金费率告警' }).body)
    expect(discord.content).toBe('**资金费率告警**\nBTC 0.3%')
    const generic = parse(buildWebhookRequest('generic', GENERIC_URL, 'BTC 0.3%', { title: '资金费率告警' }).body)
    expect(generic.text).toBe('资金费率告警\nBTC 0.3%')
  })
})
