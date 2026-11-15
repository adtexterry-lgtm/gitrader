// SPDX-License-Identifier: CPAL-1.0
// 假服务器自身的校验力（有牙）：手写一份违规请求喂给假服务器，必须被记进 violations；
// 再用手写一份合规请求过假服务器，必须零违规——证明假服务器不是只回固定 JSON 的空壳。
import { describe, expect, it } from 'vitest'
import { WeComClient } from '../src/client'
import { FakeWeCom, FIXTURE_KEY, WECOM_PATH } from './helpers/fake-wecom'

const URL_OK = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${FIXTURE_KEY}`

describe('假服务器独立校验（不 import 客户端代码）', () => {
  it('手写合规请求 → 零违规、errcode 0', async () => {
    const fake = new FakeWeCom()
    const read = fake.fetch(() => 0) as unknown as (u: string, i: RequestInit) => Promise<Response>
    const res = await read(URL_OK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: '### [INFO] t\nfact line' } }),
    })
    expect(await res.json()).toEqual({ errcode: 0, errmsg: 'ok' })
    expect(fake.violations).toEqual([])
  })

  it('msgtype 非法 → 违规被记下，回非 0 errcode', async () => {
    const fake = new FakeWeCom()
    const read = fake.fetch(() => 0) as unknown as (u: string, i: RequestInit) => Promise<Response>
    const res = await read(URL_OK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'news', news: { content: 'x' } }),
    })
    const body = (await res.json()) as { errcode: number }
    expect(fake.violations).toContain('msgtype 非法：news')
    expect(body.errcode).not.toBe(0)
  })

  it('超过 4096 字节的 markdown → 违规被记下', async () => {
    const fake = new FakeWeCom()
    const read = fake.fetch(() => 0) as unknown as (u: string, i: RequestInit) => Promise<Response>
    const content = '中'.repeat(1400) // 4200 字节
    const res = await read(URL_OK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    })
    expect(fake.violations.some((v) => v.includes('超过 4096 字节'))).toBe(true)
    expect(((await res.json()) as { errcode: number }).errcode).not.toBe(0)
  })

  it('路径 / key / 方法不对 → 违规被记下', async () => {
    const fake = new FakeWeCom()
    const read = fake.fetch(() => 0) as unknown as (u: string, i: RequestInit) => Promise<Response>
    await read(`https://qyapi.weixin.qq.com/other?key=${FIXTURE_KEY}`, {
      method: 'GET',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ msgtype: 'text', text: { content: 'x' } }),
    })
    expect(fake.violations.join('|')).toContain(`路径不是 ${WECOM_PATH}`)
    expect(fake.violations.join('|')).toContain('方法必须是 POST')
    expect(fake.violations.join('|')).toContain('content-type 必须是 application/json')
  })

  it('客户端 + 假服务器：正文只有标题与事实行，params 里的自由文本不进正文', async () => {
    const fake = new FakeWeCom()
    const client = new WeComClient({ webhookUrl: URL_OK, fetchImpl: fake.fetch(() => 0), minIntervalMs: 0, retryDelayMs: 5 })
    await client.sendNotice({ title: 'Risk denial', lines: ['rule Y'], level: 'warn' })
    expect(fake.violations).toEqual([])
    expect(fake.lastContent()).toBe('### [WARN] Risk denial\nrule Y')
  })
})
