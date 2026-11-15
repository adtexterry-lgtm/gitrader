// SPDX-License-Identifier: CPAL-1.0
// 上游报错 → 协议 Problem（契约 §2.8）。本文件只做「形状判定 + 脱敏 + 分类转交」，规则表在 venue-errors.ts。
// 铁律：`venue.message` 原样保存上游报错（只做密钥脱敏，不翻译、不截断语义）；分类认不出来的落 3001 VENUE_REJECTED。
//   1) HTTP 429 → VENUE_RATE_LIMITED（3002）+ Retry-After；只对限流码退避；
//   2) 改变状态的请求（非 GET）没拿到确定结果（50004 / 503 / 5xx / 断网）→ VENUE_OUTCOME_UNKNOWN（3006），
//      必须先按 clOrdId 查状态，不得盲目重发；
//   3) GET 的 503 / 断网 → VENUE_UNAVAILABLE（3003，可重试）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'
import { classifyOkxError } from './venue-errors'

export const VENUE_ID = 'okx'
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

export type OkxEndpoint = 'signed' | 'public'

/** 上游返回非 2xx 或 `code !== "0"`。body / msg 原样保存（未改动）；retryAfterMs 来自 Retry-After 头。 */
export class OkxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly endpoint: OkxEndpoint,
    /** OKX 信封里的 `code`（字符串，如 '51008'）；HTTP 层失败时为 undefined。 */
    readonly okxCode?: string,
    /** 信封 data[0].sCode（下单类端点逐单错误码）。 */
    readonly sCode?: string,
    /** 信封 data[0].sMsg。 */
    readonly sMsg?: string,
    readonly retryAfterMs?: number,
    /** true = 这是改变状态的请求（POST/PUT/DELETE）失败，上游结果未知 → 3006。 */
    readonly outcomeUnknown = false,
  ) {
    super(`okx ${endpoint} HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'OkxHttpError'
  }
}

/** 没拿到响应（超时 / 断网 / 取消）。签名请求上出现它意味着「结果未知」（3006）。 */
export class OkxNetworkError extends Error {
  constructor(
    message: string,
    readonly endpoint: OkxEndpoint,
    override readonly cause?: unknown,
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'OkxNetworkError'
  }
}

/** 构造带 venue 段的 Problem；upstream 由调用方传入（本函数不脱敏）。 */
export function venueProblem(name: ProblemName, summary: string, upstream: string, extra: Partial<Problem> = {}): Problem {
  return makeProblem(name, summary, { venue: { id: VENUE_ID, message: upstream }, ...extra })
}

export interface ErrorContext {
  /** apiSecret / apiKey / passphrase：任何出现在错误文本里的都要替换掉。 */
  secrets?: readonly string[]
  endpoint?: OkxEndpoint
}

function scrub(problem: Problem, secrets: readonly string[]): Problem {
  if (secrets.length === 0) return problem
  return {
    ...problem,
    message: redactSecret(problem.message, secrets),
    ...(problem.venue ? { venue: { ...problem.venue, message: redactSecret(problem.venue.message, secrets) } } : {}),
  }
}

/** 字符串里能认出 `"code":"51008"` 时取出码（上游 body 是 JSON 文本）。 */
function bodyCode(body: string): string | undefined {
  const m = /"code"\s*:\s*"?(-?\d+)"?/.exec(body)
  return m?.[1]
}

function numericOf(code: string | undefined): number | undefined {
  if (code === undefined) return undefined
  const n = Number(code)
  return Number.isFinite(n) ? n : undefined
}

/** 任意错误 → Problem（含分类与脱敏）。 */
export function asProblem(e: unknown, ctx: ErrorContext = {}): Problem {
  const secrets = ctx.secrets ?? []
  if (e instanceof ProblemError) return scrub(e.problem, secrets)
  if (e instanceof OkxHttpError) {
    const retryAfterMs = e.retryAfterMs
    if (e.status === 429) {
      return scrub(
        venueProblem('VENUE_RATE_LIMITED', 'venue rate limited the request', e.body, {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          venue: { id: VENUE_ID, code: e.status, message: e.body },
        }),
        secrets,
      )
    }
    if (e.outcomeUnknown) {
      return scrub(
        venueProblem('VENUE_OUTCOME_UNKNOWN', 'venue error after the request was sent; query by clOrdId before retrying', e.body, {
          retryable: false,
          venue: { id: VENUE_ID, code: e.sCode ?? e.okxCode ?? e.status, message: e.body },
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        }),
        secrets,
      )
    }
    if (e.status === 503) {
      return scrub(
        venueProblem('VENUE_UNAVAILABLE', 'venue unavailable', e.body, {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          venue: { id: VENUE_ID, code: e.status, message: e.body },
        }),
        secrets,
      )
    }
    const code = e.sCode ?? e.okxCode ?? bodyCode(e.body)
    const { problem } = classifyOkxError({
      text: e.sMsg !== undefined && e.sMsg !== '' ? e.sMsg : e.body,
      ...(numericOf(code) !== undefined ? { code: numericOf(code) } : {}),
      status: e.status,
    })
    return scrub({ ...problem, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }, secrets)
  }
  if (e instanceof OkxNetworkError) {
    const out = e.outcomeUnknown
      ? venueProblem('VENUE_OUTCOME_UNKNOWN', 'no response from venue; query by clOrdId before retrying', e.message)
      : venueProblem('VENUE_UNAVAILABLE', 'venue unreachable', e.message, { retryable: true })
    return scrub(out, secrets)
  }
  const message = e instanceof Error ? e.message : String(e)
  return scrub(makeProblem('INTERNAL', message), secrets)
}

/** 把任意错误包成 ProblemError 并抛出。 */
export function throwAsProblem(e: unknown, ctx: ErrorContext = {}): never {
  throw new ProblemError(asProblem(e, ctx))
}
