// SPDX-License-Identifier: CPAL-1.0
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mapVenueStatus } from '../src/connector'
import {
  buildWebhookRequest,
  detectWebhookDialect,
  signDingtalk,
  signFeishu,
  validateWebhookResponse,
} from '../src/notify/webhook'
import { formatJsonLog } from '../src/util/json-log'

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

describe('订单状态归一（QD sent_order_recovery.py:9-19）', () => {
  it('映射 QD 表中的原文', () => {
    expect(mapVenueStatus('FILLED')).toBe('filled')
    expect(mapVenueStatus('complete')).toBe('filled') // line 11
    expect(mapVenueStatus('completed')).toBe('filled') // line 11
    expect(mapVenueStatus('Partially Filled')).toBe('partially_filled')
    expect(mapVenueStatus('partially_filled')).toBe('partially_filled')
    expect(mapVenueStatus('partial')).toBe('partially_filled') // line 15
    expect(mapVenueStatus('partial_fill')).toBe('partially_filled') // line 15
    expect(mapVenueStatus('cancelled')).toBe('cancelled') // line 13
    expect(mapVenueStatus('api_cancelled')).toBe('cancelled') // line 13
    expect(mapVenueStatus('inactive')).toBe('cancelled') // line 13
    expect(mapVenueStatus('expired')).toBe('expired') // line 13
    expect(mapVenueStatus('rejected')).toBe('rejected') // line 13
    expect(mapVenueStatus('submitted')).toBe('open') // line 17
    expect(mapVenueStatus('pre_submitted')).toBe('open') // line 17
    expect(mapVenueStatus('pending_submit')).toBe('open') // line 17
    expect(mapVenueStatus('pending_cancel')).toBe('open') // line 17
    expect(mapVenueStatus('new')).toBe('open') // line 17
    expect(mapVenueStatus('not_a_status')).toBeUndefined() // line 19
  })

  it('支持 Hyperliquid 文案', () => {
    expect(mapVenueStatus('marginCanceled')).toBe('cancelled')
    expect(mapVenueStatus('reduceOnlyRejected')).toBe('rejected')
    expect(mapVenueStatus('triggered')).toBe('open')
    expect(mapVenueStatus('scheduledCancel')).toBe('expired')
    expect(mapVenueStatus(undefined)).toBeUndefined()
  })
})

describe('Webhook 方言识别（QD webhook.py:12-27）', () => {
  it('按域名判定方言', () => {
    expect(detectWebhookDialect('https://open.feishu.cn/open-apis/bot/v2/hook/x')).toBe('feishu')
    expect(detectWebhookDialect('https://open.larksuite.com/open-apis/bot/v2/hook/x')).toBe('feishu')
    expect(detectWebhookDialect('https://open.larkoffice.com/open-apis/bot/v2/hook/x')).toBe('feishu')
    expect(detectWebhookDialect('https://oapi.dingtalk.com/robot/send?access_token=x')).toBe('dingtalk')
    expect(detectWebhookDialect('https://hooks.slack.com/services/T/B/X')).toBe('slack')
    expect(detectWebhookDialect('https://discord.com/api/webhooks/1/x')).toBe('discord')
    expect(detectWebhookDialect('https://example.com/hook')).toBe('generic')
  })
})

describe('Webhook 签名（QD webhook.py:123-137）', () => {
  it('飞书：key = timestamp\\nsecret，message 为空，base64', () => {
    const secret = 'test-secret'
    const timestampSec = 1700000000
    const expected = createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64')
    const signed = signFeishu(secret, timestampSec)
    expect(signed).toBe(expected)
    expect(signed).not.toContain(secret)
  })

  it('钉钉：HMAC(secret, timestamp\\nsecret) → base64 → URL 编码', () => {
    const secret = 'test-secret'
    const timestampMs = 1700000000000
    const expected = encodeURIComponent(createHmac('sha256', secret).update(`${timestampMs}\n${secret}`).digest('base64'))
    const signed = signDingtalk(secret, timestampMs)
    expect(signed).toBe(expected)
    expect(signed).not.toContain(secret)
  })
})

