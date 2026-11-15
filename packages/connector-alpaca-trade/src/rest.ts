// SPDX-License-Identifier: CPAL-1.0
// Alpaca Trading API v2 REST 出口（**请求头密钥对鉴权，不是 HMAC**）。
// 鉴权口径（官方 Trading API 认证文档；QD alpaca_trading/client.py:623-627 手写 activities 请求即此两个头）：
//     APCA-API-KEY-ID: <key>
//     APCA-API-SECRET-KEY: <secret>
// 没有时间戳、没有预签串、没有签名算法——所以本文件不 import node:crypto 的 createHmac，
// 也**不发**任何签名头；密钥进 `#` 私有字段，JSON.stringify / util.inspect / String(err) 都看不到。
// 环境（美股八条第 7 条）：mode = paper | live 显式声明，基址随之决定（constants.ts）；
//   密钥前缀 `PK` = paper、`AK` = live（QD alpaca_trading/README.md:27-30）；
//   前缀与声明不符 → **构造时拒绝**，只比前缀、绝不打印密钥。
// 「结果未知」（教训 3）：改变状态的请求（POST / PATCH / DELETE）上的超时 / 断连 / 5xx / 上游含糊文本
//   → 3006，不重发，ack.status = 'unknown'，按 client_order_id 对账；GET 上的同类错误只算 3003（可重试）。
import type { RateBudget } from '@gitrader/protocol/connector'
import { ALPACA_WEIGHTS, createAlpacaBudget } from './budget'
import type { AlpacaBudget, BudgetKind } from './budget'
import { VenueClock } from './clock'
import { AUTH_HEADERS, DATA_BASE_URL, KEY_PREFIX_MODES, TRADING_BASE_URLS } from './constants'
import type { AlpacaMode } from './constants'
import { AlpacaApiError, AlpacaHttpError, AlpacaNetworkError, redactSecret } from './errors'
import type { AlpacaEndpoint } from './errors'
import { AMBIGUOUS_TOKENS } from './venue-errors'

export type Environment = AlpacaMode

/** 升级过的消息：前缀不认识时只说规则，前缀与声明不符时说前缀（不出现密钥本身）。 */
export class ModeMismatchError extends RangeError {
  constructor(readonly declared: AlpacaMode, readonly keyPrefix: string, readonly reason: 'mismatch' | 'unknown' = 'mismatch') {
    super(
      reason === 'unknown'
        ? 'Alpaca API key prefix is not recognised (expected PK = paper, AK = live); the connector refuses to guess the environment'
        : `Alpaca API key prefix "${keyPrefix}" does not match the declared mode "${declared}" `
          + '(PK = paper, AK = live); the connector refuses to mix paper and live',
    )
    this.name = 'ModeMismatchError'
  }
}

/** 只比前缀，不解码、不落盘、不进消息。 */
export function keyMode(apiKey: string): AlpacaMode | 'unknown' {
  const upper = apiKey.trim().toUpperCase()
  for (const entry of KEY_PREFIX_MODES) if (upper.startsWith(entry.prefix)) return entry.mode
  return 'unknown'
}

/** 前缀与声明一致性校验：前缀不认识、或与声明不符，都在构造期抛 ModeMismatchError。 */
export function assertModeMatchesKey(apiKey: string, declared: AlpacaMode): void {
  const detected = keyMode(apiKey)
  const prefix = apiKey.trim().slice(0, 2).toUpperCase()
  if (detected === 'unknown') throw new ModeMismatchError(declared, '', 'unknown')
  if (detected !== declared) throw new ModeMismatchError(declared, prefix)
}

export interface AlpacaHttpOptions {
  /** 显式声明环境：paper / live（缺省 paper——默认不碰真钱）。 */
  mode?: AlpacaMode
  /** 显式基址优先（测试 / 镜像）；缺省官方基址。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  fetchImpl?: typeof fetch
  clock?: () => number
  timeoutMs?: number
  budget?: AlpacaBudget
  onWarn?: (message: string) => void
  /** 数据 API 基址（参考价 / 报价）。 */
  dataBaseUrl?: string
}

