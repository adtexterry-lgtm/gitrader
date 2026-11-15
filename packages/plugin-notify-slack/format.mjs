// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-slack/src/format.ts（以库为准）。插件由内核以 Node 子进程拉起、cwd = 插件目录，
// 不能 import 工作区包，所以这里保留一份 JS 版；改逻辑请先改库再同步回来（test/parity.test.ts 会比对两边输出）。
// 官方依据见库文件头：mrkdwn 转义 & < >，body 只有 { text }，text 上限 40000。

/** Slack 单条消息 text 上限（40000 字符）。 */
export const MAX_TEXT = 40000

/** `&` → `&amp;`，`<` → `&lt;`，`>` → `&gt;`（& 先转，避免二次转义）。 */
export function escapeSlackText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const LEVEL_LABEL = { info: '[INFO]', warn: '[WARN]', critical: '[CRIT]' }

/**
 * 固定模板：`[LEVEL] *title*`，随后每条 lines 一行，末行 ISO 时间（有 ts 时）。
 * 只转义、不改写、不截断；调用方不要再套一层转义（会二次转义）。
 */
export function renderNotice(n) {
  const level = n.level === 'warn' || n.level === 'critical' ? n.level : 'info'
  const out = [`${LEVEL_LABEL[level]} *${escapeSlackText(n.title)}*`]
  for (const line of n.lines) out.push(escapeSlackText(line))
  if (n.ts !== undefined) out.push(new Date(n.ts).toISOString())
  return out.join('\n')
}

/** 渲染并校验尺寸：超出上限抛 RangeError（不拆分发送）。 */
export function renderNoticeText(n) {
  const text = renderNotice(n)
  if (text.length > MAX_TEXT) throw new RangeError(`notice text too long: ${text.length} > ${MAX_TEXT} characters`)
  return text
}
