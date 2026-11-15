// SPDX-License-Identifier: CPAL-1.0
// 脱敏测试：把口令原文与其 base64 塞进假错误文本，断言对外的 reason 里一个都不剩（含认证命令 blob）。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 插件内的纯 JS 模块，没有类型声明
import { baseReply, createFakeServer } from '../fake-smtp.mjs'
// @ts-expect-error 插件内的纯 JS 模块，没有类型声明
import { handleNotify } from '../index.mjs'
// @ts-expect-error 插件内的纯 JS 模块，没有类型声明
import { redactSecret } from '../secret.mjs'

const PASSWORD = 'fixture-password'
const B64_PASSWORD = Buffer.from(PASSWORD, 'utf8').toString('base64')
const AUTH_PLAIN = Buffer.from(`\0bot\0${PASSWORD}`, 'utf8').toString('base64')

const NOTICE = { level: 'critical', title: 'Risk denial', lines: ['account acct_x'] }
const PARAMS = { host: 'localhost', port: 465, secure: true, user: 'bot', from: 'bot@localhost', to: ['ops@localhost'] }

async function reasonOf(reply: (command: string) => string[]): Promise<string> {
  const { connection } = createFakeServer({ reply })
  const result = await handleNotify(
    { notice: NOTICE, params: PARAMS },
    { password: PASSWORD, connect: () => Promise.resolve(connection), fake: false },
  )
  expect(result.ok).toBe(false)
  return result.reason as string
}

describe('redactSecret', () => {
  it('替换口令原文与其 base64 形态', () => {
    const masked = redactSecret(`pw=${PASSWORD} b64=${B64_PASSWORD}`, PASSWORD)
    expect(masked).not.toContain(PASSWORD)
    expect(masked).not.toContain(B64_PASSWORD)
    expect(masked).toContain('<redacted>')
  })

  it('空口令跳过替换，文本原样返回', () => {
    expect(redactSecret('nothing to hide', '')).toBe('nothing to hide')
    expect(redactSecret('nothing to hide', [])).toBe('nothing to hide')
  })
})

describe('notify.send：错误文本脱敏', () => {
  it('服务端在 550 里回显口令与 base64 → reason 两者都不含', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('RCPT TO:')
        ? [`550 5.7.1 rejected pw=${PASSWORD} b64=${B64_PASSWORD}`]
        : baseReply(command)
    const reason = await reasonOf(reply)

    expect(reason).toContain('550')
    expect(reason).toContain('<redacted>')
    expect(reason).not.toContain(PASSWORD)
    expect(reason).not.toContain(B64_PASSWORD)
  })

  it('服务端回显整条 AUTH 命令（含 \0user\0pw 的 base64）→ reason 里没有 blob', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('AUTH PLAIN ') ? [`535 5.7.8 rejected ${command}`] : baseReply(command)
    const reason = await reasonOf(reply)

    expect(reason).toContain('535')
    expect(reason).toContain('<redacted>')
    expect(reason).not.toContain(AUTH_PLAIN)
    expect(reason).not.toContain(PASSWORD)
    expect(reason).not.toContain(B64_PASSWORD)
  })

  it('多行 550 逐行进 reason，仍是单行短句且不含口令', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('MAIL FROM:') ? ['550-5.7.1 sender rejected', `550 5.7.1 see policy ${PASSWORD}`] : baseReply(command)
    const reason = await reasonOf(reply)

    expect(reason).toContain('sender rejected')
    expect(reason).toContain('see policy')
    expect(reason).not.toContain('\n')
    expect(reason.length).toBeLessThanOrEqual(340)
    expect(reason).not.toContain(PASSWORD)
  })
})
