// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-email/src/smtp.ts（以该库为准）；JS 版，插件内单文件，不 import 工作区包。
// SMTP 发送客户端：一次完整会话（EHLO → STARTTLS → AUTH → MAIL/RCPT → DATA → QUIT）。
// 连接由调用方注入（缺省用 node:net / node:tls），认证口令只从构造参数进，
// 错误消息统一经 redactSecret，且从不回显认证命令原文。
// 超时：一次 send 用一份总预算（= timeoutMs，插件传 8 s），每次读等待都只拿剩余额度，
// 预算耗尽即抛 SmtpTimeoutError 并由调用方 close()，不会按「每步 timeoutMs」累加成多倍时长。
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { addressOnly, buildMime, dotStuff, newMessageId } from './mime.mjs'
import { redactSecret } from './secret.mjs'

const CRLF = '\r\n'
const DEFAULT_TIMEOUT_MS = 15000
/** IPv4 点分十进制（每段 0–255，不允许多余前导零）。 */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
/** 方括号包裹的 IPv6 字面量（URL / Node 的写法）。 */
const IPV6_RE = /^\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\]$/
/** 单个 DNS 标签：字母数字开头结尾，中间可带连字符，最长 63。 */
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/**
 * 主机只接受域名或 IP 字面量（L5-04，与库 packages/notify-email/src/smtp.ts 等价）：挡掉 scheme、路径、
 * 空白、`host:port` 写法与畸形标签。`params.host` 入口与本构造器用同一份判定。
 */
export function isValidSmtpHost(host) {
  if (typeof host !== 'string') return false
  if (host !== host.trim()) return false
  if (host.length === 0 || host.length > 253) return false
  if (IPV4_RE.test(host) || IPV6_RE.test(host)) return true
  const labels = host.split('.')
  // 四段全数字的写法按 IPv4 严格解析：999.1.1.1 这类「看着像 IP」的串不接受。
  if (labels.length === 4 && labels.every((label) => /^\d+$/.test(label))) return false
  return labels.every((label) => LABEL_RE.test(label))
}

/** 单次读超时或总预算耗尽都抛这个；调用方据此返回 retryable 的 timeout。 */
export class SmtpTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SmtpTimeoutError'
  }
}
/** EHLO 时报的客户端名（不回显本机名 / 地址）。 */
const CLIENT_NAME = 'localhost'

/** 缺省连接：secure 走 tls，否则 net（STARTTLS 时由 upgradeTls 就地升级）。 */
export function nodeConnector(params) {
  return new Promise((resolve, reject) => {
    const socket = params.secure
      ? tlsConnect({ host: params.host, port: params.port, servername: params.host })
      : netConnect({ host: params.host, port: params.port })
    const readyEvent = params.secure ? 'secureConnect' : 'connect'
    const onError = (err) => reject(err)
    socket.once('error', onError)
    socket.once(readyEvent, () => {
      socket.removeListener('error', onError)
      resolve(socketConnection(socket, params.host))
    })
  })
}

/** 把 socket 包成按行读写的连接对象。 */
function socketConnection(initial, host) {
  let current = initial
  let buffer = ''
  let failure
  const waiting = []

  const flush = () => {
    while (waiting.length > 0) {
      const idx = buffer.indexOf('\n')
      if (idx < 0) return
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      const next = waiting.shift()
      if (next !== undefined) next.resolve(line)
    }
  }

  const fail = (err) => {
    failure = err
    while (waiting.length > 0) {
      const next = waiting.shift()
      if (next !== undefined) next.reject(err)
    }
  }

  const attach = (s) => {
    s.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      flush()
    })
    s.on('error', (err) => fail(err))
    s.on('close', () => fail(new Error('SMTP connection closed')))
  }
  attach(current)

  return {
    write(line) {
      current.write(line.endsWith(CRLF) ? line : `${line}${CRLF}`)
    },
    readLine() {
      if (failure !== undefined) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject })
        flush()
      })
    },
    upgradeTls() {
      return new Promise((resolve, reject) => {
        current.removeAllListeners('data')
        current.removeAllListeners('error')
        current.removeAllListeners('close')
        const secured = tlsConnect({ socket: current, servername: host })
        secured.once('secureConnect', () => {
          current = secured
          attach(secured)
          resolve()
        })
        secured.once('error', (err) => reject(err))
      })
    },
    close() {
      try {
        current.destroy()
      } catch {
        // 已关闭就忽略
      }
    },
  }
}

