// SPDX-License-Identifier: CPAL-1.0
// 离线假企业微信群机器人 webhook（进程内 fetch，不开端口、不联网）。
// 独立实现：本文件**不 import 客户端任何代码**，常量（域名/路径/字节上限）、字节计量、报文校验都自己写一份，
// 按官方文档的形状回答 {"errcode":0,"errmsg":"ok"}；协议违规记进 violations 并回一个非 0 errcode
// （错误码只用于本假服务器的自证，测试断言 violations，不依赖这个数字）。
export const WECOM_HOST = 'qyapi.weixin.qq.com'
export const WECOM_PATH = '/cgi-bin/webhook/send'
export const WECOM_MARKDOWN_MAX = 4096
export const WECOM_TEXT_MAX = 2048
export const FIXTURE_KEY = 'e1f2a3b4-5566-7788-99aa-bbccddeeff00'

const encoder = new TextEncoder()
const bytesOf = (s: string): number => encoder.encode(s).length

export interface WeComCall {
  url: string
  method: string
  contentType: string
  msgtype: unknown
  content: string
  contentBytes: number
  at: number
}

/** 官方信封：成功 `{"errcode":0,"errmsg":"ok"}`，失败 `{"errcode":<非0>,"errmsg":<描述>}`。 */
const ok = (): Response =>
  new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })

const errcodeReply = (errcode: number, errmsg: string): Response =>
  new Response(JSON.stringify({ errcode, errmsg }), { status: 200, headers: { 'content-type': 'application/json' } })

export interface FakeWeComOptions {
  /** 期望的 key；不匹配时按官方 93000 invalid webhook url 回答。 */
  key?: string
  /** 注入的失败码队列（按调用顺序消费，最后一项重复使用）；每项为官方 errcode。 */
  errcodes?: number[]
  /** 注入的 HTTP 状态队列（非 2xx 走 HTTP 分支）。 */
  statuses?: number[]
  /** 注入的原始 body（用于「2xx 但不是官方 JSON」形状）。 */
  rawBodies?: string[]
  /** 每次调用的等待毫秒（超时用例）。 */
  delayMs?: number
}

export class FakeWeCom {
  readonly key: string
  calls: WeComCall[] = []
  /** 报文违规记录；正常路径必须为空数组。 */
  violations: string[] = []
  private readonly errcodes: number[]
  private readonly statuses: number[]
  private readonly rawBodies: string[]
  private readonly delayMs: number

  constructor(opts: FakeWeComOptions = {}) {
    this.key = opts.key ?? FIXTURE_KEY
    this.errcodes = opts.errcodes ?? []
    this.statuses = opts.statuses ?? []
    this.rawBodies = opts.rawBodies ?? []
    this.delayMs = opts.delayMs ?? 0
  }

  /** 传给客户端的 fetch 实现。`at` 由调用方时钟决定，方便断言节流间隔。 */
  fetch(clock: () => number = () => 0): typeof fetch {
    const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input))
      const raw = typeof init?.body === 'string' ? init.body : ''
      const headers = new Headers(init?.headers as Record<string, string> | undefined)
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        this.violations.push('body 不是 JSON')
      }
      const msgtype = parsed.msgtype
      const group = ((parsed[String(msgtype)] ?? {}) as { content?: unknown }).content
      const content = typeof group === 'string' ? group : ''
      this.calls.push({
        url: url.toString(),
        method: String(init?.method ?? 'GET'),
        contentType: headers.get('content-type') ?? '',
        msgtype,
        content,
        contentBytes: bytesOf(content),
        at: clock(),
      })

      // ---- 独立校验（按官方规则，不看客户端实现）----
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      if (url.protocol !== 'https:') this.violations.push('不是 https')
      if (url.host !== WECOM_HOST) this.violations.push(`域名不是 ${WECOM_HOST}：${url.host}`)
      if (url.pathname !== WECOM_PATH) this.violations.push(`路径不是 ${WECOM_PATH}：${url.pathname}`)
      if (url.searchParams.getAll('key').length !== 1) this.violations.push('key 查询参数必须且只能有一个')
      if (init?.method !== 'POST') this.violations.push(`方法必须是 POST：${String(init?.method)}`)
      if (!headers.get('content-type')?.toLowerCase().includes('application/json')) this.violations.push('content-type 必须是 application/json')
      if (msgtype !== 'markdown' && msgtype !== 'text') this.violations.push(`msgtype 非法：${String(msgtype)}`)
      if (content === '') this.violations.push('content 为空')

      const status = this.statuses.shift()
      if (status !== undefined) {
        const rawBody = this.rawBodies.length > 0 ? this.rawBodies.shift()! : JSON.stringify({ errcode: 0, errmsg: 'ok' })
        return new Response(rawBody, { status, headers: { 'content-type': 'application/json' } })
      }
      if (this.rawBodies.length > 0) {
        return new Response(this.rawBodies.shift()!, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.searchParams.get('key') !== this.key) return errcodeReply(93000, 'invalid webhook url')

      const errcode = this.errcodes.shift()
      if (errcode !== undefined) return errcode === 0 ? ok() : errcodeReply(errcode, errcode === 45009 ? 'api freq out of limit' : `fake errmsg ${errcode}`)

      const limit = msgtype === 'markdown' ? WECOM_MARKDOWN_MAX : WECOM_TEXT_MAX
      if (content !== '' && bytesOf(content) > limit) {
        this.violations.push(`content 超过 ${limit} 字节：${bytesOf(content)}`)
        return errcodeReply(41000, 'content too long')
      }
      if (this.violations.length > 0) return errcodeReply(41000, this.violations[this.violations.length - 1] ?? 'invalid parameter')
      return ok()
    }
    return impl as unknown as typeof fetch
  }

  /** 最近一次调用的 content（断言正文没有夹带自由文本用）。 */
  lastContent(): string {
    return this.calls[this.calls.length - 1]?.content ?? ''
  }
}
