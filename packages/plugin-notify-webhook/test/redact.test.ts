// SPDX-License-Identifier: CPAL-1.0
// 脱敏：把密钥塞进假错误文本（网络错误、厂商 errmsg、URL 里的 key），断言返回的 reason 里既没有原文也没有 base64。
import { describe, expect, it } from 'vitest'
import { notifySend } from '../index.mjs'
import { redactSecret, WebhookClient } from '../webhook.mjs'

const TOKEN = 'whtok_ABC123456789xyz'
const B64 = Buffer.from(TOKEN, 'utf8').toString('base64')
const notice = { key: 'k', level: 'warn', title: 'T', lines: ['line'] }

describe('脱敏', () => {
  it('redactSecret 替换原文与 base64，空串跳过', () => {
    expect(redactSecret(`a ${TOKEN} b ${B64} c`, TOKEN)).toBe('a <redacted> b <redacted> c')
    expect(redactSecret('nothing here', TOKEN)).toBe('nothing here')
    expect(redactSecret(`keep ${TOKEN}`, '')).toBe(`keep ${TOKEN}`)
    expect(redactSecret(`x ${TOKEN} y second`, [TOKEN, 'second'])).toBe('x <redacted> y <redacted>')
  })

  it('网络错误里带密钥：reason 不含原文与 base64', async () => {
    const fetch = async (): Promise<never> => {
      throw new Error(`request failed for secret=${TOKEN} (basic ${B64})`)
    }
    const result = await notifySend(
      { notice, params: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' } },
      { fetch, env: { WEBHOOK_SECRET: TOKEN }, sleep: async () => {}, maxRetries: 0 },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('<redacted>')
    expect(result.reason).not.toContain(TOKEN)
    expect(result.reason).not.toContain(B64)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('厂商 errmsg 里带密钥：reason 不含原文与 base64', async () => {
    const fetch = async (): Promise<{ status: number; text: () => Promise<string> }> => ({
      status: 200,
      text: async () => JSON.stringify({ errcode: 310000, errmsg: `sign not match, secret=${TOKEN} b64=${B64}` }),
    })
    const result = await notifySend(
      { notice, params: { url: 'https://oapi.dingtalk.com/robot/send?access_token=t' } },
      { fetch, env: { WEBHOOK_SECRET: TOKEN }, sleep: async () => {} },
    )
    expect(result).toEqual({ ok: false, reason: 'dingtalk_error:code=310000:sign not match, secret=<redacted> b64=<redacted>', retryable: false })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain(B64)
  })

  it('密钥只出现在签名里：WebhookClient 的返回值与请求头都不带密钥；钉钉签名 URL 不含密钥原文', async () => {
    let seen: { url: string; init: Record<string, unknown> } | undefined
    const fetch = async (url: string, init: Record<string, unknown>) => {
      seen = { url, init }
      return { status: 200, text: async () => '{"errcode":0}' }
    }
    const client = new WebhookClient({
      url: 'https://oapi.dingtalk.com/robot/send?access_token=t',
      secret: TOKEN,
      fetch,
      now: () => 1760000000000,
    })
    const result = await client.send('hello')
    expect(result).toEqual({ ok: true, status: 200 })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(String(seen!.init.headers ? JSON.stringify(seen!.init.headers) : '')).not.toContain(TOKEN)
    expect(seen!.url).not.toContain(TOKEN)
    expect(String(seen!.init.body)).not.toContain(TOKEN)
  })

  it('网络错误里的完整 URL（含 access_token）→ 只留 origin + 路径第一段', async () => {
    const url = 'https://oapi.dingtalk.com/robot/send?access_token=XYZ'
    const fetch = async (): Promise<never> => { throw new Error(`request failed for ${url}`) }
    const result = await notifySend(
      { notice, params: { url } },
      { fetch, env: {}, sleep: async () => {}, maxRetries: 0 },
    )
    expect(result).toEqual({ ok: false, reason: 'network_error:request failed for https://oapi.dingtalk.com/robot', retryable: true })
    expect(JSON.stringify(result)).not.toContain('XYZ')
    expect(JSON.stringify(result)).not.toContain('?')
    expect(JSON.stringify(result)).not.toContain('access_token')
  })

  it('缺密钥时不做任何替换，reason 原样保留', async () => {
    const fetch = async (): Promise<{ status: number; text: () => Promise<string> }> => ({ status: 200, text: async () => '{"code":1,"msg":"bad payload"}' })
    const result = await notifySend(
      { notice, params: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' } },
      { fetch, env: {} },
    )
    expect(result).toEqual({ ok: false, reason: 'feishu_error:code=1:bad payload', retryable: false })
  })
})
