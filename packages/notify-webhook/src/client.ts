// SPDX-License-Identifier: CPAL-1.0
// Webhook 客户端：方言识别 → 构造请求 → 带超时的 POST → 厂商响应校验 → 按退避重试。
// 网络、时钟、等待都可注入，测试全程离线。密钥只从构造参数进，任何对外原因串都过 redactSecret。
import { detectWebhookDialect } from './dialect'
import type { WebhookDialect } from './dialect'
import { buildWebhookRequest } from './request'
import type { WebhookRequest } from './request'
import { validateWebhookResponse } from './response'
import { redactSecret } from './secret'

/** 单次网络调用的缺省超时：内核给插件的预算 10 s，这里 4 s × 最多 1 次重试仍在预算内。 */
const DEFAULT_TIMEOUT_MS = 4000
/** 缺省重试次数：一次失败后再试一次就收手，避免把内核的调用槽占满。 */
const DEFAULT_MAX_RETRIES = 1
const DEFAULT_BACKOFF_BASE_MS = 500
const DEFAULT_MAX_BACKOFF_MS = 2000
const REASON_LIMIT = 300

export interface WebhookClientOptions {
  url: string
  /** 签名密钥；只参与签名，不打印、不回传。 */
  secret?: string
  /** fetch 注入点；缺省用全局 fetch。测试传假实现。 */
  fetch?: typeof fetch
  /** 单次请求超时（毫秒），超时按 retryable 处理。 */
  timeoutMs?: number
  /** 首次失败后的重试次数上限（不含首次）。 */
  maxRetries?: number
  /** 毫秒时钟注入点：给签名时间戳用，测试可固定。 */
  clock?: () => number
  /** 退避等待注入点（默认 setTimeout）。测试传立即返回的实现，不真等。 */
  sleep?: (ms: number) => Promise<void>
  /** 指数退避的基数与上限（毫秒）。 */
  backoffBaseMs?: number
  maxBackoffMs?: number
  /** 强制方言；缺省按 URL 自动识别。 */
  dialect?: WebhookDialect
}

export interface WebhookSendOptions {
  title?: string
  markdown?: boolean
}

/**
 * 本机回环主机（照 plugin-notify-slack 的 LOOPBACK_HOSTS 口径）：明文 http 只放行发往这些字面主机。
 * 不做 DNS 解析，`localhost` 也不展开——只认 URL 里写的那串字面值。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 出网目标分类：https，以及「明文 http 发往字面回环主机」（loopback，本地教程与自测端点走这条）。
 * 其余明文 http 一律拒（L5-02）——正文、签名密钥都会躺在链路上，钉钉方言的签名还会拼进 query。
 * 主机白名单口径待 维护者 定，这里只区分 https / 字面回环 / 其余明文。
 */
export function webhookUrlKind(value: string): 'https' | 'loopback' | 'insecure' | 'invalid' {
  if (typeof value !== 'string' || value.trim() === '') return 'invalid'
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return 'invalid'
  }
  if (parsed.protocol === 'https:') return parsed.hostname === '' ? 'invalid' : 'https'
  if (parsed.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ? 'loopback' : 'insecure'
  }
  return 'invalid'
}

/** 是否是可用目标（https + 有主机名，或明文 http 发往字面回环主机）。 */
export function isSecureWebhookUrl(value: string): boolean {
  const kind = webhookUrlKind(value)
  return kind === 'https' || kind === 'loopback'
}

export type WebhookSendResult =
  | { ok: true; status: number }
  | { ok: false; reason: string; retryable: boolean }

/**
 * 一个端点一个实例。`send` 永不抛：网络错误 / 超时 / 厂商错误都折算成 `{ ok: false, reason, retryable }`。
 */
export class WebhookClient {
  private readonly url: string
  private readonly secret: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly clock: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly backoffBaseMs: number
  private readonly maxBackoffMs: number
  private readonly dialect: WebhookDialect

