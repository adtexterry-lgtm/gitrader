// SPDX-License-Identifier: CPAL-1.0
// 假 Discord 服务器：只按官方文档的规则独立判定，**不 import 客户端任何代码**（test/independence.test.ts 会核对）。
// 官方依据：
//   路由 POST /webhooks/{webhook.id}/{webhook.token}、wait=true 回 message 对象、content ≤2000、allowed_mentions：
//     https://discord.com/developers/docs/resources/webhook#execute-webhook
//   429 响应 { message, retry_after(秒), global } + Retry-After 头：
//     https://discord.com/developers/docs/topics/rate-limits
//   错误体 { message, code }：10015 Unknown webhook、50027 Invalid webhook token、50035 Invalid form body：
//     https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes
// 说明：`errors.<field>._errors[]` 的细分码（BASE_TYPE_REQUIRED / BASE_TYPE_MAX_LENGTH）官方文档只给了示例，
// 这里照示例形状写，仅用于让失败更可读；客户端只读顶层的 code / message。

export interface RecordedRequest {
  url: string
  method: string
  contentType: string | undefined
  userAgent: string | undefined
  /** 解析后的 JSON body；解析失败为 undefined。 */
  body: Record<string, unknown> | undefined
  /** 原始 body 文本。 */
  raw: string
  /** 原始 wait 查询参数（没带为 null）。 */
  wait: string | null
  threadId: string | null
}

export interface ScriptedResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface FakeDiscordOptions {
  id?: string
  token?: string
  host?: string
  /** 前 N 次请求回 429（官方结构），之后正常。 */
  rateLimitFirst?: number
  /** 429 的 retry_after 秒数（官方 body 字段，float）。 */
  retryAfterSec?: number
  /** 429 是否标记 global。 */
  global?: boolean
  /** 脚本化响应：按顺序取，用完后回到正常路径。 */
  script?: ScriptedResponse[]
  /** 最近一次成功消息的 snowflake 起始值。 */
  firstMessageId?: string
}

