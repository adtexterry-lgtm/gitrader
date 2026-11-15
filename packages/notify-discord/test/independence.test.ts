// SPDX-License-Identifier: CPAL-1.0
// 独立性核对：假服务器不得 import 客户端代码，且必须注明官方依据（防「假服务器复刻客户端错误」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(new URL('./fake-discord.ts', import.meta.url), 'utf8')

describe('假服务器的独立性', () => {
  it('不 import 任何 src/ 下的模块（自己从 URL / JSON 复算官方规则）', () => {
    const imports = [...SOURCE.matchAll(/^\s*import\s+.*?from\s+['"](.+?)['"]/gm)].map((m) => String(m[1]))
    expect(imports.filter((spec) => /src\//.test(spec) || spec.startsWith('..'))).toEqual([])
  })

  it('引用了官方文档地址（webhook execute / rate limits / 错误码）', () => {
    expect(SOURCE).toContain('https://discord.com/developers/docs/resources/webhook#execute-webhook')
    expect(SOURCE).toContain('https://discord.com/developers/docs/topics/rate-limits')
    expect(SOURCE).toContain('https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes')
  })

  it('错误体里的 code 用官方码表的值（10015 / 50027 / 50035）', () => {
    for (const code of ['10015', '50027', '50035']) expect(SOURCE).toContain(code)
    expect(SOURCE).toContain('Unknown Webhook')
    expect(SOURCE).toContain('Invalid Webhook Token')
    expect(SOURCE).toContain('Invalid Form Body')
  })
})
