// SPDX-License-Identifier: CPAL-1.0
// 上游报错 → 协议 Problem（契约 §2.8）。本文件只做「形状判定 + 脱敏 + 分类转交」，规则表在 venue-errors.ts。
// HTX 的两套信封都要认（见 rest.ts 文件头）：
//   · linear-swap-api v1：HTTP 200 + `{"status":"ok"|"error","err_code":N,"err_msg":"..."}`；
//   · /v5：HTTP 200 + `{"code":200|..., "message":"..."}`（QD htx_v5.py:13-24 `v5_ok` 同口径）。
// 铁律：`venue.message` 原样保存上游报错（只做密钥脱敏，不翻译、不截断语义）；分类认不出来的落 3001 VENUE_REJECTED。
//   1) HTTP 429 / 418 / 403 + too frequent：与 Hyperliquid 包同口径 → 3002 VENUE_RATE_LIMITED + retryable + 重试等待；
//   2) 非 GET 请求没拿到可信结果（超时 / 断网 / 5xx / 系统类码 1000·1001·1002·1003·1004·500·6021）→ 3006，按 clientOrderId 对账；
//   3) 只读 GET 没拿到响应 → 3003 VENUE_UNAVAILABLE（可重试）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'
import { classifyHtxError, isAmbiguousVenueCode } from './venue-errors'

export const VENUE_ID = 'htx'
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

/** 请求的鉴权口径：signed = 带 AccessKeyId / Signature；public = 不带任何密钥（/linear-swap-api/v1/swap_contract_info 一类）。 */
export type HtxEndpoint = 'signed' | 'public'

/** 上游返回非 2xx，或信封 status=error / code!==200。body = 响应原文（已脱敏）。 */
export class HtxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly endpoint: HtxEndpoint,
    readonly retryAfterMs?: number,
    /** 上游错误码：v1 的 err_code 或 v5 的 code（拿不到时 undefined）。 */
    readonly venueCode?: number,
    /** true = 改变状态的请求结果未知（非 GET 的 5xx / 超时 / 1002·1003）→ 3006。 */
    readonly outcomeUnknown = false,
  ) {
    super(`htx ${endpoint} HTTP ${status}${venueCode !== undefined ? ` code ${venueCode}` : ''}: ${body.slice(0, 200)}`)
    this.name = 'HtxHttpError'
  }
}

/** 没拿到响应（超时 / 断网 / 取消）。签名请求上出现它意味着「结果未知」（3006）。 */
export class HtxNetworkError extends Error {
  constructor(
    message: string,
    readonly endpoint: HtxEndpoint,
    override readonly cause?: unknown,
    /** true = 改变状态的请求没拿到响应 → 3006（不得盲目重发）。 */
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'HtxNetworkError'
  }
}

/** 构造带 venue 段的 Problem；upstream 由调用方传入（本函数不脱敏）。 */
export function venueProblem(name: ProblemName, summary: string, upstream: string, extra: Partial<Problem> = {}): Problem {
  return makeProblem(name, summary, { venue: { id: VENUE_ID, message: upstream }, ...extra })
}

export interface ErrorContext {
  /** apiSecret / apiKey：任何出现在错误文本里的都要替换掉。 */
  secrets?: readonly string[]
  endpoint?: HtxEndpoint
}

function scrub(problem: Problem, secrets: readonly string[]): Problem {
  if (secrets.length === 0) return problem
  return {
    ...problem,
    message: redactSecret(problem.message, secrets),
    ...(problem.venue ? { venue: { ...problem.venue, message: redactSecret(problem.venue.message, secrets) } } : {}),
  }
}

/** 任意带 Problem 的 Error（本包的 ProblemError、构建器抛的错）都认。 */
function problemOf(e: unknown): Problem | undefined {
  if (e instanceof ProblemError) return e.problem
  if (e === null || typeof e !== 'object') return undefined
  const candidate = (e as { problem?: unknown }).problem
  if (candidate === null || typeof candidate !== 'object') return undefined
  const p = candidate as Partial<Problem>
  return typeof p.code === 'number' && typeof p.name === 'string' && typeof p.message === 'string'
    ? (candidate as Problem)
    : undefined
}

function isRateLimitText(text: string): boolean {
  return /too\s*(many|frequent)|frequent|rate\s*limit|429/i.test(text)
}

/** 任意错误 → Problem（含分类与脱敏）。 */
export function asProblem(e: unknown, ctx: ErrorContext = {}): Problem {
  const secrets = ctx.secrets ?? []
  const carried = problemOf(e)
  if (carried !== undefined) return scrub(carried, secrets)
  if (e instanceof HtxHttpError) {
    const retryAfterMs = e.retryAfterMs
    // 404 / 405：路径或 HTTP 方法不对（编程错误，不是场所抖动）。
    if (e.status === 404 || e.status === 405) {
      return scrub(
        venueProblem('VENUE_REJECTED', 'venue has no such endpoint or method; check the path and the HTTP verb', e.body, {
          venue: { id: VENUE_ID, code: e.venueCode ?? e.status, message: e.body },
        }),
        secrets,
      )
    }
    if (e.status === 429 || e.status === 418 || (e.status === 403 && isRateLimitText(e.body))) {
      return scrub(
        venueProblem('VENUE_RATE_LIMITED', 'venue rate limited the request', e.body, {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          venue: { id: VENUE_ID, code: e.venueCode ?? e.status, message: e.body },
        }),
        secrets,
      )
    }
    if (e.outcomeUnknown && e.venueCode !== undefined && isAmbiguousVenueCode(e.venueCode)) {
      // 上游「系统错误 / 处理超时」：状态未知，先对账。
      return scrub(
        venueProblem('VENUE_OUTCOME_UNKNOWN', 'venue reported a transient error after the request was sent; query by clientOrderId before retrying', e.body, {
          venue: { id: VENUE_ID, code: e.venueCode, message: e.body },
        }),
        secrets,
      )
    }
    if (e.outcomeUnknown) {
      return scrub(
        venueProblem('VENUE_OUTCOME_UNKNOWN', 'venue error after the request was sent; query by clientOrderId before retrying', e.body, {
          venue: { id: VENUE_ID, code: e.venueCode ?? e.status, message: e.body },
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        }),
        secrets,
      )
    }
    // 5xx / 408 且**不是**改变状态的请求（GET）：场所抖动，可重试（3003）。
    if (e.status === 408 || e.status >= 500) {
      return scrub(
        venueProblem('VENUE_UNAVAILABLE', 'venue unreachable or returned a server error', e.body, {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          venue: { id: VENUE_ID, code: e.venueCode ?? e.status, message: e.body },
        }),
        secrets,
      )
    }
    const classified = classifyHtxError({ text: e.body, venueCode: e.venueCode, httpStatus: e.status })
    return scrub({ ...classified.problem, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }, secrets)
  }
  if (e instanceof HtxNetworkError) {
    // 只有「改变状态的请求没拿到响应」才是结果未知；签名的 GET 也能安全重试（教训 3）。
    const out = e.outcomeUnknown
      ? venueProblem('VENUE_OUTCOME_UNKNOWN', 'no response from venue; query by clientOrderId before retrying', e.message)
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
