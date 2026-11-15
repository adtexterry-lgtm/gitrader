// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-telegram/src/telegram.ts（以库为准）。插件版加了：单次调用总超时（≤8 s）、
// 结构化错误（retryable 位）、token 与 base64(token) 脱敏。所有日志 / 错误消息都要先过 redactSecrets。
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/signal_notifier.py:954-985; adapted.
import { chunkMessage } from './format.mjs'

const DEFAULT_BASE_URL = 'https://api.telegram.org'
/** Telegram 单条消息文本上限。 */
const MAX_TEXT = 4096
/** B0 契约：插件内部网络超时 ≤ 8 s。 */
export const DEFAULT_TIMEOUT_MS = 8000

/**
 * 带 retryable 位的错误。reason 已经脱敏（不含 token 及其 base64 形式）。
 */
export class TelegramError extends Error {
  constructor(reason, retryable) {
    super(reason)
    this.name = 'TelegramError'
    this.retryable = retryable
  }
}

/** 把 token 替换为 'bot<redacted>'；日志 / 错误消息都要经过它。 */
export function redactToken(s, token) {
  if (!token) return s
  return s.split(token).join('bot<redacted>')
}

/** token 的常见变形（base64 / base64url / 去 padding），一并脱敏。 */
function tokenVariants(token) {
  if (!token) return []
  const b64 = Buffer.from(token, 'utf8').toString('base64')
  const out = new Set([token, b64, b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_')])
  if (token.includes(':')) {
    // bot<id>:<secret> 只泄露 secret 一段也算泄露
    for (const part of token.split(':')) if (part.length >= 8) out.add(part)
  }
  return [...out].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)
}

/** 把 token / base64(token) 全部替换成 '<redacted>'，并压成一行短句。 */
export function redactSecrets(text, token, maxLength = 200) {
  let out = String(text === undefined || text === null ? '' : text)
  for (const variant of tokenVariants(token)) out = out.split(variant).join('<redacted>')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

function timeoutError(message) {
  return new TelegramError(message, true)
}

export class TelegramClient {
  constructor(opts) {
    this.token = opts.token
    this.idempotencyKey = opts.idempotencyKey
    this.idemSeq = 0
    this.baseUrl = String(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.clock = opts.clock ?? (() => Date.now())
    this.maxRetries = opts.maxRetries ?? 2
    this.minIntervalMs = opts.minIntervalMs ?? 1000
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.lastSendAt = new Map()
  }

  /** 文本超长自动 chunk 并顺序发送；返回每块的 message_id。 */
  async sendMessage(chatId, text) {
    const messageIds = []
    for (const part of chunkMessage(text, MAX_TEXT)) messageIds.push(await this.sendPart(chatId, part))
    return { messageIds }
  }

  async sendPart(chatId, text) {
    const key = String(chatId)
    await this.waitForSlot(key)
    this.lastSendAt.set(key, this.clock())
    return this.post(chatId, text)
  }

  /** 同一 chat 两次发送之间至少间隔 minIntervalMs。 */
  async waitForSlot(key) {
    const last = this.lastSendAt.get(key)
    if (last === undefined) return
    const waitMs = this.minIntervalMs - (this.clock() - last)
    if (waitMs > 0) await sleep(waitMs)
  }

  async post(chatId, text) {
    const url = `${this.baseUrl}/bot${this.token}/sendMessage`
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    })
    // GQ-52：多块消息每块一个后缀，重试同一块用同一个键
    const idem = this.idempotencyKey ? (this.idemSeq++ ? `${this.idempotencyKey}:${this.idemSeq - 1}` : this.idempotencyKey) : undefined
    const startedAt = this.clock()
    let attempt = 0
    for (;;) {
      const remaining = this.timeoutMs - (this.clock() - startedAt)
      if (remaining <= 0) throw timeoutError('Telegram sendMessage timed out')
      let res
      let payload
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) },
          body,
          signal: AbortSignal.timeout(remaining),
        })
        payload = await readJson(res)
      } catch (e) {
        const name = e && e.name
        if (name === 'TimeoutError' || name === 'AbortError') throw timeoutError('Telegram sendMessage timed out')
        throw new TelegramError(redactSecrets(`Telegram sendMessage network error: ${e && e.message ? e.message : 'fetch failed'}`, this.token), true)
      }
      const status = res.status
      if (status === 429 && attempt < this.maxRetries) {
        const retryAfter = payload && payload.parameters && payload.parameters.retry_after
        const waitMs = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000
        attempt += 1
        if (this.clock() - startedAt + waitMs >= this.timeoutMs) throw timeoutError('Telegram sendMessage rate limited past the timeout budget')
        await sleep(waitMs)
        continue
      }
      if (status < 200 || status >= 300) throw this.fail(`HTTP ${status}`, payload)
      if (!payload || payload.ok !== true) throw this.fail('ok=false', payload)
      const messageId = payload.result && payload.result.message_id
      if (typeof messageId !== 'number') throw this.fail('missing message_id', payload)
      return messageId
    }
  }

  /** HTTP 4xx 是配置 / 权限问题，重试没有意义；429 与 5xx 由调用方看到 retryable=true。 */
  fail(reason, payload) {
    const description = payload && payload.description ? String(payload.description) : '(no description)'
    const status = Number(String(reason).replace(/^HTTP\s+/, '')) || 0
    const retryable = status === 429 || status >= 500
    return new TelegramError(redactSecrets(`Telegram sendMessage failed: ${reason}: ${description}`, this.token), retryable)
  }
}
