// SPDX-License-Identifier: CPAL-1.0
// smtp.ts 的单元测试：全部离线。connect 注入脚本化假服务器（按收到的命令回预设应答），
// 密码只用 'test-password'，并断言任何错误消息都不含密码原文 / 认证命令。
import { describe, expect, it } from 'vitest'
import { SmtpClient, isValidSmtpHost } from '../src/smtp'
import type { SmtpConnection } from '../src/smtp'
import { redactSecret } from '../src/secret'

const CRLF = '\r\n'
const PASSWORD = 'test-password'
const AUTH_PLAIN = Buffer.from(`\0bot\0${PASSWORD}`, 'utf8').toString('base64')

interface FakeLog {
  commands: string[]
  writes: string[]
  body: string
  upgrades: number
  closed: boolean
}

function fakeServer(opts: {
  greeting?: string[]
  reply: (command: string) => string[]
}): { connection: SmtpConnection; log: FakeLog } {
  const log: FakeLog = { commands: [], writes: [], body: '', upgrades: 0, closed: false }
  const queue: string[] = [...(opts.greeting ?? ['220 fake ESMTP ready'])]
  const waiters: Array<(line: string) => void> = []

  const flush = (): void => {
    while (waiters.length > 0 && queue.length > 0) {
      const next = waiters.shift()
      const line = queue.shift()
      if (next !== undefined && line !== undefined) next(line)
    }
  }
  const push = (lines: string[]): void => {
    for (const line of lines) queue.push(line)
    flush()
  }

  let buffer = ''
  let inData = false

  const connection: SmtpConnection = {
    write(line: string): void {
      // 契约：缺 CRLF 时由连接实现补
      const payload = line.endsWith(CRLF) ? line : `${line}${CRLF}`
      log.writes.push(payload)
      buffer += payload
      for (;;) {
        const idx = buffer.indexOf(CRLF)
        if (idx < 0) break
        const current = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (inData) {
          if (current === '.') {
            inData = false
            push(opts.reply('END-OF-DATA'))
          } else {
            log.body += `${current}${CRLF}`
          }
          continue
        }
        log.commands.push(current)
        if (current === 'DATA') inData = true
        push(opts.reply(current))
      }
    },
    readLine(): Promise<string> {
      const next = queue.shift()
      if (next !== undefined) return Promise.resolve(next)
      return new Promise<string>((resolve) => {
        waiters.push(resolve)
      })
    },
    upgradeTls(): Promise<void> {
      log.upgrades += 1
      return Promise.resolve()
    },
    close(): void {
      log.closed = true
    },
  }
  return { connection, log }
}

/** 正常会话的应答表。 */
function baseReply(command: string): string[] {
  if (command.startsWith('EHLO')) return ['250-fake greets you', '250-SIZE 1000000', '250 AUTH PLAIN LOGIN']
  if (command.startsWith('AUTH PLAIN ')) return ['235 2.7.0 authentication successful']
  if (command.startsWith('AUTH LOGIN')) return ['334 VXNlcm5hbWU6']
  if (command.startsWith('MAIL FROM:')) return ['250 2.1.0 ok']
  if (command.startsWith('RCPT TO:')) return ['250 2.1.5 ok']
  if (command === 'DATA') return ['354 End data with <CRLF>.<CRLF>']
  if (command === 'END-OF-DATA') return ['250 2.0.0 queued as 1']
  if (command === 'QUIT') return ['221 2.0.0 bye']
  return ['500 5.5.1 unrecognized']
}

const MAIL = {
  to: ['one@localhost', 'two@localhost'],
  subject: 'hello',
  text: 'plain body',
}

