// SPDX-License-Identifier: CPAL-1.0
// 厂商签名：飞书 / Lark 自定义机器人、钉钉自定义机器人。只用 node:crypto。
// 起点复制自 packages/kernel/src/notify/webhook.ts，此后以本库为准。
import { createHmac } from 'node:crypto'

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:123-127; adapted.
/**
 * 飞书 / Lark 自定义机器人签名：key = `${timestampSec}\n${secret}`，message 为空串，
 * HMAC-SHA256 → base64（不 URL 编码，飞书要求放在 body 里）。
 * @param timestampSec 秒级时间戳（飞书要求）
 */
export function signFeishu(secret: string, timestampSec: number): string {
  const key = `${timestampSec}\n${secret}`
  return createHmac('sha256', key).update('').digest('base64')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/notifications/webhook.py:130-137; adapted.
/**
 * 钉钉自定义机器人签名：key = secret，message = `${timestampMs}\n${secret}`，
 * HMAC-SHA256 → base64 → URL 编码（返回值已编码，拼 URL 时不要再编码一次）。
 * @param timestampMs 毫秒级时间戳（钉钉要求）
 */
export function signDingtalk(secret: string, timestampMs: number): string {
  const stringToSign = `${timestampMs}\n${secret}`
  const digest = createHmac('sha256', secret).update(stringToSign).digest('base64')
  return encodeURIComponent(digest)
}
