// SPDX-License-Identifier: CPAL-1.0
// 企业微信群机器人 webhook 客户端：地址与 key 由调用方传入，注入 fetch / clock，markdown 与 text 两种形态，
// 按官方 errcode 判定可否重试，单次调用总预算 8 s，同一机器人默认 3 s 间隔（官方 20 条/分钟）。
// 依据：企业微信官方文档「群机器人配置说明」https://developer.work.weixin.qq.com/document/path/91770 ；
//      全局错误码 https://developer.work.weixin.qq.com/document/path/90313 。
// key 是本通道唯一的凭据（企业微信群里机器人没有签名，key 就放在 URL 的 key 查询参数里）：
// 库不读环境变量、不落盘、不打印；错误消息一律先过 redactSecret。
import { chunkByBytes, MARKDOWN_MAX_BYTES, TEXT_MAX_BYTES, renderNoticeMarkdown, renderNoticeText, utf8Bytes } from './format'
import type { NoticeFields } from './format'

/** 官方文档给出的固定入口（群机器人只有一个域名 + 一个路径）。 */
export const DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com'
export const WEBHOOK_PATH = '/cgi-bin/webhook/send'
/** 出网白名单：清单 net.hosts 与本常量必须一致。 */
export const ALLOWED_HOST = 'qyapi.weixin.qq.com'
/** B0 契约：插件内部网络超时 ≤ 8 s。 */
export const DEFAULT_TIMEOUT_MS = 8000
/** 官方：每个机器人发送的消息不能超过 20 条/分钟 → 3 s 间隔。 */
export const DEFAULT_MIN_INTERVAL_MS = 3000
/** 官方返回的成功码。 */
export const ERRCODE_OK = 0
/** 官方错误码 45009 = api freq out of limit（超过机器人 20 条/分钟），可等下次再试。 */
export const ERRCODE_RATE_LIMITED = 45009
/**
 * 官方错误码 -1 = 系统繁忙（服务器暂不可用，建议稍候重试）：与 45009 同一重试分支。
 * 依据：https://developer.work.weixin.qq.com/document/path/90313
 */
export const ERRCODE_SYSTEM_BUSY = -1
/** 官方错误码 93000 = invalid webhook url（key 无效或已被删除），重试没有意义。 */
export const ERRCODE_INVALID_KEY = 93000

/** 配置问题（地址 / key 形状不对）：不是网络失败，retryable 恒为 false。 */
export class WeComConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeComConfigError'
  }
}

/** 发送失败；reason 已脱敏（不含 key 的任何变形）。 */
export class WeComError extends Error {
  readonly retryable: boolean

  constructor(reason: string, retryable: boolean) {
    super(reason)
    this.name = 'WeComError'
    this.retryable = retryable
  }
}

