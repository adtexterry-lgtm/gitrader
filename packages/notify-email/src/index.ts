// SPDX-License-Identifier: CPAL-1.0
// @gitrader/notify-email 入口：SMTP 发送客户端 + MIME 构造 + 通知模板渲染（不含内核接线）。
export { SmtpClient, nodeConnector, isValidSmtpHost } from './smtp'
export type { ConnectParams, SendResult, SmtpConnection, SmtpConnector, SmtpOptions } from './smtp'
export { addressOnly, buildMime, dotStuff, escapeHtml, formatRfc5322Date, newMessageId } from './mime'
export type { Mail, MimeOptions } from './mime'
export { renderMail } from './render'
export type { MailRenderInput, RenderedMail } from './render'
export { redactSecret } from './secret'
