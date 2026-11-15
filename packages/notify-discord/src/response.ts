// SPDX-License-Identifier: CPAL-1.0
// 响应判定（纯函数）：把 Discord 的状态码 + body 折算成 { ok, ref, reason, retryable }。
// 依据：
//   成功 200（带 message 对象）/ 204 No Content —— https://discord.com/developers/docs/resources/webhook#execute-webhook
//   429 结构 { message, retry_after(秒, float), global, code? } —— https://discord.com/developers/docs/topics/rate-limits
//   错误体 { message, code, errors? }，码表 10015 / 50027 / 50035 ——
//     https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes
// reason 不含密钥；调用方仍须再过一遍 redactText。

export interface WebhookVerdict {
  ok: boolean
  /** 成功时平台返回的 message id（200 + message 对象才有）。 */
  ref?: string
  reason?: string
  /** 同一请求重发是否可能成功。 */
  retryable: boolean
  /** 429 时建议的等待毫秒数。 */
  retryAfterMs?: number
  /** 429 时是否全局限流（官方 global 字段）。 */
  global?: boolean
}

type HeaderBag = Headers | Record<string, string | undefined> | undefined

function header(bag: HeaderBag, name: string): string | undefined {
  if (bag === undefined) return undefined
  if (typeof (bag as Headers).get === 'function') return (bag as Headers).get(name) ?? undefined
  const record = bag as Record<string, string | undefined>
  for (const key of Object.keys(record)) if (key.toLowerCase() === name.toLowerCase()) return record[key]
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function shorten(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** 秒（可能是小数）→ 毫秒；非有限值或负数返回 undefined。 */
function secondsToMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 1000)
}

/** 官方 Retry-After 头是秒（整数或小数），作为 body 里 retry_after 缺省时的退路。 */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const seconds = Number(value.trim())
  return secondsToMs(Number.isFinite(seconds) ? seconds : undefined)
}

/**
 * 判定一次 execute 的响应。
 *
 * - 2xx：204 / 空 body 算成功；200 + message 对象取 `id` 当 ref（官方 ID 一律是字符串，数字也收）。
 * - 429：retryable，reason 带 retryAfterMs 与 global 标记；等待取自 body.retry_after，缺省取 Retry-After 头。
 * - 5xx：retryable（服务端错），reason `http_<status>`。
 * - 其余 4xx：不重试（401 token 错、404 webhook 不存在或已删、400 表单非法，重发都不会变）。
 */
export function classifyResponse(status: number, bodyText: string | undefined, headers?: HeaderBag): WebhookVerdict {
  const raw = typeof bodyText === 'string' ? bodyText : ''
  let parsed: unknown = undefined
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      parsed = undefined
    }
  }
  const obj = asRecord(parsed)
  // 非 JSON 的错误体（网关 / 反代偶尔回纯文本）也给出可读摘要
  const plain = obj === undefined && trimmed !== '' && !trimmed.startsWith('{') && !trimmed.startsWith('[')
  const message = typeof obj?.message === 'string' ? shorten(obj.message, 200) : plain ? shorten(trimmed, 200) : ''
  const code = typeof obj?.code === 'number' ? obj.code : undefined

  if (status >= 200 && status < 300) {
    if (status === 204 || status === 205 || trimmed === '') return { ok: true, retryable: false }
    const id = obj?.id
    if (typeof id === 'string' && id !== '') return { ok: true, ref: id, retryable: false }
    if (typeof id === 'number' && Number.isFinite(id)) return { ok: true, ref: String(id), retryable: false }
    return { ok: true, retryable: false }
  }

  if (status === 429) {
    const fromBody = secondsToMs(obj?.retry_after)
    const fromHeader = parseRetryAfter(header(headers, 'retry-after'))
    const retryAfterMs = fromBody ?? fromHeader
    const global = obj?.global === true
    const detail = retryAfterMs === undefined ? '' : `:retry_after_ms=${retryAfterMs}`
    const verdict: WebhookVerdict = {
      ok: false,
      retryable: true,
      reason: `rate_limited${global ? ':global' : ''}${detail}`,
    }
    if (retryAfterMs !== undefined) verdict.retryAfterMs = retryAfterMs
    if (global) verdict.global = true
    return verdict
  }

  const detail = message === '' ? '' : `:${message}`
  if (status >= 500) {
    return { ok: false, retryable: true, reason: `http_${status}${code === undefined ? '' : `:code=${code}`}${detail}` }
  }
  return { ok: false, retryable: false, reason: `http_${status}${code === undefined ? '' : `:code=${code}`}${detail}` }
}
