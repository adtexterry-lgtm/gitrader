// SPDX-License-Identifier: CPAL-1.0
// 通知文本的纯函数层：Telegram MarkdownV2 转义、按行分块、固定模板渲染。
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/signal_notifier.py:529; adapted (brand copy removed).

/**
 * Telegram MarkdownV2 保留字符：规范列的 18 个，外加反斜杠自身。
 * 反斜杠必须一起转义；否则正文里的 `\` 会与后一个转义前缀合成 `\\`，把它后面的标记字符放回未转义状态，
 * 行尾单反斜杠还会让整条消息 400 can't parse entities。
 */
const RESERVED = new Set(['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '\\'])

/** 逐个给 MarkdownV2 保留字符（含反斜杠自身）加反斜杠。 */
export function escapeMarkdownV2(text: string): string {
  let out = ''
  for (const ch of text) out += RESERVED.has(ch) ? `\\${ch}` : ch
  return out
}

/** 按行切，不在行中间断；单行超过 max 时再硬切。空文本 → []。 */
export function chunkMessage(text: string, max = 4096): string[] {
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
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max))
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

// MarkdownV2 里方括号是保留字符，标记也要转义
const LEVEL_LABEL = { info: '\\[INFO\\]', warn: '\\[WARN\\]', critical: '\\[CRIT\\]' } as const

/** 代码跨度内只需转义反斜杠与反引号（MarkdownV2 规范）。 */
function codeSpan(text: string): string {
  return `\`${text.replace(/[\\`]/g, (m) => `\\${m}`)}\``
}

/**
 * 固定模板：第一行 level 标记 + 加粗 title，随后每条 lines 一行，末行 ISO 时间（有 ts 时）。
 * 动态文本走 MarkdownV2 转义；无品牌文案、无表情符号。
 */
export function renderNotice(n: NoticeFields): string {
  const level = n.level ?? 'info'
  const out: string[] = [`${LEVEL_LABEL[level]} *${escapeMarkdownV2(n.title)}*`]
  for (const line of n.lines) out.push(escapeMarkdownV2(line))
  if (n.ts !== undefined) out.push(codeSpan(new Date(n.ts).toISOString()))
  return out.join('\n')
}
