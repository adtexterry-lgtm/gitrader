// SPDX-License-Identifier: CPAL-1.0
// 写剪贴板：优先 navigator.clipboard，不可用（iframe / 非安全上下文）退回 execCommand。成功返回 true。
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch (_e) { /* 退回 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch (_e) { return false }
}
