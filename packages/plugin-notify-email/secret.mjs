// SPDX-License-Identifier: CPAL-1.0
// 复制自 packages/notify-email/src/secret.ts（以该库为准）；JS 版，插件内单文件。
// 认证信息脱敏：只从环境变量进来的 SMTP 口令，任何对外的错误消息 / 日志都要先过这里。
const MASK = '<redacted>'

/**
 * 把每个 secret 原文（以及它在 AUTH 里常见的 base64 形态）替换成 `<redacted>`。
 * 空 secret 跳过，避免空串替换炸掉整段文本。
 */
export function redactSecret(s, secrets) {
  const list = typeof secrets === 'string' ? [secrets] : secrets
  let out = s
  for (const secret of list) {
    if (secret.length === 0) continue
    out = out.split(secret).join(MASK)
    const encoded = Buffer.from(secret, 'utf8').toString('base64')
    if (encoded.length >= 4) out = out.split(encoded).join(MASK)
  }
  return out
}
