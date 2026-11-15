// SPDX-License-Identifier: CPAL-1.0
// @gitrader/notify-webhook 入口：方言识别 + 厂商签名 + 请求构造 + 响应校验 + 可注入的 WebhookClient（不含内核接线）。
export { detectWebhookDialect } from './dialect'
export type { WebhookDialect } from './dialect'
export { signDingtalk, signFeishu } from './sign'
export { buildWebhookRequest } from './request'
export type { WebhookRequest, WebhookRequestOptions } from './request'
export { isRetryableStatus, validateWebhookResponse } from './response'
export type { WebhookVerdict } from './response'
export { WebhookClient, isSecureWebhookUrl, webhookUrlKind } from './client'
export type { WebhookClientOptions, WebhookSendOptions, WebhookSendResult } from './client'
export { redactSecret } from './secret'
export { escapeMarkdownStructure } from './markdown'
