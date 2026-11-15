// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-discord/src/{url,request,response,client}.ts（以库为准）。插件版额外加了：
// 单次调用总超时（B0 契约 ≤8 s）、结构化 retryable 结果、webhook URL 与 token 的脱敏。
// 官方依据（逐处可查）：
//   Execute Webhook（路由 / wait / content ≤2000 / allowed_mentions）：
//     https://discord.com/developers/docs/resources/webhook#execute-webhook
//   Rate Limits（429 的 message / retry_after / global 与 Retry-After 头）：
//     https://discord.com/developers/docs/topics/rate-limits
//   JSON Error Codes（10015 Unknown webhook / 50027 Invalid webhook token / 50035 Invalid form body）：
//     https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes
//   User-Agent 形式：https://discord.com/developers/docs/reference#user-agent
import { MAX_CONTENT, chunkContent } from './format.mjs'

/** 长度上限只有一份（format.mjs），避免两处常量各改各的。 */
export { MAX_CONTENT }

/** B0 契约：插件内部网络超时 ≤ 8 s。 */
export const DEFAULT_TIMEOUT_MS = 8000
export const DEFAULT_MAX_RETRIES = 1
/** 官方 429 可能给出很长的 retry_after；超过这个上限就不等，直接报 retryable。 */
export const DEFAULT_MAX_RETRY_AFTER_MS = 5000
const BACKOFF_MS = 500

/** 官方 Webhook URL 所在主机（API 基址 + canary / ptb 前端域名）。 */
export const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']

const WEBHOOK_PATH = /^\/api\/webhooks\/(\d{5,25})\/([A-Za-z0-9._-]{16,})$/
const COMPAT_ROUTE = /\/(slack|github)\/?$/
const SNOWFLAKE = /^\d{5,25}$/

/** 带 retryable 位的错误；reason 已脱敏。 */
export class DiscordError extends Error {
  constructor(reason, retryable) {
    super(reason)
    this.name = 'DiscordError'
    this.retryable = retryable
  }
}

/** 主机是否在允许清单里（精确匹配，不做后缀放行）。 */
export function isAllowedHost(host) {
  return DISCORD_HOSTS.includes(String(host).trim().toLowerCase())
}

/**
 * 解析并校验 webhook URL：只接受 https + 官方主机 + `/api/webhooks/<id>/<token>`。
 * 不接受时抛 DiscordError（信息里只带问题码，不带 URL 内容）。
 */
export function parseWebhookUrl(raw, apiOrigin) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new DiscordError('webhook URL 为空', false)
  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new DiscordError('webhook URL 不是合法 URL', false)
  }
  // GQ-54：给了 apiOrigin（已由 index 校验）就只取环境变量 URL 的路径，origin 换成它，跳过官方主机检查。
  if (apiOrigin === undefined && parsed.protocol !== 'https:') throw new DiscordError('webhook URL 必须是 https（insecure_scheme）', false)
  if (apiOrigin === undefined && !isAllowedHost(parsed.hostname)) throw new DiscordError('webhook URL 主机不在允许清单里（host_not_allowed）', false)
  if (COMPAT_ROUTE.test(parsed.pathname)) throw new DiscordError('不支持 /slack 与 /github 兼容路由（unsupported_route）', false)
  if (parsed.search !== '') throw new DiscordError('webhook URL 不应带查询串（query_not_allowed）', false)
  const match = WEBHOOK_PATH.exec(parsed.pathname)
  if (match === null) throw new DiscordError('webhook URL 路径应形如 /api/webhooks/<id>/<token>（bad_path）', false)
  return { id: match[1], token: match[2], url: `${apiOrigin ?? `https://${parsed.hostname.toLowerCase()}`}/api/webhooks/${match[1]}/${match[2]}` }
}