/** key 的常见变形（原样 / URL 编码 / base64）一并脱敏，并兜住任何 `key=...` 查询参数。 */
export function redactSecret(text: unknown, secret: string, maxLength = 200): string {
  let out = String(text === undefined || text === null ? '' : text)
  if (secret.length > 0) {
    const variants = [secret, encodeURIComponent(secret), Buffer.from(secret, 'utf8').toString('base64')]
    for (const variant of variants) {
      if (variant.length >= 4) out = out.split(variant).join('<redacted>')
    }
  }
  out = out.replace(/([?&]key=)[^&\s"']+/gi, '$1<redacted>')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}

/**
 * 校验并归一化 webhook 地址：只接受 https + qyapi.weixin.qq.com + /cgi-bin/webhook/send + key 参数。
 * 归一化时丢掉地址里其它查询参数，避免把不相干的内容带出去。抛出的错误不含地址与 key。
 */
export function parseWebhookUrl(raw: string): { url: string; key: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new WeComConfigError('企业微信 webhook 地址为空：没有地址无法发送')
  }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new WeComConfigError('企业微信 webhook 地址不是合法 URL')
  }
  if (parsed.protocol !== 'https:') throw new WeComConfigError('企业微信 webhook 只接受 https')
  if (parsed.host !== ALLOWED_HOST) throw new WeComConfigError(`企业微信 webhook 的域名必须是 ${ALLOWED_HOST}`)
  if (parsed.pathname !== WEBHOOK_PATH) throw new WeComConfigError(`企业微信 webhook 的路径必须是 ${WEBHOOK_PATH}`)
  const key = parsed.searchParams.get('key') ?? ''
  if (key.trim() === '') throw new WeComConfigError('企业微信 webhook 地址缺少 key 参数')
  return { url: `${DEFAULT_BASE_URL}${WEBHOOK_PATH}?key=${encodeURIComponent(key)}`, key }
}

export interface WeComClientOptions {
  /** 群机器人 webhook 完整地址（含 key）。 */
  webhookUrl: string
  fetchImpl?: typeof fetch
  clock?: () => number
  /** 单次发送的总预算（含重试等待），缺省 8000 ms。 */
  timeoutMs?: number
  /** 可重试失败的最大重试次数，缺省 1（B0：可重试失败最多再试一次）。 */
  maxRetries?: number
  /** 两次重试之间的等待，缺省 1000 ms。 */
  retryDelayMs?: number
  /** 同一机器人的最小发送间隔，缺省 3000 ms（官方 20 条/分钟）。 */
  minIntervalMs?: number
}

interface WeComReply {
  errcode?: unknown
  errmsg?: unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(res: Response): Promise<WeComReply | undefined> {
  try {
    const parsed = (await res.json()) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as WeComReply) : undefined
  } catch {
    return undefined
  }
}

export class WeComClient {
  #url: string
  #key: string
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly minIntervalMs: number
  private lastSendAt: number | undefined

  constructor(opts: WeComClientOptions) {
    if (opts === null || typeof opts !== 'object') throw new WeComConfigError('缺少客户端配置')
    const { url, key } = parseWebhookUrl(opts.webhookUrl)
    this.#url = url
    this.#key = key
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.clock = opts.clock ?? (() => Date.now())
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? 1
    this.retryDelayMs = opts.retryDelayMs ?? 1000
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  }

  /** markdown 消息；超过 4096 字节按行分块顺序发送，返回块数。 */
  async sendMarkdown(content: string): Promise<number> {
    return this.sendParts(chunkByBytes(content, MARKDOWN_MAX_BYTES), 'markdown')
  }

  /** 纯文本消息；超过 2048 字节按行分块顺序发送，返回块数。 */
  async sendText(content: string): Promise<number> {
    return this.sendParts(chunkByBytes(content, TEXT_MAX_BYTES), 'text')
  }

  /** 通知字段 → 渲染 → 分块发送。markdown 缺省 true。返回实际发送的条数。 */
  async sendNotice(fields: NoticeFields, opts: { markdown?: boolean } = {}): Promise<number> {
    const markdown = opts.markdown !== false
    if (markdown) {
      const text = renderNoticeMarkdown(fields)
      return this.sendParts(chunkByBytes(text, MARKDOWN_MAX_BYTES), 'markdown')
    }
    const text = renderNoticeText(fields)
    return this.sendParts(chunkByBytes(text, TEXT_MAX_BYTES), 'text')
  }

  /** 分块发送：块与块之间至少间隔 minIntervalMs；任一块失败即抛出（不做部分回滚）。 */
  private async sendParts(parts: string[], msgtype: 'markdown' | 'text'): Promise<number> {
    for (const part of parts) {
      const limit = msgtype === 'markdown' ? MARKDOWN_MAX_BYTES : TEXT_MAX_BYTES
      if (utf8Bytes(part) > limit) throw new WeComError('消息块超过官方长度上限', false)
      await this.waitForSlot()
      this.lastSendAt = this.clock()
      await this.post(part, msgtype)
    }
    return parts.length
  }

  private async waitForSlot(): Promise<void> {
    const last = this.lastSendAt
    if (last === undefined || this.minIntervalMs <= 0) return
    const waitMs = this.minIntervalMs - (this.clock() - last)
    if (waitMs > 0) await sleep(waitMs)
  }

  private async post(content: string, msgtype: 'markdown' | 'text'): Promise<void> {
    const body = JSON.stringify(
      msgtype === 'markdown' ? { msgtype: 'markdown', markdown: { content } } : { msgtype: 'text', text: { content } },
    )
    const startedAt = this.clock()
    let attempt = 0
    for (;;) {
      const remaining = this.timeoutMs - (this.clock() - startedAt)
      if (remaining <= 0) throw new WeComError('企业微信 webhook 发送超时', true)

      let res: Response
      let reply: WeComReply | undefined
      try {
        res = await this.fetchImpl(this.#url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(remaining),
        })
        reply = await readJson(res)
      } catch (e) {
        const name = e !== null && typeof e === 'object' ? (e as { name?: unknown }).name : undefined
        if (name === 'TimeoutError' || name === 'AbortError') throw new WeComError('企业微信 webhook 发送超时', true)
        const detail = e instanceof Error ? e.message : 'fetch failed'
        throw new WeComError(redactSecret(`企业微信 webhook 网络错误：${detail}`, this.#key), true)
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

      const errcode = reply?.errcode
      if (typeof errcode !== 'number') {
        // 2xx 但响应体不是官方形状（网关页 / 被拦）：可重试一次，仍失败则报错
        if (await this.backoff(attempt, startedAt)) {
          attempt += 1
          continue
        }
        throw new WeComError(redactSecret('企业微信 webhook 响应缺少 errcode：无法确认是否送达', this.#key), true)
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

  /** 重试前等待；预算不够或次数用完返回 false（调用方据此报最终失败）。 */
  private async backoff(attempt: number, startedAt: number): Promise<boolean> {
    if (attempt >= this.maxRetries) return false
    if (this.clock() - startedAt + this.retryDelayMs >= this.timeoutMs) return false
    await sleep(this.retryDelayMs)
    return true
  }

  /**
   * 失败收口。retryable 由调用点给出：HTTP 4xx / 参数错 / key 失效都是配置问题，重试没有意义（false）；
   * 429 / 5xx / 45009 / -1 重试用尽后仍是「暂时性」失败，retryable 保持 true 交给内核决定下一次。
   */
  private fail(reason: string, reply: WeComReply | undefined, retryable = false): WeComError {
    const errmsg = reply?.errmsg === undefined ? '(no errmsg)' : String(reply.errmsg)
    const errcode = reply?.errcode === undefined ? '-' : String(reply.errcode)
    return new WeComError(redactSecret(`企业微信 webhook 发送失败：${reason} errcode=${errcode} errmsg=${errmsg}`, this.#key), retryable)
  }
}
