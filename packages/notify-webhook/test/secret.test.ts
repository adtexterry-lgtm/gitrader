// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { redactSecret } from '../src/index'

describe('密钥脱敏', () => {
  it('原文与其 base64 形态都替换成 <redacted>', () => {
    const secret = 'feishu-test-secret'
    const encoded = Buffer.from(secret, 'utf8').toString('base64')
    const out = redactSecret(`sign=${secret} b64=${encoded}`, secret)
    expect(out).toBe('sign=<redacted> b64=<redacted>')
    expect(out).not.toContain(secret)
  })

  it('多个密钥、空串与数组入参', () => {
    expect(redactSecret('a=one b=two', ['one', 'two'])).toBe('a=<redacted> b=<redacted>')
    expect(redactSecret('keep me', '')).toBe('keep me')
    expect(redactSecret('keep me', [])).toBe('keep me')
  })
})
