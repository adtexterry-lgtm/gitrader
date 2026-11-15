// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-email/src/mime.ts（以该库为准）；JS 版，插件进程只能读自己目录，因此不 import 工作区包。
// 邮件正文的纯函数层：RFC 5322 头、RFC 2047 主题编码、multipart/alternative、dot-stuffing、HTML 转义。
// 不碰网络、不读环境变量；正文行尾统一 CRLF，dot-stuffing 由 send 的实际投递阶段调用。
import { randomBytes } from 'node:crypto'

const CRLF = '\r\n'

/** HTML 特殊字符转义（正文里所有动态文本都要过它）。 */
export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

/** 头字段禁 CR/LF：防头注入，顺带压掉多余空白。 */
function headerValue(value) {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 单行头的软上限（RFC 5322 §2.1.1 建议 ≤78 字符；硬上限 998）。 */
const HEADER_LINE_MAX = 78

/** RFC 2047 编码词的固定外壳：`=?UTF-8?B?` + `?=`。 */
const ENCODED_WORD_SHELL = 12

/** RFC 2047 §2：单个编码词（含 `=?UTF-8?B?` 与 `?=` 外壳）不得超过 75 字符。 */
const ENCODED_WORD_MAX = 75

/** 按 UTF-8 字节数取一段：不切开多字节字符，至少取一个字；返回 [取的段, 剩下的]。 */
function takeByBytes(text, maxBytes) {
  let take = ''
  let cut = 0
  for (const ch of text) {
    if (take !== '' && Buffer.byteLength(take + ch, 'utf8') > maxBytes) break
    take += ch
    cut += ch.length
  }
  return [take, text.slice(cut)]
}

/** 把文本切成若干 RFC 2047 编码词：每行长度（含首行前缀预算）不超过上限，base64 长度取 4 的倍数。 */
function encodedWords(text, budgetFirst, budgetNext) {
  const out = []
  let rest = text
  let budget = budgetFirst
  while (rest !== '') {
    const maxB64 = Math.min(
      Math.max(4, Math.floor((budget - ENCODED_WORD_SHELL) / 4) * 4),
      Math.floor((ENCODED_WORD_MAX - ENCODED_WORD_SHELL) / 4) * 4,
    )
    const [chunk, tail] = takeByBytes(rest, (maxB64 / 4) * 3)
    out.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    rest = tail
    budget = budgetNext
  }
  return out
}

/**
 * 值 → 头行（批 11 主题二 ⑥；OSS-ADOPTION #12）：与库 src/mime.ts 的 foldHeader 同一实现，
 * 折行后每行 ≤78 字符，展开后语义不变：
 *   1. ASCII 且放得下 → 单行；
 *   2. ASCII 且能在原有空格处折 → 按空格折（展开 = 去掉 CRLF，与原值逐字相同）；
 *   3. 有超长单词或非 ASCII → RFC 2047 编码词分段（段间空白解码时忽略，原文一字不差）。
 */
function foldHeader(name, value) {
  const head = `${name}: `
  const nextBudget = HEADER_LINE_MAX - 1
  if (!/[^\x20-\x7E]/.test(value)) {
    if (head.length + value.length <= HEADER_LINE_MAX) return head + value
    const tokens = value.split(' ').filter((t) => t.length > 0)
    if (
      tokens.length > 0
      && tokens[0].length <= HEADER_LINE_MAX - head.length
      && tokens.every((t) => t.length <= nextBudget)
    ) {
      const lines = []
      let cur = tokens[0]
      let prefix = head.length
      for (const token of tokens.slice(1)) {
        if (prefix + cur.length + 1 + token.length <= HEADER_LINE_MAX) { cur += ` ${token}`; continue }
        lines.push([cur, prefix])
        cur = token
        prefix = 1
      }
      lines.push([cur, prefix])
      return lines.map(([line, offset], i) => `${i === 0 ? head : ' '.repeat(offset)}${line}`).join(CRLF)
    }
  }
  const words = encodedWords(value, HEADER_LINE_MAX - head.length, nextBudget)
  return words.map((w, i) => `${i === 0 ? head : ' '}${w}`).join(CRLF)
}

/** 只留地址部分：`Name <a@b>` → `a@b`；`<a@b>` → `a@b`。 */
export function addressOnly(value) {
  const trimmed = headerValue(value)
  const angle = /<([^>]*)>/.exec(trimmed)
  return (angle?.[1] ?? trimmed).trim()
}

/** 取地址的域名部分，用于 Message-ID 右侧；取不到时用 localhost。 */
function addressDomain(value) {
  const address = addressOnly(value)
  const at = address.lastIndexOf('@')
  const domain = at >= 0 ? address.slice(at + 1) : ''
  return domain.length > 0 ? domain : 'localhost'
}

/** 生成 `<random@domain>` 形态的 Message-ID。 */
export function newMessageId(from) {
  return `<${randomBytes(12).toString('hex')}@${addressDomain(from)}>`
}

/** RFC 5322 日期：`Wed, 21 Oct 2026 02:00:00 +0000`（缺省 UTC）。 */
export function formatRfc5322Date(date) {
  return date.toUTCString().replace(/GMT$/, '+0000')
}

/** 行尾统一成 CRLF，避免正文里混进裸 LF。 */
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, CRLF)
}

/** 正文 dot-stuffing：行首的 `.` 变 `..`，否则 SMTP 会把独立 `.` 当结束符。 */
export function dotStuff(text) {
  return text.replace(/^\./gm, '..')
}

function boundaryFor() {
  return `=_gitrader_${randomBytes(12).toString('hex')}`
}

function textPart(text) {
  return ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text]
}

function htmlPart(html) {
  return ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', html]
}

/**
 * 生成完整 MIME 报文（头 + 正文，行尾 CRLF）。
 * 有 html 时走 multipart/alternative（text 在前、html 在后），否则单段 text/plain。
 * 这里不加密、不签名、不做 dot-stuffing（那属于投递阶段，见 dotStuff）。
 */
export function buildMime(mail, from, opts) {
  const recipients = (Array.isArray(mail.to) ? mail.to : [mail.to]).map((t) => headerValue(t)).filter((t) => t.length > 0)
  const messageId = opts?.messageId ?? newMessageId(from)
  const date = opts?.date ?? new Date()
  const text = normalizeNewlines(mail.text)
  const html = mail.html === undefined ? undefined : normalizeNewlines(mail.html)

  const headers = [
    `From: ${headerValue(from)}`,
    `To: ${recipients.join(', ')}`,
  ]
  if (mail.replyTo !== undefined) headers.push(`Reply-To: ${headerValue(mail.replyTo)}`)
  headers.push(
    foldHeader('Subject', headerValue(mail.subject)),
    `Date: ${formatRfc5322Date(date)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  )

  if (html === undefined) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit')
    return `${headers.join(CRLF)}${CRLF}${CRLF}${text}${CRLF}`
  }

  const boundary = boundaryFor()
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
  const body = [
    `--${boundary}`,
    ...textPart(text),
    `--${boundary}`,
    ...htmlPart(html),
    `--${boundary}--`,
    '',
  ].join(CRLF)
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`
}
