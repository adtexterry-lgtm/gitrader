// SPDX-License-Identifier: CPAL-1.0
// @gitrader/notify-telegram 入口：通知文本纯函数 + Telegram 发送客户端（不含内核接线）。
export { escapeMarkdownV2, chunkMessage, renderNotice } from './format'
export type { NoticeFields } from './format'
export { TelegramClient, redactToken } from './telegram'
export type { TelegramClientOptions } from './telegram'
