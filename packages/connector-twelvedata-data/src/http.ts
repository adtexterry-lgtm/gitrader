// SPDX-License-Identifier: CPAL-1.0
// Twelve Data 公共 REST 客户端：只发 GET，密钥只走 `Authorization: apikey <key>` 请求头
// （不进 URL、不进日志、不进错误信息）。错误语义按官方错误码表（https://twelvedata.com/docs#errors）：
//   400 Bad Request → INVALID_PARAMS（参数 / 标的不对，不重试）
//   401 Unauthorized → VENUE_AUTH（密钥无效，不重试）
//   403 Forbidden → VENUE_AUTH（该端点 / 标的超出计划，不重试）
//   404 Not Found → INVALID_PARAMS
//   429 Too Many Requests → VENUE_UNAVAILABLE + retryAfterMs（读 Retry-After，并让预算整体退避）
//   5xx / 网络异常 / 坏 JSON → VENUE_UNAVAILABLE（retryable）
// 官方也可能用 HTTP 200 携带 {status: "error", code, message}：同样按上表映射，不看 HTTP 状态码。
// 每个请求前先向注入的预算要一次额度（1 credit），成功后 reportOk；预算缺省不限。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'
import { RATE_LIMIT, RATE_WINDOW_MS, REQUEST_WEIGHT, VENUE, authHeaders, problemError } from './parse'
import type { TwelveDataCredentials } from './parse'

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

export interface TwelveDataHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
  credentials: TwelveDataCredentials
}

/** 官方错误信封：{code, message, status: "error"}。 */
interface ErrorEnvelope {
  code?: unknown
  message?: unknown
  status?: unknown
}

export function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return !!body && typeof body === 'object' && (body as ErrorEnvelope).status === 'error'
}

export class TwelveDataHttp {
  readonly baseUrl: string
  readonly #fetchImpl: typeof fetch
  readonly #budget: RateBudget | BudgetLike
  readonly #timeoutMs: number
  readonly #headers: Record<string, string>
  /** 只供错误出口脱敏：任何对外文本里出现密钥原文（或 base64 形态）都替换掉。 */
  readonly #secrets: readonly string[]

  constructor(o: TwelveDataHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, '')
    this.#fetchImpl = o.fetchImpl
    this.#budget = o.budget
    this.#timeoutMs = o.timeoutMs
    this.#headers = authHeaders(o.credentials)
    this.#secrets = [o.credentials.apiKey].filter((s) => typeof s === 'string' && s !== '')
  }

  /** 是否带密钥（只回布尔，不回任何密钥片段）。 */
  get authenticated(): boolean {
    return Object.keys(this.#headers).length > 0
  }

  /** GET 一次并解析 JSON；非 2xx 与 `status: "error"` 信封都按官方错误码表映射。密钥不进查询参数。 */
  async get<T>(path: string, params: Record<string, string | number | undefined>, weight: number = REQUEST_WEIGHT): Promise<T> {
    await this.spend(weight)
    const url = urlOf(this.baseUrl, path, params)
    let res: Response
    try {
      res = await this.#fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...this.#headers },
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (e) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} request failed`, {
        venue: { id: VENUE, message: truncate(this.redact(e instanceof Error ? e.message : String(e))) },
      })
    }

    const text = await res.text().catch(() => '')
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = undefined
    }

    if (!res.ok) throw this.problemFor(path, res, body)
    if (body === undefined) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} returned invalid JSON`, {
        venue: { id: VENUE, message: 'invalid json' },
      })
    }
    if (isErrorEnvelope(body)) throw this.problemFor(path, res, body)
    this.#budget.reportOk?.()
    return body as T
  }

  private async spend(weight: number): Promise<void> {
    const b: BudgetLike = this.#budget
    if (typeof b.acquire === 'function') {
      await b.acquire(weight, { priority: 'high' })
      return
    }
    if (typeof b.take === 'function') await b.take(weight)
  }

  /** 错误出口脱敏：上游若在响应体 / 报错里回显密钥原文，一律替换后再外传。 */
  private redact(s: string): string {
    return redactSecret(s, this.#secrets)
  }

  /**
   * HTTP 状态码与信封 code 一起看：信封里有 4xx/5xx 数值 code 就用它，否则用 HTTP 状态码。
   * 429 一律退避并把 retryAfterMs 带回（Retry-After 缺失时按 60 s）。
   */
  private problemFor(path: string, res: Response, body: unknown): ReturnType<typeof problemError> {
    const envelope = isErrorEnvelope(body) ? body : undefined
    const code = typeof envelope?.code === 'number' && envelope.code > 0 ? envelope.code : res.status
    const message = typeof envelope?.message === 'string' && envelope.message !== '' ? envelope.message : truncate(res.statusText ?? '')
    const safeMessage = truncate(this.redact(message))
    const venue = { id: VENUE, code, message: safeMessage === '' ? 'empty response' : safeMessage }
    if (code === 401 || code === 403) {
      return problemError('VENUE_AUTH', `${VENUE} ${path} HTTP ${code} (check api key and plan coverage)`, { venue })
    }
    if (code === 404) {
      return problemError('INVALID_PARAMS', `${VENUE} ${path} HTTP 404 (unknown symbol or endpoint)`, { venue })
    }
    if (code === 400) {
      return problemError('INVALID_PARAMS', `${VENUE} ${path} HTTP 400 (bad request: ${venue.message})`, { venue })
    }
    let retryAfterMs: number | undefined
    if (code === 429) {
      const header = res.headers.get('retry-after')
      const seconds = header === null ? NaN : Number(header)
      retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 60_000
      ;(this.#budget as BudgetLike).penalize?.(retryAfterMs)
    }
    return problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} HTTP ${code}`, {
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      venue,
    })
  }
}

function urlOf(baseUrl: string, path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s)

// 以下 redactSecret 的口径与 packages/notify-email/src/secret.ts（同 CPAL-1.0）一致：
// 把每个 secret 原文（以及常见的 base64 形态）替换成 `<redacted>`；空 secret 跳过。
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
