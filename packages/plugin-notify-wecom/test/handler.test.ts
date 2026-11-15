// SPDX-License-Identifier: CPAL-1.0
// notify_send 处理函数单测：成功 / 缺环境变量 / 地址非法 / 缺 notice / 自由文本参数被拒 /
// 官方 errcode（45009 / -1 重试、93000 不重试）/ 分块 / 同一 notice 重试与重复调用都如实发送 / text 形态。全部离线。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend, WEBHOOK_ENV } from '../index.mjs'
import { FakeWeComServer } from './helpers/fake-wecom'

const KEY = 'fixture-webhook-key-0001'
const WEBHOOK = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${KEY}`

const NOTICE = {
  key: 'takeover:tk_9f',
  level: 'warn',
  title: 'Risk denial',
  lines: ['account acct_x', 'rule Y', 'notional 1200 > 1000'],
  ts: 1760000000000,
  topic: 'risk.denials',
}

function deps(fake: FakeWeComServer) {
  return { webhookUrl: WEBHOOK, fetchImpl: fake.fetch, timeoutMs: 500, retryDelayMs: 10 }
}

describe('notify_send 处理函数', () => {
  it('成功：一条 markdown 消息，正文是「标题 + 事实行 + 时间」，返回 {ok:true}（无 ref）', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))

    expect(result).toEqual({ ok: true })
    expect(fake.violations).toEqual([])
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.msgtype).toBe('markdown')
    expect(fake.lastContent()).toBe('### [WARN] Risk denial\naccount acct_x\nrule Y\nnotional 1200 > 1000\n`2025-10-09T08:53:20.000Z`')
  })

  it(`缺 ${WEBHOOK_ENV} → {ok:false, retryable:false}，不发请求`, async () => {
    const fake = new FakeWeComServer({ key: KEY })
    const saved = process.env[WEBHOOK_ENV]
    delete process.env[WEBHOOK_ENV]
    try {
      const result = await handleNotifySend({ notice: NOTICE, params: {} }, { fetchImpl: fake.fetch })
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(result.reason).toContain(WEBHOOK_ENV)
      expect(fake.calls).toHaveLength(0)
    } finally {
      if (saved !== undefined) process.env[WEBHOOK_ENV] = saved
    }
  })

  it('webhook 地址非法（非官方域名 / http / 缺 key）→ {ok:false, retryable:false}，不回显 key', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    for (const bad of [
      `https://evil.example.com/cgi-bin/webhook/send?key=${KEY}`,
      `http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${KEY}`,
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send',
    ]) {
      const result = await handleNotifySend({ notice: NOTICE, params: {} }, { webhookUrl: bad, fetchImpl: fake.fetch })
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(result.reason).not.toContain(KEY)
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('缺 notice → 报错且不发请求', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    const result = await handleNotifySend({ params: {} }, deps(fake))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('notice')
    expect(fake.calls).toHaveLength(0)
  })

  it('params 里的自由文本参数（content / text / title …）一律拒绝，不进正文', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    for (const name of ['content', 'text', 'title', 'lines', 'footer']) {
      const result = await handleNotifySend({ notice: NOTICE, params: { [name]: '买入理由：技术面突破' } }, deps(fake))
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(result.reason).toContain(`params.${name}`)
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('官方 45009（超 20 条/分钟）→ 重试一次后成功', async () => {
    const fake = new FakeWeComServer({ key: KEY, errcodes: [45009, 0] })
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))
    expect(result).toEqual({ ok: true })
    expect(fake.calls).toHaveLength(2)
  })

  it('官方 -1（系统繁忙）→ 重试一次后成功，POST 2 次', async () => {
    const fake = new FakeWeComServer({ key: KEY, errcodes: [-1, 0] })
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))
    expect(result).toEqual({ ok: true })
    expect(fake.calls).toHaveLength(2)
  })

  it('官方 -1 一直返回 → 重试用尽后 retryable:true', async () => {
    const fake = new FakeWeComServer({ key: KEY, errcodes: [-1, -1, -1] })
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason).toContain('-1')
    expect(fake.calls).toHaveLength(2)
  })

  it('官方 93000（key 失效）→ {ok:false, retryable:false}，只发一次，reason 不含 key', async () => {
    const fake = new FakeWeComServer({ key: 'another-key' })
    const result = await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('93000')
    expect(result.reason).not.toContain(KEY)
    expect(fake.calls).toHaveLength(1)
  })

  it('超长正文按 4096 字节分块，块数 = 调用次数，每块 ≤ 4096 字节', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    const lines = Array.from({ length: 160 }, (_, i) => `第 ${i} 行：资金费率接近阈值已记录`)
    const result = await handleNotifySend({ notice: { ...NOTICE, lines }, params: {} }, deps(fake))
    expect(result).toEqual({ ok: true })
    expect(fake.calls.length).toBeGreaterThan(1)
    expect(fake.violations).toEqual([])
    for (const call of fake.calls) expect(call.contentBytes).toBeLessThanOrEqual(4096)
  })

  it('同一 notice 重试：第一次 45009 两次用尽回报 retryable，第二次确实再发 POST 并成功', async () => {
    const fake = new FakeWeComServer({ key: KEY, errcodes: [45009, 45009, 0] })
    const first = await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))
    expect(first).toMatchObject({ ok: false, retryable: true })
    expect(fake.calls).toHaveLength(2)

    const second = await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))
    expect(second).toEqual({ ok: true })
    expect(fake.calls).toHaveLength(3)
  })

  it('同一 notice 连续两次成功：通道不去重，假服务器收到 2 条', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    expect(await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))).toEqual({ ok: true })
    expect(await handleNotifySend({ notice: NOTICE, params: {} }, deps(fake))).toEqual({ ok: true })
    expect(fake.calls).toHaveLength(2)
  })

  it('params.markdown=false 走 text 形态（首行 [级别] 标题、2048 字节上限）', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    const result = await handleNotifySend({ notice: NOTICE, params: { markdown: false } }, deps(fake))
    expect(result).toEqual({ ok: true })
    expect(fake.calls[0]!.msgtype).toBe('text')
    expect(fake.lastContent().startsWith('[WARN] Risk denial')).toBe(true)
    expect(fake.violations).toEqual([])
  })

  it('notice 里的非白名单字段（如 reason 自由文本）不进正文', async () => {
    const fake = new FakeWeComServer({ key: KEY })
    const noisy = { ...NOTICE, reason: '我觉得这单可以加仓', memo: '内部备注' }
    await handleNotifySend({ notice: noisy, params: {} }, deps(fake))
    expect(fake.lastContent()).not.toContain('加仓')
    expect(fake.lastContent()).not.toContain('内部备注')
  })
})
