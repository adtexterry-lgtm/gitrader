// SPDX-License-Identifier: CPAL-1.0
// Polygon REST 客户端：所有端点都是 GET https://api.massive.com/<path>?<query>，鉴权用 Authorization: Bearer <API Key>
// （官方文档给了 apiKey query 参数与 Bearer 头两种写法；本包只用头，避免密钥出现在 URL、访问日志与错误串里）。
// 密钥只存在私有字段：不打印、不进错误信息、不参与 JSON 序列化，并在错误出口按原文 / base64 形态脱敏
// （脱敏口径与 packages/notify-email/src/secret.ts 一致，同 CPAL-1.0）。
// 每个请求前先向注入的预算要额度（acquire 为主，其次 take），成功后 reportOk；预算缺省不限。
import type { BudgetUsage, RateBudget } from '@gitrader/protocol/connector'
import { RATE_LIMIT, RATE_WINDOW_MS, VENUE, polygonFailureOf, problemError } from './parse'

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

export interface PolygonHttpOptions {
  baseUrl: string
  apiKey: string
  fetchImpl: typeof fetch
  budget: RateBudget | BudgetLike
  timeoutMs: number
}

export class PolygonHttp {
  readonly baseUrl: string
  readonly #apiKey: string
  readonly #fetchImpl: typeof fetch
  readonly #budget: RateBudget | BudgetLike
  readonly #timeoutMs: number

  constructor(o: PolygonHttpOptions) {
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

  /**
   * GET 一次并解析 JSON。错误映射：
   * 401 / 403 → VENUE_AUTH（不重试；403 常见于免费套餐没有该数据权限）；404 → INVALID_PARAMS（不重试）；
   * 429 → VENUE_UNAVAILABLE + retryAfterMs（并让预算整体退避）；
   * 200 但 body 是 {"status":"NOT_AUTHORIZED"} → VENUE_AUTH（不重试）；
   * 200 但 body 是 {"status":"ERROR"} → VENUE_UNAVAILABLE；其余非 2xx / 坏 JSON / 网络异常 → VENUE_UNAVAILABLE。
   */
  async getJson<T>(path: string, params: Record<string, string | number | undefined>, weight: number): Promise<T> {
    await this.spend(weight)
    const url = urlOf(this.baseUrl, path, params)
    let res: Response
    try {
      res = await this.#fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (e) {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} request failed`, {
        retryable: true,
        venue: { id: VENUE, message: truncate(this.redact(e instanceof Error ? e.message : String(e))) },
      })
    }
    if (!res.ok) throw await this.failed(path, res)
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw problemError('VENUE_UNAVAILABLE', `${VENUE} ${path} returned invalid JSON`, {
        retryable: true, venue: { id: VENUE, message: 'invalid json' },
      })
    }
    const failure = polygonFailureOf(body)
    if (failure) {
      const unauthorized = failure.status === 'NOT_AUTHORIZED'
      throw problemError(unauthorized ? 'VENUE_AUTH' : 'VENUE_UNAVAILABLE', `${VENUE} ${path} answered status ${failure.status}`, {
        retryable: !unauthorized,
        venue: { id: VENUE, code: failure.status, message: truncate(this.redact(failure.message)) },
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

  private redact(s: string): string {
    return redactSecret(s, [this.#apiKey])
  }

  private async failed(path: string, res: Response): Promise<ReturnType<typeof problemError>> {
    const body = truncate(this.redact(await res.text().catch(() => '')))
    const venue = { id: VENUE, code: res.status, message: body === '' ? 'empty response' : body }
    if (res.status === 401 || res.status === 403) {
      return problemError('VENUE_AUTH', `${VENUE} ${path} HTTP ${res.status} (check the API key and plan entitlement)`, { venue })
    }
    if (res.status === 404) {
      return problemError('INVALID_PARAMS', `${VENUE} ${path} HTTP 404 (unknown ticker or endpoint)`, { venue })
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