describe('Webhook 请求构造', () => {
  const secret = 'test-secret'
  const now = (): number => 1700000000000

  it('钉钉把 timestamp / sign 拼到 URL，body 用 text', () => {
    const req = buildWebhookRequest('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=x', 'hi', { secret, now })
    expect(req.url).toContain('timestamp=1700000000000&sign=')
    const body = asRecord(req.body)
    expect(body.msgtype).toBe('text')
    expect(asRecord(body.text).content).toBe('hi')
    expect(JSON.stringify(req)).not.toContain(secret)
  })

  it('飞书把签名放进 body', () => {
    const req = buildWebhookRequest('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/x', 'hi', { secret, now })
    const body = asRecord(req.body)
    expect(body.msg_type).toBe('text')
    expect(body.timestamp).toBe('1700000000')
    expect(body.sign).toBe(signFeishu(secret, 1700000000))
    expect(JSON.stringify(req)).not.toContain(secret)
  })

  it('slack / discord / generic 的 body 形状', () => {
    const slack = buildWebhookRequest('slack', 'https://hooks.slack.com/services/T/B/X', 'hi')
    expect(asRecord(slack.body).text).toBe('hi')
    const discord = buildWebhookRequest('discord', 'https://discord.com/api/webhooks/1/x', 'hi')
    expect(asRecord(discord.body).content).toBe('hi')
    const generic = buildWebhookRequest('generic', 'https://example.com/hook', 'hi')
    expect(asRecord(generic.body).text).toBe('hi')
    expect(generic.headers['Content-Type']).toBe('application/json')
  })
})

describe('Webhook 响应校验（QD webhook.py:140-163）', () => {
  it('飞书 / 钉钉看业务码，generic 看 HTTP 状态', () => {
    expect(validateWebhookResponse('feishu', 200, { code: 0 }).ok).toBe(true)
    expect(validateWebhookResponse('feishu', 200, { StatusCode: 0 }).ok).toBe(true)
    expect(validateWebhookResponse('feishu', 200, '{"code":0}').ok).toBe(true)
    const feishuError = validateWebhookResponse('feishu', 200, { code: 19001, msg: 'bad sign' })
    expect(feishuError.ok).toBe(false)
    expect(feishuError.reason).toContain('19001')
    expect(validateWebhookResponse('dingtalk', 200, { errcode: 0 }).ok).toBe(true)
    expect(validateWebhookResponse('dingtalk', 200, { errcode: 310000 }).ok).toBe(false)
    expect(validateWebhookResponse('slack', 200, 'ok').ok).toBe(true)
    expect(validateWebhookResponse('discord', 204, '').ok).toBe(true)
    expect(validateWebhookResponse('generic', 200, '').ok).toBe(true)
    expect(validateWebhookResponse('generic', 500, '').ok).toBe(false)
  })
})

describe('JSON 日志格式（QD logger.py:14-27）', () => {
  it('固定字段顺序、按键名排序其余字段并打码敏感键', () => {
    const line = formatJsonLog({ level: 'info', msg: 'hello', requestId: 'r1', apiKey: 'abc', n: 1, ts: 0 })
    expect(line).toBe('{"ts":"1970-01-01T00:00:00.000Z","level":"info","msg":"hello","requestId":"r1","apiKey":"[redacted]","n":1}')
    expect(line).not.toContain('\n')
  })

  it('Error 值转成 { name, message }，可选 stack', () => {
    const line = formatJsonLog({ level: 'error', msg: 'boom', err: new Error('bad'), ts: 0 })
    expect(asRecord(JSON.parse(line)).err).toEqual({ name: 'Error', message: 'bad' })
    expect(line).not.toContain('\n')
    const withStack = formatJsonLog({ level: 'error', msg: 'boom', err: new Error('bad'), ts: 0 }, { stack: true })
    expect(asRecord(asRecord(JSON.parse(withStack)).err).stack).toContain('Error: bad')
    expect(withStack).not.toContain('\n')
  })

  it('嵌套敏感键也打码', () => {
    const line = formatJsonLog({ level: 'warn', msg: 'nested', ts: 0, ctx: { password: 'pw', token: 't', ok: 1 } })
    expect(asRecord(asRecord(JSON.parse(line)).ctx)).toEqual({ password: '[redacted]', token: '[redacted]', ok: 1 })
  })
})
