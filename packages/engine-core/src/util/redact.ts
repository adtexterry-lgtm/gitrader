// SPDX-License-Identifier: CPAL-1.0
// 日志脱敏（S4）：日志与事件里不出现密钥形状的串。引擎自己从不记录请求参数；这里是兜底，防止别处拼进来的字符串带出秘密。
const KEY_VALUE = /\b(private[_-]?key|secret|api[_-]?secret|mnemonic|seed|passphrase|token|authorization|bearer)\b\s*[:=]\s*\S+/gi
const HEX_KEY = /0x[0-9a-fA-F]{64}\b/g
const LONG_TOKEN = /\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$|[",;])/g

export function redact(text: string): string {
  return text
    .replace(KEY_VALUE, (_m: string, name: string) => `${name}=[redacted]`)
    .replace(HEX_KEY, '0x[redacted]')
    .replace(LONG_TOKEN, '[redacted-long-token]')
}
