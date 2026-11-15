// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-wecom/src/client.ts（以库为准；插件不能 import 工作区包）。
// 企业微信群机器人 webhook 客户端：地址校验 + 归一化、markdown/text 两种形态、官方 errcode 分支、
// 单次调用总预算 8 s、key 与 URL 编码形式全程脱敏。
import { chunkByBytes, MARKDOWN_MAX_BYTES, TEXT_MAX_BYTES, renderNoticeMarkdown, renderNoticeText, utf8Bytes } from './format.mjs'

export const ALLOWED_HOST = 'qyapi.weixin.qq.com'
export const WEBHOOK_PATH = '/cgi-bin/webhook/send'
export const DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com'
export const DEFAULT_TIMEOUT_MS = 8000
export const DEFAULT_MIN_INTERVAL_MS = 3000
export const ERRCODE_OK = 0
/** 45009 = api freq out of limit（官方：每个机器人 20 条/分钟）。 */
export const ERRCODE_RATE_LIMITED = 45009
/**
 * -1 = 系统繁忙（服务器暂不可用，建议稍候重试）：与 45009 同一重试分支。
 * 依据：https://developer.work.weixin.qq.com/document/path/90313
 */
export const ERRCODE_SYSTEM_BUSY = -1
/** 93000 = invalid webhook url（key 无效 / 已删除）。 */
export const ERRCODE_INVALID_KEY = 93000

export class WeComConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WeComConfigError'
  }
}

export class WeComError extends Error {
  constructor(reason, retryable) {
    super(reason)
    this.name = 'WeComError'
    this.retryable = retryable
  }
}

