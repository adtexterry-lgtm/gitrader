// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { detectWebhookDialect } from '../src/index'

describe('方言识别', () => {
  it('按厂商路径识别六种端点', () => {
    expect(detectWebhookDialect('https://open.feishu.cn/open-apis/bot/v2/hook/aaaa')).toBe('feishu')
    expect(detectWebhookDialect('https://open.larksuite.com/open-apis/bot/v2/hook/bbbb')).toBe('feishu')
    expect(detectWebhookDialect('https://oapi.dingtalk.com/robot/send?access_token=t')).toBe('dingtalk')
    expect(detectWebhookDialect('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')).toBe('wecom')
    expect(detectWebhookDialect('https://hooks.slack.com/services/T000/B000/xxxx')).toBe('slack')
    expect(detectWebhookDialect('https://discord.com/api/webhooks/1/abc')).toBe('discord')
  })

  it('未知与自建端点回落 generic', () => {
    expect(detectWebhookDialect('https://notify.internal.example/ingest')).toBe('generic')
    expect(detectWebhookDialect('')).toBe('generic')
  })

  it('大小写不敏感，且不误判相似域名', () => {
    expect(detectWebhookDialect('HTTPS://OAPI.DINGTALK.COM/robot/send?x=1')).toBe('dingtalk')
    expect(detectWebhookDialect('https://open.feishu.cn.example/robot/send')).toBe('generic')
    expect(detectWebhookDialect('https://larkoffice.com.example/hook')).toBe('generic')
  })
})
