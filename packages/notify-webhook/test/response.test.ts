// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { isRetryableStatus, validateWebhookResponse } from '../src/index'

describe('响应校验', () => {
  it('飞书：code 为 0（数字或字符串）算成功', () => {
    expect(validateWebhookResponse('feishu', 200, '{"code":0,"msg":"success"}')).toEqual({ ok: true })
    expect(validateWebhookResponse('feishu', 200, { StatusCode: 0 })).toEqual({ ok: true })
    expect(validateWebhookResponse('feishu', 200, { code: 0 })).toEqual({ ok: true })
  })

  it('飞书：非 0 码算失败，reason 带码与 msg，且不重试', () => {
    const verdict = validateWebhookResponse('feishu', 200, { code: 19021, msg: 'sign match fail' })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('feishu_error:code=19021:sign match fail')
    expect(verdict.retryable).toBe(false)
  })

  it('钉钉 / 企业微信：errcode 为 0 算成功', () => {
    expect(validateWebhookResponse('dingtalk', 200, { errcode: 0, errmsg: 'ok' })).toEqual({ ok: true })
    expect(validateWebhookResponse('wecom', 200, { errcode: 0, errmsg: 'ok' })).toEqual({ ok: true })
    expect(validateWebhookResponse('dingtalk', 200, '{"errcode":0}')).toEqual({ ok: true })
  })

  it('钉钉 / 企业微信：非 0 errcode 算失败，reason 带码', () => {
    expect(validateWebhookResponse('dingtalk', 200, { errcode: 310000, errmsg: 'invalid sign' }))
      .toEqual({ ok: false, reason: 'dingtalk_error:code=310000:invalid sign', retryable: false })
    expect(validateWebhookResponse('wecom', 200, { errcode: 93000, errmsg: 'invalid webhook url' }))
      .toEqual({ ok: false, reason: 'wecom_error:code=93000:invalid webhook url', retryable: false })
  })

  it('slack：纯文本 ok（大小写不敏感）或 JSON 对象算成功，其它文本算失败', () => {
    expect(validateWebhookResponse('slack', 200, 'ok')).toEqual({ ok: true })
    expect(validateWebhookResponse('slack', 200, ' OK ')).toEqual({ ok: true })
    expect(validateWebhookResponse('slack', 200, '{"ok":true}')).toEqual({ ok: true })
    const bad = validateWebhookResponse('slack', 200, 'invalid_payload')
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe('slack_unexpected:invalid_payload')
    expect(bad.retryable).toBe(false)
  })

  it('slack：`ok:false` 判失败且不重试（与插件副本一致）', () => {
    expect(validateWebhookResponse('slack', 200, '{"ok":false,"error":"channel_not_found"}'))
      .toEqual({ ok: false, reason: 'slack_error:channel_not_found', retryable: false })
    expect(validateWebhookResponse('slack', 200, { ok: false }))
      .toEqual({ ok: false, reason: 'slack_error:unknown', retryable: false })
  })

  it('discord 204 / generic 2xx 算成功', () => {
    expect(validateWebhookResponse('discord', 204, '')).toEqual({ ok: true })
    expect(validateWebhookResponse('discord', 200, '')).toEqual({ ok: true })
    expect(validateWebhookResponse('generic', 202, 'accepted')).toEqual({ ok: true })
  })

  it('429 / 5xx / 408 标 retryable 并带 HTTP 码', () => {
    const limited = validateWebhookResponse('slack', 429, 'slow down')
    expect(limited).toEqual({ ok: false, reason: 'http_429:slow down', retryable: true })
    expect(validateWebhookResponse('slack', 503, '').retryable).toBe(true)
    expect(validateWebhookResponse('feishu', 500, '{"msg":"internal"}').retryable).toBe(true)
    expect(validateWebhookResponse('generic', 408, '').retryable).toBe(true)
  })

  it('4xx 业务错误不重试，reason 含状态码', () => {
    expect(validateWebhookResponse('wecom', 400, 'bad request')).toEqual({ ok: false, reason: 'http_400:bad request', retryable: false })
    expect(validateWebhookResponse('dingtalk', 401, '').retryable).toBe(false)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(501)).toBe(false)
  })
})
