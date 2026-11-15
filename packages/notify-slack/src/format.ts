// SPDX-License-Identifier: CPAL-1.0
// Slack 通知文本的纯函数层：mrkdwn 转义、固定模板渲染、尺寸上限。
//
// 官方依据（消息体与转义规则）：
//   - Incoming Webhook 接受 POST + JSON `{ "text": "..." }`，成功回 200 + 纯文本 `ok`：
//     https://api.slack.com/messaging/webhooks
//   - 消息正文里 `&` `<` `>` 必须写成 `&amp;` `&lt;` `&gt;`（mrkdwn 转义）：
//     https://api.slack.com/reference/surfaces/formatting#escaping
//   - 单条消息 text 上限 40000 字符（chat.postMessage 的 text 上限，webhook 同一份消息体）：
//     https://api.slack.com/methods/chat.postMessage
//
// 与 packages/notify-webhook 的 slack 方言保持一致：body 只有 `{ text }`，标题用 `*加粗*`。

export interface NoticeFields {
  title: string
  lines: string[]
  ts?: number
  level?: 'info' | 'warn' | 'critical'
}

/** Slack 单条消息 text 上限（40000 字符）。超过它不拆分、不截断：一条接管只发一条消息。 */
export const MAX_TEXT = 40000

/**
 * Slack mrkdwn 转义：`&` → `&amp;`，`<` → `&lt;`，`>` → `&gt;`。
 * 顺序必须是 `&` 先，否则会把 `&lt;` 里的 `&` 再转义一次。
 * 转义后 `<@U123>` / `<!channel>` / `<https://x|label>` 都不可能成立（不会误 @ 人或造链接）。
 */
export function escapeSlackText(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const LEVEL_LABEL = { info: '[INFO]', warn: '[WARN]', critical: '[CRIT]' } as const

/**
 * 固定模板：第一行 `[LEVEL] *title*`，随后每条 lines 一行，末行 ISO 时间（有 ts 时）。
 * 动态文本只做转义，不改写、不截断、不加别的标记。无品牌文案、无表情符号。
 */
export function renderNotice(n: NoticeFields): string {
  const level = n.level === 'warn' || n.level === 'critical' ? n.level : 'info'
  const out: string[] = [`${LEVEL_LABEL[level]} *${escapeSlackText(n.title)}*`]
  for (const line of n.lines) out.push(escapeSlackText(line))
  if (n.ts !== undefined) out.push(new Date(n.ts).toISOString())
  return out.join('\n')
}

/**
 * 渲染并做尺寸校验：超出 Slack 上限抛 RangeError。
 * 调用方（客户端 / 插件）据此报错，不把长文拆成多条——同一接管只发一条。
 */
export function renderNoticeText(n: NoticeFields): string {
  const text = renderNotice(n)
  if (text.length > MAX_TEXT) throw new RangeError(`notice text too long: ${text.length} > ${MAX_TEXT} characters`)
  return text
}
