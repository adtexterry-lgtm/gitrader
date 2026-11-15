// SPDX-License-Identifier: CPAL-1.0
// Telegram Bot API 发送客户端：token 由调用方传入，注入 fetch / clock，MarkdownV2，429 重试，同 chat 节流。
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/signal_notifier.py:546; adapted (brand copy removed).
import { chunkMessage } from './format'

const DEFAULT_BASE_URL = 'https://api.telegram.org'
/** Telegram 单条消息文本上限。 */
const MAX_TEXT = 4096

export interface TelegramClientOptions {
  token: string
  /** 缺省 https://api.telegram.org */
  baseUrl?: string
  fetchImpl?: typeof fetch
  clock?: () => number
  /** 429 后的最大重试次数，缺省 2。 */
  maxRetries?: number
  /** 同一 chat 的最小发送间隔（毫秒），缺省 1000。 */
  minIntervalMs?: number
}

/** 把 token 替换为 'bot<redacted>'；日志 / 错误消息都要经过它。 */
export function redactToken(s: string, token: string): string {
  if (token.length === 0) return s
  return s.split(token).join('bot<redacted>')
}

interface TelegramApiResponse {
  ok?: boolean
  description?: string
  parameters?: { retry_after?: number }
  result?: { message_id?: number }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(res: Response): Promise<TelegramApiResponse | undefined> {
  try {
    return (await res.json()) as TelegramApiResponse
  } catch {
    return undefined
  }
}

export class TelegramClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private readonly maxRetries: number
  private readonly minIntervalMs: number
  private readonly lastSendAt = new Map<string, number>()

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.clock = opts.clock ?? (() => Date.now())
    this.maxRetries = opts.maxRetries ?? 2
    this.minIntervalMs = opts.minIntervalMs ?? 1000
  }

  /** 文本超长自动 chunk 并顺序发送；返回每块的 message_id。 */
  async sendMessage(chatId: string | number, text: string): Promise<{ messageIds: number[] }> {
    const messageIds: number[] = []
    for (const part of chunkMessage(text, MAX_TEXT)) messageIds.push(await this.sendPart(chatId, part))
    return { messageIds }
  }

  private async sendPart(chatId: string | number, text: string): Promise<number> {
    const key = String(chatId)
    await this.waitForSlot(key)
    this.lastSendAt.set(key, this.clock())
    return this.post(chatId, text)
  }

  /** 同一 chat 两次发送之间至少间隔 minIntervalMs。 */
  private async waitForSlot(key: string): Promise<void> {
    const last = this.lastSendAt.get(key)
    if (last === undefined) return
    const waitMs = this.minIntervalMs - (this.clock() - last)
    if (waitMs > 0) await sleep(waitMs)
  }

  private async post(chatId: string | number, text: string): Promise<number> {
    const url = `${this.baseUrl}/bot${this.token}/sendMessage`
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    })
    let attempt = 0
    for (;;) {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      const payload = await readJson(res)
      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = payload?.parameters?.retry_after
        const waitMs = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000
        attempt += 1
        await sleep(waitMs)
        continue
      }
      if (!res.ok) throw this.fail(`HTTP ${res.status}`, payload)
      if (payload?.ok !== true) throw this.fail('ok=false', payload)
      const messageId = payload.result?.message_id
      if (typeof messageId !== 'number') throw this.fail('missing message_id', payload)
      return messageId
    }
  }

  private fail(reason: string, payload: TelegramApiResponse | undefined): Error {
    const description = payload?.description ?? '(no description)'
    return new Error(redactToken(`Telegram sendMessage failed: ${reason}: ${description}`, this.token))
  }
}
