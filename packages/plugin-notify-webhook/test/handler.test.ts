// SPDX-License-Identifier: CPAL-1.0
// notify.send 处理函数：六种方言的请求形状、成功 / 厂商报错 / 429 / 5xx / 超时 / 缺环境变量 / 假 fetch 冒烟。
// fetch、时钟、sleep 全部注入，测试不出网。
import { describe, expect, it } from 'vitest'
import { FAKE_REF, notifySend, resolveSecret } from '../index.mjs'
import { WebhookClient, buildWebhookRequest, detectWebhookDialect, renderNotice, signFeishu, signDingtalk, validateWebhookResponse } from '../webhook.mjs'

interface Call { url: string; init: Record<string, unknown> }
type Reply = { status: number; body: string }

function recorder(replies: Reply[] | ((url: string, n: number) => Reply)) {
  const calls: Call[] = []
  const fetch = async (url: string, init: Record<string, unknown>): Promise<{ status: number; text: () => Promise<string> }> => {
    const index = calls.length
    calls.push({ url, init })
    const reply = typeof replies === 'function' ? replies(url, index) : replies[Math.min(index, replies.length - 1)]!
    return { status: reply.status, text: async () => reply.body }
  }
  return { calls, fetch }
}

const JSON_OK = (body = '{"code":0}'): Reply => ({ status: 200, body })
const notice = { key: 'risk.denials:acct_x:ruleY', level: 'warn', title: 'Risk denial', lines: ['account acct_x', 'rule Y'], ts: 1760000000000, topic: 'risk.denials' }
const params = (extra: Record<string, unknown> = {}) => ({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', ...extra })
const fastSleep = async (): Promise<void> => {}
const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>

describe('方言识别', () => {
  it('六个平台按域名识别，自建端点是 generic', () => {
    expect(detectWebhookDialect('https://open.feishu.cn/open-apis/bot/v2/hook/x')).toBe('feishu')
    expect(detectWebhookDialect('https://open.larksuite.com/open-apis/bot/v2/hook/x')).toBe('feishu')
    expect(detectWebhookDialect('https://oapi.dingtalk.com/robot/send?access_token=x')).toBe('dingtalk')
    expect(detectWebhookDialect('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x')).toBe('wecom')
    expect(detectWebhookDialect('https://hooks.slack.com/services/T/B/x')).toBe('slack')
    expect(detectWebhookDialect('https://discord.com/api/webhooks/1/x')).toBe('discord')
    expect(detectWebhookDialect('https://ntfy.internal/alerts')).toBe('generic')
  })

  it('相似域名不误判：主机名必须精确匹配且路径前缀对得上', () => {
    expect(detectWebhookDialect('https://open.feishu.cn.example/robot/send')).toBe('generic')
    expect(detectWebhookDialect('https://oapi.dingtalk.com.evil.com/robot/send')).toBe('generic')
    expect(detectWebhookDialect('https://discordapp.com/api/webhooks/1/x')).toBe('discord')
  })
})

describe('请求构造与签名向量', () => {
  it('飞书签名：HMAC-SHA256(key = `${ts}\\n${secret}`, 空 body) → base64（固定输入手算的向量）', () => {
    expect(signFeishu('feishu-secret', 1760000000)).toBe('ZoddQCeyjYQD2OMy0Ec23f+zL4X01RJhlFB122asI2o=')
  })

  it('钉钉签名：HMAC-SHA256(secret, `${tsMs}\\n${secret}`) → base64 → URL 编码（固定输入手算的向量）', () => {
    expect(signDingtalk('ding-secret', 1760000000000)).toBe('obTDgqGapMUqttVN10pjJyHTK3ziw%2F6xDo9VtQkt%2FJY%3D')
  })

  it('飞书带密钥：timestamp / sign 进请求体；文本形态 msg_type=text', () => {
    const request = buildWebhookRequest('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'hello', {
      secret: 'feishu-secret', now: () => 1760000000000,
    })
    expect(request.body).toEqual({
      msg_type: 'text', content: { text: 'hello' }, timestamp: '1760000000', sign: 'ZoddQCeyjYQD2OMy0Ec23f+zL4X01RJhlFB122asI2o=',
    })
    expect(request.headers['Content-Type']).toBe('application/json')
  })

  it('飞书 markdown：换成消息卡片的 markdown 元素（与库一致：div + lark_md）', () => {
    const request = buildWebhookRequest('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', '### hi', { markdown: true })
    expect(request.body).toEqual({ msg_type: 'interactive', card: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: '### hi' } }] } })
  })

  it('钉钉带密钥：timestamp / sign 追加到查询串，已有 ? 时用 &', () => {
    const request = buildWebhookRequest('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=t', 'hi', {
      secret: 'ding-secret', now: () => 1760000000000,
    })
    expect(request.url).toBe('https://oapi.dingtalk.com/robot/send?access_token=t&timestamp=1760000000000&sign=obTDgqGapMUqttVN10pjJyHTK3ziw%2F6xDo9VtQkt%2FJY%3D')
    expect(request.body).toEqual({ msgtype: 'text', text: { content: 'hi' } })
    expect(JSON.stringify(request.body)).not.toContain('ding-secret')
  })

  it('钉钉 / 企业微信的 markdown 形态；slack 纯文本与 mrkdwn；discord / generic 的字段', () => {
    expect(buildWebhookRequest('dingtalk', 'https://oapi.dingtalk.com/robot/send', 'x', { markdown: true, title: 'T' }).body)
      .toEqual({ msgtype: 'markdown', markdown: { title: 'T', text: 'x' } })
    expect(buildWebhookRequest('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', 'x').body).toEqual({ msgtype: 'text', text: { content: 'x' } })
    expect(buildWebhookRequest('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', 'x', { markdown: true }).body).toEqual({ msgtype: 'markdown', markdown: { content: 'x' } })
    expect(buildWebhookRequest('slack', 'https://hooks.slack.com/services/T/B/x', 'x').body).toEqual({ text: 'x' })
    expect(buildWebhookRequest('slack', 'https://hooks.slack.com/services/T/B/x', 'x', { markdown: true }).body).toEqual({ text: 'x', mrkdwn: true })
    expect(buildWebhookRequest('discord', 'https://discord.com/api/webhooks/1/x', 'x').body).toEqual({ content: 'x' })
    expect(buildWebhookRequest('generic', 'https://ntfy.internal/alerts', 'x').body).toEqual({ text: 'x' })
  })

  it('厂商响应校验：飞书 code:0 / 钉钉 errcode:0 / 企业微信 errcode:0 / slack ok / discord 204 都算成功', () => {
    expect(validateWebhookResponse('feishu', 200, '{"code":0,"msg":"success"}')).toEqual({ ok: true })
    expect(validateWebhookResponse('dingtalk', 200, '{"errcode":0,"errmsg":"ok"}')).toEqual({ ok: true })
    expect(validateWebhookResponse('wecom', 200, '{"errcode":0,"errmsg":"ok"}')).toEqual({ ok: true })
    expect(validateWebhookResponse('slack', 200, 'ok')).toEqual({ ok: true })
    expect(validateWebhookResponse('discord', 204, '')).toEqual({ ok: true })
    expect(validateWebhookResponse('generic', 200, '')).toEqual({ ok: true })
  })

  it('厂商业务错误码不重试；429 / 5xx 标 retryable', () => {
    expect(validateWebhookResponse('wecom', 200, '{"errcode":93000,"errmsg":"invalid webhook url"}'))
      .toEqual({ ok: false, reason: 'wecom_error:code=93000:invalid webhook url', retryable: false })
    expect(validateWebhookResponse('slack', 200, '{"ok":false,"error":"channel_not_found"}'))
      .toEqual({ ok: false, reason: 'slack_error:channel_not_found', retryable: false })
    expect(validateWebhookResponse('feishu', 429, '')).toEqual({ ok: false, reason: 'http_429', retryable: true })
    expect(validateWebhookResponse('wecom', 408, '')).toEqual({ ok: false, reason: 'http_408', retryable: true })
    expect(validateWebhookResponse('generic', 503, '')).toEqual({ ok: false, reason: 'http_503', retryable: true })
    expect(validateWebhookResponse('generic', 400, '')).toEqual({ ok: false, reason: 'http_400', retryable: false })
  })

  it('通知渲染：纯文本是标题 + 行，markdown 只加排版前缀', () => {
    expect(renderNotice(notice)).toBe('Risk denial\naccount acct_x\nrule Y')
    expect(renderNotice(notice, true)).toBe('### Risk denial\n\naccount acct_x\n\nrule Y')
  })
})

