// SPDX-License-Identifier: CPAL-1.0
// 脱敏：把 token 塞进假错误文本，断言输出既不含 token 也不含 base64(token) / base64url(token)。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend } from '../index.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { redactSecrets, redactToken } from '../telegram.mjs'

const TOKEN = '987654:AAHfixture-token-never-real'
const BASE64 = Buffer.from(TOKEN, 'utf8').toString('base64')
const BASE64URL = BASE64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const NOTICE = { key: 'k', level: 'critical', title: 'Risk denial', lines: ['rule Y'] }
const ARGS = { notice: NOTICE, params: { chatId: '1' } }

function leaks(text: string): string[] {
  const found: string[] = []
  for (const secret of [TOKEN, BASE64, BASE64URL]) if (text.includes(secret)) found.push(secret)
  return found
}

describe('脱敏', () => {
  it('redactToken 把 token 换成 bot<redacted>，空 token 不动原文', () => {
    expect(redactToken(`https://api.telegram.org/bot${TOKEN}/sendMessage`, TOKEN)).toBe('https://api.telegram.org/botbot<redacted>/sendMessage')
    expect(redactToken('nothing to hide', '')).toBe('nothing to hide')
  })

  it('redactSecrets 覆盖 token、base64、base64url 三种变形', () => {
    const text = redactSecrets(`a=${TOKEN} b=${BASE64} c=${BASE64URL}`, TOKEN)
    expect(leaks(text)).toEqual([])
    expect(text).toContain('<redacted>')
  })

  it('假 fetch 抛错时 token 与 base64(token) 都不出现在 reason 里', async () => {
    const fetchImpl = async () => {
      throw new Error(`connect failed for bot${TOKEN} (b64 ${BASE64})`)
    }
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(leaks(result.reason)).toEqual([])
    expect(result.reason).toContain('<redacted>')
  })

  it('平台把 token 回显在 description 里也不漏', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: `Unauthorized: bad token ${TOKEN} ${BASE64}` }),
    })
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(leaks(result.reason)).toEqual([])
    expect(result.reason).toContain('Unauthorized')
  })

  it('reason 压成一行短句（不带换行、不超过上限）', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: `line1\nline2\n\t${'z'.repeat(400)}` }),
    })
    const result = await handleNotifySend(ARGS, { token: TOKEN, fetchImpl })
    expect(result.reason).not.toContain('\n')
    expect(redactSecrets('a\nb\tc', '')).toBe('a b c')
    expect(result.reason.length).toBeLessThanOrEqual(201)
  })
})
