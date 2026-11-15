// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-wecom/src/format.ts（以库为准；插件不能 import 工作区包）。
// 企业微信群机器人消息的渲染、UTF-8 字节计量与按字节分块。
// 依据官方文档「群机器人配置说明」https://developer.work.weixin.qq.com/document/path/91770 ：
// markdown content ≤ 4096 字节、text content ≤ 2048 字节，均 UTF-8；上限按字节而不是字符。

export const MARKDOWN_MAX_BYTES = 4096
export const TEXT_MAX_BYTES = 2048

const encoder = new TextEncoder()

export function utf8Bytes(text) {
  return encoder.encode(text).length
}

/** 按行切、行不跨块；单行超限时在码位边界硬切（不切开汉字 / 代理对）。空文本 → []。 */
export function chunkByBytes(text, maxBytes) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (!Number.isFinite(maxBytes) || maxBytes < 4) throw new RangeError('maxBytes must be a number >= 4')
  if (text.length === 0) return []

  const chunks = []
  let current = ''
  let currentBytes = 0
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
  }

  for (const line of text.split('\n')) {
    const lineBytes = utf8Bytes(line)
    if (lineBytes > maxBytes) {
      flush()
      for (const piece of hardSplit(line, maxBytes)) chunks.push(piece)
      continue
    }
    const candidateBytes = current.length === 0 ? lineBytes : currentBytes + 1 + lineBytes
    if (candidateBytes > maxBytes) {
      flush()
      current = line
      currentBytes = lineBytes
    } else {
      current = current.length === 0 ? line : `${current}\n${line}`
      currentBytes = candidateBytes
    }
  }
  flush()
  return chunks
}

function hardSplit(line, maxBytes) {
  const out = []
  let buf = ''
  let bytes = 0
  for (const ch of line) {
    const n = utf8Bytes(ch)
    if (bytes + n > maxBytes) {
      out.push(buf)
      buf = ''
      bytes = 0
    }
    buf += ch
    bytes += n
  }
  if (buf.length > 0) out.push(buf)
  return out
}

/** 字段清洗：字段内换行折成空格、去掉其余控制字符（不改写文字，只保证一行一个字段）。 */
export function sanitizeField(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n|[\r\n]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .trim()
}

/** 结构字符转义；只用于正文与标题，不用于插件自己生成的模板前缀（如 `### [WARN]`）。 */
export function escapeMarkdownStructure(text) {
  if (typeof text !== 'string') return ''
  // 逐行处理：行首 # / > 会变成标题或引用，先换掉；再逐字符处理链接与 HTML 标签的开头。
  return text
    .split('\n')
    .map((line) => {
      let head = line
      head = head.replace(/^#+/, (run) => '＃'.repeat(run.length)).replace(/^>+/, (run) => '＞'.repeat(run.length))
      let out = ''
      for (let i = 0; i < head.length; i++) {
        const ch = head[i]
        if (ch === '[') out += '［'
        else if (ch === ']') out += '］'
        else if (ch === '(') out += '（'
        else if (ch === ')') out += '）'
        // 只有标签样式的 `<`（后接字母或 /）才换掉：`1200 > 1000` 这类比较符保持原样。
        else if (ch === '<' && /[A-Za-z/]/.test(head[i + 1] ?? '')) out += '＜'
        else out += ch
      }
      return out
    })
    .join('\n')
}

const LEVEL_LABEL = { info: 'INFO', warn: 'WARN', critical: 'CRIT' }

function levelOf(notice) {
  return notice.level === 'warn' || notice.level === 'critical' ? notice.level : 'info'
}

function isoOf(ts) {
  return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

/** markdown 形态：`### [级别] 标题` + 逐行事实 + ISO 时间行内代码。 */
export function renderNoticeMarkdown(notice) {
  const title = escapeMarkdownStructure(sanitizeField(notice.title))
  const out = [`### [${LEVEL_LABEL[levelOf(notice)]}]${title.length > 0 ? ` ${title}` : ''}`]
  for (const line of notice.lines) out.push(escapeMarkdownStructure(sanitizeField(line)))
  const iso = isoOf(notice.ts)
  if (iso !== null) out.push(`\`${iso}\``)
  return out.join('\n')
}

/** text 形态（2048 字节上限）：首行 `[级别] 标题` + 逐行事实 + 裸 ISO 时间。 */
export function renderNoticeText(notice) {
  const title = sanitizeField(notice.title)
  const out = [`[${LEVEL_LABEL[levelOf(notice)]}]${title.length > 0 ? ` ${title}` : ''}`]
  for (const line of notice.lines) out.push(sanitizeField(line))
  const iso = isoOf(notice.ts)
  if (iso !== null) out.push(iso)
  return out.join('\n')
}
