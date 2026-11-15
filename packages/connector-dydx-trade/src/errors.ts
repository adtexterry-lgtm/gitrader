// SPDX-License-Identifier: CPAL-1.0
// 上游错误 → 协议 Problem（契约 §2.8）。铁律：
//   · `venue.message` 原样保存上游原文（只做密钥脱敏，不翻译、不截断语义）；
//   · 非 GET 请求没拿到结果（超时 / 断连 / 5xx / 408）→ 3006 VENUE_OUTCOME_UNKNOWN，不可盲目重发，先按 clientOrderId 对账；
//   · 只读 GET 失败 → 3003 VENUE_UNAVAILABLE（可重试）；
//   · 429 / 418 → 3003 + retryable + retryAfterMs（与 HL 包同口径）。
// 链上回执（Cosmos ABCI）：code=0 才算成功；code≠0 是「已确定失败」，不是结果未知。
//   通用码（Cosmos SDK）：3 / 32 = 序列号不符（本包会触发重新同步并标记 sequenceMismatch），5 = 余额不足，
//   11 = out of gas，13 = 手续费不足。dYdX 模块自定义错误在 1100+，只按 raw_log 原文分类，不猜码义。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'

export const VENUE_ID = 'dydx'
const MASK = '<redacted>'

/** 本包自己的错误：携带 Problem（与 protocol 的 ProblemError 同形，便于内核按形状识别）。 */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message)
    this.name = 'ProblemError'
  }
}

/** 把字符串里出现的密钥原文与 base64 形态替换成 <redacted>。 */
export function redactSecret(s: string, secrets: string | readonly string[]): string {
  const list = typeof secrets === 'string' ? [secrets] : secrets
  let out = s
  for (const secret of list) {
    if (secret.length === 0) continue
    out = out.split(secret).join(MASK)
    const b64 = Buffer.from(secret, 'utf8').toString('base64')
    if (b64.length >= 4) out = out.split(b64).join(MASK)
  }
  return out
}

export class DydxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
    /** true = 改变状态的请求失败且结果未知 → 3006。 */
    readonly outcomeUnknown = false,
    readonly retryAfterMs?: number,
  ) {
    super(`dydx ${method} ${path} HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'DydxHttpError'
  }
}

export class DydxNetworkError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    readonly outcomeUnknown = false,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'DydxNetworkError'
  }
}

/** 链上交易被拒（广播回执 code≠0，或交易里只有本包能识别的错误）。 */
export class DydxTxError extends Error {
  constructor(
    readonly code: number,
    readonly codespace: string,
    readonly rawLog: string,
    readonly txHash: string,
  ) {
    super(`dydx tx ${txHash} rejected: code ${code} ${codespace} ${rawLog.slice(0, 200)}`)
    this.name = 'DydxTxError'
  }
}

export function txProblemName(code: number, rawLog: string): ProblemName {
  if (code === 3 || code === 32) return 'VENUE_REJECTED'
  if (code === 13 || /insufficient fee/i.test(rawLog)) return 'VENUE_REJECTED'
  if (code === 11 || /out of gas/i.test(rawLog)) return 'VENUE_REJECTED'
  if (code === 5 || /insufficient funds|insufficient margin|insufficient collateral/i.test(rawLog)) {
    return 'VENUE_INSUFFICIENT_MARGIN'
  }
  return 'VENUE_REJECTED'
}

export interface ErrorContext {
  /** 私钥（hex）：任何出现在错误文本里的都要替换掉。 */
  secrets?: readonly string[]
  method?: string
  path?: string
}

function scrub(p: Problem, secrets: readonly string[]): Problem {
  if (secrets.length === 0) return p
  return {
    ...p,
    message: redactSecret(p.message, secrets),
    ...(p.venue ? { venue: { ...p.venue, message: redactSecret(p.venue.message, secrets) } } : {}),
  }
}

function venueProblem(name: ProblemName, summary: string, upstream: string, code?: string | number, extra: Partial<Problem> = {}): Problem {
  return makeProblem(name, summary, {
    venue: code === undefined ? { id: VENUE_ID, message: upstream } : { id: VENUE_ID, code, message: upstream },
    ...extra,
  })
}

/** 任意错误 → Problem（含分类与脱敏）。 */
export function asProblem(e: unknown, ctx: ErrorContext = {}): Problem {
  const secrets = ctx.secrets ?? []

  if (e instanceof ProblemError) return scrub(e.problem, secrets)
  const foreign = e as { problem?: Partial<Problem> } | null
  if (foreign !== null && typeof foreign === 'object' && foreign.problem !== undefined && foreign.problem !== null
    && typeof foreign.problem.code === 'number' && typeof foreign.problem.name === 'string') {
    return scrub(foreign.problem as Problem, secrets)
  }

  if (e instanceof DydxHttpError) {
    const base = { ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) }
    if (e.status === 429 || e.status === 418) {
      return scrub(venueProblem('VENUE_UNAVAILABLE', 'venue rate limited the request', e.body, e.status, { retryable: true, ...base }), secrets)
    }
    if (e.outcomeUnknown) {
      return scrub(venueProblem('VENUE_OUTCOME_UNKNOWN', 'no definite result from the chain; query by clientOrderId before retrying', e.body, e.status), secrets)
    }
    if (e.status === 401 || e.status === 403) {
      return scrub(venueProblem('VENUE_AUTH', 'venue rejected the credentials', e.body, e.status), secrets)
    }
    if (e.status >= 500) {
      return scrub(venueProblem('VENUE_UNAVAILABLE', 'venue unavailable', e.body, e.status, { retryable: true }), secrets)
    }
    return scrub(venueProblem('VENUE_REJECTED', 'venue rejected the request', e.body, e.status, base), secrets)
  }

  if (e instanceof DydxNetworkError) {
    const out = e.outcomeUnknown
      ? venueProblem('VENUE_OUTCOME_UNKNOWN', 'no response after the request was sent; query by clientOrderId before retrying', e.message)
      : venueProblem('VENUE_UNAVAILABLE', 'venue unreachable', e.message)
    return scrub(out, secrets)
  }

  if (e instanceof DydxTxError) {
    const name = txProblemName(e.code, e.rawLog)
    return scrub(venueProblem(name, 'chain rejected the transaction', e.rawLog, e.code, {}), secrets)
  }

  if (e instanceof RangeError) return scrub(makeProblem('INVALID_PARAMS', e.message), secrets)
  if (e instanceof TypeError) return scrub(makeProblem('INVALID_PARAMS', e.message), secrets)

  const message = e instanceof Error ? e.message : String(e)
  return scrub(makeProblem('INTERNAL', message), secrets)
}

/** 把任意错误包成 ProblemError 并抛出。 */
export function throwAsProblem(e: unknown, ctx: ErrorContext = {}): never {
  throw new ProblemError(asProblem(e, ctx))
}

/** 便捷构造：能力不支持 / 参数错误（连接器自己产生的拒绝）。 */
export function invalidParams(message: string): ProblemError {
  return new ProblemError(makeProblem('INVALID_PARAMS', message))
}

export function unsupported(message: string): ProblemError {
  return new ProblemError(makeProblem('ORDER_TYPE_UNSUPPORTED', message))
}

export function capabilityUnsupported(message: string): ProblemError {
  return new ProblemError(makeProblem('CAPABILITY_UNSUPPORTED', message))
}
