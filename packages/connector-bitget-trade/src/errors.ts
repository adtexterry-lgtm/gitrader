// SPDX-License-Identifier: CPAL-1.0
// 上游报错 → 协议 Problem（契约 §2.8）。本文件只做「形状判定 + 脱敏 + 分类转交」，规则表在 venue-errors.ts。
// 铁律：`venue.message` 原样保存上游报错（只做密钥脱敏，不翻译、不截断语义）；分类认不出来的落 3001 VENUE_REJECTED。
//   1) HTTP 429 / 418：按工单口径 → VENUE_UNAVAILABLE + retryable + Retry-After（与 HL 包一致）；
//   2) 改变状态的请求（POST / PUT / DELETE）没拿到结果 → VENUE_OUTCOME_UNKNOWN（3006），必须先按 clientOrderId 查状态；
//   3) 只读查询没拿到响应 → VENUE_UNAVAILABLE（3003，可重试）。
// Bitget 的坑：业务错误以 `{code,msg}` 信封返回，HTTP 状态可能是 200 或 4xx，所以「信封错误」也是本文件的一等输入。
// 对应地，rest.ts 对任意 HTTP 状态都先解析信封；状态码只在没有信封码时才决定分类。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'
import { classifyBitgetError } from './venue-errors'

export const VENUE_ID = 'bitget'
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

export type BitgetEndpoint = 'signed' | 'public'

/** 上游返回非 2xx。body = 响应原文（已脱敏）；retryAfterMs 来自 Retry-After 头。 */
export class BitgetHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly endpoint: BitgetEndpoint,
    readonly retryAfterMs?: number,
    /** true = 改变状态的请求失败且结果未知（非 GET 的 408 / 5xx / 断连）→ 3006。 */
    readonly outcomeUnknown = false,
  ) {
    super(`bitget ${endpoint} HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'BitgetHttpError'
  }
}

/**
 * Bitget 业务错误信封（`code !== '00000'`，HTTP 状态可能是 200 或 4xx）。`code` 是上游原值（字符串，如 '40009'）。
 * 单列一类是因为它既不是网络错也不是 HTTP 错，但必须按码表分类；`status` 保留 HTTP 状态供分类器判 401 / 5xx。
 */
export class BitgetApiError extends Error {
  constructor(
    readonly code: string,
    readonly msg: string,
    readonly endpoint: BitgetEndpoint,
    readonly body: string,
    /** true = 改变状态的请求拿到「执行状态未知」类业务码（由 rest.ts 判定）。 */
    readonly outcomeUnknown = false,
    /** HTTP 状态（信封可能随 4xx 一起回来）。 */
    readonly status = 200,
  ) {
    super(`bitget ${endpoint} code ${code}: ${msg.slice(0, 200)}`)
    this.name = 'BitgetApiError'
  }
}

/** 没拿到响应（超时 / 断网 / 取消）。改变状态的请求上出现它意味着「结果未知」（3006）。 */
export class BitgetNetworkError extends Error {
  constructor(
    message: string,
    readonly endpoint: BitgetEndpoint,
    override readonly cause?: unknown,
    /** true = 改变状态的请求没拿到响应 → 3006（不得盲目重发）。 */
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'BitgetNetworkError'
  }
}

/** 构造带 venue 段的 Problem；upstream 由调用方传入（本函数不脱敏）。 */
export function venueProblem(name: ProblemName, summary: string, upstream: string, extra: Partial<Problem> = {}): Problem {
  return makeProblem(name, summary, { venue: { id: VENUE_ID, message: upstream }, ...extra })
}

export interface ErrorContext {
  /** apiSecret / passphrase / apiKey：任何出现在错误文本里的都要替换掉。 */
  secrets?: readonly string[]
  endpoint?: BitgetEndpoint
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
  // 别的包（例如 @gitrader/connector-bitget-data）的 ProblemError 是另一个类：按形状认，避免退化成 INTERNAL。
  const foreign = e as { problem?: Partial<Problem> } | null
  if (foreign !== null && typeof foreign === 'object' && typeof foreign.problem === 'object' && foreign.problem !== null
    && typeof foreign.problem.code === 'number' && typeof foreign.problem.name === 'string') {
    return scrub(foreign.problem as Problem, secrets)
  }

  if (e instanceof BitgetHttpError) {
    const retryAfterMs = e.retryAfterMs
    if (e.status === 429 || e.status === 418) {
      return scrub(
        venueProblem('VENUE_UNAVAILABLE', 'venue rate limited the request', e.body, {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          venue: { id: VENUE_ID, code: e.status, message: e.body },
        }),
        secrets,
      )
    }
    if (e.outcomeUnknown) {
      return scrub(
        venueProblem('VENUE_OUTCOME_UNKNOWN', 'venue error after the request was sent; query by clientOrderId before retrying', e.body, {
          venue: { id: VENUE_ID, code: e.status, message: e.body },
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        }),
        secrets,
      )
    }
    if (e.status === 401 || e.status === 403) {
      return scrub(
        venueProblem('VENUE_AUTH', 'venue rejected the credentials', e.body, {
          venue: { id: VENUE_ID, code: e.status, message: e.body },
        }),
        secrets,
      )
    }
    const classified = classifyBitgetError({ status: e.status, text: e.body })
    return scrub({ ...classified.problem, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }, secrets)
  }

  if (e instanceof BitgetApiError) {
    if (e.outcomeUnknown) {
      return scrub(
        venueProblem('VENUE_OUTCOME_UNKNOWN', 'venue reported an unknown execution state; query by clientOrderId before retrying', e.body, {
          venue: { id: VENUE_ID, code: e.code, message: e.msg },
        }),
        secrets,
      )
    }
    const classified = classifyBitgetError({ status: e.status, code: e.code, text: `${e.code} ${e.msg}`.trim() })
    return scrub({ ...classified.problem, venue: { id: VENUE_ID, code: e.code, message: e.msg } }, secrets)
  }

  if (e instanceof BitgetNetworkError) {
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
