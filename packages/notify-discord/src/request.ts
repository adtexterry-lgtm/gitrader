// SPDX-License-Identifier: CPAL-1.0
// Execute Webhook 请求构造（纯函数，不发网络）。字段与查询参数以官方文档为准：
//   https://discord.com/developers/docs/resources/webhook#execute-webhook
// 只用两个查询参数：wait（返回创建出来的 message 对象）、thread_id（发到指定 thread）；
// body 只用 content / username / allowed_mentions，其余字段（embeds、components、files）本通道不产生。
import { MAX_CONTENT } from './format'
import { WebhookUrlError, parseWebhookUrl } from './url'
import type { WebhookTarget } from './url'

/** 官方要求客户端带可识别的 User-Agent（DiscordBot ($url, $versionNumber)）。 */
export const USER_AGENT = 'DiscordBot (local/plugin-notify-discord, 0.1.0)'

export interface ExecuteRequest {
  url: string
  body: string
  headers: Record<string, string>
}

export interface ExecuteOptions {
  /** 发到指定 thread（官方 query thread_id，snowflake 十进制串）。 */
  threadId?: string
  /** 覆盖 webhook 默认用户名（官方 body username）。 */
  username?: string
}

/** snowflake 只接受十进制串（官方 HTTP API 一律以字符串返回 ID）。 */
const SNOWFLAKE = /^\d{5,25}$/

function targetOf(target: WebhookTarget | string): WebhookTarget {
  if (typeof target === 'string') return parseWebhookUrl(target)
  if (!target || typeof target.url !== 'string' || typeof target.token !== 'string') {
    throw new WebhookUrlError('not_a_url', 'webhook target 形状不对')
  }
  return target
}

/**
 * 消息 body：`content` + `allowed_mentions.parse = []`。
 * 空数组是官方的「谁都不提及」写法——通知正文里的 @everyone / 角色 / 用户提及一律不触发通知，
 * 这样即使上游把用户输入的字符串塞进通知，也不会变成一次全体 @。
 */
export function buildMessageBody(content: string, options: ExecuteOptions = {}): Record<string, unknown> {
  if (typeof content !== 'string' || content.trim() === '') throw new RangeError('content must be a non-empty string')
  if (content.length > MAX_CONTENT) throw new RangeError(`content exceeds ${MAX_CONTENT} characters`)
  const body: Record<string, unknown> = { content, allowed_mentions: { parse: [] } }
  if (typeof options.username === 'string' && options.username.trim() !== '') body.username = options.username.trim()
  return body
}

/** 构造一次 execute 请求；`wait=true` 让 Discord 回 message 对象，从中取 message id 当 ref。 */
export function buildExecuteRequest(
  target: WebhookTarget | string,
  content: string,
  options: ExecuteOptions = {},
): ExecuteRequest {
  const webhook = targetOf(target)
  const body = buildMessageBody(content, options)
  const url = new URL(webhook.url)
  url.searchParams.set('wait', 'true')
  if (options.threadId !== undefined) {
    if (!SNOWFLAKE.test(options.threadId)) throw new RangeError('threadId must be a snowflake string')
    url.searchParams.set('thread_id', options.threadId)
  }
  return {
    url: url.toString(),
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
  }
}
