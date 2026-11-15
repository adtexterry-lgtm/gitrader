// SPDX-License-Identifier: CPAL-1.0
// SMTP 发送客户端：一次完整会话（EHLO → STARTTLS → AUTH → MAIL/RCPT → DATA → QUIT）。
// 连接由调用方注入（缺省用 node:net / node:tls），密码只从构造参数进，
// 错误消息统一经 redactSecret，且从不回显认证命令原文。
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { addressOnly, buildMime, dotStuff, newMessageId } from './mime'
import type { Mail } from './mime'
import { redactSecret } from './secret'

const CRLF = '\r\n'
const DEFAULT_TIMEOUT_MS = 15000
/** EHLO 时报的客户端名（不回显本机名 / 地址）。 */
const CLIENT_NAME = 'localhost'

/** IPv4 点分十进制（每段 0–255）。 */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
/** 方括号包裹的 IPv6 字面量。 */
const IPV6_RE = /^\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\]$/
/** 单个 DNS 标签：字母数字开头结尾，中间可带连字符，最长 63。 */
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/**
 * 主机只接受域名或 IP 字面量（L5-04）：挡掉 scheme、路径、空白、`host:port` 写法与畸形标签。
 * 是否必须落在清单 net.hosts 内（白名单口径）待 维护者 定，这里不做白名单比对。
 */
export function isValidSmtpHost(host: string): boolean {
  if (typeof host !== 'string') return false
  if (host !== host.trim()) return false
  if (host.length === 0 || host.length > 253) return false
  if (IPV4_RE.test(host) || IPV6_RE.test(host)) return true
  const labels = host.split('.')
  // 四段全数字的写法按 IPv4 严格解析：999.1.1.1 这类「看着像 IP」的串不接受。
  if (labels.length === 4 && labels.every((label) => /^\d+$/.test(label))) return false
  return labels.every((label) => LABEL_RE.test(label))
}

export interface SmtpConnection {
  /** 写一行命令（缺 CRLF 时由实现补）。 */
  write(line: string): void
  /** 读一行应答（不含行尾）。 */
  readLine(): Promise<string>
  /** STARTTLS 就地升级，可选。 */
  upgradeTls?(): Promise<void>
  close(): void
}

export interface ConnectParams {
  host: string
  port: number
  secure: boolean
}

export type SmtpConnector = (params: ConnectParams) => Promise<SmtpConnection>

export interface SmtpOptions {
  host: string
  /** 465 隐式 TLS / 587 STARTTLS / 25 明文。 */
  port: number
  /** true = 连上即 TLS（465）；false = 明文起手，服务端报 STARTTLS 时升级（587）。 */
  secure: boolean
  user?: string
  password?: string
  from: string
  /** 单次读应答的超时，缺省 15000ms。 */
  timeoutMs?: number
  /** 连接注入点，缺省 node:net / node:tls。 */
  connect?: SmtpConnector
  clock?: () => number
}

export interface SendResult {
  accepted: string[]
  messageId: string
}

interface Reply {
  code: number
  lines: string[]
  text: string
}

interface CmdMeta {
  /** 出错时展示的命令名；认证命令必须传，避免把凭据写进错误消息。 */
  label?: string
  /** 认证阶段的应答文本额外屏蔽长 base64 串。 */
  maskAuth?: boolean
}

/** 缺省连接：secure 走 tls，否则 net（STARTTLS 时由 upgradeTls 就地升级）。 */
export function nodeConnector(params: ConnectParams): Promise<SmtpConnection> {
  return new Promise<SmtpConnection>((resolve, reject) => {
    const socket = params.secure
      ? tlsConnect({ host: params.host, port: params.port, servername: params.host })
      : netConnect({ host: params.host, port: params.port })
    const readyEvent = params.secure ? 'secureConnect' : 'connect'
    const onError = (err: Error): void => reject(err)
    socket.once('error', onError)
    socket.once(readyEvent, () => {
      socket.removeListener('error', onError)
      resolve(socketConnection(socket, params.host))
    })
  })
}

