// SPDX-License-Identifier: Apache-2.0
// 工具 schema 里 `pattern` 的回溯风险检查：插件同时控制 schema 与数据，灾难性回溯会卡死内核主线程。
// 不是完整的正则分析器，只拒绝最典型的几类：过长、回溯引用、"量词作用在本身含重复量词或分支的分组上"。无第三方依赖。

export const MAX_PATTERN_LENGTH = 256
/** 单个工具 schema 序列化后的字节上限（checkPluginManifestIssues 用）。 */
export const MAX_TOOL_SCHEMA_BYTES = 64 * 1024

const QUANT_BRACE = /^\{(\d+)(,(\d*))?\}/

/** 嵌套量词的拒绝原因（带改写示例，接在 `pattern "…" is rejected: ` 后面读得通）。 */
const NESTED_REASON = 'quantifier over a group that contains a quantifier or alternation can backtrack catastrophically; rewrite without nested quantifiers (e.g. ^[a-z-]+$ instead of ^[a-z]+(-[a-z]+)*$)'

/** 有风险返回原因（接在 `pattern "…" is rejected: ` 后面读得通），否则 null。 */
export function patternRisk(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return `longer than ${MAX_PATTERN_LENGTH} characters`
  // 每层分组记录：里面是否出现过"会重复的量词"、是否出现过分支（`|`）
  const stack: { quant: boolean; alt: boolean }[] = []
  // 上一个原子：是不是分组、分组体是否危险（含重复量词或分支）；null = 刚吃过量词，不能再被量词作用
  let last: { group: boolean; risky: boolean } | null = null
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '\\') {
      const nx = pattern[i + 1] ?? ''
      if (/[1-9]/.test(nx) || (nx === 'k' && pattern[i + 2] === '<')) return 'backreferences are not supported'
      i += 2
      last = { group: false, risky: false }
    } else if (ch === '[') {
      i += 1
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
      i += 1
      last = { group: false, risky: false }
    } else if (ch === '(') {
      i += 1
      if (pattern[i] === '?') {
        i += 1
        if (pattern[i] === ':' || pattern[i] === '=' || pattern[i] === '!') i += 1
        else if (pattern[i] === '<') {
          i += 1
          if (pattern[i] === '=' || pattern[i] === '!') i += 1
          else {
            while (i < pattern.length && pattern[i] !== '>') i += 1
            i += 1
          }
        }
      }
      stack.push({ quant: false, alt: false })
      last = null
    } else if (ch === ')') {
      i += 1
      const g = stack.pop()
      if (g) {
        const top = stack[stack.length - 1]
        if (top) { top.quant ||= g.quant; top.alt ||= g.alt }
        last = { group: true, risky: g.quant || g.alt }
      } else last = { group: false, risky: false }
    } else if (ch === '|') {
      const top = stack[stack.length - 1]
      if (top) top.alt = true
      i += 1
      last = null
    } else if (ch === '*' || ch === '+' || ch === '?' || (ch === '{' && QUANT_BRACE.test(pattern.slice(i)))) {
      let repeating = ch === '*' || ch === '+'
      if (ch === '{') {
        const m = QUANT_BRACE.exec(pattern.slice(i))!
        const min = Number(m[1])
        repeating = m[2] === undefined ? min > 1 : m[3] === '' || Number(m[3]) > 1
        i += m[0].length
      } else i += 1
      if (pattern[i] === '?') i += 1 // 惰性修饰
      if (repeating) {
        if (last?.group && last.risky) return NESTED_REASON
        const top = stack[stack.length - 1]
        if (top) top.quant = true
      }
      last = null
    } else {
      i += 1
      last = { group: false, risky: false }
    }
  }
  return null
}

/** 遍历 schema 树，收集所有 `pattern` 值与 `patternProperties` 的键里有风险的，返回 `{pattern, reason}`。 */
export function findUnsafePatterns(schema: unknown): { pattern: string; reason: string }[] {
  const out: { pattern: string; reason: string }[] = []
  const check = (p: string): void => {
    const reason = patternRisk(p)
    if (reason !== null) out.push({ pattern: p, reason })
  }
  const todo: unknown[] = [schema]
  while (todo.length > 0) {
    const v = todo.pop()
    if (Array.isArray(v)) todo.push(...v)
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'pattern' && typeof x === 'string') check(x)
        else if (k === 'patternProperties' && typeof x === 'object' && x !== null) for (const pk of Object.keys(x)) check(pk)
        todo.push(x)
      }
    }
  }
  return out
}
