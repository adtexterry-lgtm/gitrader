// SPDX-License-Identifier: CPAL-1.0
// 插件测试用的假 Discord 服务器：按官方规则独立判定（不 import 客户端 / 插件代码，test/independence.test.ts 会核对）。
// 官方依据：
//   Execute Webhook（路由、wait、content ≤2000、allowed_mentions）：
//     https://discord.com/developers/docs/resources/webhook#execute-webhook
//   Rate Limits（429 的 message / retry_after / global 与 Retry-After 头）：
//     https://discord.com/developers/docs/topics/rate-limits
//   JSON Error Codes（10015 Unknown webhook / 50027 Invalid webhook token / 50035 Invalid form body）：
//     https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes

export interface SeenRequest {
  url: string
  method: string
  contentType: string | null
  userAgent: string | null
  content: string | null
  allowedMentions: unknown
  wait: string | null
  threadId: string | null
}

export interface FakeOptions {
  id?: string
  token?: string
  startMessageId?: number
  /** 前 N 次回 429。 */
  rateLimitFirst?: number
  retryAfterSec?: number
}

export class FakeDiscordServer {
  readonly seen: SeenRequest[] = []
  readonly pings: string[] = []
  readonly id: string
  readonly token: string
  private limitLeft: number
  private readonly retryAfterSec: number
  private next: number

  constructor(options: FakeOptions = {}) {
    this.id = options.id ?? '123456789012345678'
    this.token = options.token ?? 'fixture-webhook-token-0123456789'
    this.limitLeft = options.rateLimitFirst ?? 0
    this.retryAfterSec = options.retryAfterSec ?? 0.02
    this.next = options.startMessageId ?? 4242
  }

  get url(): string {
    return `https://discord.com/api/webhooks/${this.id}/${this.token}`
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(String(input))
    const bodyText = typeof init.body === 'string' ? init.body : ''
    const headers = new Headers(init.headers)
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(bodyText)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = {}
    }
    this.seen.push({
      url: target.toString(),
      method: String(init.method ?? 'GET').toUpperCase(),
      contentType: headers.get('content-type'),
      userAgent: headers.get('user-agent'),
      content: typeof body.content === 'string' ? body.content : null,
      allowedMentions: body.allowed_mentions,
      wait: target.searchParams.get('wait'),
      threadId: target.searchParams.get('thread_id'),
    })

    const route = /^\/api\/webhooks\/(\d{5,25})\/([A-Za-z0-9._-]+)$/.exec(target.pathname)
    if (target.hostname !== 'discord.com' || route === null) return this.json({ message: '404: Not Found', code: 0 }, 404)
    if (route[1] !== this.id) return this.json({ message: 'Unknown Webhook', code: 10015 }, 404)
    if (route[2] !== this.token) return this.json({ message: 'Invalid Webhook Token', code: 50027 }, 401)
    if (String(init.method ?? 'GET').toUpperCase() !== 'POST') return this.json({ message: '405: Method Not Allowed', code: 0 }, 405)

    if (!(headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return this.json({ message: 'Invalid Form Body', code: 50035 }, 400)
    }
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      return this.json({ message: 'Invalid Form Body', code: 50035, errors: { content: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }] } } }, 400)
    }
    if (body.content.length > 2000) {
      return this.json({ message: 'Invalid Form Body', code: 50035, errors: { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2000 or fewer in length.' }] } } }, 400)
    }

    const allowed = body.allowed_mentions
    const parse = allowed !== null && typeof allowed === 'object' && Array.isArray((allowed as { parse?: unknown }).parse)
      ? ((allowed as { parse: unknown[] }).parse.filter((v) => typeof v === 'string') as string[])
      : ['everyone', 'users', 'roles']
    if (parse.includes('everyone') && /@(everyone|here)\b/.test(body.content)) this.pings.push('everyone')
    if (parse.includes('users') && /<@!?\d+>/.test(body.content)) this.pings.push('user')
    if (parse.includes('roles') && /<@&\d+>/.test(body.content)) this.pings.push('role')

    if (this.limitLeft > 0) {
      this.limitLeft -= 1
      return this.json({ message: 'You are being rate limited.', retry_after: this.retryAfterSec, global: false }, 429, { 'retry-after': String(this.retryAfterSec) })
    }

    const wait = target.searchParams.get('wait')
    if (wait === null || !['true', 'True', '1'].includes(wait)) return new Response(null, { status: 204 })
    const id = String(this.next++)
    return this.json({ id, type: 0, channel_id: '1', content: body.content, webhook_id: this.id }, 200)
  }

  json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }
}