/** 把 socket 包成按行读写的 SmtpConnection。 */
function socketConnection(initial: Socket, host: string): SmtpConnection {
  let current: Socket = initial
  let buffer = ''
  let failure: Error | undefined
  const waiting: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = []

  const flush = (): void => {
    while (waiting.length > 0) {
      const idx = buffer.indexOf('\n')
      if (idx < 0) return
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      const next = waiting.shift()
      if (next !== undefined) next.resolve(line)
    }
  }

  const fail = (err: Error): void => {
    failure = err
    while (waiting.length > 0) {
      const next = waiting.shift()
      if (next !== undefined) next.reject(err)
    }
  }

  const attach = (s: Socket): void => {
    s.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      flush()
    })
    s.on('error', (err: Error) => fail(err))
    s.on('close', () => fail(new Error('SMTP connection closed')))
  }
  attach(current)

  return {
    write(line: string): void {
      current.write(line.endsWith(CRLF) ? line : `${line}${CRLF}`)
    },
    readLine(): Promise<string> {
      if (failure !== undefined) return Promise.reject(failure)
      return new Promise<string>((resolve, reject) => {
        waiting.push({ resolve, reject })
        flush()
      })
    },
    upgradeTls(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        current.removeAllListeners('data')
        current.removeAllListeners('error')
        current.removeAllListeners('close')
        const secured = tlsConnect({ socket: current, servername: host })
        secured.once('secureConnect', () => {
          current = secured
          attach(secured)
          resolve()
        })
        secured.once('error', (err: Error) => reject(err))
      })
    },
    close(): void {
      try {
        current.destroy()
      } catch {
        // 已关闭就忽略
      }
    },
  }
}

export class SmtpClient {
  private readonly host: string
  private readonly port: number
  private readonly secure: boolean
  private readonly user: string
  private readonly password: string
  private readonly secrets: readonly string[]
  private readonly from: string
  private readonly timeoutMs: number
  private readonly connect: SmtpConnector
  private readonly clock: () => number

  constructor(opts: SmtpOptions) {
    if (typeof opts?.host !== 'string' || opts.host.length === 0) throw new Error('SmtpClient: host is required')
    if (!isValidSmtpHost(opts.host)) throw new Error('SmtpClient: host must be a host name or IP address')
    if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error('SmtpClient: port must be a positive integer')
    if (typeof opts.from !== 'string' || addressOnly(opts.from).length === 0) throw new Error('SmtpClient: from is required')
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('SmtpClient: timeoutMs must be positive')
    this.host = opts.host
    this.port = opts.port
    this.secure = opts.secure === true
    this.user = opts.user ?? ''
    this.password = opts.password ?? ''
    this.secrets = this.password.length === 0
      ? []
      : this.user.length === 0
        ? [this.password]
        : [this.password, Buffer.from(`\0${this.user}\0${this.password}`, 'utf8').toString('base64')]
    this.from = opts.from
    this.timeoutMs = timeoutMs
    this.connect = opts.connect ?? nodeConnector
    this.clock = opts.clock ?? (() => Date.now())
  }

