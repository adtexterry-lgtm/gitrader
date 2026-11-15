// SPDX-License-Identifier: CPAL-1.0
// Webhook URL 解析与脱敏。路由照官方 Execute Webhook：
//   POST /webhooks/{webhook.id}/{webhook.token}      （https://discord.com/developers/docs/resources/webhook#execute-webhook）
// 基址照官方 API Reference（https://discord.com/api，v10 版本号可写在路径里）。token 是密钥：任何对外文本都必须先过这里。

/** 允许的主机：官方 API 基址与 Discord 的 canary / ptb 前端域名。 */
export const DISCORD_HOSTS: readonly string[] = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']

/** URL 不接受时的问题码（测试与 reason 都用它，不带 token）。 */
export type WebhookUrlProblem =
  | 'not_a_url'
  | 'insecure_scheme'
  | 'host_not_allowed'
  | 'bad_path'
  | 'unsupported_route'
  | 'query_not_allowed'

export class WebhookUrlError extends Error {
  readonly problem: WebhookUrlProblem

  constructor(problem: WebhookUrlProblem, message: string) {
    super(message)
    this.name = 'WebhookUrlError'
    this.problem = problem
  }
}

export interface WebhookTarget {
  /** webhook id（snowflake，官方以字符串返回）。 */
  id: string
  /** webhook token：密钥，不进日志、不回传。 */
  token: string
  /** 规范化后的 execute URL（不带查询串）。 */
  url: string
}

// id 是 snowflake 十进制串；token 是大小写字母 / 数字 / . _ - 组成的长串。
const WEBHOOK_PATH = /^\/api\/webhooks\/(\d{5,25})\/([A-Za-z0-9._-]{16,})$/
const COMPAT_ROUTE = /\/(slack|github)\/?$/

/** 主机是否在允许清单里（大小写不敏感，精确匹配，不做后缀匹配）。 */
export function isAllowedHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return DISCORD_HOSTS.includes(normalized)
}

/**
 * 解析并校验 webhook URL。只接受 `https://<官方主机>/api/webhooks/<id>/<token>`：
 * 非 https、非官方主机、路径不符、`/slack` `/github` 兼容路由、带查询串，一律抛 WebhookUrlError。
 */
export function parseWebhookUrl(raw: unknown): WebhookTarget {
  if (typeof raw !== 'string' || raw.trim() === '') throw new WebhookUrlError('not_a_url', 'webhook URL 为空')
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new WebhookUrlError('not_a_url', 'webhook URL 不是合法 URL')
  }
  if (parsed.protocol !== 'https:') throw new WebhookUrlError('insecure_scheme', 'webhook URL 必须是 https')
  if (!isAllowedHost(parsed.hostname)) throw new WebhookUrlError('host_not_allowed', `不接受的主机：${parsed.hostname}`)
  if (COMPAT_ROUTE.test(parsed.pathname)) throw new WebhookUrlError('unsupported_route', '不支持 /slack 与 /github 兼容路由，请用原生 execute 路由')
  if (parsed.search !== '') throw new WebhookUrlError('query_not_allowed', 'webhook URL 不应带查询串：wait 与 thread_id 由客户端加')
  const match = WEBHOOK_PATH.exec(parsed.pathname)
  if (match === null) throw new WebhookUrlError('bad_path', 'webhook URL 路径应形如 /api/webhooks/<id>/<token>')
  const id = match[1] as string
  const token = match[2] as string
  return { id, token, url: `https://${parsed.hostname.toLowerCase()}/api/webhooks/${id}/${token}` }
}

/** 对外展示用的短形式：保留 id，token 换成 <redacted>；解析失败返回固定串（不回显原值）。 */
export function redactWebhookUrl(raw: unknown): string {
  try {
    const parsed = new URL(String(raw).trim())
    const match = /^\/api\/webhooks\/(\d{5,25})\/.*$/.exec(parsed.pathname)
    if (match !== null) return `https://${parsed.hostname.toLowerCase()}/api/webhooks/${match[1]}/<redacted>`
    return `https://${parsed.hostname.toLowerCase()}/<redacted>`
  } catch {
    return '<invalid webhook url>'
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/gi

/** 把文本里出现的 webhook URL 一律换成脱敏形式（其它 URL 不动）。 */
export function scrubWebhookUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trimmed = match.replace(/[).,;:!?]+$/, '')
    const suffix = match.slice(trimmed.length)
    if (/\/api\/webhooks\//.test(trimmed)) return `${redactWebhookUrl(trimmed)}${suffix}`
    if (/\/webhooks\//.test(trimmed)) return `${redactWebhookUrl(trimmed)}${suffix}`
    return match
  })
}

/**
 * 对外原因串脱敏：抹掉给定密钥（≥4 字符才算密钥，短的挡不住也没意义）+ 压成一行 + 截断。
 * reason 会进插件应答与日志，任何密钥都不得出现。
 */
export function redactText(text: unknown, secrets: readonly string[] = [], maxLength = 300): string {
  let out = text === undefined || text === null ? '' : String(text)
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length)
  for (const secret of list) out = out.split(secret).join('<redacted>')
  out = scrubWebhookUrls(out)
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out
}
