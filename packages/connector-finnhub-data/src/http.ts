// SPDX-License-Identifier: CPAL-1.0
// Finnhub 公共 REST 客户端：只发 GET，密钥只走 `X-Finnhub-Token` 请求头（不进 URL、不进日志、不进错误信息）。
// 错误码语义按官方文档（https://finnhub.io/docs/api/rate-limit 与各端点页的 Error 段）：
//   401 Unauthorized → VENUE_AUTH（密钥无效，不重试）
//   403 Forbidden    → VENUE_AUTH（该端点 / 该标的需要付费档，不重试）
//   404 Not Found    → INVALID_PARAMS（端点或标的写错，不重试）
//   429 Too Many Requests → VENUE_UNAVAILABLE + retryAfterMs（读 Retry-After，并让预算整体退避）
//   其余非 2xx / 坏 JSON / 网络异常 → VENUE_UNAVAILABLE（retryable）
// 每个请求前先向注入的预算要一次额度，成功后 reportOk；预算缺省不限。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'
import { RATE_LIMIT, RATE_WINDOW_MS, VENUE, authHeaders, problemError } from './parse'
import type { FinnhubCredentials } from './parse'

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

export interface FinnhubHttpOptions {
  baseUrl: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
  credentials: FinnhubCredentials
}

export class FinnhubHttp {
  readonly baseUrl: string
  readonly #fetchImpl: typeof fetch
  readonly #budget: RateBudget | BudgetLike
  readonly #timeoutMs: number
  readonly #headers: Record<string, string>
  /** 只供错误出口脱敏：任何对外文本里出现密钥原文（或 base64 形态）都替换掉。 */
  readonly #secrets: readonly string[]

  constructor(o: FinnhubHttpOptions) {
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

  /** GET 一次并解析 JSON；错误映射见文件头。密钥永远不放进查询参数。 */
  async get<T>(path: string, params: Record<string, string | number | undefined>, weight: number): Promise<T> {
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
    if (!res.ok) throw await this.failed(path, res)
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} returned invalid JSON`, {
        venue: { id: VENUE, message: 'invalid json' },
      })
    }
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

  private async failed(path: string, res: Response): Promise<ReturnType<typeof problemError>> {
    const body = truncate(this.redact(await res.text().catch(() => '')))
    const venue = { id: VENUE, code: res.status, message: body === '' ? 'empty response' : body }
    if (res.status === 401 || res.status === 403) {
      // 401 = 密钥无效；403 = 该端点 / 标的属于付费档（官方端点页的 Error 段）
      return problemError('VENUE_AUTH', `${VENUE} ${path} HTTP ${res.status} (check api key and plan coverage)`, { venue })
    }
    if (res.status === 404) {
      return problemError('INVALID_PARAMS', `${VENUE} ${path} HTTP 404 (unknown symbol or endpoint)`, { venue })
    }
    let retryAfterMs: number | undefined
    if (res.status === 429) {
      const header = res.headers.get('retry-after')
      const seconds = header === null ? NaN : Number(header)
      retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 60_000
      ;(this.#budget as BudgetLike).penalize?.(retryAfterMs)
    }
    return problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} HTTP ${res.status}`, {
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
