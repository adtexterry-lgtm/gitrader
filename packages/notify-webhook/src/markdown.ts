// SPDX-License-Identifier: CPAL-1.0
// markdown 方言的正文结构字符处理（L5-14）：飞书 lark_md / 企业微信 markdown 不认反斜杠转义，
// 所以把链接、标题、`<font>` 之类结构字符换成同形全角字符——渲染后不可点击、不成标题，正文仍可读。
/**
 * 把正文里的 markdown 结构字符换成全角同形字符（渲染后不成链接、不成标题）；
 * 只用于「正文内容」，不要用在插件自己生成的模板前缀（如 `### 标题`）上。
 */
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
