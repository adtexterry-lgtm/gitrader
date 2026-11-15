// SPDX-License-Identifier: CPAL-1.0
// 按方言构造 Webhook 请求：URL（含签名查询参数）、JSON body 字符串、请求头。
// 起点复制自 packages/kernel/src/notify/webhook.ts，补齐 QD 的企业微信方言、Markdown / 纯文本两种形态与标题排版。
import type { WebhookDialect } from './dialect'
import { signDingtalk, signFeishu } from './sign'

export interface WebhookRequestOptions {
  /** 签名密钥；只参与签名 / 查询参数，不出现在返回值以外的任何地方（也不会被打印）。 */
  secret?: string
  /** 标题：Markdown 方言渲染成标题行，纯文本方言渲染成首行。 */
  title?: string
  /** 消息体形态；缺省按方言取默认（feishu / generic 纯文本，其余 Markdown）。 */
  markdown?: boolean
  /** 当前毫秒时间戳；缺省 Date.now()。签名时间戳由它派生。 */
  now?: number
}

export interface WebhookRequest {
  url: string
  body: string
  headers: Record<string, string>
}

const JSON_HEADERS: Readonly<Record<string, string>> = { 'Content-Type': 'application/json; charset=utf-8' }

/** 各方言的默认消息体形态：有原生 markdown 类型的用 Markdown，飞书默认走 text（卡片需额外结构）。 */
const DEFAULT_MARKDOWN: Readonly<Record<WebhookDialect, boolean>> = {
  feishu: false,
  dingtalk: true,
  wecom: true,
  slack: true,
  discord: true,
  generic: false,
}

const TITLE_LIMIT = 64

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:105-137; adapted.
/**
 * 构造一次 Webhook 请求（纯函数，不发网络）。
 *
 * - feishu：`msg_type: text`；markdown 时改发 `msg_type: interactive` 卡片（`lark_md`）。有 secret 时 body 带
 *   `timestamp`（秒，字符串）与 `sign`。
 * - dingtalk：`msgtype: markdown`（`markdown.title` / `markdown.text`，`### 标题` 开头）或 `msgtype: text`；
 *   有 secret 时把 `timestamp`（毫秒）与 `sign` 拼到 URL 查询串。
 * - wecom：`msgtype: markdown`（`markdown.content`）或 `msgtype: text`（`text.content`）；密钥已在 URL 的 `key`
 *   参数里，本库不再签名。
 * - slack：`{ text }`；discord：`{ content }`；generic：`{ text }`。标题按方言加粗语法渲染。
 */
export function buildWebhookRequest(
  dialect: WebhookDialect,
  url: string,
  text: string,
  opts: WebhookRequestOptions = {},
): WebhookRequest {
  const body = typeof text === 'string' ? text : String(text)
  const title = typeof opts.title === 'string' ? opts.title.trim() : ''
  const markdown = typeof opts.markdown === 'boolean' ? opts.markdown : DEFAULT_MARKDOWN[dialect]
  const secret = typeof opts.secret === 'string' ? opts.secret.trim() : ''
  const nowMs = typeof opts.now === 'number' && Number.isFinite(opts.now) ? Math.floor(opts.now) : Date.now()

  if (dialect === 'feishu') {
    const payload: Record<string, unknown> = markdown
      ? {
        msg_type: 'interactive',
        card: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: withTitle(title, body, '**') } }] },
      }
      : { msg_type: 'text', content: { text: withTitle(title, body, '') } }
    if (secret) {
      const timestampSec = Math.floor(nowMs / 1000)
      payload.timestamp = String(timestampSec)
      payload.sign = signFeishu(secret, timestampSec)
    }
    return { url, body: JSON.stringify(payload), headers: { ...JSON_HEADERS } }
  }

  if (dialect === 'dingtalk') {
    const payload = markdown
      ? { msgtype: 'markdown', markdown: { title: headingOf(title, body), text: headed(title, body) } }
      : { msgtype: 'text', text: { content: withTitle(title, body, '') } }
    let postUrl = url
    if (secret) {
      const timestampMs = nowMs
      const separator = postUrl.includes('?') ? '&' : '?'
      postUrl = `${postUrl}${separator}timestamp=${timestampMs}&sign=${signDingtalk(secret, timestampMs)}`
    }
    return { url: postUrl, body: JSON.stringify(payload), headers: { ...JSON_HEADERS } }
  }

  if (dialect === 'wecom') {
    const payload = markdown
      ? { msgtype: 'markdown', markdown: { content: headed(title, body) } }
      : { msgtype: 'text', text: { content: withTitle(title, body, '') } }
    return { url, body: JSON.stringify(payload), headers: { ...JSON_HEADERS } }
  }

  if (dialect === 'slack') {
    return { url, body: JSON.stringify({ text: withTitle(title, body, markdown ? '*' : '') }), headers: { ...JSON_HEADERS } }
  }

  if (dialect === 'discord') {
    return { url, body: JSON.stringify({ content: withTitle(title, body, markdown ? '**' : '') }), headers: { ...JSON_HEADERS } }
  }

  return { url, body: JSON.stringify({ text: withTitle(title, body, markdown ? '**' : '') }), headers: { ...JSON_HEADERS } }
}

/** 标题 + 正文拼成一段；marker 非空时标题用该标记包起来（`*` / `**`）。 */
function withTitle(title: string, body: string, marker: string): string {
  if (!title) return body
  return `${marker}${title}${marker}\n${body}`
}

/** Markdown 方言的正文：标题作二级 / 三级标题（QD 用 `### 标题` + 空行）。 */
function headed(title: string, body: string): string {
  return title ? `### ${title}\n\n${body}` : body
}

/** dingtalk markdown 必填的 `title` 字段：取标题，缺省取正文首行，按 QD 截到 64 字符。 */
function headingOf(title: string, body: string): string {
  const source = title || (body.split('\n', 1)[0] ?? '').trim()
  return source.length <= TITLE_LIMIT ? source : source.slice(0, TITLE_LIMIT)
}
