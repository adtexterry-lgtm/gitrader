// SPDX-License-Identifier: CPAL-1.0
// client.ts 单测：地址校验与归一化、成功报文、官方 errcode 分支（0 / 45009 / 93000）、HTTP 分支、
// 超时、脱敏、节流、按字节分块。全部离线：网络由 test/helpers/fake-wecom.ts 的独立假服务器承担。
import { describe, expect, it } from 'vitest'
import { parseWebhookUrl, redactSecret, WeComClient, WeComConfigError, WeComError } from '../src/client'
import { FakeWeCom, FIXTURE_KEY } from './helpers/fake-wecom'

const URL_OK = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${FIXTURE_KEY}`
const NO_WAIT = { retryDelayMs: 5, minIntervalMs: 0 } as const

describe('parseWebhookUrl', () => {
  it('接受官方入口，并把地址归一化（丢掉多余查询参数）', () => {
    const { url, key } = parseWebhookUrl(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${FIXTURE_KEY}&extra=1`)
    expect(key).toBe(FIXTURE_KEY)
    expect(url).toBe(URL_OK)
  })

  it('拒绝 http / 非官方域名 / 错误路径 / 缺 key，错误里不带 key', () => {
    const cases = [
      `http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${FIXTURE_KEY}`,
      `https://evil.example.com/cgi-bin/webhook/send?key=${FIXTURE_KEY}`,
      `https://qyapi.weixin.qq.com/other/path?key=${FIXTURE_KEY}`,
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
      '   ',
    ]
    for (const raw of cases) {
      let error: unknown
      try {
        parseWebhookUrl(raw)
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(WeComConfigError)
      expect(String((error as Error).message)).not.toContain(FIXTURE_KEY)
    }
  })
})

