// SPDX-License-Identifier: CPAL-1.0
// 工具读写标注 + 日志脱敏。标注表与协议包 `MCP_TOOLS` 一一对应（多一个少一个都算错，测试比对）。
// 脱敏用于日志与错误透传：不修改输入，返回新对象；循环引用处替换为 '[circular]'。
// Ported from QuantDinger v5.6.5 (Apache-2.0): mcp_server/src/quantdinger_mcp/tool_contract.py:11; adapted.
// Ported from QuantDinger v5.6.5 (Apache-2.0): mcp_server/src/quantdinger_mcp/security.py:43; adapted.

import type { McpToolName } from '@gitrader/protocol'

/** 工具的读写标注：read = 只读查询；write = 可撤销副作用（提案 / 作业 / 笔记等）；control = 影响交易状态或授权。 */
export type ToolAccess = 'read' | 'write' | 'control'

const ACCESS_BY_NAME: Record<McpToolName, ToolAccess> = {
  takeover: 'control',
  mandate: 'control',
  discover: 'read',
  market: 'read',
  account: 'read',
  risk_status: 'read',
  ledger: 'read',
  engines: 'write',
  propose: 'write',
  proposals: 'write',
  note: 'write',
  backtest: 'write',
  research: 'read',
  experiment: 'write',
  plugins: 'write',
  order: 'control',
  workspace: 'write',
}

/** 我们 17 个工具的读写标注表，键与协议清单完全一致。 */
export const TOOL_ACCESS: Readonly<Record<string, ToolAccess>> = ACCESS_BY_NAME

/** 查一个工具的读写标注；未知工具返回 undefined。 */
export function toolAccess(name: string): ToolAccess | undefined {
  return TOOL_ACCESS[name]
}

const REDACTED = '[redacted]'
const CIRCULAR = '[circular]'

/** QD 的 _SECRET_KEYS 按词表匹配；这里按"键名包含"匹配，先去掉非字母数字以便覆盖 snake / camel / kebab 写法。 */
const SECRET_KEY_PARTS: readonly string[] = [
  'secret', 'token', 'password', 'passphrase', 'privatekey', 'mnemonic', 'seed', 'apikey', 'authorization',
]

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '')

const isSecretKey = (key: string): boolean => {
  const k = normalizeKey(key)
  return SECRET_KEY_PARTS.some((part) => k.includes(part))
}

/** 0x + 64 位十六进制（私钥 / 哈希形态的密钥）。 */
const HEX64 = /^0x[0-9a-fA-F]{64}$/
/** `sk-` 开头的长串（≥ 20 字符）。 */
const SK_TOKEN = /^sk-[A-Za-z0-9_-]{17,}$/
/** JWT：三段 base64url，用点分隔。 */
const JWT = /^[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}$/

const isSecretString = (value: string): boolean => HEX64.test(value) || SK_TOKEN.test(value) || JWT.test(value)

/**
 * 深度脱敏：对象 / 数组递归；键名（大小写不敏感）含 secret / token / password / passphrase / privatekey /
 * mnemonic / seed / apikey / authorization 的值替换为 '[redacted]'；字符串值本身呈密钥形态的同样替换。
 * 不修改输入，返回新对象；循环引用不炸，循环处替换为 '[circular]'。
 */
export function redactSecrets<T>(value: T): T {
  const onPath = new WeakSet<object>()

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return isSecretString(node) ? REDACTED : node
    if (typeof node !== 'object' || node === null) return node
    if (onPath.has(node)) return CIRCULAR
    onPath.add(node)
    try {
      if (Array.isArray(node)) return node.map((item) => walk(item))
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) {
        out[key] = isSecretKey(key) ? REDACTED : walk(child)
      }
      return out
    } finally {
      onPath.delete(node)
    }
  }

  return walk(value) as T
}

/**
 * 给日志用：把工具调用入参脱敏后 JSON 串化；超过 maxChars 截断并加 '…(truncated)'。
 * 无法串化（如 BigInt）时只留工具名与占位符，保证日志不炸也不带出原值。
 */
export function describeToolCall(name: string, params: unknown, maxChars = 2000): string {
  let text: string
  try {
    text = JSON.stringify(redactSecrets(params)) ?? 'undefined'
  } catch {
    return `${name}: <unserializable>`
  }
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…(truncated)`
}
