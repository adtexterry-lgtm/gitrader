// SPDX-License-Identifier: CPAL-1.0
// 插件 index.mjs 与库 src/smtp.ts 各有一份 host 格式闸门（L5-04 修在两处）：
// 逐条比对两边判定，防止只改一边造成「库拒、插件放」的口径漂移（L5-12）。
import { describe, expect, it } from 'vitest'
import { isValidSmtpHost as libIsValidSmtpHost } from '../../notify-email/src/smtp'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { isValidSmtpHost as pluginIsValidSmtpHost, resolveParams as pluginResolveParams } from '../index.mjs'

/** 通过 / 拒绝两组的并集夹具。 */
const HOSTS = [
  'localhost',
  'smtp.gmail.com',
  'smtp.qq.com',
  'a-b.example.org',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '[2001:db8::1]',
  'smtp.example.com/path',
  'https://smtp.example.com',
  'smtp.example.com:587',
  'evil host',
  'a..b',
  '-bad.example.com',
  'bad-.example.com',
  'under_score.example.com',
  '999.1.1.1',
  '1.2.3.4.5',
  'localhost.',
  '',
  'x',
  `${'a'.repeat(64)}.example.com`,
]

describe('index.mjs 与库 src/smtp.ts 的 host 判定一致', () => {
  it('22 个夹具两边逐条相同', () => {
    for (const host of HOSTS) {
      expect(pluginIsValidSmtpHost(host), host).toBe(libIsValidSmtpHost(host))
    }
  })

  it('插件 resolveParams 拒绝非法 host 时不动口令、不连网', () => {
    const result = pluginResolveParams({ host: 'smtp.example.com:587', from: 'bot@localhost', to: ['a@localhost'] })
    expect(result.ok).toBe(false)
    expect(String(result.reason)).toBe('params.host must be a valid host name or IP address (no scheme, no path)')
  })
})
