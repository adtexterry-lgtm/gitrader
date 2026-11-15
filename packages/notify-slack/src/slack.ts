// SPDX-License-Identifier: CPAL-1.0
// Slack Incoming Webhook 发送客户端：webhook URL 由调用方传入（URL 本身即凭据），注入 fetch / clock /
// sleep / 超时；一次 send 只发一条消息（不分块），429 按 Retry-After 重试，错误原因统一脱敏。
//
// 官方依据：
//   - POST {webhook url}，body `{ "text": "..." }`，成功 200 + 纯文本 `ok`：
//     https://api.slack.com/messaging/webhooks
//   - 403/404/410/400 是配置或权限类错误；限流回 429 并带 `Retry-After`（秒）：
//     https://api.slack.com/apis/rate-limits
//   - 同一频道每秒 1 条（突发允许），故保留同一 URL 的最小发送间隔：
//     https://api.slack.com/apis/rate-limits#rate_limits
//   - 正文转义规则见 ./format.ts 文件头。
import { MAX_TEXT } from './format'

/** B0 契约：插件内部网络超时 ≤ 8 s（单次调用含重试共用一份预算）。 */
export const DEFAULT_TIMEOUT_MS = 8000
/** 只允许发到 Slack 的 webhook 主机；测试 / 自建代理可显式换清单。 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['hooks.slack.com']
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const REDACTED = '<redacted>'

/** 带 retryable 位的通道错误；reason 已脱敏，不含 webhook URL 及其路径段。 */
export class SlackError extends Error {
  readonly retryable: boolean

  constructor(reason: string, retryable: boolean) {
    super(reason)
    this.name = 'SlackError'
    this.retryable = retryable
  }
}

export interface WebhookUrlPolicy {
  /** 允许的主机名（小写精确匹配），缺省 `['hooks.slack.com']`。 */
  allowedHosts?: readonly string[]
  /** 仅供测试：允许 http + 回环主机。缺省 false，生产路径永远要求 https。 */
  allowInsecureLoopback?: boolean
}

/**
 * 校验并规范化 webhook URL：非空、合法 URL、https（回环 + 显式放开时可为 http）、
 * 主机在允许清单内、路径以 `/services/` 开头、不带查询串或锚点。
 * 任何一条不满足都抛 SlackError（retryable=false）：配置错误重试没有意义。
 */
export function assertSlackWebhookUrl(raw: unknown, policy: WebhookUrlPolicy = {}): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') throw new SlackError('webhook URL 为空：没有可发送的目标', false)

  let url: URL
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

/** webhook URL 里真正是秘密的部分：整串、path、`/services/` 之后的各段（T/B/X）。 */
function urlVariants(url: string): string[] {
  const out = new Set<string>()
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

/** 把 webhook URL / path / 路径段替换成 `<redacted>`，压成一行短句。所有日志与错误消息都要过它。 */
export function redactWebhookUrl(text: string, url: string, maxLength = 200): string {
  let out = String(text === undefined || text === null ? '' : text)
  for (const variant of urlVariants(url)) out = out.split(variant).join(REDACTED)
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}

export interface SlackVerdict {
  ok: boolean
  reason?: string
  retryable?: boolean
}

/** 该 HTTP 状态码是否值得重试：429 限流、408 网关超时、5xx 服务端错误。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/**
 * 校验一次 webhook 响应。
 * - 非 2xx：`http_<status>`（有 body 摘要时附在冒号后），429 / 408 / 5xx 标 retryable。
 * - 2xx：纯文本 `ok` 算成功；JSON 对象里 `ok:false` 判失败（厂商业务错误，不重试），其余 JSON 对象算成功
 *   （与 packages/notify-webhook 的 slack 方言同一口径）；其它 body 判 `slack_unexpected`。
 */
export function parseSlackResponse(status: number, body: string, webhookUrl = ''): SlackVerdict {
  const raw = String(body === undefined || body === null ? '' : body)
  const snippet = redactWebhookUrl(raw, webhookUrl)
  if (!(status >= 200 && status < 300)) {
    return { ok: false, reason: snippet ? `http_${status}:${snippet}` : `http_${status}`, retryable: isRetryableStatus(status) }
  }
  const trimmed = raw.trim()
  if (trimmed.toLowerCase() === 'ok') return { ok: true }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { ok?: unknown; error?: unknown }
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

export interface SlackClientOptions {
  webhookUrl: string
  fetchImpl?: typeof fetch
  clock?: () => number
  sleepImpl?: (ms: number) => Promise<void>
  timeoutMs?: number
  /** 429 后的最大重试次数，缺省 2。 */
  maxRetries?: number
  /** 同一 webhook 两次发送的最小间隔（毫秒），缺省 1000（Slack 每频道每秒 1 条）。 */
  minIntervalMs?: number
  allowedHosts?: readonly string[]
  allowInsecureLoopback?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `Retry-After` 头（秒）→ 毫秒；缺失或不是非负数字时返回 undefined。 */
function retryAfterMs(res: { headers?: { get?: (name: string) => string | null } }): number | undefined {
  const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null
  if (header === null || header === undefined || String(header).trim() === '') return undefined
  const seconds = Number(String(header).trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.round(seconds * 1000)
}

export class SlackClient {
  #webhookUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly minIntervalMs: number
  private lastSendAt: number | undefined

  constructor(opts: SlackClientOptions) {
    this.#webhookUrl = assertSlackWebhookUrl(opts.webhookUrl, {
      ...(opts.allowedHosts === undefined ? {} : { allowedHosts: opts.allowedHosts }),
      allowInsecureLoopback: opts.allowInsecureLoopback === true,
    })
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.clock = opts.clock ?? (() => Date.now())
    this.sleepImpl = opts.sleepImpl ?? sleep
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? 2
    this.minIntervalMs = opts.minIntervalMs ?? 1000
  }

  /**
   * 发一条消息：一次 POST。文本为空或超过 Slack 上限时直接抛错（不发请求、不拆分、不截断），
   * 保证「同一接管只发一条」。成功返回 void——webhook 响应里没有消息 id。
   */
  async send(text: string): Promise<void> {
    if (typeof text !== 'string' || text.length === 0) throw new SlackError('消息文本为空，未发送', false)
    if (text.length > MAX_TEXT) {
      throw new SlackError(`消息文本超过 Slack 上限：${text.length} > ${MAX_TEXT} 字符（不拆分发送）`, false)
    }
    await this.waitForSlot()
    this.lastSendAt = this.clock()
    await this.post(text)
  }

  /** 同一 webhook 两次发送之间至少间隔 minIntervalMs。 */
  private async waitForSlot(): Promise<void> {
    if (this.lastSendAt === undefined) return
    const waitMs = this.minIntervalMs - (this.clock() - this.lastSendAt)
    if (waitMs > 0) await this.sleepImpl(waitMs)
  }

  private async post(text: string): Promise<void> {
    const body = JSON.stringify({ text })
    const startedAt = this.clock()
    let attempt = 0
    for (;;) {
      const remaining = this.timeoutMs - (this.clock() - startedAt)
      if (remaining <= 0) throw new SlackError('Slack webhook timed out', true)

      let status = 0
      let raw = ''
      let retryAfter: number | undefined
      try {
        const res = await this.fetchImpl(this.#webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(remaining),
        })
        status = res.status
        raw = await res.text()
        retryAfter = retryAfterMs(res)
      } catch (e) {
        const name = e !== null && typeof e === 'object' ? (e as { name?: unknown }).name : undefined
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