/** 官方 allowed_mentions.parse 的三个取值（https://discord.com/developers/docs/resources/message#allowed-mentions-object）。 */
const MENTION_TYPES = ['roles', 'users', 'everyone'] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export class FakeDiscord {
  readonly requests: RecordedRequest[] = []
  /** 按官方 allowed_mentions 语义算出的「这条消息实际会 @ 到谁」。 */
  readonly pings: string[] = []
  private readonly id: string
  private readonly token: string
  private readonly host: string
  private rateLimitLeft: number
  private readonly retryAfterSec: number
  private readonly global: boolean
  private readonly script: ScriptedResponse[]
  private nextMessageId: bigint

  constructor(options: FakeDiscordOptions = {}) {
    this.id = options.id ?? '123456789012345678'
    this.token = options.token ?? 'fixture-webhook-token-0123456789'
    this.host = options.host ?? 'discord.com'
    this.rateLimitLeft = options.rateLimitFirst ?? 0
    this.retryAfterSec = options.retryAfterSec ?? 1
    this.global = options.global === true
    this.script = [...(options.script ?? [])]
    this.nextMessageId = BigInt(options.firstMessageId ?? '1300000000000000000')
  }

  /** 可直接作为 `fetchImpl` 注入。 */
  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url)
    const raw = typeof init.body === 'string' ? init.body : ''
    const headers = new Headers(init.headers)
    let body: Record<string, unknown> | undefined
    try {
      body = record(JSON.parse(raw))
    } catch {
      body = undefined
    }
    this.requests.push({
      url: url.toString(),
      method: String(init.method ?? 'GET').toUpperCase(),
      contentType: headers.get('content-type') ?? undefined,
      userAgent: headers.get('user-agent') ?? undefined,
      body,
      raw,
      wait: url.searchParams.get('wait'),
      threadId: url.searchParams.get('thread_id'),
    })

    // 1) 主机与路由：官方 API 基址是 discord.com；不认识的路由按 404 处理。
    if (url.hostname !== this.host) return json({ message: '404: Not Found', code: 0 }, 404)
    const route = /^\/api\/webhooks\/(\d{5,25})\/([A-Za-z0-9._-]+)$/.exec(url.pathname)
    if (route === null) return json({ message: '404: Not Found', code: 0 }, 404)
    if (route[1] !== this.id) return json({ message: 'Unknown Webhook', code: 10015 }, 404)
    if (route[2] !== this.token) return json({ message: 'Invalid Webhook Token', code: 50027 }, 401)
    if (String(init.method ?? 'GET').toUpperCase() !== 'POST') return json({ message: '405: Method Not Allowed', code: 0 }, 405)

    // 2) 脚本化响应（限流 / 5xx / 自定义失败），用完后走正常路径。
    const scripted = this.script.shift()
    if (scripted !== undefined) {
      return json(scripted.body ?? {}, scripted.status, scripted.headers)
    }

    // 3) Content-Type：官方 50035 说明里写明 content-type 不对也报 50035。
    const contentType = headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return json({ message: 'Invalid Form Body', code: 50035 }, 400)
    }
    if (body === undefined) return json({ message: 'Invalid Form Body', code: 50035 }, 400)

    // 4) 至少要有 content / embeds / files / poll 之一（官方各字段 Required 列）。
    const hasPayload = body.content !== undefined || body.embeds !== undefined || body.files !== undefined || body.poll !== undefined
    if (!hasPayload) {
      return json(
        { message: 'Invalid Form Body', code: 50035, errors: { content: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }] } } },
        400,
      )
    }
    const content = body.content
    if (content !== undefined && typeof content !== 'string') {
      return json({ message: 'Invalid Form Body', code: 50035 }, 400)
    }
    // 5) content 上限 2000 字符（官方：「the message contents (up to 2000 characters)」）。
    if (typeof content === 'string' && content.length > 2000) {
      return json(
        { message: 'Invalid Form Body', code: 50035, errors: { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2000 or fewer in length.' }] } } },
        400,
      )
    }

    // 6) allowed_mentions：缺省不过滤（官方默认全部允许）；parse 里没有的类型不会触发提及。
    const allowed = record(body.allowed_mentions)
    const parse = Array.isArray(allowed?.parse) ? (allowed.parse as unknown[]) : null
    const allowedTypes = parse === null ? [...MENTION_TYPES] : parse.filter((v): v is string => typeof v === 'string')
    const text = typeof content === 'string' ? content : ''
    if (allowedTypes.includes('everyone') && /@(everyone|here)\b/.test(text)) this.pings.push('everyone')
    if (allowedTypes.includes('users') && /<@!?\d+>/.test(text)) this.pings.push('user')
    if (allowedTypes.includes('roles') && /<@&\d+>/.test(text)) this.pings.push('role')

    // 7) 限流：官方 429 结构 + Retry-After 头。
    if (this.rateLimitLeft > 0) {
      this.rateLimitLeft -= 1
      return json(
        { message: 'You are being rate limited.', retry_after: this.retryAfterSec, global: this.global },
        429,
        { 'retry-after': String(this.retryAfterSec) },
      )
    }

    // 8) wait：缺省 false → 204 无 body；True/true/1 → 200 + message 对象（官方 boolean query strings）。
    const wait = url.searchParams.get('wait')
    const waits = wait !== null && ['true', 'True', '1'].includes(wait)
    if (!waits) return new Response(null, { status: 204 })
    const id = (this.nextMessageId++).toString()
    return json(
      {
        id,
        type: 0,
        channel_id: '987654321098765432',
        guild_id: '111111111111111111',
        content: typeof content === 'string' ? content : '',
        webhook_id: this.id,
        author: { id: this.id, username: 'webhook', discriminator: '0000', bot: true },
        timestamp: new Date(1760000000000).toISOString(),
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        pinned: false,
        tts: false,
      },
      200,
    )
  }
}
