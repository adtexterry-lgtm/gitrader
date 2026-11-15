// SPDX-License-Identifier: CPAL-1.0
// Bybit v5 签名 REST 出口（HMAC SHA-256 hex over `timestamp + apiKey + recvWindow + (query | body)`）。
// 口径来源：QD backend_api_python/app/services/live_trading/bybit.py:273-345
//   · 头 `X-BAPI-API-KEY / X-BAPI-SIGN / X-BAPI-TIMESTAMP / X-BAPI-RECV-WINDOW / X-BAPI-SIGN-TYPE: 2`；
//   · GET 的待签串是**按参数名排序后的** query string，POST 的待签串是 JSON body 原文
//     （所以这里先把 body 序列化一次、签名与发送用同一份字符串，绝不让引擎再序列化一遍）；
//   · 响应是 `{retCode, retMsg, result, time}` 信封：HTTP 200 + retCode !== 0 也是失败，
//     retCode 10002（时间戳越界）重校 /v5/market/time 后只重试一次（照 QD bybit.py:336-338）；
//   · 429 / 418 / 403 + access too frequent 让预算整体退避，并带回重试等待（毫秒）；
//   · `X-Bapi-Limit-Status` 是**剩余次数**：只回填 rateLimitStatus；剩 0 时按 reset 头退避；
//   · 密钥只从构造参数进：任何对外文本（warn / 错误）先过 redactSecret，签名本身从不进日志。
import { createHmac } from 'node:crypto'
import type { RateBudget } from '@gitrader/protocol/connector'
import { BYBIT_WEIGHTS, createWeightBudget } from './budget'
import type { BybitBudget } from './budget'
import { BybitHttpError, BybitNetworkError, redactSecret } from './errors'
import type { BybitEndpoint } from './errors'
import { serverTimeMsOf, TimestampSource } from './nonce'

export type Environment = 'mainnet' | 'testnet'

/** 基址可配（测试用 http://bybit.example.test）。测试网照官方 testnet 域名。 */
export const BYBIT_ENDPOINTS: Record<Environment, string> = {
  mainnet: 'https://api.bybit.com',
  testnet: 'https://api-testnet.bybit.com',
}

/** 签名向量：HMAC-SHA256(apiSecret, prehash) 的小写 hex。独立可测，不依赖网络。 */
export function signatureOf(apiSecret: string, prehash: string): string {
  return createHmac('sha256', apiSecret).update(prehash).digest('hex')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/bybit.py:296-319; adapted.
/** 待签串：timestamp + apiKey + recvWindow + payload（GET 用排序后的 query，POST 用 body 原文）。 */
export function prehashOf(timestamp: string, apiKey: string, recvWindow: number, payload: string): string {
  return `${timestamp}${apiKey}${recvWindow}${payload}`
}

/** 参数按**参数名排序**编码成 query string（undefined / null 跳过；值一律 String）。 */
export function encodeQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams()
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value === undefined || value === null) continue
    qs.append(key, String(value))
  }
  return qs.toString()
}

/**
 * v5 端点表（教训 1 / 2 的唯一事实源）：路径与 HTTP 方法都以 QD 的当前实现 / Bybit v5 官方为准。
 * 撤单、全撤、改单都是 **POST**（不是 DELETE）；GET 只用于查询。
 */
export const ENDPOINTS = {
  orderCreate: { method: 'POST', path: '/v5/order/create' },
  orderAmend: { method: 'POST', path: '/v5/order/amend' },
  orderCancel: { method: 'POST', path: '/v5/order/cancel' },
  orderCancelAll: { method: 'POST', path: '/v5/order/cancel-all' },
  orderRealtime: { method: 'GET', path: '/v5/order/realtime' },
  orderHistory: { method: 'GET', path: '/v5/order/history' },
  positionList: { method: 'GET', path: '/v5/position/list' },
  walletBalance: { method: 'GET', path: '/v5/account/wallet-balance' },
  executionList: { method: 'GET', path: '/v5/execution/list' },
  setLeverage: { method: 'POST', path: '/v5/position/set-leverage' },
  setMarginMode: { method: 'POST', path: '/v5/account/set-margin-mode' },
  tradingStop: { method: 'POST', path: '/v5/position/trading-stop' },
  serverTime: { method: 'GET', path: '/v5/market/time' },
} as const

