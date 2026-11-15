// SPDX-License-Identifier: CPAL-1.0
// 通知通道插件 notify-email 的处理函数：renderMail → SmtpClient.send。
// 认证口令只从环境变量 SMTP_PASSWORD 进（内核按清单 secrets 声明注入），不写盘、不打印、不回传；
// 任何返回的 reason 都先过 redactSecret（含其 base64 形态）并压成单行短句。
// 依赖的客户端代码是 packages/notify-email/src/{smtp,mime,render,secret}.ts 的 JS 副本（以库为准）。
import { renderMail } from './render.mjs'
import { redactSecret } from './secret.mjs'
import { SmtpClient, SmtpTimeoutError, isValidSmtpHost, nodeConnector } from './smtp.mjs'

export const TOOL_NAME = 'notify_send'
// B0 契约里工具叫 `notify.send`；协议的工具名不允许点号，清单与 GSP 都只用 `notify_send`（L5-10）。
/** 内核默认 10 s，插件内部网络总预算 ≤ 8 s（B0 契约）：整个 send 共用这一份预算。 */
export const DEFAULT_TIMEOUT_MS = 8000
/** reason 是短句，超出的截断（不截断成半句语义不通时也要保证单行）。 */
const MAX_REASON = 300
const LEVELS = new Set(['info', 'warn', 'critical'])
const DEFAULT_PORT_SECURE = 465
const DEFAULT_PORT_PLAIN = 587

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `params.host` 与 SmtpClient 构造器用同一份主机判定（实现在 smtp.mjs，与库 src/smtp.ts 等价）。 */
export { isValidSmtpHost }

const fail = (reason, retryable = false) => ({ ok: false, reason, retryable })

/** 单行短句：折叠空白、截断。 */
export function clipReason(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_REASON ? flat : `${flat.slice(0, MAX_REASON - 1)}…`
}

/**
 * 4xx（421 / 450 / 451 / 452 …）与网络类错误 → 可重试；5xx（550 / 535 …）→ 不可重试。
 * 只读脱敏后的消息文本，不含任何认证信息。
 */
export function classifyFailure(message) {
  const match = /(?:^|[^\d])(\d{3})(?:[ -])/.exec(message)
  if (match !== null) {
    const code = Number(match[1])
    if (code >= 400 && code < 500) return true
    if (code >= 500 && code < 600) return false
  }
  return /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|connection closed|invalid connection/i.test(message)
}

/**
 * 校验并归一化 `params`（原样来自用户配置 notify.channels[].params）。
 * 返回 { ok: true, value } 或 { ok: false, reason }；reason 不含任何认证信息（这里根本拿不到口令）。
 */
export function resolveParams(params) {
  if (!isPlainObject(params)) return { ok: false, reason: 'params is required' }

  const host = typeof params.host === 'string' ? params.host.trim() : ''
  if (host.length === 0) return { ok: false, reason: 'params.host is required' }
  if (!isValidSmtpHost(host)) return { ok: false, reason: 'params.host must be a valid host name or IP address (no scheme, no path)' }

  const secureGiven = typeof params.secure === 'boolean' ? params.secure : undefined
  const port = params.port ?? (secureGiven === true ? DEFAULT_PORT_SECURE : DEFAULT_PORT_PLAIN)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: 'params.port must be an integer in 1..65535' }
  const secure = secureGiven ?? port === DEFAULT_PORT_SECURE

  const user = typeof params.user === 'string' ? params.user.trim() : ''
  const from = typeof params.from === 'string' ? params.from.trim() : ''
  if (from.length === 0 || !from.includes('@')) return { ok: false, reason: 'params.from must be an email address' }

  const rawTo = typeof params.to === 'string' ? [params.to] : params.to
  if (!Array.isArray(rawTo)) return { ok: false, reason: 'params.to must be an email address or an array of addresses' }
  const to = rawTo.map((t) => (typeof t === 'string' ? t.trim() : '')).filter((t) => t.length > 0)
  if (to.length === 0) return { ok: false, reason: 'params.to must list at least one email address' }
  if (to.length > 50) return { ok: false, reason: 'params.to lists more than 50 recipients' }

  const subjectPrefix = typeof params.subjectPrefix === 'string' ? params.subjectPrefix : ''

  return { ok: true, value: { host, port, secure, user, from, to, subjectPrefix } }
}

