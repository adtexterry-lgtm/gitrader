// SPDX-License-Identifier: CPAL-1.0
import { SECRET_KEY_NAMES } from './errors'

export interface JsonLogRecord {
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  requestId?: string
  [k: string]: unknown
}

// 与 util/errors.ts 保持一致：先按规范化键名匹配其 SECRET_KEY_NAMES，再兼容日志历史键名 token / key。
const SECRET_KEY_NAMES_SET = new Set<string>(SECRET_KEY_NAMES)
const SECRET_KEY = /secret|token|password|key/i
const REDACTED = '[redacted]'

function isSecretKey(key: string): boolean {
  return SECRET_KEY_NAMES_SET.has(key.toLowerCase().replace(/[_-]/g, '')) || SECRET_KEY.test(key)
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/utils/logger.py:14-27; adapted.
/** 一行 JSON（无换行），字段顺序 ts, level, msg, requestId, 其余按键名排序；Error 转 { name, message }；敏感键值打码。 */
export function formatJsonLog(
  rec: Omit<JsonLogRecord, 'ts'> & { ts?: Date | number | string },
  opts?: { stack?: boolean },
): string {
  const { ts, level, msg, requestId, ...rest } = rec
  const withStack = opts?.stack === true
  const out: Record<string, unknown> = {
    ts: toIso(ts),
    level,
    msg,
  }
  if (requestId !== undefined) out.requestId = requestId
  for (const key of Object.keys(rest).sort()) {
    const value = rest[key]
    out[key] = isSecretKey(key) ? REDACTED : sanitize(value, withStack, new WeakSet<object>())
  }
  return JSON.stringify(out)
}

function toIso(value: Date | number | string | undefined): string {
  if (value === undefined) return new Date().toISOString()
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function sanitize(value: unknown, withStack: boolean, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    const error: Record<string, unknown> = { name: value.name, message: value.message }
    if (withStack && value.stack !== undefined) error.stack = value.stack
    return error
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const items = value.map((item) => sanitize(item, withStack, seen))
    seen.delete(value)
    return items
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const obj: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const item = (value as Record<string, unknown>)[key]
      obj[key] = isSecretKey(key) ? REDACTED : sanitize(item, withStack, seen)
    }
    seen.delete(value)
    return obj
  }
  return value
}
