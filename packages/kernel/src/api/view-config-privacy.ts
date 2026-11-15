// SPDX-License-Identifier: CPAL-1.0
import { findSecretKeys } from '../util/errors'

const SENSITIVE_NOTIFY_KEYS = new Set([
  'apikey', 'token', 'accesstoken', 'refreshtoken', 'bottoken', 'authtoken', 'webhook', 'webhookurl',
  'authorization', 'bearer', 'clientsecret', 'secretkey', 'accesskey', 'secretaccesskey', 'accesskeysecret',
])

/** Known credential-like keys are rejected anywhere in notification params. Values are never inspected. */
export function hasSensitiveNotifyParams(value: unknown): boolean {
  if (findSecretKeys(value).length > 0) return true
  const scan = (current: unknown, depth: number): boolean => {
    if (depth > 12) return true
    if (current === null || typeof current !== 'object') return false
    if (Array.isArray(current)) return current.some((item) => scan(item, depth + 1))
    return Object.entries(current).some(([key, item]) => {
      const normalized = key.toLowerCase().replace(/[-_]/g, '')
      return SENSITIVE_NOTIFY_KEYS.has(normalized) || scan(item, depth + 1)
    })
  }
  return scan(value, 0)
}
