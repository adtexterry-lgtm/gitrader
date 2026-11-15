// SPDX-License-Identifier: CPAL-1.0
// 报错正文 + 可展开、可复制的「详情」（ux-fix2 B2，Owner 令「报错弹窗也要精致极简化」）。
// 上游原文 / 错误码只进详情；中文界面的正文行不出英文原文。原文始终在 DOM 里（折叠的 <details> 内）。
import { useState } from 'preact/hooks'
import { Icon } from './Icon.jsx'
import { t as tr } from '../lib/i18n.js'
import { copyText } from '../lib/clip.js'
import { toastParts } from '../lib/toast-parts.js'

/** 折叠的「详情」：原生 <details>（键盘、读屏原生可用），展开后是原文 + 复制。 */
export function ErrDetail({ detail }) {
  const [copied, setCopied] = useState(false)
  return (
    <details className="gr-errd" data-err-detail="" onClick={(e) => e.stopPropagation()}>
      <summary className="gr-errd__k"><Icon name="chevron-right" size={10} />{tr('详情')}</summary>
      <span className="gr-errd__b">
        <code className="gr-errd__v">{detail}</code>
        <button type="button" className="gr-errd__cp" data-act="err-copy" onClick={() => { void copyText(detail).then(setCopied) }}>{copied ? tr('已复制') : tr('复制')}</button>
      </span>
    </details>
  )
}

/** 行内报错：正文（中文界面里英文原文换成一句人话）+ 详情。bare：前面已经有「读取失败」这类标签时，不再补那句通用人话。 */
export function ErrText({ text, bare = false }) {
  const p = toastParts('err', text)
  const main = p.generic && bare ? '' : p.body
  return <>{main ? <span className="gr-errt" title={main}>{main}</span> : null}{p.detail ? <ErrDetail detail={p.detail} /> : null}</>
}
