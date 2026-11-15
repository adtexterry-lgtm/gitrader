// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-discord/src/format.ts（以库为准）。插件由内核以 Node 子进程拉起、cwd = 插件目录，
// 不能 import 工作区包，所以这里保留一份 JS 版；改逻辑请先改库再同步回来。
// 2000 字符上限出自官方 Execute Webhook 的 content 字段：
//   https://discord.com/developers/docs/resources/webhook#execute-webhook

/** Discord 单条消息 content 上限。 */
export const MAX_CONTENT = 2000

/** 会被客户端当作格式标记的字符（同库：`\ * _ ~ ` | > [ ]`）。 */
const ESCAPABLE = new Set(['\\', '*', '_', '~', '`', '|', '>', '[', ']'])

/** 给格式字符加反斜杠，让动态文本按字面显示。 */
export function escapeDiscordMarkdown(text) {
  let out = ''
  for (const ch of text) out += ESCAPABLE.has(ch) ? `\\${ch}` : ch
  return out
}

/** 按行切，不在行中间断；单行超过 max 时按码点硬切（不切开代理对）。空文本 → []。 */
export function chunkContent(text, max = MAX_CONTENT) {
  if (text.length === 0) return []
  if (!Number.isFinite(max) || max < 1) throw new RangeError('max must be a positive integer')

  const chunks = []
  let current = ''
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current)
      current = ''
    }
  }

  for (const line of text.split('\n')) {
    if (line.length > max) {
      flush()
      let piece = ''
      for (const ch of line) {
        if (piece.length + ch.length > max) {
          chunks.push(piece)
          piece = ''
        }
        piece += ch
      }
      if (piece.length > 0) chunks.push(piece)
      continue
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`
    if (candidate.length > max) {
      flush()
      current = line
    } else {
      current = candidate
    }
  }
  flush()
  return chunks
}

const LEVEL_LABEL = { info: '[INFO]', warn: '[WARN]', critical: '[CRIT]' }

/**
 * 固定模板：第一行 level 标记 + title，随后每条 lines 一行，末行 Discord 时间戳（有 ts 时）。
 * 注意：本函数已把 title / lines 转义过，调用方不要再套一层 escapeDiscordMarkdown（会二次转义）。
 */
export function renderNotice(n) {
  const level = n.level ?? 'info'
  const title = escapeDiscordMarkdown(n.title)
  const out = [title === '' ? `**${LEVEL_LABEL[level] ?? LEVEL_LABEL.info}**` : `**${LEVEL_LABEL[level] ?? LEVEL_LABEL.info}** ${title}`]
  for (const line of n.lines) out.push(escapeDiscordMarkdown(line))
  if (n.ts !== undefined) out.push(`<t:${Math.floor(n.ts / 1000)}:f>`)
  return out.join('\n')
}