/** 从 notice 取标题 / 正文行 / 级别 / 时间；不改写内容，只做字段收敛。 */
function readNotice(notice) {
  if (!isPlainObject(notice)) return { ok: false, reason: 'notice is required' }
  const title = typeof notice.title === 'string' ? notice.title : ''
  if (title.length === 0) return { ok: false, reason: 'notice.title is required' }
  const lines = Array.isArray(notice.lines) ? notice.lines.filter((line) => typeof line === 'string') : []
  const level = LEVELS.has(notice.level) ? notice.level : 'info'
  const ts = typeof notice.ts === 'number' && Number.isFinite(notice.ts) ? notice.ts : undefined
  return { ok: true, value: { title, lines, level, ts } }
}

/**
 * `notify.send` 处理函数。入参 = B0 的 `{ notice, params }`，返回 `{ ok, ref }` 或 `{ ok:false, reason, retryable }`。
 * `deps`：`env`（缺省 process.env）、`password`（测试注入）、`connect`（假连接注入）、
 * `timeoutMs`、`fake`（缺省读 GITRADER_PLUGIN_FAKE_FETCH=1）。
 */
export async function handleNotify(input, deps = {}) {
  const env = deps.env ?? process.env
  const notice = readNotice(isPlainObject(input) ? input.notice : undefined)
  if (!notice.ok) return fail(`notify.send: ${notice.reason}`)
  const params = resolveParams(isPlainObject(input) ? input.params : undefined)
  if (!params.ok) return fail(`notify.send: ${params.reason}`)
  const { host, port, secure, user, from, to, subjectPrefix } = params.value

  const password = typeof deps.password === 'string'
    ? deps.password
    : (typeof env.SMTP_PASSWORD === 'string' ? env.SMTP_PASSWORD : '')
  // 本地 relay 分支：没有口令且没配 user → 不做认证；配了 user 却没口令 → 直接失败，不发半个会话。
  if (password.length === 0 && user.length > 0) {
    return fail('notify.send: SMTP_PASSWORD is not set; authenticated SMTP needs it, or leave params.user empty for an unauthenticated local relay')
  }

  const secrets = []
  if (password.length > 0) {
    secrets.push(password)
    if (user.length > 0) secrets.push(Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64'))
  }

  const fake = deps.fake === undefined ? env.GITRADER_PLUGIN_FAKE_FETCH === '1' : deps.fake === true
  // fake-smtp 是测试桩，打包时排除：只在 fake 模式下动态加载（正式路径不依赖这个文件）。
  const fakeMod = fake ? await import('./fake-smtp.mjs') : null
  const connect = deps.connect ?? (fake ? fakeMod.fakeConnector : nodeConnector)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const rendered = renderMail(notice.value)
  const subject = subjectPrefix.length > 0 ? `${subjectPrefix}${rendered.subject}` : rendered.subject

  let client
  try {
    client = new SmtpClient({ host, port, secure, user, password, from, timeoutMs, connect })
  } catch (err) {
    return fail(`notify.send: ${redactSecret(err instanceof Error ? err.message : String(err), secrets)}`, false)
  }

  try {
    const result = await client.send({ to, subject, text: rendered.text, html: rendered.html })
    return { ok: true, ref: fake ? fakeMod.FAKE_REF : result.messageId }
  } catch (err) {
    // 总预算耗尽（或单次读超时）：连接已由 send 的 finally 关闭，这里只回固定 reason。
    if (err instanceof SmtpTimeoutError) return fail('timeout', true)
    const message = redactSecret(err instanceof Error ? err.message : String(err), secrets)
    return { ok: false, reason: `notify.send: ${clipReason(message)}`, retryable: classifyFailure(message) }
  }
}