  constructor(options: WebhookClientOptions) {
    if (!options || typeof options.url !== 'string' || options.url.trim() === '') {
      throw new Error('WebhookClient: url is required')
    }
    this.url = options.url.trim()
    // 明文 http 只放行字面回环主机；其余明文不上路：签名与正文会在链路上裸奔。
    if (!isSecureWebhookUrl(this.url)) {
      throw new Error('WebhookClient: url must use https (plaintext http is allowed only for loopback hosts)')
    }
    this.secret = typeof options.secret === 'string' ? options.secret.trim() : ''
    this.fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.timeoutMs = positiveOr(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxRetries = nonNegativeOr(options.maxRetries, DEFAULT_MAX_RETRIES)
    this.clock = options.clock ?? ((): number => Date.now())
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
    this.backoffBaseMs = positiveOr(options.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS)
    this.maxBackoffMs = positiveOr(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS)
    this.dialect = options.dialect ?? detectWebhookDialect(this.url)
  }

  /** 本次实例识别出的方言。 */
  getDialect(): WebhookDialect {
    return this.dialect
  }

  /**
   * 发送一条文本通知。可重试的失败（408 / 429 / 5xx / 超时 / 网络错误）按指数退避重试到 `maxRetries` 上限；
   * 厂商业务错误与配置错误直接返回 `retryable: false`。
   */
  async send(text: string, options: WebhookSendOptions = {}): Promise<WebhookSendResult> {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, reason: 'empty_text', retryable: false }
    }

    let reason = 'unknown'
    let retryable = false

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt - 1))
      const request = buildWebhookRequest(this.dialect, this.url, text, {
        secret: this.secret,
        title: options.title,
        markdown: options.markdown,
        now: this.clock(),
      })
      const outcome = await this.attempt(request)
      if (outcome.ok) return { ok: true, status: outcome.status }
      reason = outcome.reason
      retryable = outcome.retryable
      if (!retryable) break
    }

    return { ok: false, reason: this.redact(reason), retryable }
  }

  private async attempt(request: WebhookRequest): Promise<{ ok: true; status: number } | { ok: false; reason: string; retryable: boolean }> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      })
      const raw = await response.text()
      const verdict = validateWebhookResponse(this.dialect, response.status, raw)
      if (verdict.ok) return { ok: true, status: response.status }
      return { ok: false, reason: verdict.reason ?? `http_${response.status}`, retryable: verdict.retryable === true }
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, reason: 'timeout', retryable: true }
      return { ok: false, reason: `network_error:${errorText(error)}`, retryable: true }
    } finally {
      clearTimeout(timer)
    }
  }

  private backoffMs(retryIndex: number): number {
    return Math.min(this.maxBackoffMs, this.backoffBaseMs * 2 ** retryIndex)
  }

  private redact(reason: string): string {
    // Webhook URL 的 query 与深层 path 本身就是凭据：先收成 origin + 路径第一段，
    // 再把整条 URL 也当密钥过一遍 redactSecret。
    const cleaned = scrubUrls(reason)
    const secrets = [this.secret, this.url].filter((value) => value.length > 0)
    const masked = redactSecret(cleaned, secrets)
    return masked.length <= REASON_LIMIT ? masked : `${masked.slice(0, REASON_LIMIT)}...`
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/gi

/** Webhook URL 对外只保留 origin + 路径第一段；解析失败返回空串。 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const first = parsed.pathname.split('/').find((segment) => segment !== '')
    return first === undefined ? parsed.origin : `${parsed.origin}/${first}`
  } catch {
    return ''
  }
}

/** 把文本里出现的 URL 都收成 origin + 路径第一段；没有 URL 时原样返回。 */
export function scrubUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trimmed = match.replace(/[).,;:!?]+$/, '')
    const suffix = match.slice(trimmed.length)
    const safe = safeUrl(trimmed)
    return safe === '' ? match : `${safe}${suffix}`
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}