/** 对外展示用的短形式：保留 id，token 换成 <redacted>。 */
export function redactWebhookUrl(raw) {
  try {
    const parsed = new URL(String(raw).trim())
    const match = /^\/api\/webhooks\/(\d{5,25})\/.*$/.exec(parsed.pathname)
    if (match !== null) return `https://${parsed.hostname.toLowerCase()}/api/webhooks/${match[1]}/<redacted>`
    return `https://${parsed.hostname.toLowerCase()}/<redacted>`
  } catch {
    return '<invalid webhook url>'
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/gi

/** 把文本里的 webhook URL 换成脱敏形式。 */
export function scrubWebhookUrls(text) {
  return text.replace(URL_IN_TEXT, (match) => {
    const trimmed = match.replace(/[).,;:!?]+$/, '')
    const suffix = match.slice(trimmed.length)
    if (/\/webhooks\//.test(trimmed)) return `${redactWebhookUrl(trimmed)}${suffix}`
    return match
  })
}

/** 抹掉给定密钥、压成一行、截断。密钥不进 reason / 日志。 */
export function redactSecrets(text, secrets = [], maxLength = 300) {
  let out = text === undefined || text === null ? '' : String(text)
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length)
  for (const secret of list) out = out.split(secret).join('<redacted>')
  out = scrubWebhookUrls(out)
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}

/** body：content + allowed_mentions.parse=[]（谁都不 @），可选 username。 */
export function buildMessageBody(content, options = {}) {
  if (typeof content !== 'string' || content.trim() === '') throw new RangeError('content must be a non-empty string')
  if (content.length > MAX_CONTENT) throw new RangeError(`content exceeds ${MAX_CONTENT} characters`)
  const body = { content, allowed_mentions: { parse: [] } }
  if (typeof options.username === 'string' && options.username.trim() !== '') body.username = options.username.trim()
  return body
}

/** 构造 execute 请求：wait=true（拿 message id 当 ref），可选 thread_id。 */
export function buildExecuteRequest(target, content, options = {}) {
  const webhook = typeof target === 'string' ? parseWebhookUrl(target) : target
  const body = buildMessageBody(content, options)
  const url = new URL(webhook.url)
  url.searchParams.set('wait', 'true')
  if (options.threadId !== undefined) {
    if (!SNOWFLAKE.test(options.threadId)) throw new RangeError('threadId must be a snowflake string')
    url.searchParams.set('thread_id', options.threadId)
  }
  return {
    url: url.toString(),
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'user-agent': 'DiscordBot (local/plugin-notify-discord, 0.1.0)',
    },
  }
}

function headerOf(bag, name) {
  if (bag === undefined || bag === null) return undefined
  if (typeof bag.get === 'function') return bag.get(name) ?? undefined
  for (const key of Object.keys(bag)) if (key.toLowerCase() === name.toLowerCase()) return bag[key]
  return undefined
}

function secondsToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 1000)
}

/** 判定一次 execute 响应（成功 / 429 / 5xx / 4xx）。 */
export function classifyResponse(status, bodyText, headers) {
  const raw = typeof bodyText === 'string' ? bodyText : ''
  const trimmed = raw.trim()
  let parsed
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      parsed = undefined
    }
  }
  const obj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  const plain = obj === undefined && trimmed !== '' && !trimmed.startsWith('{') && !trimmed.startsWith('[')
  const message = typeof obj?.message === 'string' ? obj.message.replace(/\s+/g, ' ').trim().slice(0, 200) : plain ? trimmed.replace(/\s+/g, ' ').slice(0, 200) : ''
  const code = typeof obj?.code === 'number' ? obj.code : undefined

  if (status >= 200 && status < 300) {
    if (status === 204 || status === 205 || trimmed === '') return { ok: true, retryable: false }
    if (typeof obj?.id === 'string' && obj.id !== '') return { ok: true, ref: obj.id, retryable: false }
    if (typeof obj?.id === 'number' && Number.isFinite(obj.id)) return { ok: true, ref: String(obj.id), retryable: false }
    return { ok: true, retryable: false }
  }

  if (status === 429) {
    const fromBody = secondsToMs(obj?.retry_after)
    const fromHeader = secondsToMs(headerOf(headers, 'retry-after') === undefined ? undefined : Number(headerOf(headers, 'retry-after')))
    const retryAfterMs = fromBody ?? fromHeader
    const global = obj?.global === true
    const out = { ok: false, retryable: true, reason: `rate_limited${global ? ':global' : ''}${retryAfterMs === undefined ? '' : `:retry_after_ms=${retryAfterMs}`}` }
    if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs
    if (global) out.global = true
    return out
  }

  const detail = message === '' ? '' : `:${message}`
  const codePart = code === undefined ? '' : `:code=${code}`
  return { ok: false, retryable: status >= 500, reason: `http_${status}${codePart}${detail}` }
}

