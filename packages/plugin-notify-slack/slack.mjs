// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-slack/src/slack.ts（以库为准）。插件版保留同一套 URL 校验 / 单条发送 / 429 重试 /
// 8 s 超时 / retryable 位 / webhook URL 脱敏；不 import 工作区包（内核以子进程拉起，cwd = 插件目录）。
// 官方依据：POST webhook + {"text":...}，成功回 "ok"；429 带 Retry-After（秒）；正文转义 & < >。
import { MAX_TEXT } from './format.mjs'

/** B0 契约：插件内部网络超时 ≤ 8 s。 */
export const DEFAULT_TIMEOUT_MS = 8000
/** 只允许发到 Slack 的 webhook 主机。 */
export const DEFAULT_ALLOWED_HOSTS = ['hooks.slack.com']
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const REDACTED = '<redacted>'

/** 带 retryable 位的通道错误；reason 已脱敏。 */
export class SlackError extends Error {
  constructor(reason, retryable) {
    super(reason)
    this.name = 'SlackError'
    this.retryable = retryable
  }
}

/**
 * 校验 webhook URL：非空、合法、https（回环 + 显式放开时允许 http）、主机在清单内、
 * 路径以 /services/ 开头、不带查询串 / 锚点。不满足抛 SlackError(retryable=false)。
 */
export function assertSlackWebhookUrl(raw, policy = {}) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') throw new SlackError('webhook URL 为空：没有可发送的目标', false)

  let url
  try {
    url = new URL(value)
  } catch {
    throw new SlackError('webhook URL 不是合法 URL', false)
  }

  const host = url.hostname.toLowerCase()
  const loopback = LOOPBACK_HOSTS.has(host)
  if (url.protocol !== 'https:') {
    const insecureLoopback = url.protocol === 'http:' && loopback && policy.allowInsecureLoopback === true
    if (!insecureLoopback) throw new SlackError(`webhook URL 必须是 https（收到 ${url.protocol}）`, false)
  }

  const allowed = (policy.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((item) => item.toLowerCase())
  if (!allowed.includes(host)) throw new SlackError(`webhook URL 主机不在允许清单内：${host}`, false)
  if (!url.pathname.startsWith('/services/')) throw new SlackError('webhook URL 路径必须以 /services/ 开头', false)
  if (url.search !== '' || url.hash !== '') throw new SlackError('webhook URL 不应带查询串或锚点', false)
  return url.toString()
}

/** webhook URL 里是秘密的部分：整串、path、`/services/` 之后的各段（T/B/X）。 */
function urlVariants(url) {
  const out = new Set()
  if (url) out.add(url)
  try {
    const parsed = new URL(url)
    out.add(parsed.pathname)
    for (const segment of parsed.pathname.split('/').filter(Boolean).slice(1)) {
      if (segment.length >= 4) out.add(segment)
    }
  } catch {
    // 不是合法 URL：只脱敏整串
  }
  return [...out].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)
}

/** 把 webhook URL / path / 路径段替换成 `<redacted>`，压成一行短句（≤200 字符）。 */
export function redactWebhookUrl(text, url, maxLength = 200) {
  let out = String(text === undefined || text === null ? '' : text)
  for (const variant of urlVariants(url)) out = out.split(variant).join(REDACTED)
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}

/** 429 限流、408 网关超时、5xx 服务端错误可重试。 */
export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

/**
 * 校验 webhook 响应：非 2xx → `http_<status>[:摘要]`（429/408/5xx 可重试）；
 * 2xx → 纯文本 `ok` 成功；JSON `{ok:false}` 失败（`slack_error:<error>`，不重试）；其余 JSON 对象成功；
 * 其它 body → `slack_unexpected:<摘要>`。
 */