describe('notify.send 处理函数', () => {
  it('飞书成功：正文 = 标题 + 行，返回 { ok: true }，平台给了 message_id 就带 ref', async () => {
    const { calls, fetch } = recorder([JSON_OK('{"code":0,"data":{"message_id":"om_1"}}')])
    const result = await notifySend({ notice, params: params() }, { fetch, env: {}, now: () => 1760000000000 })
    expect(result).toEqual({ ok: true, ref: 'om_1' })
    expect(calls).toHaveLength(1)
    expect(bodyOf(calls[0]!)).toEqual({ msg_type: 'text', content: { text: 'Risk denial\naccount acct_x\nrule Y' } })
  })

  it('钉钉成功：请求 URL 带签名，返回 { ok: true }', async () => {
    const { calls, fetch } = recorder([JSON_OK('{"errcode":0,"errmsg":"ok"}')])
    const result = await notifySend(
      { notice, params: { url: 'https://oapi.dingtalk.com/robot/send?access_token=t' } },
      { fetch, env: { WEBHOOK_SECRET: 'ding-secret' }, now: () => 1760000000000 },
    )
    expect(result).toEqual({ ok: true })
    expect(calls[0]!.url).toContain('timestamp=1760000000000&sign=')
    expect(calls[0]!.url).not.toContain('ding-secret')
  })

  it('企业微信 markdown 成功；errcode 非 0 返回不可重试的失败', async () => {
    const ok = recorder([JSON_OK('{"errcode":0,"errmsg":"ok"}')])
    await expect(notifySend(
      { notice, params: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', markdown: true } },
      { fetch: ok.fetch, env: {} },
    )).resolves.toEqual({ ok: true })
    expect(bodyOf(ok.calls[0]!).msgtype).toBe('markdown')

    const bad = recorder([JSON_OK('{"errcode":93000,"errmsg":"invalid webhook url"}')])
    await expect(notifySend(
      { notice, params: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } },
      { fetch: bad.fetch, env: {} },
    )).resolves.toEqual({ ok: false, reason: 'wecom_error:code=93000:invalid webhook url', retryable: false })
    expect(bad.calls).toHaveLength(1)
  })

  it('slack / discord / generic 各自的请求体', async () => {
    const slack = recorder([{ status: 200, body: 'ok' }])
    await expect(notifySend(
      { notice, params: { url: 'https://hooks.slack.com/services/T/B/x' } },
      { fetch: slack.fetch, env: {} },
    )).resolves.toEqual({ ok: true })
    expect(bodyOf(slack.calls[0]!)).toEqual({ text: 'Risk denial\naccount acct_x\nrule Y' })

    const discord = recorder([{ status: 204, body: '' }])
    await expect(notifySend(
      { notice, params: { url: 'https://discord.com/api/webhooks/1/x' } },
      { fetch: discord.fetch, env: {} },
    )).resolves.toEqual({ ok: true })
    expect(bodyOf(discord.calls[0]!)).toEqual({ content: 'Risk denial\naccount acct_x\nrule Y' })

    const generic = recorder([{ status: 202, body: 'accepted' }])
    await expect(notifySend(
      { notice, params: { url: 'https://ntfy.internal/alerts' } },
      { fetch: generic.fetch, env: {} },
    )).resolves.toEqual({ ok: true })
    expect(bodyOf(generic.calls[0]!)).toEqual({ text: 'Risk denial\naccount acct_x\nrule Y' })
  })

  it('429 之后重试到成功，退避 250 ms', async () => {
    const delays: number[] = []
    const { calls, fetch } = recorder([{ status: 429, body: '' }, JSON_OK()])
    const result = await notifySend({ notice, params: params() }, {
      fetch, env: {}, sleep: async (ms: number) => { delays.push(ms) },
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(delays).toEqual([250])
  })

  it('5xx 一直失败：重试到上限（1 + 2 次）后返回 retryable:true', async () => {
    const delays: number[] = []
    const { calls, fetch } = recorder([{ status: 503, body: '' }])
    const result = await notifySend({ notice, params: params() }, {
      fetch, env: {}, sleep: async (ms: number) => { delays.push(ms) },
    })
    expect(result).toEqual({ ok: false, reason: 'http_503', retryable: true })
    expect(calls).toHaveLength(3)
    expect(delays).toEqual([250, 500])
  })

  it('4xx 不重试', async () => {
    const { calls, fetch } = recorder([{ status: 400, body: 'bad request' }])
    await expect(notifySend({ notice, params: params() }, { fetch, env: {} }))
      .resolves.toEqual({ ok: false, reason: 'http_400', retryable: false })
    expect(calls).toHaveLength(1)
  })

  it('超时（AbortError）→ retryable:true，reason 是 timeout', async () => {
    let attempts = 0
    const fetch = async (): Promise<never> => {
      attempts += 1
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    const result = await notifySend({ notice, params: params() }, { fetch, env: {}, sleep: fastSleep, timeoutMs: 5 })
    expect(result).toEqual({ ok: false, reason: 'timeout', retryable: true })
    expect(attempts).toBe(3)
  })

  it('缺环境变量（env: 句柄指向的变量不存在）→ { ok:false, retryable:false }，不出网', async () => {
    const { calls, fetch } = recorder([JSON_OK()])
    const result = await notifySend(
      { notice, params: params({ secret: 'env:WEBHOOK_SECRET' }) },
      { fetch, env: {} },
    )
    expect(result).toEqual({ ok: false, reason: 'missing_env:WEBHOOK_SECRET', retryable: false })
    expect(calls).toHaveLength(0)
  })

  it('env: 句柄存在时用它签名；没有 secret 时明文发送', () => {
    expect(resolveSecret({ secret: 'env:WEBHOOK_SECRET' }, { WEBHOOK_SECRET: 'from-env' })).toEqual({ secret: 'from-env' })
    expect(resolveSecret({ secret: 'env:WEBHOOK_SECRET' }, {})).toEqual({ error: 'missing_env:WEBHOOK_SECRET' })
    expect(resolveSecret({ secret: 'env:MISSING' }, {})).toEqual({ error: 'secret handle not declared' })
    expect(resolveSecret({ secret: 'env:GITRADER_GSP_TOKEN' }, { GITRADER_GSP_TOKEN: 'gsp-token' })).toEqual({ error: 'secret handle not declared' })
    expect(resolveSecret({ secret: 'inline' }, {})).toEqual({ secret: 'inline' })
    expect(resolveSecret({}, { WEBHOOK_SECRET: 'declared' })).toEqual({ secret: 'declared' })
    expect(resolveSecret({}, {})).toEqual({})
  })

  it('env: 句柄只允许清单声明的 WEBHOOK_SECRET；GITRADER_GSP_TOKEN 被拒且不出网', async () => {
    const { calls, fetch } = recorder([JSON_OK()])
    await expect(notifySend(
      { notice, params: params({ secret: 'env:GITRADER_GSP_TOKEN' }) },
      { fetch, env: { GITRADER_GSP_TOKEN: 'gsp-token' } },
    )).resolves.toEqual({ ok: false, reason: 'secret handle not declared', retryable: false })
    expect(calls).toHaveLength(0)

    const ok = recorder([JSON_OK()])
    await expect(notifySend(
      { notice, params: params({ secret: 'env:WEBHOOK_SECRET' }) },
      { fetch: ok.fetch, env: { WEBHOOK_SECRET: 'declared', GITRADER_GSP_TOKEN: 'gsp-token' }, now: () => 1760000000000 },
    )).resolves.toEqual({ ok: true })
    expect(ok.calls).toHaveLength(1)
  })

  it('总预算 8 s：重试与退避合计超出即返回 timeout（注入时钟推进）', async () => {
    let now = 0
    const fetch = async (): Promise<{ status: number; text: () => Promise<string> }> => {
      now += 5000
      return { status: 503, text: async () => '' }
    }
    const result = await notifySend(
      { notice, params: params() },
      { fetch, env: {}, now: () => now, sleep: async (ms: number) => { now += ms } },
    )
    expect(result).toEqual({ ok: false, reason: 'timeout', retryable: true })
  })

  it('URL 非法 / 通知形状不对 → 不可重试的失败，不出网', async () => {
    const { calls, fetch } = recorder([JSON_OK()])
    await expect(notifySend({ notice, params: { url: 'not-a-url' } }, { fetch, env: {} }))
      .resolves.toEqual({ ok: false, reason: 'invalid_url', retryable: false })
    await expect(notifySend({ notice: { title: 'x' }, params: params() }, { fetch, env: {} }))
      .resolves.toEqual({ ok: false, reason: 'invalid_notice', retryable: false })
    await expect(notifySend({}, { fetch, env: {} }))
      .resolves.toEqual({ ok: false, reason: 'invalid_notice', retryable: false })
    expect(calls).toHaveLength(0)
  })

  it('明文 http 目标一律拒绝（insecure_url）：不出网，签名密钥不落任何返回值', async () => {
    const { calls, fetch } = recorder([JSON_OK()])
    for (const url of [
      'http://collector.example.com/hook?token=x',
      'http://example.test/x',
      'http://10.0.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1.example.test/x',
    ]) {
      const result = await notifySend({ notice, params: { url, secret: 'fixture-secret' } }, { fetch, env: {} })
      expect(result).toEqual({ ok: false, reason: 'insecure_url', retryable: false })
      expect(JSON.stringify(result)).not.toContain('fixture-secret')
    }
    expect(calls).toHaveLength(0)
  })

  it('明文 http 发往字面回环主机放行（loopback 例外）：127.0.0.1 / localhost / [::1] 各发一次，其余不出网', async () => {
    const { calls, fetch } = recorder([JSON_OK()])
    const loopback = await notifySend({ notice, params: { url: 'http://127.0.0.1:8787/hook' } }, { fetch, env: {} })
    expect(loopback).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8787/hook')
    for (const url of ['http://localhost/x', 'http://[::1]/x']) {
      await expect(notifySend({ notice, params: { url } }, { fetch, env: {} })).resolves.toEqual({ ok: true })
    }
    expect(calls).toHaveLength(3)
    // 非回环的明文 http 仍然 0 次出网（上面那条用例兜底，这里再确认总数不涨）
    const blocked = await notifySend({ notice, params: { url: 'http://10.0.0.1/x' } }, { fetch, env: {} })
    expect(blocked).toEqual({ ok: false, reason: 'insecure_url', retryable: false })
    expect(calls).toHaveLength(3)
  })

  it('describeTarget 对 http 目标：非回环判无效，回环按 loopback 例外算可用（方言 generic）', async () => {
    const { describeTarget, isSecureWebhookUrl, webhookUrlKind } = await import('../index.mjs')
    expect(webhookUrlKind('http://hooks.slack.com/services/T/B/x')).toBe('insecure')
    expect(isSecureWebhookUrl('http://hooks.slack.com/services/T/B/x')).toBe(false)
    expect(describeTarget({ url: 'http://hooks.slack.com/services/T/B/x' })).toEqual({ dialect: 'invalid', valid: false })
    expect(describeTarget({ url: 'https://hooks.slack.com/services/T/B/x' })).toEqual({ dialect: 'slack', valid: true })
    expect(webhookUrlKind('http://127.0.0.1:8787/hook')).toBe('loopback')
    expect(isSecureWebhookUrl('http://127.0.0.1:8787/hook')).toBe(true)
    expect(describeTarget({ url: 'http://127.0.0.1:8787/hook' })).toEqual({ dialect: 'generic', valid: true })
  })


  it('WebhookClient 构造期闸：非回环明文 http 抛错，字面回环主机（loopback 例外）可构造', () => {
    for (const url of ['http://example.test/x', 'http://10.0.0.1/x', 'http://169.254.169.254/x', 'http://127.0.0.1.example.test/x']) {
      expect(() => new WebhookClient({ url }), url).toThrow(/must use https/)
    }
    for (const url of ['http://127.0.0.1:8787/hook', 'http://localhost/x', 'http://[::1]/x']) {
      expect(() => new WebhookClient({ url }), url).not.toThrow()
    }
  })

  it('GITRADER_PLUGIN_FAKE_FETCH=1：用内置假响应，不出网（stdio 冒烟与 conformance 走这条路）', async () => {
    const { calls, fetch } = recorder([JSON_OK()])
    const result = await notifySend({ notice, params: params() }, { fetch, env: { GITRADER_PLUGIN_FAKE_FETCH: '1' } })
    expect(result).toEqual({ ok: true, ref: FAKE_REF })
    expect(calls).toHaveLength(0)
  })

  it('超过平台上限的正文分块发送（discord 1900 字符）', async () => {
    const long = { ...notice, lines: ['x'.repeat(2000), 'y'.repeat(2000)] }
    const { calls, fetch } = recorder([{ status: 204, body: '' }])
    const result = await notifySend(
      { notice: long, params: { url: 'https://discord.com/api/webhooks/1/x' } },
      { fetch, env: {} },
    )
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(String(bodyOf(call).content).length).toBeLessThanOrEqual(1900)
  })
})
