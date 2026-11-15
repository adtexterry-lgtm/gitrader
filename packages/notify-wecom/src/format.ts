// SPDX-License-Identifier: CPAL-1.0
// 通知文本的纯函数层：企业微信群机器人消息的渲染、UTF-8 字节计量与按字节分块。
// 格式与长度上限以企业微信官方文档「群机器人配置说明」为准：
//   https://developer.work.weixin.qq.com/document/path/91770
//   markdown 消息 content 上限 4096 字节；text 消息 content 上限 2048 字节；均为 UTF-8 编码。
// 与 Telegram 通道的区别（同目录 README 有对照表）：上限按**字节**而不是字符，中文一个字 3 字节，
// 所以分块必须按字节算，且不能把一个码位（含代理对）切开。

/** 企业微信 markdown 消息 content 的字节上限。 */
export const MARKDOWN_MAX_BYTES = 4096
/** 企业微信 text 消息 content 的字节上限。 */
export const TEXT_MAX_BYTES = 2048

const encoder = new TextEncoder()

/** 字符串的 UTF-8 字节数（按官方上限判定，不用 `String.length`）。 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/**
 * 按行切，行不跨块；单行超过上限时在**码位边界**硬切（不切开代理对 / 不产生半个汉字）。
 * 空文本 → []。上限按 UTF-8 字节。
 */
export function chunkByBytes(text: string, maxBytes: number): string[] {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (!Number.isFinite(maxBytes) || maxBytes < 4) throw new RangeError('maxBytes must be a number >= 4')

  if (text.length === 0) return []

  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  const flush = (): void => {
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

/** 单行按字节硬切，只在码位边界落刀。 */
function hardSplit(line: string, maxBytes: number): string[] {
  const out: string[] = []
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

/**
 * 字段清洗：把字段内的换行（\r\n / \r / \n）折成一个空格，去掉其余 C0 / C1 控制字符。
 * 不改写文字内容，只保证「一行就是一个字段」——否则一行里的换行能把标题结构伪造进正文。
 */
export function sanitizeField(text: string): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n|[\r\n]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .trim()
}

/** markdown 结构字符 → 同形全角字符（企业微信 markdown 不认反斜杠转义，L5-14）。 */
/** 把正文里的结构字符换成全角同形字符；行首 `#` 单独处理。只用于正文，不用于模板前缀。 */
export function escapeMarkdownStructure(text: string): string {
  if (typeof text !== 'string') return ''
  // 逐行处理：行首 # / > 会变成标题或引用，先换掉；再逐字符处理链接与 HTML 标签的开头。
  return text
    .split('\n')
    .map((line) => {
      let head = line
      head = head.replace(/^#+/, (run) => '＃'.repeat(run.length)).replace(/^>+/, (run) => '＞'.repeat(run.length))
      let out = ''
      for (let i = 0; i < head.length; i++) {
        const ch = head[i]!
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

export interface NoticeFields {
  title: string
  lines: string[]
  ts?: number
  level?: 'info' | 'warn' | 'critical'
}

/** 级别标记用纯文本方括号：企业微信 markdown 的 `<font color>` 只认 info / comment / warning 三色，不覆盖 critical。 */
const LEVEL_LABEL = { info: 'INFO', warn: 'WARN', critical: 'CRIT' } as const

function levelOf(n: NoticeFields): keyof typeof LEVEL_LABEL {
  const level = n.level
  return level === 'warn' || level === 'critical' ? level : 'info'
}

function isoLine(ts: number | undefined): string | null {
  if (ts === undefined || !Number.isFinite(ts)) return null
  return `\`${new Date(ts).toISOString()}\``
}

/**
 * markdown 形态：`### [级别] 标题`（官方文档支持 1–6 级标题与加粗），随后每条 lines 一行，
 * 末行 ISO 时间（有 ts 时）用行内代码包住。无品牌文案、无表情符号、不做自由文本。
 */
export function renderNoticeMarkdown(n: NoticeFields): string {
  const title = escapeMarkdownStructure(sanitizeField(n.title))
  const heading = `### [${LEVEL_LABEL[levelOf(n)]}]${title.length > 0 ? ` ${title}` : ''}`
  const out: string[] = [heading]
  for (const line of n.lines) out.push(escapeMarkdownStructure(sanitizeField(line)))
  const ts = isoLine(n.ts)
  if (ts !== null) out.push(ts)
  return out.join('\n')
}

/** text 形态（上限 2048 字节）：首行 `[级别] 标题`，随后逐行正文，末行 ISO 时间。 */
export function renderNoticeText(n: NoticeFields): string {
  const title = sanitizeField(n.title)
  const out: string[] = [`[${LEVEL_LABEL[levelOf(n)]}]${title.length > 0 ? ` ${title}` : ''}`]
  for (const line of n.lines) out.push(sanitizeField(line))
  const ts = isoLine(n.ts)
  if (ts !== null) out.push(new Date(n.ts as number).toISOString())
  return out.join('\n')
}
