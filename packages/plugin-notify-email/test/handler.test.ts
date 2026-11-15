// SPDX-License-Identifier: CPAL-1.0
// 处理函数单测：假连接脚本化（照 packages/notify-email/test/smtp.test.ts 的 helper，JS 版在 ../fake-smtp.mjs）。
// 覆盖：完整会话命令序列、无认证 relay、缺口令、550 / 421 / 450、AUTH 535、超时、params 校验。
import { describe, expect, it } from 'vitest'
// @ts-expect-error 插件内的纯 JS 模块，没有类型声明
import { baseReply, createFakeServer } from '../fake-smtp.mjs'
// @ts-expect-error 插件内的纯 JS 模块，没有类型声明
import { classifyFailure, handleNotify, isValidSmtpHost, resolveParams } from '../index.mjs'
// @ts-expect-error 插件内的纯 JS 模块，没有类型声明
import { SmtpClient } from '../smtp.mjs'

const PASSWORD = 'fixture-password'
const AUTH_PLAIN = Buffer.from(`\0bot\0${PASSWORD}`, 'utf8').toString('base64')
const B64_PASSWORD = Buffer.from(PASSWORD, 'utf8').toString('base64')

const NOTICE = {
  key: 'risk.denials:acct_x:ruleY',
  level: 'warn',
  title: 'Risk denial',
  lines: ['account acct_x', 'rule Y', 'notional 1200 > 1000'],
  ts: 1760000000000,
}

const PARAMS = {
  host: 'localhost',
  port: 465,
  secure: true,
  user: 'bot',
  from: 'bot@localhost',
  to: ['one@localhost', 'two@localhost'],
}

/** 假连接 + 假口令注入（口令只走 deps，不读 process.env）。 */
async function run(
  params: Record<string, unknown>,
  opts: { reply?: (command: string) => string[]; password?: string; timeoutMs?: number; notice?: unknown } = {},
) {
  const { connection, log } = createFakeServer(opts.reply === undefined ? {} : { reply: opts.reply })
  const result = await handleNotify(
    { notice: opts.notice ?? NOTICE, params },
    {
      password: opts.password ?? PASSWORD,
      connect: () => Promise.resolve(connection),
      fake: false,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    },
  )
  return { result, log }
}

describe('notify.send：成功路径', () => {
  it('命令序列精确、主题带前缀、正文行原样、返回 {ok:true,ref}', async () => {
    const { result, log } = await run({ ...PARAMS, subjectPrefix: '[Gitrader] ' })

    expect(log.commands).toEqual([
      'EHLO localhost',
      `AUTH PLAIN ${AUTH_PLAIN}`,
      'MAIL FROM:<bot@localhost>',
      'RCPT TO:<one@localhost>',
      'RCPT TO:<two@localhost>',
      'DATA',
      'QUIT',
    ])
    expect(log.upgrades).toBe(0)
    expect(log.closed).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.ref).toMatch(/^<[^@\s]+@[^>\s]+>$/)

    expect(log.body).toContain('Subject: [Gitrader] [WARN] Risk denial')
    expect(log.body).toContain('Content-Type: multipart/alternative')
    expect(log.body).toContain('account acct_x')
    expect(log.body).toContain('notional 1200 > 1000')
    // ts 走品级无关的 ISO 时间行（正文末行）
    expect(log.body).toContain(new Date(NOTICE.ts).toISOString())
    expect(log.body).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  })

  it('params.user 为空且没有口令 → 无认证本地 relay：会话里没有 AUTH 命令', async () => {
    const { result, log } = await run({ ...PARAMS, user: '' }, { password: '' })

    expect(result.ok).toBe(true)
    expect(log.commands).toEqual([
      'EHLO localhost',
      'MAIL FROM:<bot@localhost>',
      'RCPT TO:<one@localhost>',
      'RCPT TO:<two@localhost>',
      'DATA',
      'QUIT',
    ])
    expect(log.commands.some((command: string) => command.startsWith('AUTH'))).toBe(false)
  })

  it('STARTTLS：EHLO 宣告 STARTTLS → 升级 → 再 EHLO，之后才认证', async () => {
    let ehlo = 0
    const reply = (command: string): string[] => {
      if (command.startsWith('EHLO')) {
        ehlo += 1
        return ehlo === 1 ? ['250-fake', '250-STARTTLS', '250 AUTH PLAIN LOGIN'] : ['250-fake', '250 AUTH PLAIN LOGIN']
      }
      if (command === 'STARTTLS') return ['220 2.0.0 ready to start TLS']
      return baseReply(command)
    }
    const { result, log } = await run({ ...PARAMS, port: 587, secure: false }, { reply })

    expect(result.ok).toBe(true)
    expect(log.commands.slice(0, 3)).toEqual(['EHLO localhost', 'STARTTLS', 'EHLO localhost'])
    expect(log.upgrades).toBe(1)
    expect(ehlo).toBe(2)
  })
})

