// SPDX-License-Identifier: Apache-2.0
// 契约 §2.1 编码（JSON-RPC 2.0）、§2.8 错误放在 error.data、§2.10 S1 秘密字段拒收。
import { makeProblem, type Problem, type ProblemName } from '../model/problem'

export type JsonRpcId = number | string

export interface JsonRpcRequest<P = unknown> { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: P }
export interface JsonRpcNotification<P = unknown> { jsonrpc: '2.0'; method: string; params?: P }
export interface JsonRpcSuccess<R = unknown> { jsonrpc: '2.0'; id: JsonRpcId; result: R }
/** error.data 是 Problem（§2.8）。 */
export interface JsonRpcError { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string; data?: Problem } }
export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** 构造 JSON-RPC 错误响应：Problem 放在 error.data，error.code 与 Problem.code 一致。 */
export function rpcError(id: JsonRpcId | null, name: ProblemName, message: string, extra: Partial<Problem> = {}): JsonRpcError {
  const problem = makeProblem(name, message, extra)
  return { jsonrpc: '2.0', id, error: { code: problem.code, message: problem.message, data: problem } }
}

export function isRpcRequest(m: unknown): m is JsonRpcRequest {
  return !!m && typeof m === 'object' && (m as JsonRpcRequest).jsonrpc === '2.0' && typeof (m as JsonRpcRequest).method === 'string' && 'id' in (m as object)
}
export function isRpcNotification(m: unknown): m is JsonRpcNotification {
  return !!m && typeof m === 'object' && (m as JsonRpcNotification).jsonrpc === '2.0' && typeof (m as JsonRpcNotification).method === 'string' && !('id' in (m as object))
}
export function isRpcResponse(m: unknown): m is JsonRpcResponse {
  return !!m && typeof m === 'object' && (m as JsonRpcResponse).jsonrpc === '2.0' && 'id' in (m as object) && ('result' in (m as object) || 'error' in (m as object))
}

// ---- S1：协议里不存在传递密钥明文的方法或字段 ------------------------------------------

/**
 * 收到名为这些的字段一律 5006 拒收，不落盘、不回显。键名比较忽略大小写与下划线 / 连字符。
 * 唯一例外：路径形如 `....spec.seed` 且值为 number 的 `seed`（BacktestSpec 的随机种子）放行；其余 `seed` 都拒收。
 */
export const SECRET_FIELD_NAMES = ['privateKey', 'secret', 'apiSecret', 'mnemonic', 'seed', 'passphrase'] as const

const SECRET_NORMALIZED = new Set(SECRET_FIELD_NAMES.map((n) => n.toLowerCase()))
const normalizeKey = (k: string): string => k.toLowerCase().replace(/[_-]/g, '')

/** 递归查找秘密字段名，返回路径列表（只返回键路径，从不返回值）。 */
export function findSecretFields(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findSecretFields(v, `${path}[${i}]`)))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // 唯一例外（v0.1.5）：BacktestSpec 里的 `spec.seed`（number）是随机数种子，不是助记词 / 种子短语。别处的 seed 一律拒收。
      const isRngSeed = normalizeKey(k) === 'seed' && typeof v === 'number' && (path === '$.spec' || path.endsWith('.spec'))
      if (SECRET_NORMALIZED.has(normalizeKey(k)) && !isRngSeed) hits.push(`${path}.${k}`)
      hits.push(...findSecretFields(v, `${path}.${k}`))
    }
  }
  return hits
}

/** 若含秘密字段，返回 5006 错误（消息里只含字段路径，不含值）；否则返回 null。 */
export function rejectSecretFields(id: JsonRpcId | null, params: unknown): JsonRpcError | null {
  const hits = findSecretFields(params)
  return hits.length === 0 ? null : rpcError(id, 'SECRET_FIELD_REJECTED', `secret-like field rejected: ${hits.join(', ')}`)
}
