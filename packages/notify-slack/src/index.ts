// SPDX-License-Identifier: CPAL-1.0
// @gitrader/notify-slack 入口：通知文本纯函数 + Slack Incoming Webhook 客户端（不含内核接线）。
export { MAX_TEXT, escapeSlackText, renderNotice, renderNoticeText } from './format'
export type { NoticeFields } from './format'
export {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_TIMEOUT_MS,
  SlackClient,
  SlackError,
  assertSlackWebhookUrl,
  isRetryableStatus,
  parseSlackResponse,
  redactWebhookUrl,
} from './slack'
export type { SlackClientOptions, SlackVerdict, WebhookUrlPolicy } from './slack'