describe('notify.send：失败与会话不发起', () => {
  it('EHLO 不宣告 STARTTLS + 有口令 → 不发 AUTH：ok:false、retryable:false、命令只有 EHLO', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('EHLO') ? ['250-fake', '250 AUTH PLAIN LOGIN'] : baseReply(command)
    const { result, log } = await run({ ...PARAMS, port: 587, secure: false }, { reply })

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(result.reason).toContain('does not offer STARTTLS')
    expect(log.commands).toEqual(['EHLO localhost'])
    expect(log.commands.some((command: string) => command.startsWith('AUTH'))).toBe(false)
    expect(log.commands.some((command: string) => command.startsWith('MAIL FROM'))).toBe(false)
    expect(result.reason).not.toContain(PASSWORD)
    expect(result.reason).not.toContain(AUTH_PLAIN)
  })

  it('缺 SMTP_PASSWORD 但 params.user 非空 → {ok:false,retryable:false}，且不连接', async () => {
    let connected = 0
    const result = await handleNotify(
      { notice: NOTICE, params: PARAMS },
      { password: '', connect: () => { connected += 1; return Promise.resolve({ write() {}, readLine: async () => '500 no', close() {} }) }, fake: false },
    )

    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('SMTP_PASSWORD')
    expect(connected).toBe(0)
  })

  it('RCPT 550 → {ok:false,retryable:false}，reason 含 550 与应答文本，不含口令 / 其 base64', async () => {
    const reply = (command: string): string[] =>
      command === 'RCPT TO:<two@localhost>' ? ['550 5.1.1 mailbox unavailable'] : baseReply(command)
    const { result } = await run(PARAMS, { reply })

    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('550')
    expect(result.reason).toContain('mailbox unavailable')
    expect(result.reason).not.toContain(PASSWORD)
    expect(result.reason).not.toContain(B64_PASSWORD)
    expect(result.reason).not.toContain(AUTH_PLAIN)
  })

  it('greeting 421 → retryable:true', async () => {
    const { connection } = createFakeServer({ greeting: ['421 4.3.2 service busy'] })
    const result = await handleNotify(
      { notice: NOTICE, params: PARAMS },
      { password: PASSWORD, connect: () => Promise.resolve(connection), fake: false },
    )

    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason).toContain('421')
  })

  it('MAIL 450 → retryable:true', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('MAIL FROM:') ? ['450 4.7.1 try again later'] : baseReply(command)
    const { result } = await run(PARAMS, { reply })

    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason).toContain('450')
  })

  it('AUTH 535 → retryable:false，reason 不含口令 / 其 base64 / 认证命令原文', async () => {
    const reply = (command: string): string[] =>
      command.startsWith('AUTH PLAIN ') ? [`535 5.7.8 rejected ${command}`] : baseReply(command)
    const { result } = await run(PARAMS, { reply })

    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain('535')
    expect(result.reason).not.toContain(PASSWORD)
    expect(result.reason).not.toContain(B64_PASSWORD)
    expect(result.reason).not.toContain(AUTH_PLAIN)
  })

  it('读应答超时 → retryable:true，reason 含 timeout', async () => {
    const connection = {
      write() {},
      readLine: () => new Promise<string>(() => {}),
      close() {},
    }
    const result = await handleNotify(
      { notice: NOTICE, params: PARAMS },
      { password: PASSWORD, connect: () => Promise.resolve(connection), fake: false, timeoutMs: 50 },
    )

    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(result.reason.toLowerCase()).toContain('timeout')
    expect(result.reason).not.toContain(PASSWORD)
  })

  it('总预算：假连接每步慢 3 s、共 4 步 → 在 8 s 总预算处返回 timeout，而不是每步 8 s 累加', async () => {
    const replies = [
      '220 fake ESMTP ready',
      '250-fake greets you',
      '250 AUTH PLAIN LOGIN',
      '235 2.7.0 authentication successful',
      '250 2.1.0 ok',
      '250 2.1.5 ok',
      '354 End data with <CRLF>.<CRLF>',
      '250 2.0.0 queued as fake-smtp-1',
    ]
    const state = { reads: 0, closed: false }
    const connection = {
      write() {},
      readLine() {
        const reply = replies[state.reads] ?? '250 ok'
        state.reads += 1
        return new Promise<string>((resolve) => setTimeout(() => resolve(reply), 3000))
      },
      close() {
        state.closed = true
      },
    }

    const startedAt = Date.now()
    const result = await handleNotify(
      { notice: NOTICE, params: PARAMS },
      { password: PASSWORD, connect: () => Promise.resolve(connection), fake: false, timeoutMs: 8000 },
    )
    const elapsed = Date.now() - startedAt

    expect(result).toEqual({ ok: false, retryable: true, reason: 'timeout' })
    // 单步 3 s：跑到第 4 步要 12 s，说明总预算没生效
    expect(state.reads).toBeLessThan(4)
    expect(elapsed).toBeGreaterThanOrEqual(7000)
    expect(elapsed).toBeLessThan(11000)
    expect(state.closed).toBe(true)
  }, 20000)
})