/** 结果未知的 retCode：非 GET 请求碰到它们时按 3006 处理（不盲目重发）。
 * 110072 = 同号的单已在场上（多半是上次 3006 的那次落地了），按 clientOrderId 对账。
 */
export const AMBIGUOUS_RET_CODES = [10000, 10016, 10019, 110072] as const
const AMBIGUOUS_IN_BODY = new RegExp(`"retCode"\\s*:\\s*(${AMBIGUOUS_RET_CODES.join('|')})(?!\\d)`)

/** 10002：时间戳越界（重校时钟后可重试一次）。 */
const isClockSkew = (e: unknown): boolean => e instanceof BybitHttpError && e.retCode === 10002

export interface BybitHttpOptions {
  environment?: Environment
  /** 显式基址优先（测试 / 镜像）；缺省按 environment 选官方基址。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  fetchImpl?: typeof fetch
  clock?: () => number
  timeoutMs?: number
  recvWindowMs?: number
  /** 内核注入的权重预算；缺省本对象内部那份（≤ 60% × 600 / 5 s）。 */
  budget?: RateBudget
  onWarn?: (message: string) => void
}

export interface RequestOptions {
  /** 权重用途：trade 走满额，query / background 受限（见 budget.ts）。 */
  kind?: 'trade' | 'query' | 'background'
  weight?: number
  signal?: AbortSignal
  /** 下单 / 撤单 / 改单类请求：权重 0 但记一笔下单计数。 */
  order?: boolean
}

/** 签名请求的载荷：GET / DELETE 用 params，POST 用 body（二者互斥）。 */
export interface SignedPayload {
  params?: Record<string, string | number | boolean | undefined | null>
  body?: Record<string, unknown>
}

/** Bybit v5 统一信封。 */
export interface BybitEnvelope<T> {
  retCode?: number
  retMsg?: string
  result?: T
  time?: number
}

export class BybitHttp {
  readonly environment: Environment
  readonly baseUrl: string
  readonly ts: TimestampSource
  // 密钥放 # 私有字段：JSON.stringify / util.inspect 都看不到明文。
  readonly #apiKey: string
  readonly #apiSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly budget: RateBudget
  private readonly onWarn: (message: string) => void
  /** 诊断：累计请求数、累计记账权重、最近一次 X-Bapi-Limit-Status。 */
  requests = 0
  weightSpent = 0
  rateLimitStatus = 0
  /** 测试与诊断用：最近一次签名（hex），不含密钥本身。 */
  lastSignature: string | null = null
  /** 私有：最近一次待签串，不对外暴露。 */
  #lastPrehash: string | null = null

