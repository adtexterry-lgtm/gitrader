// SPDX-License-Identifier: CPAL-1.0
// @gitrader/notify-wecom 入口：通知文本纯函数 + 企业微信群机器人 webhook 客户端（不含内核接线）。
export {
  MARKDOWN_MAX_BYTES,
  TEXT_MAX_BYTES,
  chunkByBytes,
  renderNoticeMarkdown,
  renderNoticeText,
  sanitizeField,
  utf8Bytes,
} from './format'
export type { NoticeFields } from './format'
export {
  ALLOWED_HOST,
  DEFAULT_BASE_URL,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  ERRCODE_INVALID_KEY,
  ERRCODE_OK,
  ERRCODE_RATE_LIMITED,
  ERRCODE_SYSTEM_BUSY,
  WEBHOOK_PATH,
  WeComClient,
  WeComConfigError,
  WeComError,
  parseWebhookUrl,
  redactSecret,
} from './client'
export type { WeComClientOptions } from './client'
