// SPDX-License-Identifier: CPAL-1.0
// 失败 toast 的呈现结构（ux-fix2 B2，只改呈现、不改文案来源）：「出了什么事 + 下一步」两行，与 CLI 的 fatal 两行一致。
// 中文界面里整句英文原文、括号里的英文原文不进正文，收进可复制的「详情」行；英文界面原文本身可读，照原样。
import { getLang, t } from './i18n.js'

const CJK = /[㐀-鿿]/
/** 「中文说明（英文原文）中文说明」：括号里是至少 6 个非中文字符。 */
const PAREN = /^(.*?)（([^㐀-鿿（）]{6,})）(.*)$/

/** kind = toast 种类；只拆失败（err）。返回 { what, next, detail, body }：空串 = 没有这一行；body = 去掉原文后的整句（行内报错用）；generic = 正文是通用人话（原文整句是英文）。 */
export function toastParts(kind, text, lang = getLang()) {
  let s = String(text)
  let detail = ''
  if (kind !== 'err') return { what: s, next: '', detail, body: s }
  if (lang !== 'en') {
    if (!CJK.test(s)) { const what = t('这一步没有完成'), next = t('先看一眼最新状态，再决定要不要重试'); return { what, next, detail: s, body: what + '；' + next, generic: true } }
    const m = PAREN.exec(s)
    if (m) { s = m[1] + m[3]; detail = m[2] }
  }
  const i = Math.max(s.lastIndexOf('；'), s.lastIndexOf('; '))
  return i > 0 ? { what: s.slice(0, i), next: s.slice(i + (s[i] === '；' ? 1 : 2)), detail, body: s } : { what: s, next: '', detail, body: s }
}
