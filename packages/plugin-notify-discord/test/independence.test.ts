// SPDX-License-Identifier: CPAL-1.0
// 独立性核对：假服务器不 import 客户端 / 插件代码，且注明官方依据。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(new URL('./fake-server.ts', import.meta.url), 'utf8')

describe('假服务器的独立性', () => {
  it('没有任何 import（自己从 URL / JSON 复算官方规则，不借客户端的判定）', () => {
    expect([...SOURCE.matchAll(/^\s*import\s+.*?from\s+['"](.+?)['"]/gm)].map((m) => String(m[1]))).toEqual([])
  })

  it('注明三处官方依据（execute webhook / rate limits / 错误码）', () => {
    expect(SOURCE).toContain('https://discord.com/developers/docs/resources/webhook#execute-webhook')
    expect(SOURCE).toContain('https://discord.com/developers/docs/topics/rate-limits')
    expect(SOURCE).toContain('https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes')
  })

  it('用的错误码是官方码表里的值（10015 / 50027 / 50035）', () => {
    for (const code of ['10015', '50027', '50035']) expect(SOURCE).toContain(code)
  })
})
