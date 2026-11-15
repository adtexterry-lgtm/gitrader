// SPDX-License-Identifier: CPAL-1.0
// Alpha Vantage REST 客户端：所有端点共用 GET /query，参数以 query string 区分（官方文档的唯一入口）。
// API Key 走 query 参数 `apikey`（官方示例写法）；它只存在私有字段里：不打印、不进错误信息、不参与 JSON 序列化，
// 并在错误出口按原文 / base64 形态脱敏（脱敏函数口径与 packages/notify-email/src/secret.ts 一致，同 CPAL-1.0）。
// 上游限制（官方 Support 页，施工时离线）：超限与参数错误**仍是 HTTP 200**，body 里带 Information / Note / Error Message；
// 所以这里先看 body 再判状态码，两类失败都映射成 Problem：含 premium 的提示是付费门槛（VENUE_AUTH，不重试、
// 不罚预算），其余 Information / Note 按限流（VENUE_UNAVAILABLE，可重试并让预算退避）。
// 每个请求前先向注入的预算要额度（acquire 为主，其次 take），确认响应不是失败体后才 reportOk；预算缺省不限。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'
import { QUERY_PATH, RATE_LIMIT, RATE_WINDOW_MS, VENUE, avFailureOf, problemError } from './parse'

/** 预算接口的最小形状：优先 `acquire`（协议 RateBudget），其次 `take`；成功回调 `reportOk`。 */
export interface BudgetLike {
  acquire?(weight: number, opts?: { priority?: 'high' | 'low'; signal?: AbortSignal }): Promise<void>
  take?(weight: number): void | Promise<void>
  charge?(weight: number): void
  penalize?(retryAfterMs?: number): void
  reportOk?(): void
  usage?(): BudgetUsage
}

/** 缺省预算：不限额度（只记录口径，不阻塞）。 */
export function unlimitedBudget(): RateBudget {
  return {
    acquire: async () => {},
    charge: () => {},
    penalize: () => {},
    reportOk: () => {},
    usage: () => ({
      used: 0, target: RATE_LIMIT, limit: RATE_LIMIT, ratio: 0, windowMs: RATE_WINDOW_MS, backoffUntil: 0,
    }),
  }
}

export interface AlphaVantageHttpOptions {
  baseUrl: string
  apiKey: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

export class AlphaVantageHttp {
  readonly baseUrl: string
  readonly #apiKey: string
  readonly #fetchImpl: typeof fetch
  readonly #budget: RateBudget | BudgetLike
  readonly #timeoutMs: number

  constructor(o: AlphaVantageHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.#apiKey = o.apiKey
    this.#fetchImpl = o.fetchImpl
    this.#budget = o.budget
    this.#timeoutMs = o.timeoutMs
  }

  /** 是否带 key（只回布尔，不回任何片段）。 */
  get authenticated(): boolean {
    return this.#apiKey !== ''
  }