  /** 走完一次会话；失败抛 Error（含应答码与应答文本，密码已脱敏）。 */
  async send(mail: Mail): Promise<SendResult> {
    const recipients = (Array.isArray(mail.to) ? mail.to : [mail.to])
      .map((to) => addressOnly(to))
      .filter((to) => to.length > 0)
    if (recipients.length === 0) throw new Error('SmtpClient: mail.to has no usable address')

    const messageId = newMessageId(this.from)
    const payload = buildMime({ ...mail, to: recipients }, this.from, { messageId, date: new Date(this.clock()) })

    let connection: SmtpConnection | undefined
    try {
      connection = await this.open()
      await this.expect(connection, [220], 'greeting')
      let caps = await this.ehlo(connection)
      /** 当前通道是否已加密：secure=true 时连上即 TLS，否则只有 STARTTLS 升级成功后才为真。 */
      let encrypted = this.secure

      if (!this.secure && caps.has('STARTTLS')) {
        await this.cmd(connection, 'STARTTLS', [220], { label: 'STARTTLS' })
        if (connection.upgradeTls === undefined) throw new Error('SMTP STARTTLS failed: connection cannot upgrade to TLS')
        await connection.upgradeTls()
        encrypted = true
        caps = await this.ehlo(connection)
      }

      // 没有加密通道就绝不发口令：服务端不宣告 STARTTLS（或中间人剥掉该能力）时直接失败，
      // 而不是把 AUTH PLAIN 的 base64 明文写进 TCP。
      if (this.user.length > 0 && !encrypted) {
        throw new Error('SMTP server does not offer STARTTLS; refusing to send credentials over plaintext')
      }
      if (this.user.length > 0) await this.auth(connection, caps)

      await this.cmd(connection, `MAIL FROM:<${addressOnly(this.from)}>`, [250], { label: 'MAIL FROM' })
      for (const recipient of recipients) {
        await this.cmd(connection, `RCPT TO:<${recipient}>`, [250, 251], { label: 'RCPT TO' })
      }

      await this.cmd(connection, 'DATA', [354], { label: 'DATA' })
      const stuffed = dotStuff(payload)
      connection.write(`${stuffed.endsWith(CRLF) ? stuffed : `${stuffed}${CRLF}`}.${CRLF}`)
      await this.expect(connection, [250], 'message body')

      connection.write('QUIT')
      try {
        await this.expect(connection, [221], 'QUIT', Math.min(this.timeoutMs, 1000))
      } catch {
        // 正文已投递，QUIT 的应答丢了不影响结果
      }
      return { accepted: recipients, messageId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(redactSecret(message, this.secrets))
    } finally {
      if (connection !== undefined) {
        try {
          connection.close()
        } catch {
          // close 失败无所谓
        }
      }
    }
  }

  private async open(): Promise<SmtpConnection> {
    const connection = await this.connect({ host: this.host, port: this.port, secure: this.secure })
    if (typeof connection?.write !== 'function' || typeof connection?.readLine !== 'function') {
      throw new Error('SmtpClient: connect() returned an invalid connection')
    }
    return connection
  }

  /** EHLO 并把应答里的能力（含 AUTH 机制）收成大写 token 集合。 */
  private async ehlo(connection: SmtpConnection): Promise<Set<string>> {
    const reply = await this.cmd(connection, `EHLO ${CLIENT_NAME}`, [250], { label: 'EHLO' })
    const caps = new Set<string>()
    for (const line of reply.lines) {
      for (const token of line.split(/[\s=]+/)) {
        const upper = token.trim().toUpperCase()
        if (upper.length > 0) caps.add(upper)
      }
    }
    return caps
  }

  /** 有 user 时认证：优先 AUTH PLAIN，服务端只给 LOGIN 时走 LOGIN。 */
  private async auth(connection: SmtpConnection, caps: Set<string>): Promise<void> {
    const plain = Buffer.from(`\0${this.user}\0${this.password}`, 'utf8').toString('base64')
    if (caps.has('PLAIN') || !caps.has('LOGIN')) {
      await this.cmd(connection, `AUTH PLAIN ${plain}`, [235], { label: 'AUTH PLAIN', maskAuth: true })
      return
    }
    await this.cmd(connection, 'AUTH LOGIN', [334], { label: 'AUTH LOGIN' })
    const userB64 = Buffer.from(this.user, 'utf8').toString('base64')
    await this.cmd(connection, userB64, [334], { label: 'AUTH LOGIN (user)', maskAuth: true })
    const passwordB64 = Buffer.from(this.password, 'utf8').toString('base64')
    await this.cmd(connection, passwordB64, [235], { label: 'AUTH LOGIN (password)', maskAuth: true })
  }

  /** 发一行命令并校验应答码。 */
  private async cmd(connection: SmtpConnection, line: string, expectCodes: number[], meta: CmdMeta = {}): Promise<Reply> {
    connection.write(line)
    const reply = await this.readReply(connection)
    if (!expectCodes.includes(reply.code)) throw this.failure(meta.label ?? line, reply, meta.maskAuth === true)
    return reply
  }

  /** 只读一条应答并校验应答码。 */
  private async expect(connection: SmtpConnection, expectCodes: number[], label: string, timeoutMs = this.timeoutMs): Promise<Reply> {
    const reply = await this.readReply(connection, timeoutMs)
    if (!expectCodes.includes(reply.code)) throw this.failure(label, reply, false)
    return reply
  }

  /** 解析一条（可多行的）应答：`250-…` 续行，`250 …` 收尾。 */
  private async readReply(connection: SmtpConnection, timeoutMs = this.timeoutMs): Promise<Reply> {
    const lines: string[] = []
    for (;;) {
      const line = await this.readLine(connection, timeoutMs)
      const match = /^(\d{3})([ -])(.*)$/.exec(line)
      if (match === null) {
        throw new Error(`SMTP malformed reply: ${redactSecret(line.slice(0, 200), this.secrets)}`)
      }
      lines.push(match[3] ?? '')
      if (match[2] === ' ') {
        const code = Number(match[1])
        return { code, lines, text: lines.join(' ').trim() }
      }
    }
  }

  /** readLine + 超时；超时后 timer 一定清掉，不留下挂着的句柄。 */
  private async readLine(connection: SmtpConnection, timeoutMs: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`SMTP timeout: no reply within ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      return await Promise.race([Promise.resolve().then(() => connection.readLine()), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 错误消息：命令名 + 应答码 + 应答文本；认证阶段额外屏蔽长 base64。 */
  private failure(label: string, reply: Reply, maskAuth: boolean): Error {
    const text = maskAuth ? reply.text.replace(/[A-Za-z0-9+/=]{16,}/g, '<redacted>') : reply.text
    const message = `SMTP ${label} failed: ${reply.code} ${text}`.trim()
    return new Error(redactSecret(message, this.secrets))
  }
}
