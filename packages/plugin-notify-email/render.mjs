// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-email/src/render.ts（以该库为准）；JS 版，插件内单文件。
// 通知邮件的固定模板：纯文本 + HTML 两版。无品牌文案、无表情符号；动态文本在 HTML 版里一律转义。
import { escapeHtml } from './mime.mjs'

const LEVEL_LABEL = { info: '[INFO]', warn: '[WARN]', critical: '[CRIT]' }

/** 缺省 level 是 info；ts 有值时末行给出 ISO 时间。 */
export function renderMail(n) {
  const level = n.level === undefined || LEVEL_LABEL[n.level] === undefined ? 'info' : n.level
  const head = `${LEVEL_LABEL[level]} ${n.title}`
  const stamp = n.ts === undefined ? undefined : new Date(n.ts).toISOString()

  const textLines = [head, ...n.lines]
  if (stamp !== undefined) textLines.push(stamp)

  const htmlLines = [`<h2>${escapeHtml(head)}</h2>`]
  for (const line of n.lines) htmlLines.push(`<p>${escapeHtml(line)}</p>`)
  if (stamp !== undefined) htmlLines.push(`<p><code>${escapeHtml(stamp)}</code></p>`)

  return {
    subject: head,
    text: textLines.join('\n'),
    html: ['<!doctype html>', '<html><body>', ...htmlLines, '</body></html>'].join('\n'),
  }
}