  /** 取 JSON：竞价预算 → GET → 错误 / 上游失败体判定 → JSON.parse。 */
  async queryJson(params: Record<string, string | number | undefined>, weight: number): Promise<unknown> {
    const text = await this.queryText(params, weight)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${String(params.function ?? '')} returned invalid JSON`, {
        retryable: true, venue: { id: VENUE, message: 'invalid json' },
      })
    }
  }

  /** 取原文（LISTING_STATUS 是 CSV）：同样做状态码与上游失败体判定，再做 CSV 解析。 */
  async queryText(params: Record<string, string | number | undefined>, weight: number): Promise<string> {
    await this.spend(weight)
    const url = urlOf(this.baseUrl, params, this.#apiKey)
    const fn = String(params.function ?? '')
    let res: Response
    try {
      res = await this.#fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json, text/csv;q=0.9' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (e) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${fn} request failed`, {
        retryable: true,
        venue: { id: VENUE, message: truncate(this.redact(e instanceof Error ? e.message : String(e))) },
      })
    }
    if (!res.ok) throw await this.failed(fn, res)
    let text: string
    try {
      text = await res.text()
    } catch {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${fn} response body could not be read`, {
        retryable: true, venue: { id: VENUE, message: 'unreadable body' },
      })
    }
    // CSV 端点不会有 JSON 失败体；只有 JSON 端点才需要判 Information / Note / Error Message
    if (looksJson(text)) {
      let body: unknown
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = undefined
      }
      const failure = avFailureOf(body)
      if (failure) throw this.upstreamFailure(fn, failure.kind, failure.message)
    }
    this.#budget.reportOk?.()
    return text
  }

  private async spend(weight: number): Promise<void> {
    const b: BudgetLike = this.#budget
    if (typeof b.acquire === 'function') {
      await b.acquire(weight, { priority: 'high' })
      return
    }
    if (typeof b.take === 'function') await b.take(weight)
  }

  private redact(s: string): string {
    return redactSecret(s, [this.#apiKey])
  }

  /**
   * 200 + 失败体：
   *   api-error  → INVALID_PARAMS（参数 / 标的错，不重试）
   *   premium    → VENUE_AUTH（付费门槛，重试也无用；不 penalize 预算）
   *   rate-limit → VENUE_UNAVAILABLE（retryable，retryAfterMs 按「免费档 25 次/天」给 60 s 起）
   * 都把上游原文放进 venue.message（截断 + 脱敏），不翻译、不改写。
   */
  private upstreamFailure(fn: string, kind: 'api-error' | 'rate-limit', message: string): ReturnType<typeof problemError> {
    const venue = { id: VENUE, message: truncate(this.redact(message)) }
    if (kind === 'api-error') {
      return problemError('INVALID_PARAMS', `${VENUE} ${fn} rejected the request (upstream: ${venue.message})`, { venue })
    }
    if (/premium/i.test(message)) {
      return problemError('VENUE_AUTH', `${VENUE} ${fn} needs a premium plan (upstream: ${venue.message})`, { venue })
    }
    const retryAfterMs = 60_000
    ;(this.#budget as BudgetLike).penalize?.(retryAfterMs)
    return problemError('VENUE_UNAVAILABLE', `${VENUE} ${fn} is rate-limited (upstream: ${venue.message})`, {
      retryable: true, retryAfterMs, venue,
    })
  }

  private async failed(fn: string, res: Response): Promise<ReturnType<typeof problemError>> {
    const body = truncate(this.redact(await res.text().catch(() => '')))
    const venue = { id: VENUE, code: res.status, message: body === '' ? 'empty response' : body }
    if (res.status === 401 || res.status === 403) {
      return problemError('VENUE_AUTH', `${VENUE} ${fn} HTTP ${res.status} (check the API key)`, { venue })
    }
    if (res.status === 404) {
      return problemError('INVALID_PARAMS', `${VENUE} ${fn} HTTP 404 (unknown endpoint)`, { venue })
    }
    let retryAfterMs: number | undefined
    if (res.status === 429) {
      const header = res.headers.get('retry-after')
      const seconds = header === null ? NaN : Number(header)
      retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 60_000
      ;(this.#budget as BudgetLike).penalize?.(retryAfterMs)
    }
    return problemError('VENUE_UNAVAILABLE', `${VENUE} ${fn} HTTP ${res.status}`, {
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      venue,
    })
  }
}

function looksJson(text: string): boolean {
  const head = text.trimStart()[0]
  return head === '{' || head === '['
}

function urlOf(baseUrl: string, params: Record<string, string | number | undefined>, apiKey: string): string {
  const url = new URL(`${baseUrl}${QUERY_PATH}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  url.searchParams.set('apikey', apiKey)
  return url.toString()
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

// 脱敏口径与 packages/notify-email/src/secret.ts（CPAL-1.0）一致：把每个 secret 原文（以及它在 AUTH 里常见的
// base64 形态）替换成 `<redacted>`；空 secret 跳过。
const REDACTED = '<redacted>'
function redactSecret(s: string, secrets: readonly string[]): string {
  let out = s
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.split(secret).join(REDACTED)
    const encoded = Buffer.from(secret, 'utf8').toString('base64')
    if (encoded.length >= 4) out = out.split(encoded).join(REDACTED)
  }
  return out
}
