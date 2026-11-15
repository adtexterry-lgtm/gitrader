// SPDX-License-Identifier: CPAL-1.0
// 离线假企业微信群机器人 webhook（插件侧）：进程内 fetch，不开端口、不联网。
// 独立实现：不 import 插件运行时代码，域名 / 路径 / 字节上限 / 报文校验都自己写一份，
// 成功回官方形状 {"errcode":0,"errmsg":"ok"}，key 不匹配回官方 93000，超频回 45009。
export const HOST = 'qyapi.weixin.qq.com'
export const PATH = '/cgi-bin/webhook/send'
export const MARKDOWN_LIMIT = 4096
export const TEXT_LIMIT = 2048

const encoder = new TextEncoder()
const bytesOf = (s: string): number => encoder.encode(s).length

export interface Call {
  url: string
  msgtype: unknown
  content: string
  contentBytes: number
}

export interface FakeOptions {
  key: string
  /** 依次消费的官方 errcode（0 表示成功）。 */
  errcodes?: number[]
  /** 依次消费的 HTTP 状态。 */
  statuses?: number[]
}

export class FakeWeComServer {
  readonly key: string
  calls: Call[] = []
  violations: string[] = []
  private readonly errcodes: number[]
  private readonly statuses: number[]

  constructor(opts: FakeOptions) {
    this.key = opts.key
    this.errcodes = opts.errcodes ?? []
    this.statuses = opts.statuses ?? []
  }

  readonly fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>
    } catch {
      this.violations.push('body 不是 JSON')
    }
    const msgtype = body.msgtype
    const group = ((body[String(msgtype)] ?? {}) as { content?: unknown }).content
    const content = typeof group === 'string' ? group : ''
    this.calls.push({ url: url.toString(), msgtype, content, contentBytes: bytesOf(content) })

    const headers = new Headers(init?.headers as Record<string, string> | undefined)
    if (url.host !== HOST) this.violations.push(`域名不是 ${HOST}`)
    if (url.pathname !== PATH) this.violations.push(`路径不是 ${PATH}`)
    if (init?.method !== 'POST') this.violations.push('方法必须是 POST')
    if (!headers.get('content-type')?.toLowerCase().includes('application/json')) this.violations.push('content-type 必须是 application/json')
    if (msgtype !== 'markdown' && msgtype !== 'text') this.violations.push(`msgtype 非法：${String(msgtype)}`)
    if (content === '') this.violations.push('content 为空')
    const limit = msgtype === 'text' ? TEXT_LIMIT : MARKDOWN_LIMIT
    if (content !== '' && bytesOf(content) > limit) this.violations.push(`content 超过 ${limit} 字节`)

    const status = this.statuses.shift()
    if (status !== undefined) {
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url.searchParams.get('key') !== this.key) {
      return new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const errcode = this.errcodes.shift()
    const code = errcode ?? 0
    const errmsg = code === 0 ? 'ok' : code === 45009 ? 'api freq out of limit' : `fake errmsg ${code}`
    return new Response(JSON.stringify({ errcode: code, errmsg }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  lastContent(): string {
    return this.calls[this.calls.length - 1]?.content ?? ''
  }
}