export interface RequestOptions {
  kind?: BudgetKind
  weight?: number
  signal?: AbortSignal
  /** 下单 / 撤单 / 改单 / 全撤：另记下单计数（与查询共用额度，仍走 acquire(1)）。 */
  order?: boolean
  params?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
}

/** 参数按键名排序后编码（Alpaca 不签名，排序只为稳定与可断言）。undefined / null 跳过。 */
export function encodeQuery(params: Record<string, string | number | boolean | undefined | null> = {}): string {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null).sort()
  const qs = new URLSearchParams()
  for (const key of keys) qs.append(key, String(params[key]))
  return qs.toString()
}

export class AlpacaHttp {
  readonly mode: AlpacaMode
  readonly baseUrl: string
  readonly dataBaseUrl: string
  readonly clockSync: VenueClock
  readonly #apiKey: string
  readonly #apiSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly budget: AlpacaBudget
  private readonly onWarn: (message: string) => void
  /** 诊断：累计请求数、累计请求额度、最近一次上游 code / 状态（都不含密钥）。 */
  requests = 0
  weightSpent = 0
  lastStatus: number | null = null
  lastCode: string | number | null = null

  constructor(o: AlpacaHttpOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey.trim() === '') throw new RangeError('apiKey is required')
    if (typeof o.apiSecret !== 'string' || o.apiSecret.trim() === '') throw new RangeError('apiSecret is required')
    this.mode = o.mode ?? 'paper'
    // 美股八条第 7 条：前缀与声明不符 → 构造时拒绝（只比前缀，不打印密钥）。
    assertModeMatchesKey(o.apiKey, this.mode)
    this.baseUrl = (o.baseUrl ?? TRADING_BASE_URLS[this.mode]).replace(/\/+$/, '')
    this.dataBaseUrl = (o.dataBaseUrl ?? DATA_BASE_URL).replace(/\/+$/, '')
    const clock = o.clock ?? (() => Date.now())
    this.clockSync = new VenueClock(clock)
    this.#apiKey = o.apiKey.trim()
    this.#apiSecret = o.apiSecret.trim()
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = o.timeoutMs ?? 15_000
    this.budget = o.budget ?? createAlpacaBudget({ clock })
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
  }

  /** 诊断：预算占用。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.budget.usage()
  }

  /** 用 `GET /v2/clock` 的 timestamp 重校（可选，本连接器不依赖时间戳鉴权）。 */
  resync(serverTimeMs: number): void {
    this.clockSync.resync(serverTimeMs)
  }

  /** 密钥脱敏：错误消息 / 告警只走这里。 */
  safeText(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e)
    return redactSecret(text, [this.#apiSecret, this.#apiKey])
  }

  /** 同包内的 account / trading 组 Problem 时要用同一份密钥做脱敏。 */
  secretsForRedaction(): readonly string[] {
    return [this.#apiSecret, this.#apiKey]
  }

  /** 鉴权头（唯一一处出现密钥的地方）。 */
  private headers(): Record<string, string> {
    return {
      [AUTH_HEADERS.keyId]: this.#apiKey,
      [AUTH_HEADERS.secret]: this.#apiSecret,
      accept: 'application/json',
    }
  }

  /**
   * 请求并返回 JSON（204 / 空体 → undefined）。
   * 参数放 query（GET / DELETE）或 JSON body（POST / PATCH）。
   */
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    const weight = opts.order === true ? 1 : opts.weight ?? 1
    await this.budget.acquire(weight, {
      kind: opts.order === true ? 'trade' : opts.kind ?? 'trade',
      ...(opts.order === true ? { order: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    this.weightSpent += weight
    const query = method === 'GET' || method === 'DELETE' ? encodeQuery(opts.params ?? {}) : ''
    const url = query === '' ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}?${query}`
    const init: RequestInit = { method, headers: this.headers() }
    if (method !== 'GET' && method !== 'DELETE' && opts.body !== undefined) {
      init.body = JSON.stringify(opts.body)
      ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
    }
    return this.send<T>(method, path, url, init, opts)
  }

  /** 数据 API 的只读 GET（参考价 / 报价；同一对鉴权头，另一台主机）。 */
  async dataGet<T>(path: string, params: Record<string, string | number | boolean | undefined | null> = {}, opts: RequestOptions = {}): Promise<T> {
    await this.budget.acquire(opts.weight ?? 1, {
      kind: opts.kind ?? 'background',
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    const query = encodeQuery(params)
    const url = query === '' ? `${this.dataBaseUrl}${path}` : `${this.dataBaseUrl}${path}?${query}`
    return this.send<T>('GET', path, url, { method: 'GET', headers: this.headers() }, { ...opts, kind: 'background' })
  }

  private async send<T>(method: string, path: string, url: string, init: RequestInit, opts: RequestOptions): Promise<T> {
    const endpoint: AlpacaEndpoint = 'signed'
    const mutating = method !== 'GET'
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`alpaca ${path} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => reject(ctl.signal.reason instanceof Error ? ctl.signal.reason : new Error(String(ctl.signal.reason)))
      if (ctl.signal.aborted) fire()
      else ctl.signal.addEventListener('abort', fire, { once: true })
    })
    aborted.catch(() => {})

    this.requests += 1
    try {
      const run = (async (): Promise<T> => {
        const res = await this.fetchImpl(url, { ...init, signal: ctl.signal })
        if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error('aborted')
        this.lastStatus = res.status
        const text = await res.text()
        const redacted = this.safeText(text)

        if (res.status === 429) {
          const retryAfterMs = this.retryAfterOf(res)
          this.onWarn(`alpaca rate limited (HTTP 429); backing off ${retryAfterMs} ms`)
          this.budget.penalize(retryAfterMs)
          throw new AlpacaHttpError(429, redacted, endpoint, retryAfterMs, false)
        }

        // 207 是「批量结果」（全撤），是成功状态，必须解析 body。
        const okStatus = res.ok || res.status === 207
        let parsed: unknown
        let jsonOk = true
        try {
          parsed = text.trim() === '' ? undefined : (JSON.parse(text) as unknown)
        } catch {
          jsonOk = false
        }
        const envelope = jsonOk && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { code?: unknown; message?: unknown })
          : undefined
        const rawCode = envelope?.code
        const code = typeof rawCode === 'number' ? rawCode : rawCode === undefined || rawCode === null ? undefined : Number(rawCode)
        const message = typeof envelope?.message === 'string' ? envelope.message : ''

        if (!okStatus) {
          const lower = `${String(code ?? '')} ${message}`.toLowerCase()
          const ambiguous = mutating && (res.status === 408 || res.status >= 500 || AMBIGUOUS_TOKENS.some((t) => lower.includes(t)))
          this.lastCode = code ?? res.status
          if (code !== undefined && Number.isFinite(code)) throw new AlpacaApiError(code, this.safeText(message), endpoint, redacted, ambiguous, res.status)
          throw new AlpacaHttpError(res.status, redacted, endpoint, undefined, ambiguous)
        }

        if (!jsonOk) throw new AlpacaHttpError(res.status, 'invalid json from venue', endpoint, undefined, mutating)
        this.lastCode = code ?? res.status
        if (res.status !== 207) this.budget.reportOk()
        return parsed as T
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof AlpacaHttpError || e instanceof AlpacaApiError) throw e
      throw new AlpacaNetworkError(this.safeText(e), endpoint, e, mutating)
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Retry-After 是秒（也见过 HTTP-date）；解析不了按 60 s。 */
  private retryAfterOf(res: Response): number {
    const header = res.headers.get('retry-after')
    if (header === null) return 60_000
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - this.clockSync.now())
    return 60_000
  }
}

/** 各端点默认请求数（导出便于断言；Alpaca 是次数模型，下单类另记下单计数）。 */
export const DEFAULT_WEIGHTS = ALPACA_WEIGHTS
