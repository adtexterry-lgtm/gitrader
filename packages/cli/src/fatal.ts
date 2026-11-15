// SPDX-License-Identifier: CPAL-1.0
// 顶层失败分支的文案：内核的 Problem（KernelError 一类）查中文映射表，普通错误只说「出错了」；
// 只有 --debug / GITRADER_DEBUG=1 才把原始 String(e) 与堆栈附在后面（排查用，普通用户的文案里不出现英文原文）。
import { humanizeProblem } from '@gitrader/protocol'
import { isPinRequired, pinNeedsHuman } from './lang'
import type { Lang } from './lang'

interface Problemish {
  name: string
  message?: string
  retryAfterMs?: number
}

/** 中文（含「PIN 不对」这种中文夹拉丁字母的写法）。 */
const HAS_ZH = /[一-龥]/

function asRecord(e: unknown): Record<string, unknown> | undefined {
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : undefined
}

/** 带 problem 的错（KernelError）、SDK 的 problemName 形状，或本身就是 Problem（有 name 与 code）。 */
export function problemOf(e: unknown): Problemish | undefined {
  const r = asRecord(e)
  if (!r) return undefined
  const p = asRecord(r.problem)
  if (p && typeof p.name === 'string') {
    return {
      name: p.name,
      ...(typeof p.message === 'string' ? { message: p.message } : {}),
      ...(typeof p.retryAfterMs === 'number' ? { retryAfterMs: p.retryAfterMs } : {}),
    }
  }
  if (typeof r.problemName === 'string') {
    return { name: r.problemName, ...(typeof r.message === 'string' ? { message: r.message } : {}) }
  }
  if (typeof r.name === 'string' && typeof r.code === 'number') {
    return { name: r.name, ...(typeof r.message === 'string' ? { message: r.message } : {}) }
  }
  return undefined
}

/** 普通错误：中文原文照用；纯英文 / 代码类错误加一句中文，不把英文原文当主文案。 */
function plainText(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)
  return HAS_ZH.test(message) ? message : `操作没有完成（${message}）`
}

function rawText(e: unknown): string {
  const text = String(e)
  if (text !== '[object Object]') return text
  try {
    return JSON.stringify(e) ?? text
  } catch {
    return text
  }
}

/** 顶层失败分支的整段输出（不含结尾换行）：首行「出错了：…」，有下一步再一行；debug 追加原文与堆栈。 */
export function formatFatal(e: unknown, o: { debug?: boolean; nonInteractive?: boolean; lang?: Lang; env?: Record<string, string | undefined> } = {}): string {
  const p = problemOf(e)
  const lines: string[] = []
  if (p && o.nonInteractive && isPinRequired(p)) {
    const h = pinNeedsHuman(o.lang ?? 'zh', o.env ?? {})
    lines.push(o.lang === 'en' ? `Error: ${h.text}` : `出错了：${h.text}`)
    lines.push(o.lang === 'en' ? `Next: ${h.next}` : `下一步：${h.next}`)
  } else if (p) {
    const text = humanizeProblem(p, { surface: 'cli' })
    lines.push(`出错了：${text.zh}`)
    if (text.next) lines.push(`下一步：${text.next}`)
  } else {
    lines.push(`出错了：${plainText(e)}`)
  }
  if (o.debug) {
    lines.push(`原文：${rawText(e)}`)
    const stack = asRecord(e)?.stack
    if (typeof stack === 'string' && stack.trim()) lines.push(stack)
  }
  return lines.join('\n')
}
