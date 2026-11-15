// SPDX-License-Identifier: CPAL-1.0
// 通知文本的纯函数层：Discord Markdown 子集转义、按行分块（2000 字符上限）、固定模板渲染。
// 2000 字符上限出自官方 Execute Webhook 的 content 字段：
// https://discord.com/developers/docs/resources/webhook#execute-webhook
// 时间戳用 Discord 的 Unix 时间戳格式 <t:秒:f>：
// https://discord.com/developers/docs/reference#message-formatting

/** Discord 单条消息 content 上限（官方 Execute Webhook：up to 2000 characters）。 */
export const MAX_CONTENT = 2000

/**
 * 会被客户端当作格式标记的字符。反斜杠转义是客户端行为，官方文档没有逐字列出可转义字符表，
 * 转义集按客户端实际支持的字面量取（见 README「未覆盖」一节）。
 */
const ESCAPABLE = new Set(['\\', '*', '_', '~', '`', '|', '>', '[', ']'])

/** 给格式字符加反斜杠，让动态文本按字面显示。 */
export function escapeDiscordMarkdown(text: string): string {
  let out = ''
  for (const ch of text) out += ESCAPABLE.has(ch) ? `\\${ch}` : ch
  return out
}

/**
 * 按行切，不在行中间断；单行超过 max 时按码点硬切（不切开代理对）。空文本 → []。
 */
export function chunkContent(text: string, max = MAX_CONTENT): string[] {
  if (text.length === 0) return []
  if (!Number.isFinite(max) || max < 1) throw new RangeError('max must be a positive integer')

  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
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

export interface NoticeFields {
  title: string
  lines: string[]
  ts?: number
  level?: 'info' | 'warn' | 'critical'
}

const LEVEL_LABEL = { info: '[INFO]', warn: '[WARN]', critical: '[CRIT]' } as const

/**
 * 固定模板：第一行 level 标记 + title，随后每条 lines 一行，末行 Discord 时间戳（有 ts 时）。
 * 动态文本一律走转义；不加品牌文案、不加表情符号、不改写事实。
 */
export function renderNotice(n: NoticeFields): string {
  const level = n.level ?? 'info'
  const title = escapeDiscordMarkdown(n.title)
  const out: string[] = [title === '' ? `**${LEVEL_LABEL[level]}**` : `**${LEVEL_LABEL[level]}** ${title}`]
  for (const line of n.lines) out.push(escapeDiscordMarkdown(line))
  if (n.ts !== undefined) out.push(`<t:${Math.floor(n.ts / 1000)}:f>`)
  return out.join('\n')
}