export function parseSlackResponse(status, body, webhookUrl = '') {
  const raw = String(body === undefined || body === null ? '' : body)
  const snippet = redactWebhookUrl(raw, webhookUrl)
  if (!(status >= 200 && status < 300)) {
    return { ok: false, reason: snippet ? `http_${status}:${snippet}` : `http_${status}`, retryable: isRetryableStatus(status) }
  }
  const trimmed = raw.trim()
  if (trimmed.toLowerCase() === 'ok') return { ok: true }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && parsed.ok === false) {
        const error = typeof parsed.error === 'string' && parsed.error ? parsed.error : 'unknown'
        return { ok: false, reason: `slack_error:${error}`, retryable: false }
      }
      return { ok: true }
    } catch {
      // 落到下面按意外响应处理
    }
  }
  return { ok: false, reason: snippet ? `slack_unexpected:${snippet}` : 'slack_unexpected', retryable: false }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `Retry-After`（秒）→ 毫秒；缺失或不是非负数字返回 undefined。 */
function retryAfterMs(res) {
  const header = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null
  if (header === null || header === undefined || String(header).trim() === '') return undefined
  const seconds = Number(String(header).trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.round(seconds * 1000)
}

export class SlackClient {
  #webhookUrl

  constructor(opts) {
    this.#webhookUrl = assertSlackWebhookUrl(opts.webhookUrl, {
      allowedHosts: opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
      allowInsecureLoopback: opts.allowInsecureLoopback === true,
    })
    this.idempotencyKey = opts.idempotencyKey
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.clock = opts.clock ?? (() => Date.now())
    this.sleepImpl = opts.sleepImpl ?? sleep
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? 2
    this.minIntervalMs = opts.minIntervalMs ?? 1000
    this.lastSendAt = undefined
  }

  /** 一条消息一次 POST；空文本或超上限直接抛错（不拆分、不截断）。 */
  async send(text) {
    if (typeof text !== 'string' || text.length === 0) throw new SlackError('消息文本为空，未发送', false)
    if (text.length > MAX_TEXT) throw new SlackError(`消息文本超过 Slack 上限：${text.length} > ${MAX_TEXT} 字符（不拆分发送）`, false)
    await this.waitForSlot()
    this.lastSendAt = this.clock()
    await this.post(text)
  }

  async waitForSlot() {
    if (this.lastSendAt === undefined) return
    const waitMs = this.minIntervalMs - (this.clock() - this.lastSendAt)
    if (waitMs > 0) await this.sleepImpl(waitMs)
  }

  async post(text) {
    const body = JSON.stringify({ text })
    const startedAt = this.clock()
    let attempt = 0
    for (;;) {
      const remaining = this.timeoutMs - (this.clock() - startedAt)
      if (remaining <= 0) throw new SlackError('Slack webhook timed out', true)

      let status = 0
      let raw = ''
      let retryAfter
      try {
        const res = await this.fetchImpl(this.#webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.idempotencyKey ? { 'idempotency-key': this.idempotencyKey } : {}) },
          body,
          signal: AbortSignal.timeout(remaining),
        })
        status = res.status
        raw = await res.text()
        retryAfter = retryAfterMs(res)
      } catch (e) {
        const name = e !== null && typeof e === 'object' ? e.name : undefined
        if (name === 'TimeoutError' || name === 'AbortError') throw new SlackError('Slack webhook timed out', true)
        const message = e instanceof Error && e.message ? e.message : 'fetch failed'
        throw new SlackError(redactWebhookUrl(`Slack webhook network error: ${message}`, this.#webhookUrl), true)
      }

      const verdict = parseSlackResponse(status, raw, this.#webhookUrl)
      if (verdict.ok) return

      const reason = redactWebhookUrl(verdict.reason ?? 'Slack webhook failed', this.#webhookUrl)
      const retryable = verdict.retryable === true
      if (retryable && attempt < this.maxRetries) {
        const waitMs = retryAfter ?? Math.min(2000, 500 * 2 ** attempt)
        attempt += 1
        if (this.clock() - startedAt + waitMs >= this.timeoutMs) {
          throw new SlackError(`${reason}（重试会超出 ${this.timeoutMs} ms 预算）`, true)
        }
        await this.sleepImpl(waitMs)
        continue
      }
      throw new SlackError(reason, retryable)
    }
  }
}
