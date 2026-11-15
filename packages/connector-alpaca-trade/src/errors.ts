// SPDX-License-Identifier: CPAL-1.0
// 上游错误 → 协议 Problem（契约 §2.8）。本文件只做「形状判定 + 脱敏 + 分类转交」，规则表在 venue-errors.ts。
// 铁律：
//   1) HTTP 429：VENUE_UNAVAILABLE(3003) + retryable + Retry-After（与 HL / Bitget 包同口径）；
//   2) **改变状态的请求**（POST / PATCH / DELETE）没拿到结果 → VENUE_OUTCOME_UNKNOWN（3006）：必须先按
//      client_order_id 查状态，不得盲目重发；只有 GET 才可重试（3003）；
//   3) 只读查询没拿到响应 → VENUE_UNAVAILABLE（3003，可重试）；
//   4) `venue.message` 原样保存上游原文（只做密钥脱敏，不翻译、不截断语义）；
//   5) 密钥只从构造参数进，放 `#` 私有字段：JSON.stringify / util.inspect / String(err) / 日志都看不到。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'
import { VENUE_ID } from './constants'
import { classifyAlpacaError } from './venue-errors'

const MASK = '<redacted>'

/** 本条连接器自己抛的错：携带 Problem（与 protocol 的 ProblemError 同形）。 */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message)
    this.name = 'ProblemError'
  }
}

/**
 * Copied from packages/notify-email/src/secret.ts (CPAL-1.0); that file is authoritative.
 * 把每个 secret 原文（以及它常见的 base64 形态）替换成 `<redacted>`；空串跳过。
 */
export function redactSecret(s: string, secrets: string | readonly string[]): string {
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

export type AlpacaEndpoint = 'signed' | 'public' | 'stream'

/** 上游返回非 2xx。body = 响应原文（已脱敏）；retryAfterMs 来自 Retry-After 头。 */
export class AlpacaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly endpoint: AlpacaEndpoint,
    readonly retryAfterMs?: number,
    /** true = 改变状态的请求失败且结果未知（非 GET 的 408 / 5xx / 断连）→ 3006。 */
    readonly outcomeUnknown = false,
  ) {
    super(`alpaca ${endpoint} HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'AlpacaHttpError'
  }
}

/** Alpaca 业务错误体 `{code, message}`（HTTP 状态可能是 4xx，也可能 200 带回拒绝）。 */
export class AlpacaApiError extends Error {
  constructor(
    readonly code: string | number,
    readonly upstreamMessage: string,
    readonly endpoint: AlpacaEndpoint,
    readonly body: string,
    readonly outcomeUnknown = false,
    readonly status = 200,
  ) {
    super(`alpaca ${endpoint} code ${String(code)}: ${upstreamMessage.slice(0, 200)}`)
    this.name = 'AlpacaApiError'
  }
}

/** 没拿到响应（超时 / 断网 / 取消）。改变状态的请求上出现它意味着「结果未知」（3006）。 */
export class AlpacaNetworkError extends Error {
  constructor(
    message: string,
    readonly endpoint: AlpacaEndpoint,
    override readonly cause?: unknown,
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'AlpacaNetworkError'
  }
}

/** 构造带 venue 段的 Problem；upstream 由调用方传入（本函数不脱敏）。 */
export function venueProblem(name: ProblemName, summary: string, upstream: string, extra: Partial<Problem> = {}): Problem {
  return makeProblem(name, summary, { venue: { id: VENUE_ID, message: upstream }, ...extra })
}

export interface ErrorContext {
  /** apiSecret / apiKey：任何出现在错误文本里的都要替换掉。 */
  secrets?: readonly string[]
  endpoint?: AlpacaEndpoint
}

function scrub(problem: Problem, secrets: readonly string[]): Problem {
  if (secrets.length === 0) return problem
  return {
    ...problem,
    message: redactSecret(problem.message, secrets),
    ...(problem.venue ? { venue: { ...problem.venue, message: redactSecret(problem.venue.message, secrets) } } : {}),
  }
}

/** 任意错误 → Problem（含分类与脱敏）。 */
export function asProblem(e: unknown, ctx: ErrorContext = {}): Problem {
  const secrets = ctx.secrets ?? []

  if (e instanceof ProblemError) return scrub(e.problem, secrets)
  // 别的包（例如行情连接器）的 ProblemError 是另一个类：按形状认，避免退化成 INTERNAL。
  const foreign = e as { problem?: Partial<Problem> } | null
  if (foreign !== null && typeof foreign === 'object' && typeof foreign.problem === 'object' && foreign.problem !== null
    && typeof foreign.problem.code === 'number' && typeof foreign.problem.name === 'string') {
    return scrub(foreign.problem as Problem, secrets)
  }

  if (e instanceof AlpacaHttpError) {
    const retryAfterMs = e.retryAfterMs
    if (e.status === 429) {
      return scrub(
        venueProblem('VENUE_UNAVAILABLE', 'venue rate limited the request', e.body, {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          venue: { id: VENUE_ID, code: e.status, message: e.body },
        }),
        secrets,
      )
    }
    // 只读请求上的 408 / 5xx / 坏响应：可重试的「场所不可用」（教训 3：只有 GET 能重试）。
    if (!e.outcomeUnknown && (e.status === 408 || e.status >= 500 || e.status < 400)) {
      return scrub(
        venueProblem('VENUE_UNAVAILABLE', 'venue failed to answer a read-only request', e.body, {
          retryable: true,
          venue: { id: VENUE_ID, code: e.status, message: e.body },
        }),
        secrets,
      )
    }
    if (e.outcomeUnknown) {
      return scrub(
        venueProblem('VENUE_OUTCOME_UNKNOWN', 'no response from the venue after the request was sent; query by client_order_id before retrying', e.body, {
          venue: { id: VENUE_ID, code: e.status, message: e.body },
        }),
        secrets,
      )
    }
    const classified = classifyAlpacaError({ status: e.status, text: e.body, mutating: e.outcomeUnknown })
    return scrub({ ...classified.problem, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }, secrets)
  }

  if (e instanceof AlpacaApiError) {
    if (e.outcomeUnknown) {
      return scrub(
        venueProblem('VENUE_OUTCOME_UNKNOWN', 'venue reported an unknown execution state; query by client_order_id before retrying', e.body, {
          venue: { id: VENUE_ID, code: e.code, message: e.upstreamMessage },
        }),
        secrets,
      )
    }
    const classified = classifyAlpacaError({ status: e.status, code: e.code, text: `${String(e.code)} ${e.upstreamMessage}`.trim() })
    return scrub({ ...classified.problem, venue: { id: VENUE_ID, code: e.code, message: e.upstreamMessage } }, secrets)
  }

  if (e instanceof AlpacaNetworkError) {
    const out = e.outcomeUnknown
      ? venueProblem('VENUE_OUTCOME_UNKNOWN', 'no response from the venue; query by client_order_id before retrying', e.message)
      : venueProblem('VENUE_UNAVAILABLE', 'venue unreachable', e.message)
    return scrub(out, secrets)
  }

  const message = e instanceof Error ? e.message : String(e)
  return scrub(makeProblem('INTERNAL', message), secrets)
}

/** 把任意错误包成 ProblemError 并抛出。 */
export function throwAsProblem(e: unknown, ctx: ErrorContext = {}): never {
  throw new ProblemError(asProblem(e, ctx))
}
