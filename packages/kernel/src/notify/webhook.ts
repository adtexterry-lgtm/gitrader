// SPDX-License-Identifier: CPAL-1.0
import { createHmac } from 'node:crypto'

export type WebhookDialect = 'feishu' | 'dingtalk' | 'slack' | 'discord' | 'generic'

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:12-27; adapted.
/** 照 QD 的域名规则识别 Webhook 方言；无法识别时返回 generic。 */
export function detectWebhookDialect(url: string): WebhookDialect {
  const lowered = String(url ?? '').toLowerCase()
  if (lowered.includes('discord.com/api/webhooks')) return 'discord'
  if (lowered.includes('open.feishu.cn') || lowered.includes('larksuite') || lowered.includes('larkoffice')) return 'feishu'
  if (lowered.includes('oapi.dingtalk.com')) return 'dingtalk'
  if (lowered.includes('hooks.slack.com')) return 'slack'
  return 'generic'
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:123-127; adapted.
/** 飞书 / Lark 自定义机器人签名：HMAC-SHA256(key = `${timestamp}\n${secret}`, message = 空) → base64。 */
export function signFeishu(secret: string, timestampSec: number): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:130-137; adapted.
/** 钉钉自定义机器人签名：HMAC-SHA256(secret, `${timestamp}\n${secret}`) → base64 → URL 编码。 */
export function signDingtalk(secret: string, timestampMs: number): string {
  const digest = createHmac('sha256', secret).update(`${timestampMs}\n${secret}`).digest('base64')
  return encodeURIComponent(digest)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:100-137; adapted.
/** 按方言构造 Webhook 请求；密钥只参与签名，不出现在返回值中。 */
export function buildWebhookRequest(
  dialect: WebhookDialect,
  url: string,
  text: string,
  opts?: { secret?: string; now?: () => number },
): { url: string; body: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const secret = typeof opts?.secret === 'string' ? opts.secret.trim() : ''
  const nowMs = (): number => {
    const value = (opts?.now ?? Date.now)()
    return Number.isFinite(value) ? Math.floor(value) : Date.now()
  }

  if (dialect === 'feishu') {
    const body: Record<string, unknown> = { msg_type: 'text', content: { text } }
    if (secret) {
      const timestampSec = Math.floor(nowMs() / 1000)
      body.timestamp = String(timestampSec)
      body.sign = signFeishu(secret, timestampSec)
    }
    return { url, body, headers }
  }

  if (dialect === 'dingtalk') {
    const body = { msgtype: 'text', text: { content: text } }
    let postUrl = url
    if (secret) {
      const timestampMs = nowMs()
      const sign = signDingtalk(secret, timestampMs)
      const separator = postUrl.includes('?') ? '&' : '?'
      postUrl = `${postUrl}${separator}timestamp=${timestampMs}&sign=${sign}`
    }
    return { url: postUrl, body, headers }
  }

  if (dialect === 'slack') return { url, body: { text }, headers }
  if (dialect === 'discord') return { url, body: { content: text }, headers }
  return { url, body: { text }, headers }
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:140-163; adapted.
/** 按方言校验厂商响应：飞书看 code / StatusCode，钉钉看 errcode，slack 看 'ok'，discord / generic 看 2xx。 */
export function validateWebhookResponse(dialect: WebhookDialect, status: number, body: unknown): { ok: boolean; reason?: string } {
  if (!(status >= 200 && status < 300)) return { ok: false, reason: `http_${status}` }
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { /* 非 JSON 文本按原字符串处理 */ }
  }

  if (dialect === 'slack') {
    if (typeof body === 'string') {
      const text = body.trim()
      if (text.toLowerCase() === 'ok' || text.startsWith('{')) return { ok: true }
      return { ok: false, reason: `slack_unexpected:${shorten(text, 300)}` }
    }
    if (body !== null && typeof body === 'object') return { ok: true }
    return { ok: false, reason: 'slack_unexpected' }
  }

  if (dialect === 'feishu' || dialect === 'dingtalk') {
    const obj = asRecord(body)
    if (!obj) return { ok: true }
    const code = dialect === 'feishu'
      ? firstDefined(obj.code, obj.StatusCode)
      : firstDefined(obj.errcode, obj.code)
    if (code === undefined || code === null) return { ok: true }
    if (code === 0 || code === '0') return { ok: true }
    const message = firstDefined(obj.msg, obj.errmsg, obj.StatusMessage)
    const suffix = message === undefined || message === null ? '' : `:${shorten(String(message), 200)}`
    return { ok: false, reason: `${dialect}_error:code=${String(code)}${suffix}` }
  }

  return { ok: true }
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
