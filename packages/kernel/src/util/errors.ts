// SPDX-License-Identifier: CPAL-1.0
import { makeProblem } from '../proto'
import type { Problem, ProblemName } from '../proto'

/** 带 Problem 对象的错误；HTTP / WS 层把它原样序列化。上游报错原文放 problem.venue.message，不改写。 */
export class KernelError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.name}: ${problem.message}`)
    this.name = 'KernelError'
  }
}

export const fail = (name: ProblemName, message: string, extra: Partial<Problem> = {}): never => {
  throw new KernelError(makeProblem(name, message, extra))
}

export function toProblem(e: unknown): Problem {
  if (e instanceof KernelError) return e.problem
  return makeProblem('INTERNAL_ERROR', e instanceof Error ? e.message : String(e))
}

/** 递归检查：对象键名是否出现密钥类字段（契约 §2.10 S1）。返回命中的路径。 */
export const SECRET_KEY_NAMES = ['privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase', 'pin', 'password'] as const
export function findSecretKeys(value: unknown, path = '$', depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== 'object') return []
  const hits: string[] = []
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findSecretKeys(v, `${path}[${i}]`, depth + 1)))
  else for (const [k, v] of Object.entries(value)) {
    const norm = k.toLowerCase().replace(/[_-]/g, '')
    // protocol v0.1.5 #6：BacktestSpec 的 `spec.seed`（number）是随机数种子，唯一例外；别处的 seed 一律拒收（集成修补 H）
    const rngSeed = norm === 'seed' && typeof v === 'number' && (path === '$.spec' || path.endsWith('.spec'))
    if (!rngSeed && (SECRET_KEY_NAMES as readonly string[]).includes(norm)) hits.push(`${path}.${k}`)
    hits.push(...findSecretKeys(v, `${path}.${k}`, depth + 1))
  }
  return hits
}