/**
 * 一个 webhook 一个实例；`sendContent` / `sendText` 不抛异常，全部折算成
 * `{ ok, ref }` 或 `{ ok:false, reason, retryable }`（reason 已脱敏）。
 */
export class DiscordWebhookClient {
  #target

  constructor(options) {
    this.#target = parseWebhookUrl(options.url, options.apiOrigin)
    this.idempotencyKey = options.idempotencyKey
    this.idemSeq = 0
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.clock = options.clock ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS
  }

  get webhookId() {
    return this.#target.id
  }

  async sendContent(content, options = {}) {
    if (typeof content !== 'string' || content.trim() === '') return this.fail('content 为空：没有可发送的文本', false)
    if (content.length > MAX_CONTENT) return this.fail(`content 超过 ${MAX_CONTENT} 字符上限`, false)
    let request
    try {
      request = buildExecuteRequest(this.#target, content, options)
    } catch (error) {
      return this.fail(error && error.message ? error.message : '请求构造失败', false)
    }

    // GQ-52：多块消息每块一个后缀，重试同一块用同一个键
    const idem = this.idempotencyKey ? (this.idemSeq++ ? `${this.idempotencyKey}:${this.idemSeq - 1}` : this.idempotencyKey) : undefined
    const startedAt = this.clock()
    let attempt = 0
    for (;;) {
      const remaining = this.timeoutMs - (this.clock() - startedAt)
      if (remaining <= 0) return this.fail('execute 超时：预算用尽', true)

      let status
      let headers
      let text
      try {
        const response = await this.fetchImpl(request.url, {
          method: 'POST',
          headers: idem ? { ...request.headers, 'idempotency-key': idem } : request.headers,
          body: request.body,
          signal: AbortSignal.timeout(remaining),
        })
        status = response.status
        headers = response.headers
        try {
          text = await response.text()
        } catch {
          text = ''
        }
      } catch (error) {
        const name = error && error.name
        if (name === 'TimeoutError' || name === 'AbortError') return this.fail('execute 超时：网络请求未在预算内返回', true)
        return this.fail(`network error: ${error && error.message ? error.message : 'fetch failed'}`, true)
      }

      const verdict = classifyResponse(status, text, headers)
      if (verdict.ok) return verdict.ref === undefined ? { ok: true } : { ok: true, ref: verdict.ref }
      if (!verdict.retryable || attempt >= this.maxRetries) return this.fail(verdict.reason ?? `http_${status}`, verdict.retryable)

      const waitMs = verdict.retryAfterMs ?? BACKOFF_MS
      if (waitMs > this.maxRetryAfterMs) return this.fail(`${verdict.reason ?? 'retryable failure'}:retry_after 超出 ${this.maxRetryAfterMs} ms 上限，不等待`, true)
      if (this.clock() - startedAt + waitMs >= this.timeoutMs) return this.fail(`${verdict.reason ?? 'retryable failure'}:重试预算不足，不再重试`, true)
      attempt += 1
      await this.sleep(waitMs)
    }
  }

  /** 长文本按 2000 字符分块顺序发送；任何一块失败即停止，ref 取第一条。 */
  async sendText(text, options = {}) {
    let parts
    try {
      parts = chunkContent(text, MAX_CONTENT)
    } catch (error) {
      return this.fail(error && error.message ? error.message : '分块失败', false)
    }
    if (parts.length === 0) return this.fail('content 为空：没有可发送的文本', false)
    let ref
    for (const part of parts) {
      const result = await this.sendContent(part, options)
      if (!result.ok) return result
      if (ref === undefined && result.ref !== undefined) ref = result.ref
    }
    return ref === undefined ? { ok: true } : { ok: true, ref }
  }

  fail(reason, retryable) {
    return { ok: false, reason: redactSecrets(reason, [this.#target.token, this.#target.url]), retryable }
  }
}