/** key 的原样 / URL 编码 / base64 变形与任何 `key=` 查询参数一并脱敏。 */
export function redactSecrets(text, secret, maxLength = 200) {
  let out = String(text === undefined || text === null ? '' : text)
  if (secret) {
    const variants = [secret, encodeURIComponent(secret), Buffer.from(secret, 'utf8').toString('base64')]
    for (const variant of variants) if (variant.length >= 4) out = out.split(variant).join('<redacted>')
  }
  out = out.replace(/([?&]key=)[^&\s"']+/gi, '$1<redacted>')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}

/** 只接受 https + qyapi.weixin.qq.com + /cgi-bin/webhook/send + key 参数；归一化时丢掉其它查询参数。 */
export function parseWebhookUrl(raw, apiOrigin) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new WeComConfigError('企业微信 webhook 地址为空：没有地址无法发送')
  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new WeComConfigError('企业微信 webhook 地址不是合法 URL')
  }
  // GQ-54：给了 apiOrigin（已由 index 校验）就只取环境变量 URL 的路径与 key，origin 换成它。
  if (apiOrigin === undefined && parsed.protocol !== 'https:') throw new WeComConfigError('企业微信 webhook 只接受 https')
  if (apiOrigin === undefined && parsed.host !== ALLOWED_HOST) throw new WeComConfigError(`企业微信 webhook 的域名必须是 ${ALLOWED_HOST}`)
  if (parsed.pathname !== WEBHOOK_PATH) throw new WeComConfigError(`企业微信 webhook 的路径必须是 ${WEBHOOK_PATH}`)
  const key = parsed.searchParams.get('key') ?? ''
  if (key.trim() === '') throw new WeComConfigError('企业微信 webhook 地址缺少 key 参数')
  return { url: `${apiOrigin ?? DEFAULT_BASE_URL}${WEBHOOK_PATH}?key=${encodeURIComponent(key)}`, key }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(res) {
  try {
    const parsed = await res.json()
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export class WeComClient {
  #url
  #key

  constructor(opts) {
    if (opts === null || typeof opts !== 'object') throw new WeComConfigError('缺少客户端配置')
    const { url, key } = parseWebhookUrl(opts.webhookUrl, opts.apiOrigin)
    this.idempotencyKey = opts.idempotencyKey
    this.idemSeq = 0
    this.#url = url
    this.#key = key
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.clock = opts.clock ?? (() => Date.now())
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? 1
    this.retryDelayMs = opts.retryDelayMs ?? 1000
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.lastSendAt = undefined
  }

  async sendMarkdown(content) {
    return this.sendParts(chunkByBytes(content, MARKDOWN_MAX_BYTES), 'markdown')
  }

  async sendText(content) {
    return this.sendParts(chunkByBytes(content, TEXT_MAX_BYTES), 'text')
  }

  async sendNotice(notice, opts = {}) {
    if (opts.markdown === false) {
      return this.sendParts(chunkByBytes(renderNoticeText(notice), TEXT_MAX_BYTES), 'text')
    }
    return this.sendParts(chunkByBytes(renderNoticeMarkdown(notice), MARKDOWN_MAX_BYTES), 'markdown')
  }

  async sendParts(parts, msgtype) {
    const limit = msgtype === 'markdown' ? MARKDOWN_MAX_BYTES : TEXT_MAX_BYTES
    for (const part of parts) {
      if (utf8Bytes(part) > limit) throw new WeComError('消息块超过官方长度上限', false)
      await this.waitForSlot()
      this.lastSendAt = this.clock()
      await this.post(part, msgtype)
    }
    return parts.length
  }

  async waitForSlot() {
    if (this.lastSendAt === undefined || this.minIntervalMs <= 0) return
    const waitMs = this.minIntervalMs - (this.clock() - this.lastSendAt)
    if (waitMs > 0) await sleep(waitMs)
  }

  async post(content, msgtype) {
    const body = JSON.stringify(
      msgtype === 'markdown' ? { msgtype: 'markdown', markdown: { content } } : { msgtype: 'text', text: { content } },
    )
    // GQ-52：多块消息每块一个后缀，重试同一块用同一个键
    const idem = this.idempotencyKey ? (this.idemSeq++ ? `${this.idempotencyKey}:${this.idemSeq - 1}` : this.idempotencyKey) : undefined
    const startedAt = this.clock()
    let attempt = 0
    for (;;) {
      const remaining = this.timeoutMs - (this.clock() - startedAt)
      if (remaining <= 0) throw new WeComError('企业微信 webhook 发送超时', true)

      let res
      let reply
      try {
        res = await this.fetchImpl(this.#url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) },
          body,
          signal: AbortSignal.timeout(remaining),
        })
        reply = await readJson(res)
      } catch (e) {
        const name = e !== null && typeof e === 'object' ? e.name : undefined
        if (name === 'TimeoutError' || name === 'AbortError') throw new WeComError('企业微信 webhook 发送超时', true)
        const detail = e instanceof Error ? e.message : 'fetch failed'
        throw new WeComError(redactSecrets(`企业微信 webhook 网络错误：${detail}`, this.#key), true)
      }

      const status = res.status
      if (status < 200 || status >= 300) {
        const retryable = status === 429 || status >= 500
        if (retryable && (await this.backoff(attempt, startedAt))) {
          attempt += 1
          continue
        }
        throw this.fail(`HTTP ${status}`, reply, retryable)
      }

      const errcode = reply ? reply.errcode : undefined
      if (typeof errcode !== 'number') {
        if (await this.backoff(attempt, startedAt)) {
          attempt += 1
          continue
        }
        throw new WeComError(redactSecrets('企业微信 webhook 响应缺少 errcode：无法确认是否送达', this.#key), true)
      }
      if (errcode === ERRCODE_OK) return
      if (errcode === ERRCODE_RATE_LIMITED || errcode === ERRCODE_SYSTEM_BUSY) {
        if (await this.backoff(attempt, startedAt)) {
          attempt += 1
          continue
        }
        throw this.fail(`errcode=${errcode}`, reply, true)
      }
      throw this.fail(`errcode=${errcode}`, reply)
    }
  }

  async backoff(attempt, startedAt) {
    if (attempt >= this.maxRetries) return false
    if (this.clock() - startedAt + this.retryDelayMs >= this.timeoutMs) return false
    await sleep(this.retryDelayMs)
    return true
  }

  fail(reason, reply, retryable = false) {
    const errmsg = reply === undefined || reply.errmsg === undefined ? '(no errmsg)' : String(reply.errmsg)
    const errcode = reply === undefined || reply.errcode === undefined ? '-' : String(reply.errcode)
    return new WeComError(redactSecrets(`企业微信 webhook 发送失败：${reason} errcode=${errcode} errmsg=${errmsg}`, this.#key), retryable)
  }
}