  constructor(o: BybitHttpOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey === '') throw new RangeError('apiKey is required')
    if (typeof o.apiSecret !== 'string' || o.apiSecret === '') throw new RangeError('apiSecret is required')
    this.environment = o.environment ?? 'mainnet'
    this.baseUrl = (o.baseUrl ?? BYBIT_ENDPOINTS[this.environment]).replace(/\/+$/, '')
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = o.timeoutMs ?? 10_000
    this.ts = new TimestampSource(o.clock ?? (() => Date.now()), o.recvWindowMs ?? 5_000)
    this.budget = o.budget ?? defaultBudget(o.clock)
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
    // 私有待签串只在本对象内保存，不提供 getter；显式读一次避免被当成未使用的私有字段。
    void this.#lastPrehash
  }

  /** 诊断：预算占用（透传注入的预算对象）。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.budget.usage()
  }

  /** 用场所时间重校偏移（GET /v5/market/time 或收到 10002 之后调用）。 */
  resync(serverTimeMs: number): void {
    this.ts.resync(serverTimeMs)
  }

  /** 读场所时间并重校（只读、不签名）。失败只 warn，不抛。 */
  async calibrate(): Promise<void> {
    try {
      const body = await this.publicGet<unknown>('/v5/market/time', {}, BYBIT_WEIGHTS.walletBalance)
      const serverTime = serverTimeMsOf({ result: body })
      if (serverTime !== undefined) this.resync(serverTime)
    } catch (e) {
      this.warn(`bybit time calibration failed: ${this.safeText(e)}`)
    }
  }

  /**
   * 签名请求。GET / DELETE 把参数放 query（排序后参与签名），POST 把 body 原文参与签名。
   * retCode 10002（时间戳越界）：重校时钟后只重试一次；仍失败才抛。
   */
  async signed<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    payload: SignedPayload = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const weight = opts.order === true ? 0 : opts.weight ?? 1
    for (let attempt = 0; ; attempt++) {
      // 权重 0 的请求也要 acquire(0)：429 退避期间不得绕过限流。
      await this.spend(weight, opts)
      if (opts.order === true) {
        const b = this.budget as Partial<BybitBudget>
        b.noteOrder?.(1)
      }
      const query = encodeQuery(payload.params ?? {})
      const bodyText = payload.body !== undefined ? JSON.stringify(payload.body) : ''
      const timestamp = String(this.ts.next())
      const recvWindow = this.ts.recvWindowMs
      const prehash = prehashOf(timestamp, this.#apiKey, recvWindow, method === 'GET' || method === 'DELETE' ? query : bodyText)
      const signature = signatureOf(this.#apiSecret, prehash)
      this.lastSignature = signature
      this.#lastPrehash = prehash
      const relative = method === 'GET' || method === 'DELETE' ? (query === '' ? path : `${path}?${query}`) : path
      try {
        return await this.send<T>('signed', method, path, relative, bodyText === '' ? undefined : bodyText, {
          ...opts,
          timestamp,
          recvWindow,
          signature,
        })
      } catch (e) {
        if (attempt === 0 && isClockSkew(e)) {
          await this.calibrate()
          continue
        }
        throw e
      }
    }
  }

  /** 公共只读请求（不带密钥、不签名）。 */
  async publicGet<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined | null> = {},
    weight = 1,
    opts: RequestOptions = {},
  ): Promise<T> {
    await this.spend(weight, opts)
    const query = encodeQuery(params)
    return this.send<T>('public', 'GET', path, query === '' ? path : `${path}?${query}`, undefined, opts)
  }

  /** 密钥脱敏：错误消息 / 告警只走这里。 */
  safeText(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e)
    return redactSecret(text, [this.#apiSecret, this.#apiKey])
  }

  private warn(message: string): void {
    this.onWarn(redactSecret(message, [this.#apiSecret, this.#apiKey]))
  }

  private async spend(weight: number, opts: RequestOptions): Promise<void> {
    await this.budget.acquire(weight, {
      ...(opts.kind === 'trade' ? { priority: 'high' as const } : { priority: 'low' as const }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    this.weightSpent += weight
  }

  private async send<T>(
    endpoint: BybitEndpoint,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    relative: string,
    bodyText: string | undefined,
    opts: RequestOptions & { timestamp?: string; recvWindow?: number; signature?: string },
  ): Promise<T> {
    const url = `${this.baseUrl}${relative}`
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`bybit ${path} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
    // 注入的 fetch 不理会 signal 时，abort 也要立刻结束本次调用
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => reject(ctl.signal.reason instanceof Error ? ctl.signal.reason : new Error(String(ctl.signal.reason)))
      if (ctl.signal.aborted) fire()
      else ctl.signal.addEventListener('abort', fire, { once: true })
    })
    aborted.catch(() => {})

    this.requests += 1
    try {
      const run = (async (): Promise<T> => {
        const headers: Record<string, string> = { accept: 'application/json' }
        if (endpoint === 'signed') {
          headers['X-BAPI-API-KEY'] = this.#apiKey
          headers['X-BAPI-SIGN'] = opts.signature ?? ''
          headers['X-BAPI-TIMESTAMP'] = opts.timestamp ?? ''
          headers['X-BAPI-RECV-WINDOW'] = String(opts.recvWindow ?? this.ts.recvWindowMs)
          headers['X-BAPI-SIGN-TYPE'] = '2'
          headers['content-type'] = 'application/json'
        }
        const res = await this.fetchImpl(url, {
          method,
          headers,
          ...(bodyText !== undefined ? { body: bodyText } : {}),
          signal: ctl.signal,
        })
        if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error('aborted')
        this.readRateLimit(res)
        const text = await res.text()
        const redacted = redactSecret(text, [this.#apiSecret, this.#apiKey])
        // 结果未知的判定：改变状态的请求遇到 408 / 5xx / retCode 10000·10016·10019·110072。
        // GET 的同类错误仍可重试（3003），非 GET 一律 3006（先对账，不盲目重发）。
        const mutating = method !== 'GET'
        const ambiguous = res.status === 408 || res.status >= 500 || AMBIGUOUS_IN_BODY.test(text)
        const retCode = retCodeOf(text)
        // Bybit 的「访问太频繁」可能是 HTTP 403（不是鉴权失败）：与 429 同路。
        if (res.status === 403 && /access too frequent/i.test(text)) {
          this.budget.penalize(600_000)
          throw new BybitHttpError(403, redacted, endpoint, 600_000, undefined, false)
        }
        if (res.status === 429 || res.status === 418) {
          const retryAfterMs = this.retryAfterOf(res)
          this.budget.penalize(retryAfterMs)
          throw new BybitHttpError(res.status, redacted, endpoint, retryAfterMs, undefined, false)
        }
        // 信封里的限流码：按 X-Bapi-Limit-Reset-Timestamp 退避（拿不到就不带时长）。
        if (retCode === 10006 || retCode === 10018) {
          const ms = this.resetAfterOf(res)
          this.budget.penalize(ms)
          throw new BybitHttpError(res.status, redacted, endpoint, ms, retCode, false)
        }
        if (!res.ok) {
          throw new BybitHttpError(res.status, redacted, endpoint, undefined, retCode, mutating && ambiguous)
        }
        if (retCode !== undefined && retCode !== 0) {
          // HTTP 200 + retCode !== 0：Bybit 的常规失败形状。10002 交给上层重试一次。
          throw new BybitHttpError(res.status, redacted, endpoint, undefined, retCode, mutating && ambiguous)
        }
        this.budget.reportOk()
        if (text === '') return undefined as unknown as T
        let parsed: BybitEnvelope<T>
        try {
          parsed = JSON.parse(text) as BybitEnvelope<T>
        } catch {
          throw new BybitHttpError(res.status, 'invalid json from venue', endpoint, undefined, undefined, mutating)
        }
        return (parsed.result ?? (parsed as unknown as T)) as T
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof BybitHttpError) throw e
      throw new BybitNetworkError(this.safeText(e), endpoint, e, method !== 'GET')
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** X-Bapi-Limit-Status = 本窗口的**剩余次数**；剩 0 时只有 reset 头指向将来才退避（未超限时它就是当前时间）。 */
  private readRateLimit(res: Response): void {
    const header = res.headers.get('x-bapi-limit-status')
    if (header === null) return
    const remaining = Number(header)
    if (!Number.isFinite(remaining) || remaining < 0) return
    this.rateLimitStatus = remaining
    if (remaining === 0) {
      const ms = this.resetAfterOf(res)
      if (ms !== undefined) this.budget.penalize(ms)
    }
  }

  /** X-Bapi-Limit-Reset-Timestamp 是毫秒时间戳；比当前时间晚才返回差值。 */
  private resetAfterOf(res: Response): number | undefined {
    const header = res.headers.get('x-bapi-limit-reset-timestamp')
    if (header === null) return undefined
    const resetAt = Number(header)
    if (!Number.isFinite(resetAt)) return undefined
    const delta = resetAt - this.ts.now()
    return delta > 0 ? delta : undefined
  }

  /** Retry-After 是秒（Bybit 偶尔给 HTTP-date）；解析不了按 60 s。 */
  private retryAfterOf(res: Response): number {
    const header = res.headers.get('retry-after')
    if (header === null) return 60_000
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - this.ts.now())
    return 60_000
  }
}

/** 从响应原文里取 retCode（拿不到返回 undefined）。 */
export function retCodeOf(text: string): number | undefined {
  const m = /"retCode"\s*:\s*(-?\d+)/.exec(text)
  if (!m?.[1]) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/** 从响应原文里取 retMsg（拿不到返回空串）。 */
export function retMsgOf(text: string): string {
  const m = /"retMsg"\s*:\s*"([^"]*)"/.exec(text)
  return m?.[1] ?? ''
}

/** 缺省预算：本连接器自己一份（≤ 60% × 600 / 5 s）。同机多连接时必须由内核注入共用一份。 */
function defaultBudget(clock?: () => number): RateBudget {
  return createWeightBudget({ ...(clock ? { clock } : {}) })
}