describe('WeComClient', () => {
  it('markdown 成功：POST 官方地址、content-type、msgtype=markdown、正文含标题与逐行事实', async () => {
    const fake = new FakeWeCom()
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), ...NO_WAIT })

    const parts = await client.sendNotice({ title: 'Risk denial', lines: ['rule Y', 'notional 1200 > 1000'], ts: 1760000000000, level: 'warn' })

    expect(parts).toBe(1)
    expect(fake.violations).toEqual([])
    const call = fake.calls[0]!
    expect(call.method).toBe('POST')
    expect(call.contentType).toContain('application/json')
    expect(call.msgtype).toBe('markdown')
    expect(call.url).toBe(URL_OK)
    expect(call.content).toBe('### [WARN] Risk denial\nrule Y\nnotional 1200 > 1000\n`2025-10-09T08:53:20.000Z`')
  })

  it('构造后 JSON.stringify / Object.keys 不含 key 与完整 URL', () => {
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: async () => new Response(null, { status: 204 }), ...NO_WAIT })
    const exposed = `${JSON.stringify(client)}|${Object.keys(client).join(',')}`
    for (const secret of [FIXTURE_KEY, URL_OK, `?key=${FIXTURE_KEY}`]) expect(exposed).not.toContain(secret)
    expect(Object.keys(client)).not.toContain('keyLength')
  })

  it('sendText 走 msgtype=text 与 2048 字节上限', async () => {
    const fake = new FakeWeCom()
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), ...NO_WAIT })
    await client.sendText('一行文本')
    expect(fake.calls[0]!.msgtype).toBe('text')
    expect(fake.violations).toEqual([])
  })

  it('官方 errcode 93000（key 失效）→ 不重试，抛 retryable=false', async () => {
    const fake = new FakeWeCom({ key: 'another-key-value-0000' })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), ...NO_WAIT })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error).toBeInstanceOf(WeComError)
    expect(error?.retryable).toBe(false)
    expect(error?.message).toContain('93000')
    expect(error?.message).toContain('invalid webhook url')
    expect(fake.calls).toHaveLength(1)
  })

  it('官方 errcode 45009（超 20 条/分钟）→ 重试一次后成功', async () => {
    const fake = new FakeWeCom({ errcodes: [45009, 0] })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), maxRetries: 1, retryDelayMs: 5, minIntervalMs: 0 })

    await client.sendMarkdown('x')

    expect(fake.calls).toHaveLength(2)
  })

  it('45009 一直返回 → 重试用尽后抛 retryable=true', async () => {
    const fake = new FakeWeCom({ errcodes: [45009, 45009, 45009] })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), maxRetries: 1, retryDelayMs: 5, minIntervalMs: 0 })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(true)
    expect(fake.calls).toHaveLength(2)
  })

  it('官方 errcode -1（系统繁忙）→ 重试一次后成功，POST 2 次', async () => {
    const fake = new FakeWeCom({ errcodes: [-1, 0] })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), maxRetries: 1, retryDelayMs: 5, minIntervalMs: 0 })

    await client.sendMarkdown('x')

    expect(fake.calls).toHaveLength(2)
  })

  it('-1 一直返回 → 重试用尽后抛 retryable=true', async () => {
    const fake = new FakeWeCom({ errcodes: [-1, -1, -1] })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), maxRetries: 1, retryDelayMs: 5, minIntervalMs: 0 })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(true)
    expect(error?.message).toContain('-1')
    expect(fake.calls).toHaveLength(2)
  })

  it('其它非 0 errcode（参数错）→ 不重试', async () => {
    const fake = new FakeWeCom({ errcodes: [40058] })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), ...NO_WAIT })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(false)
    expect(error?.message).toContain('40058')
    expect(fake.calls).toHaveLength(1)
  })

  it('HTTP 500 → 可重试（重试后仍 500 抛 retryable=true）', async () => {
    const fake = new FakeWeCom({ statuses: [500, 502] })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), ...NO_WAIT })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(true)
    expect(error?.message).toContain('HTTP 502')
    expect(fake.calls).toHaveLength(2)
  })

  it('HTTP 400 → 不重试', async () => {
    const fake = new FakeWeCom({ statuses: [400] })
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), ...NO_WAIT })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(false)
    expect(fake.calls).toHaveLength(1)
  })

  it('2xx 但不是官方 JSON → 重试一次后失败，retryable=true', async () => {
    const fake = new WeComFakeHtml()
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch, ...NO_WAIT })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(true)
    expect(error?.message).toContain('errcode')
    expect(fake.count).toBe(2)
  })

  it('网络超时（≤ 8 s 预算）→ 抛 retryable=true 且 reason 不含 key', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
      })) as unknown as typeof fetch
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl, timeoutMs: 20 })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(true)
    expect(error?.message).toContain('超时')
    expect(error?.message).not.toContain(FIXTURE_KEY)
  })

  it('网络错误 → retryable=true，reason 里 key 与 URL 编码形式都被替换', async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED key=${FIXTURE_KEY}`)
    }) as unknown as typeof fetch
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl, ...NO_WAIT })

    const error = await client.sendMarkdown('x').then(() => undefined, (e: unknown) => e as WeComError)

    expect(error?.retryable).toBe(true)
    expect(error?.message).not.toContain(FIXTURE_KEY)
    expect(error?.message).toContain('<redacted>')
  })

  it('同一机器人连发两条：第二条 ≥ 第一条 + minIntervalMs', async () => {
    const fake = new FakeWeCom()
    const clock = (): number => Date.now()
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(clock), clock, minIntervalMs: 60, retryDelayMs: 5 })

    await client.sendMarkdown('first')
    await client.sendMarkdown('second')

    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]!.at - fake.calls[0]!.at).toBeGreaterThanOrEqual(59)
  })

  it('长中文 markdown 自动分块：每块 ≤ 4096 字节（假服务器独立复算），返回块数', async () => {
    const fake = new FakeWeCom()
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), ...NO_WAIT })
    const lines = Array.from({ length: 160 }, (_, i) => `第 ${i} 行：资金费率接近阈值已记录`)

    const parts = await client.sendNotice({ title: '批量告警', lines })

    expect(parts).toBeGreaterThan(1)
    expect(fake.calls).toHaveLength(parts)
    expect(fake.violations).toEqual([])
    for (const call of fake.calls) expect(call.contentBytes).toBeLessThanOrEqual(4096)
  })
})

describe('redactSecret', () => {
  it('原样 / URL 编码 / base64 / key= 查询参数都脱敏', () => {
    const secret = 'a+b/c=d-e'
    const text = `key=${secret} enc=${encodeURIComponent(secret)} b64=${Buffer.from(secret).toString('base64')} raw=${secret}`
    const out = redactSecret(text, secret)
    expect(out).not.toContain(secret)
    expect(out).not.toContain(encodeURIComponent(secret))
    expect(out).not.toContain(Buffer.from(secret).toString('base64'))
    expect(out).toContain('key=<redacted>')
  })

  it('超长文本截断到上限并保持单行', () => {
    const out = redactSecret('a\nb'.repeat(200), 'secret-value-long')
    expect(out.length).toBeLessThanOrEqual(201)
    expect(out).not.toContain('\n')
  })
})

/** 2xx 但不是 JSON 的网关页（覆盖「响应缺 errcode」分支）。 */
class WeComFakeHtml {
  count = 0
  readonly fetch = (async () => {
    this.count += 1
    return new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
}
