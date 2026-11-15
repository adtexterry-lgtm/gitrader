// SPDX-License-Identifier: CPAL-1.0
// Discord execute-webhook 客户端：fetch / clock / sleep 可注入，单次调用有总超时预算（缺省 4 s），
// 429 按官方 retry_after 重试一次；所有对外 reason 先过 redactText（token 与整条 URL 都抹掉）。
import { MAX_CONTENT, chunkContent } from './format'
import type { ExecuteOptions } from './request'
import { buildExecuteRequest } from './request'
import { classifyResponse } from './response'
import { parseWebhookUrl, redactText } from './url'
import type { WebhookTarget } from './url'

/** 内核给插件的一次工具调用预算 10 s，这里留足余量。 */
export const DEFAULT_TIMEOUT_MS = 4000
export const DEFAULT_MAX_RETRIES = 1
/** 官方 429 可能给出很长的 retry_after；超过这个上限就不等，直接报 retryable。 */
export const DEFAULT_MAX_RETRY_AFTER_MS = 5000
const DEFAULT_BACKOFF_MS = 500

export type ExecuteResult =
  | { ok: true; ref?: string }
  | { ok: false; reason: string; retryable: boolean }

export interface DiscordWebhookClientOptions {
  url: string
  fetchImpl?: typeof fetch
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 单次 send 的总时间预算（毫秒，含重试与等待）。 */
  timeoutMs?: number
  /** 可重试失败的重试次数上限（不含首次）。 */
  maxRetries?: number
  /** 429 给出的等待超过它就不等，直接返回 retryable。 */
  maxRetryAfterMs?: number
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/**
 * 一个 webhook 一个实例。`sendContent` / `sendText` 不抛异常：网络错误、超时、平台错误
 * 都折算成 `{ ok: false, reason, retryable }`，reason 已脱敏。
 */
export class DiscordWebhookClient {
  #target: WebhookTarget
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly maxRetryAfterMs: number

  constructor(options: DiscordWebhookClientOptions) {
    this.#target = parseWebhookUrl(options.url)
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.clock = options.clock ?? ((): number => Date.now())
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
    this.timeoutMs = positiveOr(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxRetries = nonNegativeOr(options.maxRetries, DEFAULT_MAX_RETRIES)
    this.maxRetryAfterMs = positiveOr(options.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS)
  }

  /** webhook id（snowflake 字符串）；token 不对外暴露。 */
  get webhookId(): string {
    return this.#target.id
  }

  /** 发一条消息；content 超过 2000 字符直接失败（调用方先分块，或用 sendText）。 */
  async sendContent(content: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (typeof content !== 'string' || content.trim() === '') return this.fail('content 为空：没有可发送的文本', false)
    if (content.length > MAX_CONTENT) return this.fail(`content 超过 ${MAX_CONTENT} 字符上限`, false)
    let request
    try {
      request = buildExecuteRequest(this.#target, content, options)
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : '请求构造失败', false)
    }

    const startedAt = this.clock()
    let attempt = 0
    for (;;) {
      const remaining = this.timeoutMs - (this.clock() - startedAt)
      if (remaining <= 0) return this.fail('execute 超时：预算用尽', true)

      let status: number
      let headers: Headers
      let text: string
      try {
        const response = await this.fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
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
        const name = error instanceof Error ? error.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') return this.fail('execute 超时：网络请求未在预算内返回', true)
        const message = error instanceof Error ? error.message : 'fetch failed'
        return this.fail(`network error: ${message}`, true)
      }

      const verdict = classifyResponse(status, text, headers)
      if (verdict.ok) return verdict.ref === undefined ? { ok: true } : { ok: true, ref: verdict.ref }
      if (!verdict.retryable || attempt >= this.maxRetries) return this.fail(verdict.reason ?? `http_${status}`, verdict.retryable)

      const waitMs = verdict.retryAfterMs ?? DEFAULT_BACKOFF_MS
      if (waitMs > this.maxRetryAfterMs) return this.fail(`${verdict.reason ?? 'retryable failure'}:retry_after 超出 ${this.maxRetryAfterMs} ms 上限，不等待`, true)
      if (this.clock() - startedAt + waitMs >= this.timeoutMs) {
        return this.fail(`${verdict.reason ?? 'retryable failure'}:重试预算不足，不再重试`, true)
      }
      attempt += 1
      await this.sleep(waitMs)
    }
  }

  /**
   * 长文本按 2000 字符分块顺序发送；返回第一条消息的 ref。
   * 任何一块失败即停止（不继续发后面的块），并把该块的 reason 返回。
   */
  async sendText(text: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    let parts: string[]
    try {
      parts = chunkContent(text, MAX_CONTENT)
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : '分块失败', false)
    }
    if (parts.length === 0) return this.fail('content 为空：没有可发送的文本', false)
    let ref: string | undefined
    for (const part of parts) {
      const result = await this.sendContent(part, options)
      if (!result.ok) return result
      if (ref === undefined && result.ref !== undefined) ref = result.ref
    }
    return ref === undefined ? { ok: true } : { ok: true, ref }
  }

  private fail(reason: string, retryable: boolean): ExecuteResult {
    return { ok: false, reason: redactText(reason, [this.#target.token, this.#target.url]), retryable }
  }
}
