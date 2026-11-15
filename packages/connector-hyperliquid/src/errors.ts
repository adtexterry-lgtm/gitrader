// SPDX-License-Identifier: CPAL-1.0
// 上游报错 → Problem（契约 §2.8）。
// 铁律：`venue.message` 原样保存上游报错，不翻译、不改写、不截断；`message` 只写一句简短英文摘要。
// 分类只看已知短语 / HTTP 状态，认不出来的一律落到 3001 VENUE_REJECTED。
import { makeProblem } from '@gitrader/protocol'
import type { Problem, ProblemName } from '@gitrader/protocol'
import { HlHttpError, HlNetworkError } from './rest'

const VENUE_ID = 'hyperliquid'

export function venueProblem(name: ProblemName, summary: string, upstream: string, extra: Partial<Problem> = {}): Problem {
  return makeProblem(name, summary, { venue: { id: VENUE_ID, message: upstream }, ...extra })
}

/** 订单 / 动作级错误文本（statuses[i].error 或顶层 {status:"err", response:"..."}）。 */
export function problemFromVenueMessage(message: string): Problem {
  if (/insufficient margin|insufficient (?:spot )?balance/i.test(message)) {
    return venueProblem('VENUE_INSUFFICIENT_MARGIN', 'venue reports insufficient margin', message)
  }
  if (/too many requests|rate limit/i.test(message)) {
    return venueProblem('VENUE_RATE_LIMITED', 'venue rate limited the request', message)
  }
  if (/user or api wallet .* does not exist|invalid signature|unable to recover|api wallet .*expired/i.test(message)) {
    return venueProblem('VENUE_AUTH', 'venue could not authenticate the signer', message)
  }
  return venueProblem('VENUE_REJECTED', 'venue rejected the request', message)
}

/** 传输层错误。exchange 上「没拿到响应」= 结果未知（3006），不得盲目重发。 */
export function problemFromTransportError(e: unknown, endpoint: 'info' | 'exchange'): Problem {
  if (e instanceof HlHttpError) {
    if (e.status === 429) return venueProblem('VENUE_RATE_LIMITED', 'venue rate limited the request', e.body, { retryable: true })
    if (e.status >= 500) {
      return endpoint === 'exchange'
        ? venueProblem('VENUE_OUTCOME_UNKNOWN', 'venue error after the request was sent; query by clientOrderId before retrying', e.body)
        : venueProblem('VENUE_UNAVAILABLE', 'venue unavailable', e.body)
    }
    return problemFromVenueMessage(e.body)
  }
  if (e instanceof HlNetworkError) {
    return endpoint === 'exchange'
      ? venueProblem('VENUE_OUTCOME_UNKNOWN', 'no response from venue; query by clientOrderId before retrying', e.message)
      : venueProblem('VENUE_UNAVAILABLE', 'venue unreachable', e.message)
  }
  const msg = e instanceof Error ? e.message : String(e)
  return makeProblem('INTERNAL', msg)
}

/** 给调用方抛的错误：携带 Problem。 */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.venue?.message ?? problem.message)
    this.name = 'ProblemError'
  }
}
