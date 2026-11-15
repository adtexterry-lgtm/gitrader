// SPDX-License-Identifier: CPAL-1.0
// 厂商响应校验：把 2xx + 厂商 JSON 里的错误码统一成 { ok, reason, retryable }。
// 起点复制自 packages/kernel/src/notify/webhook.ts，补齐企业微信、retryable 判定与 body 文本入参。
import type { WebhookDialect } from './dialect'

export interface WebhookVerdict {
  ok: boolean
  /** 失败原因短句；不含密钥（调用方仍须再过一遍 redactSecret）。 */
  reason?: string
  /** 同一请求重发是否可能成功（429 / 5xx / 超时），失败时为 false。 */
  retryable?: boolean
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/signal_notifier.py:832-835; adapted.
// QD 只在限流 / 网关类状态码上重试；408 是本库补充（请求超时在网关侧常见）。
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504])

/** 该 HTTP 状态码是否值得重试。 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:140-163; adapted.
/**
 * 校验一次 Webhook 响应。
 *
 * - 非 2xx：`http_<status>`（能读出错误摘要时附在冒号后），429 / 5xx / 408 标 retryable。
 * - feishu / dingtalk / wecom：body 里 `code` / `errcode` / `StatusCode` 为 0（或缺省 / 非 JSON）算成功，
 *   否则 `<dialect>_error:code=<码>:<msg>`，厂商业务错误不重试。
 * - slack：纯文本 `ok`（大小写不敏感）或 JSON 对象算成功；`{"ok":false,...}` 判失败（`retryable: false`）。
 * - discord / generic：2xx 即成功（discord 回 204 无 body）。
 */
export function validateWebhookResponse(dialect: WebhookDialect, status: number, body: unknown): WebhookVerdict {
  const parsed = parseBody(body)
  if (!(status >= 200 && status < 300)) {
    const detail = summaryOf(parsed)
    return {
      ok: false,
      reason: detail ? `http_${status}:${detail}` : `http_${status}`,
      retryable: isRetryableStatus(status),
    }
  }

  if (dialect === 'slack') {
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim()
      if (trimmed.toLowerCase() === 'ok' || trimmed.startsWith('{')) return { ok: true }
      return { ok: false, reason: `slack_unexpected:${shorten(trimmed, 300)}`, retryable: false }
    }
    const obj = asRecord(parsed)
    if (obj && obj.ok === false) {
      return { ok: false, reason: `slack_error:${shorten(String(obj.error ?? 'unknown'), 200)}`, retryable: false }
    }
    if (obj) return { ok: true }
    return { ok: false, reason: 'slack_unexpected', retryable: false }
  }

  if (dialect === 'feishu' || dialect === 'dingtalk' || dialect === 'wecom') {
    const obj = asRecord(parsed)
    if (!obj) return { ok: true }
    const code = firstDefined(obj.code, obj.errcode, obj.StatusCode)
    if (code === undefined || code === null || code === 0 || code === '0') return { ok: true }
    const message = firstDefined(obj.msg, obj.errmsg, obj.StatusMessage)
    const suffix = typeof message === 'string' && message.length > 0 ? `:${shorten(message, 200)}` : ''
    return { ok: false, reason: `${dialect}_error:code=${String(code)}${suffix}`, retryable: false }
  }

  return { ok: true }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return trimmed
    }
  }
  return trimmed
}

function summaryOf(body: unknown): string {
  if (typeof body === 'string') return shorten(body, 200)
  const obj = asRecord(body)
  if (!obj) return ''
  const message = firstDefined(obj.msg, obj.errmsg, obj.message, obj.StatusMessage)
  return typeof message === 'string' ? shorten(message, 200) : ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) if (value !== undefined) return value
  return undefined
}

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`
}