export class SmtpClient {
  constructor(opts) {
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
    /** 本次 send 的总预算截止点；send() 开头重算，未开始时（Infinity）退化成单次读超时。 */
    this.deadline = Number.POSITIVE_INFINITY
  }

  /** 走完一次会话；失败抛 Error（含应答码与应答文本，口令已脱敏）。 */
  async send(mail) {
    this.deadline = this.clock() + this.timeoutMs
    const recipients = (Array.isArray(mail.to) ? mail.to : [mail.to])
      .map((to) => addressOnly(to))
      .filter((to) => to.length > 0)
    if (recipients.length === 0) throw new Error('SmtpClient: mail.to has no usable address')

    const messageId = newMessageId(this.from)
    const payload = buildMime({ ...mail, to: recipients }, this.from, { messageId, date: new Date(this.clock()) })

    let connection
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
      // 而不是把 AUTH PLAIN 的 base64 明文写进 TCP 让被动/主动攻击者截获。
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
      const redacted = redactSecret(message, this.secrets)
      // 超时保留类型（调用方据此返回固定 reason）；其余错误包成脱敏后的 Error。
      if (err instanceof SmtpTimeoutError) throw new SmtpTimeoutError(redacted)
      throw new Error(redacted)
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

  async open() {
    const connection = await this.connect({ host: this.host, port: this.port, secure: this.secure })
    if (typeof connection?.write !== 'function' || typeof connection?.readLine !== 'function') {
      throw new Error('SmtpClient: connect() returned an invalid connection')
    }
    return connection
  }

  /** EHLO 并把应答里的能力（含 AUTH 机制）收成大写 token 集合。 */
  async ehlo(connection) {
    const reply = await this.cmd(connection, `EHLO ${CLIENT_NAME}`, [250], { label: 'EHLO' })
    const caps = new Set()
    for (const line of reply.lines) {
      for (const token of line.split(/[\s=]+/)) {
        const upper = token.trim().toUpperCase()
        if (upper.length > 0) caps.add(upper)
      }
    }
    return caps
  }

  /** 有 user 时认证：优先 AUTH PLAIN，服务端只给 LOGIN 时走 LOGIN。 */
  async auth(connection, caps) {
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
  async cmd(connection, line, expectCodes, meta = {}) {
    connection.write(line)
    const reply = await this.readReply(connection)
    if (!expectCodes.includes(reply.code)) throw this.failure(meta.label ?? line, reply, meta.maskAuth === true)
    return reply
  }

  /** 只读一条应答并校验应答码。 */
  async expect(connection, expectCodes, label, timeoutMs = this.timeoutMs) {
    const reply = await this.readReply(connection, timeoutMs)
    if (!expectCodes.includes(reply.code)) throw this.failure(label, reply, false)
    return reply
  }

  /** 解析一条（可多行的）应答：`250-…` 续行，`250 …` 收尾。 */
  async readReply(connection, timeoutMs = this.timeoutMs) {
    const lines = []
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

  /** 本次 send 剩余的总预算（毫秒）；≤ 0 表示已耗尽。 */
  budgetLeft() {
    return this.deadline - this.clock()
  }

  /**
   * readLine + 超时；单次等待上限 = min(timeoutMs, 总预算剩余)。
   * 超时后 timer 一定清掉，不留下挂着的句柄。
   */
  async readLine(connection, timeoutMs) {
    const waitMs = Math.floor(Math.min(timeoutMs, this.budgetLeft()))
    if (waitMs <= 0) throw this.timeoutError(0)
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(this.timeoutError(waitMs)), waitMs)
    })
    try {
      return await Promise.race([Promise.resolve().then(() => connection.readLine()), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 超时错误：只含等待时长与本次 send 的总预算，不含任何连接信息。 */
  timeoutError(waitedMs) {
    return new SmtpTimeoutError(`SMTP timeout: no reply within ${waitedMs}ms (send budget ${this.timeoutMs}ms)`)
  }

  /** 错误消息：命令名 + 应答码 + 应答文本；认证阶段额外屏蔽长 base64。 */
  failure(label, reply, maskAuth) {
    const text = maskAuth ? reply.text.replace(/[A-Za-z0-9+/=]{16,}/g, '<redacted>') : reply.text
    const message = `SMTP ${label} failed: ${reply.code} ${text}`.trim()
    return new Error(redactSecret(message, this.secrets))
  }
}
