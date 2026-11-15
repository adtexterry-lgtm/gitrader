// SPDX-License-Identifier: CPAL-1.0
// 脱敏单测：key 的原样 / URL 编码 / base64 / `key=` 查询参数四种形态都不许出现在任何 reason 里；
// 错误消息来自客户端与来自处理函数两条路径都要过一遍。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend } from '../index.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { WeComClient, redactSecrets } from '../wecom.mjs'

const KEY = 'k3y-with+plus/slash=and-more'
const WEBHOOK = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(KEY)}`

describe('redactSecrets', () => {
  it('原样 / URL 编码 / base64 三种变形都替换成 <redacted>', () => {
    const text = `raw=${KEY} enc=${encodeURIComponent(KEY)} b64=${Buffer.from(KEY).toString('base64')}`
    const out = redactSecrets(text, KEY)
    expect(out).not.toContain(KEY)
    expect(out).not.toContain(encodeURIComponent(KEY))
    expect(out).not.toContain(Buffer.from(KEY).toString('base64'))
  })

  it('任何 `key=` 查询参数都脱敏，即使值与给定 secret 不同', () => {
    const out = redactSecrets('GET https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=someone-elses-key failed', 'secret-value-1')
    expect(out).toContain('key=<redacted>')
    expect(out).not.toContain('someone-elses-key')
  })

  it('压成单行并截断到上限', () => {
    const out = redactSecrets(`a\nb\n${'x'.repeat(500)}`, KEY)
    expect(out).not.toContain('\n')
    expect(out.length).toBeLessThanOrEqual(201)
  })
})

describe('错误路径的 reason 不含密钥', () => {
  it('客户端网络错误：reason 里 key 已被替换', async () => {
    const fetchImpl = (async () => {
      throw new Error(`ECONNRESET while url=${WEBHOOK}`)
    }) as unknown as typeof fetch
    const client = new WeComClient({ webhookUrl: WEBHOOK, fetchImpl, maxRetries: 0, minIntervalMs: 0 })
    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error?.message)).not.toContain(KEY)
    expect(String(error?.message)).toContain('<redacted>')
  })

  it('处理函数失败：reason 不含 key', async () => {
    const fetchImpl = (async () => {
      throw new Error(`boom ${KEY}`)
    }) as unknown as typeof fetch
    const result = await handleNotifySend(
      { notice: { key: 'k1', level: 'info', title: 't', lines: ['x'] }, params: {} },
      { webhookUrl: WEBHOOK, fetchImpl },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).not.toContain(KEY)
    expect(result.reason).toContain('<redacted>')
  })

  it('构造后 JSON.stringify / Object.keys 不含 key 与完整 URL', () => {
    const client = new WeComClient({ webhookUrl: WEBHOOK })
    const exposed = `${JSON.stringify(client)}|${Object.keys(client).join(',')}`
    for (const secret of [KEY, WEBHOOK, encodeURIComponent(KEY)]) expect(exposed).not.toContain(secret)
    expect(Object.keys(client)).not.toContain('keyLength')
  })
})