function clientWith(connection: SmtpConnection, timeoutMs?: number): SmtpClient {
  return new SmtpClient({
    host: 'localhost',
    port: 465,
    secure: true,
    user: 'bot',
    password: PASSWORD,
    from: 'bot@localhost',
    connect: () => Promise.resolve(connection),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

describe('SmtpClient.send（隐式 TLS 完整会话）', () => {
  it('命令序列、DATA 结尾、accepted 与 messageId', async () => {
    const { connection, log } = fakeServer({ reply: baseReply })
    const result = await clientWith(connection).send(MAIL)

    expect(log.commands[0]).toBe('EHLO localhost')
    expect(log.commands[1]).toBe(`AUTH PLAIN ${AUTH_PLAIN}`)
    expect(log.commands[2]).toBe('MAIL FROM:<bot@localhost>')
    expect(log.commands[3]).toBe('RCPT TO:<one@localhost>')
    expect(log.commands[4]).toBe('RCPT TO:<two@localhost>')
    expect(log.commands[5]).toBe('DATA')
    expect(log.commands[6]).toBe('QUIT')
    expect(log.commands).toHaveLength(7)

    // 正文单独一次写入，且以 CRLF.CRLF 结束（dot-stuffing 的结束符）
    const bodyWrite = log.writes.find((w) => w.includes('MIME-Version: 1.0'))
    expect(bodyWrite).toBeDefined()
    expect(bodyWrite?.endsWith(`${CRLF}.${CRLF}`)).toBe(true)
    expect(log.body).toContain('Subject: hello')

    expect(result.accepted).toEqual(['one@localhost', 'two@localhost'])
    expect(result.messageId).toMatch(/^<[^@\s]+@[^>\s]+>$/)
    expect(log.upgrades).toBe(0)
    expect(log.closed).toBe(true)
  })
})

describe('SmtpClient.send（无 STARTTLS 时拒绝发口令）', () => {
  it('EHLO 不宣告 STARTTLS + 有 user → 抛错、命令序列只有 EHLO，不发 AUTH / MAIL', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('EHLO') ? ['250-fake greets you', '250 AUTH PLAIN LOGIN'] : baseReply(command)
    const { connection, log } = fakeServer({ reply })

    await expect(
      new SmtpClient({
        host: 'localhost',
        port: 587,
        secure: false,
        user: 'bot',
        password: PASSWORD,
        from: 'bot@localhost',
        connect: () => Promise.resolve(connection),
      }).send(MAIL),
    ).rejects.toThrow(/does not offer STARTTLS/)

    expect(log.commands).toEqual(['EHLO localhost'])
    expect(log.commands.some((command) => command.startsWith('AUTH'))).toBe(false)
    expect(log.upgrades).toBe(0)
    expect(log.closed).toBe(true)
  })

  it('错误消息不含口令原文与 AUTH PLAIN 的 base64', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('EHLO') ? ['250-fake greets you', '250 AUTH PLAIN LOGIN'] : baseReply(command)
    const { connection } = fakeServer({ reply })
    const client = new SmtpClient({
      host: 'localhost',
      port: 587,
      secure: false,
      user: 'bot',
      password: PASSWORD,
      from: 'bot@localhost',
      connect: () => Promise.resolve(connection),
    })
    const message = await client.send(MAIL).then(
      () => 'no error',
      (err: Error) => err.message,
    )
    expect(message).not.toContain(PASSWORD)
    expect(message).not.toContain(AUTH_PLAIN)
  })
})

describe('isValidSmtpHost（host 格式闸门）', () => {
  it('域名 / IPv4 / [IPv6] 通过', () => {
    for (const host of ['localhost', 'smtp.gmail.com', 'a-b.example.org', '127.0.0.1', '[::1]', '[2001:db8::1]']) {
      expect(isValidSmtpHost(host), host).toBe(true)
    }
  })

  it('scheme / 路径 / 端口 / 空白 / 畸形标签一律拒绝', () => {
    for (const host of [
      'smtp.example.com/path',
      'https://smtp.example.com',
      'smtp.example.com:587',
      'evil host',
      'a..b',
      '-bad.example.com',
      'bad-.example.com',
      'under_score.example.com',
      '999.1.1.1',
      `${'a'.repeat(64)}.example.com`,
      'localhost\n',
      '',
    ]) {
      expect(isValidSmtpHost(host), host).toBe(false)
    }
  })

  it('SmtpClient 构造期就拒绝非法 host（不发任何命令）', () => {
    expect(() => new SmtpClient({ host: 'smtp.example.com/evil', port: 587, secure: false, from: 'bot@localhost' })).toThrow(/host must be a host name/)
  })
})

describe('SmtpClient.send（STARTTLS 路径）', () => {
  it('EHLO 应答含 STARTTLS → 发 STARTTLS → upgradeTls → 再 EHLO', async () => {
    let ehloCount = 0
    const reply = (command: string): string[] => {
      if (command.startsWith('EHLO')) {
        ehloCount += 1
        return ehloCount === 1
          ? ['250-fake greets you', '250-STARTTLS', '250 AUTH PLAIN LOGIN']
          : ['250-fake greets you', '250 AUTH PLAIN LOGIN']
      }
      if (command === 'STARTTLS') return ['220 2.0.0 ready to start TLS']
      return baseReply(command)
    }
    const { connection, log } = fakeServer({ reply })
    const client = new SmtpClient({
      host: 'localhost',
      port: 587,
      secure: false,
      user: 'bot',
      password: PASSWORD,
      from: 'bot@localhost',
      connect: () => Promise.resolve(connection),
    })

    await client.send(MAIL)

    expect(log.commands.slice(0, 4)).toEqual([
      'EHLO localhost',
      'STARTTLS',
      'EHLO localhost',
      `AUTH PLAIN ${AUTH_PLAIN}`,
    ])
    expect(log.upgrades).toBe(1)
    expect(ehloCount).toBe(2)
  })
})

describe('SmtpClient.send（AUTH 失败脱敏）', () => {
  it('AUTH PLAIN 收到回显的畸形应答 → reject 且消息不含密码及其 base64', async () => {
    const user = 'user'
    const authPlain = Buffer.from(`\0${user}\0${PASSWORD}`, 'utf8').toString('base64')
    const reply = (command: string): string[] => {
      if (command.startsWith('AUTH PLAIN ')) return [`oops ${command}`]
      return baseReply(command)
    }
    const { connection } = fakeServer({ reply })
    const client = new SmtpClient({
      host: 'localhost',
      port: 465,
      secure: true,
      user,
      password: PASSWORD,
      from: 'bot@localhost',
      connect: () => Promise.resolve(connection),
    })

    const error = await client.send(MAIL).then(
      () => undefined,
      (e: unknown) => e as Error,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).not.toContain(authPlain)
    expect(error?.message).not.toContain(PASSWORD)
    expect(error?.message).not.toContain(Buffer.from(PASSWORD, 'utf8').toString('base64'))
  })
})

describe('SmtpClient.send（AUTH LOGIN 回退）', () => {
  const userB64 = Buffer.from('bot', 'utf8').toString('base64')
  const passwordB64 = Buffer.from(PASSWORD, 'utf8').toString('base64')

  it('EHLO 只宣告 AUTH LOGIN → 走 LOGIN，命令序列含 user / password 的 base64', async () => {
    const reply = (command: string): string[] => {
      if (command.startsWith('EHLO')) return ['250-fake greets you', '250 AUTH LOGIN']
      if (command === 'AUTH LOGIN') return ['334 VXNlcm5hbWU6']
      if (command === userB64) return ['334 UGFzc3dvcmQ6']
      if (command === passwordB64) return ['235 2.7.0 authentication successful']
      return baseReply(command)
    }
    const { connection, log } = fakeServer({ reply })

    const result = await clientWith(connection).send(MAIL)

    expect(log.commands.slice(0, 4)).toEqual(['EHLO localhost', 'AUTH LOGIN', userB64, passwordB64])
    expect(result.accepted).toEqual(['one@localhost', 'two@localhost'])
  })

  it('LOGIN 密码步被 535 拒 → reject，消息含 535 且不含密码 base64', async () => {
    const reply = (command: string): string[] => {
      if (command.startsWith('EHLO')) return ['250-fake greets you', '250 AUTH LOGIN']
      if (command === 'AUTH LOGIN') return ['334 VXNlcm5hbWU6']
      if (command === userB64) return ['334 UGFzc3dvcmQ6']
      if (command === passwordB64) return ['535 5.7.8 authentication credentials invalid']
      return baseReply(command)
    }
    const { connection } = fakeServer({ reply })

    const error = await clientWith(connection).send(MAIL).then(
      () => undefined,
      (e: unknown) => e as Error,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('535')
    expect(error?.message).not.toContain(passwordB64)
    expect(error?.message).not.toContain(PASSWORD)
  })
})

describe('SmtpClient.send（应答码与多行应答）', () => {
  it('RCPT TO 回 550 抛错：含 550 与文本，不含密码 / 认证命令', async () => {
    const reply = (command: string): string[] => {
      if (command.startsWith('RCPT TO:<two@localhost>')) return ['550 5.1.1 mailbox unavailable']
      return baseReply(command)
    }
    const { connection } = fakeServer({ reply })
    const client = clientWith(connection)

    const error = await client.send(MAIL).then(
      () => undefined,
      (e: unknown) => e as Error,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('550')
    expect(error?.message).toContain('mailbox unavailable')
    expect(error?.message).not.toContain(PASSWORD)
    expect(error?.message).not.toContain(AUTH_PLAIN)
    expect(error?.message).not.toContain('AUTH PLAIN ')
  })

  it('多行 250 应答逐行拼接（EHLO 三行不误判为结束）', async () => {
    const { connection, log } = fakeServer({ reply: baseReply })
    await clientWith(connection).send(MAIL)
    // 三行 EHLO 应答只消耗一次读，没把续行当新应答
    expect(log.commands[0]).toBe('EHLO localhost')
    expect(log.commands[1]).toContain('AUTH PLAIN')
  })

  it('多行 550 应答拼接：续行与收尾行都进错误消息', async () => {
    const reply = (command: string): string[] => {
      if (command.startsWith('MAIL FROM:')) return ['550-5.7.1 sender rejected', '550 5.7.1 see policy']
      return baseReply(command)
    }
    const { connection } = fakeServer({ reply })

    const error = await clientWith(connection).send(MAIL).then(
      () => undefined,
      (e: unknown) => e as Error,
    )

    expect(error?.message).toContain('550')
    expect(error?.message).toContain('sender rejected')
    expect(error?.message).toContain('see policy')
    expect(error?.message).not.toContain(PASSWORD)
  })
})

describe('SmtpClient.send（超时）', () => {
  it('readLine 永不返回 + timeoutMs:50 → 抛含 timeout 的错并关闭连接', async () => {
    let closed = false
    const connection: SmtpConnection = {
      write(): void {
        // 假服务器不回应
      },
      readLine(): Promise<string> {
        return new Promise<string>(() => {
          // 永不 settle
        })
      },
      close(): void {
        closed = true
      },
    }

    const client = clientWith(connection, 50)
    const startedAt = Date.now()
    const error = await client.send(MAIL).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    const elapsed = Date.now() - startedAt

    expect(error).toBeInstanceOf(Error)
    expect(error?.message.toLowerCase()).toContain('timeout')
    expect(error?.message).not.toContain(PASSWORD)
    expect(elapsed).toBeLessThan(2000)
    expect(closed).toBe(true)
  })
})

describe('redactSecret', () => {
  it('替换密码原文与其 base64 形态', () => {
    const masked = redactSecret(`pw=${PASSWORD} b64=${Buffer.from(PASSWORD).toString('base64')}`, PASSWORD)
    expect(masked).not.toContain(PASSWORD)
    expect(masked).toContain('<redacted>')
  })

  it('密码为空时原样返回', () => {
    expect(redactSecret('nothing to hide', '')).toBe('nothing to hide')
  })
})
