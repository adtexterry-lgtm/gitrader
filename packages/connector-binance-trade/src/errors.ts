// SPDX-License-Identifier: CPAL-1.0
// 上游报错 → 协议 Problem（契约 §2.8）。本文件只做「形状判定 + 脱敏 + 分类转交」，规则表在 venue-errors.ts。
// 铁律：`venue.message` 原样保存上游报错（只做密钥脱敏，不翻译、不截断语义）；分类认不出来的落 3001 VENUE_REJECTED。
//   1) HTTP 429 / 418 → VENUE_UNAVAILABLE（3003，与 HL venue-errors.ts 同码）+ retryable + Retry-After；
//   2) 改变状态的请求（POST / PUT / DELETE）没拿到响应 → VENUE_OUTCOME_UNKNOWN（3006），必须先按 clientOrderId 查状态，不得盲目重发；
//   3) GET（含签名 GET）没拿到响应 → VENUE_UNAVAILABLE（3003，可重试）。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'
import { classifyBinanceError, refineOrderSizeProblem } from './venue-errors'

export const VENUE_ID = 'binance'
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

export type BinanceEndpoint = 'signed' | 'public'

/** 上游返回非 2xx。body = 响应原文（未改动）；retryAfterMs 来自 Retry-After 头。 */
export class BinanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly endpoint: BinanceEndpoint,
    readonly retryAfterMs?: number,
    /** true = 这是改变状态的请求（POST/PUT/DELETE）失败，上游结果未知 → 3006。 */
    readonly outcomeUnknown = false,
  ) {
    super(`binance ${endpoint} HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'BinanceHttpError'
  }
}

/** 没拿到响应（超时 / 断网 / 取消）。签名请求上出现它意味着「结果未知」（3006）。 */
export class BinanceNetworkError extends Error {
  constructor(
    message: string,
    readonly endpoint: BinanceEndpoint,
    override readonly cause?: unknown,
    /** true = 改变状态的请求没拿到响应 → 3006（不得盲目重发）。 */
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'BinanceNetworkError'
  }
}

/** 构造带 venue 段的 Problem；upstream 由调用方传入（本函数不脱敏）。 */
export function venueProblem(name: ProblemName, summary: string, upstream: string, extra: Partial<Problem> = {}): Problem {
  return makeProblem(name, summary, { venue: { id: VENUE_ID, message: upstream }, ...extra })
}

export interface ErrorContext {
  /** apiSecret / apiKey：任何出现在错误文本里的都要替换掉。 */
  secrets?: readonly string[]
  endpoint?: BinanceEndpoint
}

function scrub(problem: Problem, secrets: readonly string[]): Problem {
  if (secrets.length === 0) return problem
  return {
    ...problem,
    message: redactSecret(problem.message, secrets),
    ...(problem.venue ? { venue: { ...problem.venue, message: redactSecret(problem.venue.message, secrets) } } : {}),
  }
}

/** 字符串里能认出 `{"code":-1021,...}` 时取出 code（上游 body 是 JSON 文本）。 */
function bodyCode(body: string): number | undefined {
  const m = /"code"\s*:\s*(-?\d+)/.exec(body)
  if (!m?.[1]) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

function bodyMessage(body: string): string {
  const m = /"msg"\s*:\s*"([^"]*)"/.exec(body)
  return m?.[1] ?? body
}

/** 任意错误 → Problem（含分类与脱敏）。 */
export function asProblem(e: unknown, ctx: ErrorContext = {}): Problem {
  const secrets = ctx.secrets ?? []
  if (e instanceof ProblemError) return scrub(e.problem, secrets)
  if (e instanceof BinanceHttpError) {
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
    const code = bodyCode(e.body)
    const text = e.body === '' ? bodyMessage(e.body) : e.body
    const classified = classifyBinanceError({ text, code, status: e.status })
    // -4164（名义额过小）属于参数类：分类结果是 1002，再细分落 1003 MIN_NOTIONAL 并带一句可执行提示（不夹取、不改数量）。
    const refined = refineOrderSizeProblem(classified.problem, { text, code, status: e.status })
    return scrub(
      { ...refined, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
      secrets,
    )
  }
  if (e instanceof BinanceNetworkError) {
    // GET（含签名 GET）没拿到响应 → 3003 可重试，与 HL 读端点同码；只有改变状态的请求（POST / PUT / DELETE）才 3006。
    const out = e.outcomeUnknown
      ? venueProblem('VENUE_OUTCOME_UNKNOWN', 'no response from venue; query by clientOrderId before retrying', e.message)
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