describe('notify.send：入参校验', () => {
  const INVALID: Array<[Record<string, unknown>, string]> = [
    [{ ...PARAMS, host: '' }, 'params.host'],
    [{ ...PARAMS, host: 'smtp://localhost' }, 'params.host'],
    [{ ...PARAMS, port: 0 }, 'params.port'],
    [{ ...PARAMS, to: [] }, 'params.to'],
    [{ ...PARAMS, from: '' }, 'params.from'],
  ]

  it.each(INVALID)('非法参数 → {ok:false,retryable:false}（%#）', async (params, fragment) => {
    const result = await handleNotify({ notice: NOTICE, params }, { password: PASSWORD, fake: false })
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(result.reason).toContain(fragment)
  })

  it('notice 缺 title / 缺 notice → 校验失败且不连接', async () => {
    const noTitle = await handleNotify({ notice: { lines: [] }, params: PARAMS }, { password: PASSWORD, fake: false })
    expect(noTitle).toMatchObject({ ok: false, retryable: false })
    expect(noTitle.reason).toContain('notice.title')

    const noNotice = await handleNotify({ params: PARAMS }, { password: PASSWORD, fake: false })
    expect(noNotice).toMatchObject({ ok: false, retryable: false })
    expect(noNotice.reason).toContain('notice')
  })

  it('resolveParams：secure 与端口的缺省关系', () => {
    expect(resolveParams({ host: 'localhost', from: 'bot@localhost', to: ['a@localhost'] })).toMatchObject({
      ok: true,
      value: { port: 587, secure: false, user: '' },
    })
    expect(resolveParams({ host: 'localhost', secure: true, from: 'bot@localhost', to: 'a@localhost' })).toMatchObject({
      ok: true,
      value: { port: 465, secure: true, to: ['a@localhost'] },
    })
  })

  it('resolveParams：host 只接受域名或 IP 字面量', () => {
    for (const good of ['localhost', 'smtp.gmail.com', 'a-b.example.org', '127.0.0.1', '[::1]', '[2001:db8::1]']) {
      expect(isValidSmtpHost(good), good).toBe(true)
    }
    for (const bad of [
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
      expect(isValidSmtpHost(bad), bad).toBe(false)
    }
    // 走 resolveParams 时同样拦下，且 reason 指向 params.host（不含口令）
    const rejected = resolveParams({ host: 'smtp.example.com/evil', from: 'bot@localhost', to: ['a@localhost'] })
    expect(rejected.ok).toBe(false)
    expect(String(rejected.reason)).toContain('params.host')
  })

  it('classifyFailure：4xx / 网络类可重试，5xx 不可重试', () => {
    expect(classifyFailure('SMTP RCPT TO failed: 421 4.3.2 busy')).toBe(true)
    expect(classifyFailure('SMTP MAIL FROM failed: 450 4.7.1 later')).toBe(true)
    expect(classifyFailure('SMTP RCPT TO failed: 550 5.1.1 no such user')).toBe(false)
    expect(classifyFailure('SMTP AUTH PLAIN failed: 535 5.7.8 bad')).toBe(false)
    expect(classifyFailure('SMTP timeout: no reply within 8000ms')).toBe(true)
    expect(classifyFailure('connect ECONNREFUSED 127.0.0.1:25')).toBe(true)
    expect(classifyFailure('SMTP malformed reply: whatever')).toBe(false)
  })

  it('SmtpClient 构造器与库对齐：非法 host 抛同一个错误（与 resolveParams 同一判定）', () => {
    const base = { port: 587, from: 'bot@localhost' }
    for (const host of ['http://smtp.example.com', 'smtp.example.com:587', '999.1.1.1', 'a..b', 'localhost\n']) {
      expect(isValidSmtpHost(host), host).toBe(false)
      expect(() => new SmtpClient({ ...base, host }), host).toThrow('SmtpClient: host must be a host name or IP address')
    }
    expect(() => new SmtpClient({ ...base, host: 'smtp.example.com' })).not.toThrow()
  })
})
