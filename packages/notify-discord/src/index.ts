// SPDX-License-Identifier: CPAL-1.0
// @gitrader/notify-discord 入口：通知文本纯函数 + Discord execute-webhook 客户端（不含内核接线）。
export { MAX_CONTENT, chunkContent, escapeDiscordMarkdown, renderNotice } from './format'
export type { NoticeFields } from './format'
export { DISCORD_HOSTS, WebhookUrlError, isAllowedHost, parseWebhookUrl, redactText, redactWebhookUrl, scrubWebhookUrls } from './url'
export type { WebhookTarget, WebhookUrlProblem } from './url'
export { USER_AGENT, buildExecuteRequest, buildMessageBody } from './request'
export type { ExecuteOptions, ExecuteRequest } from './request'
export { classifyResponse, parseRetryAfter } from './response'
export type { WebhookVerdict } from './response'
export { DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRY_AFTER_MS, DEFAULT_TIMEOUT_MS, DiscordWebhookClient } from './client'
export type { DiscordWebhookClientOptions, ExecuteResult } from './client'
