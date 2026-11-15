// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-email/test/smtp.test.ts 的 fakeServer helper，改成 JS 版供插件进程内用。
// 用途：离线冒烟 / 协议一致性套件里替代真实 SMTP 连接（GITRADER_PLUGIN_FAKE_FETCH=1 时启用）。
// 行为：按收到的命令回预设应答，记录命令序列与正文。不发包、不解析地址、不做 TLS。
const CRLF = '\r\n'

/** 假平台给出的消息 id；插件在假连接模式下原样作为 ref 返回。 */
export const FAKE_REF = 'fake-smtp-1'

/** 正常会话的应答表。 */
export function baseReply(command) {
  if (command.startsWith('EHLO')) return ['250-fake greets you', '250-SIZE 1000000', '250 AUTH PLAIN LOGIN']
  if (command.startsWith('AUTH PLAIN ')) return ['235 2.7.0 authentication successful']
  if (command.startsWith('AUTH LOGIN')) return ['334 VXNlcm5hbWU6']
  if (command.startsWith('MAIL FROM:')) return ['250 2.1.0 ok']
  if (command.startsWith('RCPT TO:')) return ['250 2.1.5 ok']
  if (command === 'DATA') return ['354 End data with <CRLF>.<CRLF>']
  if (command === 'END-OF-DATA') return [`250 2.0.0 queued as ${FAKE_REF}`]
  if (command === 'QUIT') return ['221 2.0.0 bye']
  return ['500 5.5.1 unrecognized']
}

/**
 * 造一个脚本化的假连接。
 * `reply(command)` 返回该命令的应答行数组；正文结束用 'END-OF-DATA' 触发。
 */
export function createFakeServer(opts = {}) {
  const reply = opts.reply ?? baseReply
  const log = { commands: [], writes: [], body: '', upgrades: 0, closed: false }
  const queue = [...(opts.greeting ?? ['220 fake ESMTP ready'])]
  const waiters = []

  const flush = () => {
    while (waiters.length > 0 && queue.length > 0) {
      const next = waiters.shift()
      const line = queue.shift()
      if (next !== undefined && line !== undefined) next(line)
    }
  }
  const push = (lines) => {
    for (const line of lines) queue.push(line)
    flush()
  }

  let buffer = ''
  let inData = false

  const connection = {
    write(line) {
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
            push(reply('END-OF-DATA'))
          } else {
            log.body += `${current}${CRLF}`
          }
          continue
        }
        log.commands.push(current)
        if (current === 'DATA') inData = true
        push(reply(current))
      }
    },
    readLine() {
      const next = queue.shift()
      if (next !== undefined) return Promise.resolve(next)
      return new Promise((resolve) => {
        waiters.push(resolve)
      })
    },
    upgradeTls() {
      log.upgrades += 1
      return Promise.resolve()
    },
    close() {
      log.closed = true
    },
  }
  return { connection, log }
}

/** 连接器形态：SmtpClient 的 connect 注入点。 */
export function fakeConnector() {
  return Promise.resolve(createFakeServer().connection)
}
