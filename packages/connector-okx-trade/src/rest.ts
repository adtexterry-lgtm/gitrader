// SPDX-License-Identifier: CPAL-1.0
// OKX v5 签名 REST 出口（HMAC SHA-256 over `timestamp + method + path + body`，base64）。
// 口径来源：QD backend_api_python/app/services/live_trading/okx.py:269-388
//   · 头：`OK-ACCESS-KEY` / `OK-ACCESS-SIGN` / `OK-ACCESS-TIMESTAMP` / `OK-ACCESS-PASSPHRASE`（+ Content-Type）；
//   · 预签名串 = `isoTs + METHOD + requestPath + body`，requestPath **包含按 key 排序的 query string**；
//   · body 用 `data=<序列化后的 JSON>` 发送，签名对的就是实际发出的那串字节（QD okx.py:302-306 同一理由）；
//   · 时间戳来自注入时钟（IsoTimestampSource），不是本机 Date.now() 直取；演示盘加 `x-simulated-trading: 1`；
//   · 429 → 3002，只对限流码退避；GET 503 → 3003；非 GET 503 / 50004 / 无响应 → 3006（结果未知）；
//   · 密钥只从构造参数进：头值必须是 ASCII（QD okx.py:34-50 的坑），任何对外文本先过 redactSecret，
//     签名本身只留在 lastSignature 供测试对拍，从不进日志。
import { createHmac } from 'node:crypto'
import type { RateBudget } from '@gitrader/protocol/connector'
import { createCountBudget } from './budget'
import type { OkxBudget } from './budget'
import { OkxHttpError, OkxNetworkError, redactSecret } from './errors'
import { ProblemError } from './errors'
import { makeProblem } from '@gitrader/protocol'
import type { OkxEndpoint } from './errors'
import { isRateLimitCode, isUnknownOutcomeCode } from './venue-errors'
import { IsoTimestampSource } from './nonce'

export type Environment = 'mainnet' | 'testnet'

export function validateEnvironment(value: unknown): Environment {
  if (value === undefined || value === 'mainnet') return 'mainnet'
  if (value === 'testnet') return 'testnet'
  throw new ProblemError(makeProblem('INVALID_PARAMS', 'environment must be mainnet or testnet'))
}

/**
 * OKX 的演示盘与生产用同一主机，靠 `x-simulated-trading: 1` 区分（与 Binance 的独立域名不同）。
 * 所以两个环境共用基址，environment 只决定头；测试里可注入 `http://okx.example.test`。
 */
export const OKX_ENDPOINTS: Record<Environment, string> = {
  mainnet: 'https://www.okx.com',
  testnet: 'https://www.okx.com',
}

/** 统一的成功信封。 */
export interface OkxEnvelope<T> {
  code?: string
  msg?: string
  data?: T[]
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:276-279; adapted.
/** 签名向量：base64(HMAC-SHA256(secret, `${ts}${METHOD}${path}${body}`))。独立可测，不依赖网络。 */
export function signOkx(secret: string, ts: string, method: string, path: string, body = ''): string {
  const prehash = `${ts}${method.toUpperCase()}${path}${body}`
  return createHmac('sha256', secret).update(prehash, 'utf8').digest('base64')
}

/** 私有 WS 的 login 帧签名：base64(HMAC-SHA256(secret, `${ts}GET/users/self/verify`))。 */
export function signWsLogin(secret: string, ts: string): string {
  return createHmac('sha256', secret).update(`${ts}GET/users/self/verify`, 'utf8').digest('base64')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:310-320; adapted.
/**
 * query string：过滤 undefined 与空串、全部转字符串、**按 key 排序**（OKX 要求稳定顺序）。
 * 排序让「同样参数 → 同样签名」，测试可以对拍固定向量。
 */
export function encodeQuery(params: Record<string, string | number | undefined>): string {
  const norm: Array<[string, string]> = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const text = String(value)
    if (text.trim() === '') continue
    norm.push([key, text])
  }
  norm.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return norm.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
}

/** 签名用的 requestPath：有 query 时 `path?query`。 */
export function signedPathOf(path: string, params: Record<string, string | number | undefined> = {}): string {
  const query = encodeQuery(params)
  return query === '' ? path : `${path}?${query}`
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:34-50; adapted.
/**
 * 凭据必须是 ASCII：HTTP 头按 latin-1 编码，粘进来的中文 / 全角字符 / 智能引号会在发请求前就炸。
 * 这里提前给出可读错误，不把密钥本身带进消息。
 */
export function assertHeaderSafe(value: string, field: string): string {
  const text = value.trim()
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code > 0x7e) {
      throw new RangeError(`okx ${field} contains non-ASCII or control characters; API credentials must be ASCII`)
    }
  }
  return text
}

export interface OkxHttpOptions {
  environment?: Environment
  /** 显式基址优先（测试 / 镜像）；缺省按 environment 选官方基址。 */
  baseUrl?: string
  /** 只从构造参数进；不落盘、不打印、不进 JSON-RPC。 */
  apiKey: string
  apiSecret: string
  passphrase: string
  fetchImpl?: typeof fetch
  clock?: () => number
  timeoutMs?: number
  /** 内核注入的预算；缺省本对象内部那份（≤ 60% × 60 次 / 2 s）。 */
  budget?: RateBudget
  onWarn?: (message: string) => void
}

export interface RequestOptions {
  /** 用途：trade 走满额，query / background 受限（见 budget.ts）。 */
  kind?: 'trade' | 'query' | 'background'
  /** 额度（OKX 一次调用 = 1）。 */
  cost?: number
  signal?: AbortSignal
  /** 下单 / 撤单类请求：记一笔下单计数（额度照收）。 */
  order?: boolean
}

export class OkxHttp {
  readonly environment: Environment
  readonly baseUrl: string
  readonly ts: IsoTimestampSource
  #apiKey: string
  #apiSecret: string
  #passphrase: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly budget: RateBudget
  private readonly onWarn: (message: string) => void
  /** 诊断：累计请求数、最近一次签名（base64，不含密钥本身）、最近一次发送的 body。 */
  requests = 0
  costSpent = 0
  lastSignature: string | null = null
  lastBody: string | null = null

  constructor(o: OkxHttpOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey.trim() === '') throw new RangeError('apiKey is required')
    if (typeof o.apiSecret !== 'string' || o.apiSecret.trim() === '') throw new RangeError('apiSecret is required')
    if (typeof o.passphrase !== 'string' || o.passphrase.trim() === '') throw new RangeError('passphrase is required')
    this.environment = validateEnvironment(o.environment)
    this.baseUrl = (o.baseUrl ?? OKX_ENDPOINTS[this.environment]).replace(/\/+$/, '')
    this.#apiKey = assertHeaderSafe(o.apiKey, 'apiKey')
    // secret 只用于 HMAC（utf-8），仍 strip 掉不可见空白
    this.#apiSecret = o.apiSecret.trim()
    this.#passphrase = assertHeaderSafe(o.passphrase, 'passphrase')
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = o.timeoutMs ?? 10_000
    this.ts = new IsoTimestampSource(o.clock ?? (() => Date.now()))
    this.budget = o.budget ?? defaultBudget(o.clock)
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
  }

  /** 诊断：预算占用（透传注入的预算对象）。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.budget.usage()
  }

  /** 用场所时间重校偏移（/api/v5/public/time 或收到 50112 之后调用）。 */
  resync(serverTimeMs: number): void {
    this.ts.resync(serverTimeMs)
  }

  /** 读场所时间并重校（只读，无签名）。失败只 warn，不抛。 */
  async calibrate(): Promise<void> {
    try {
      const rows = await this.publicGet<{ ts?: string }>('/api/v5/public/time', {})
      const serverTime = rows[0]?.ts
      if (serverTime !== undefined) {
        const n = Number(serverTime)
        if (Number.isFinite(n) && n > 0) this.resync(n)
      }
    } catch (e) {
      this.warn(`okx time calibration failed: ${this.safeText(e)}`)
    }
  }

  /** 签名请求：body（GET 也有 params）与路径一起进预签名串；返回解开的信封。 */
  async signed<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      params?: Record<string, string | number | undefined>
      body?: unknown
      /** 已经是字符串的 body（批量撤单要发 JSON 数组）；给了就原样发送并签名。 */
      rawBody?: string
      request?: RequestOptions
    } = {},
  ): Promise<OkxEnvelope<T>> {
    const request = opts.request ?? {}
    const cost = request.cost ?? 1
    await this.spend(cost, request)
    if (request.order === true) {
      const b = this.budget as Partial<OkxBudget>
      b.noteOrder?.(1)
    }
    const signedPath = signedPathOf(path, opts.params ?? {})
    const body = opts.rawBody ?? (opts.body === undefined ? '' : JSON.stringify(opts.body))
    this.lastBody = body
    const stamp = this.ts.next()
    const signature = signOkx(this.#apiSecret, stamp, method, signedPath, body)
    this.lastSignature = signature
    const headers = this.headersOf(stamp, signature, body !== '')
    return this.send<T>('signed', method, signedPath, headers, body === '' ? undefined : body, request)
  }

  /** 公共只读请求（不带密钥、不签名）。 */
  async publicGet<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    request: RequestOptions = {},
  ): Promise<T[]> {
    await this.spend(request.cost ?? 1, request)
    const signedPath = signedPathOf(path, params)
    const envelope = await this.send<T>('public', 'GET', signedPath, { accept: 'application/json' }, undefined, request)
    return Array.isArray(envelope.data) ? envelope.data : []
  }

  /** 密钥脱敏：错误消息 / 告警只走这里。 */
  safeText(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e)
    return redactSecret(text, [this.#apiSecret, this.#apiKey, this.#passphrase])
  }

  private warn(message: string): void {
    this.onWarn(redactSecret(message, [this.#apiSecret, this.#apiKey, this.#passphrase]))
  }

  // Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/okx.py:281-291; adapted.
  private headersOf(stamp: string, signature: string, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'OK-ACCESS-KEY': this.#apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': stamp,
      'OK-ACCESS-PASSPHRASE': this.#passphrase,
      accept: 'application/json',
    }
    if (hasBody) headers['content-type'] = 'application/json'
    if (this.environment === 'testnet') headers['x-simulated-trading'] = '1'
    return headers
  }

  private async spend(cost: number, request: RequestOptions): Promise<void> {
    // 权重 0 也走 acquire：退避期间不能绕过预算（教训 11）
    await this.budget.acquire(cost, {
      ...(request.kind === 'trade' ? { priority: 'high' as const } : { priority: 'low' as const }),
      ...(request.signal ? { signal: request.signal } : {}),
    })
    this.costSpent += cost
  }

  private async send<T>(
    endpoint: OkxEndpoint,
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
    request: RequestOptions,
  ): Promise<OkxEnvelope<T>> {
    const url = `${this.baseUrl}${path}`
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`okx ${path} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => reject(ctl.signal.reason instanceof Error ? ctl.signal.reason : new Error(String(ctl.signal.reason)))
      if (ctl.signal.aborted) fire()
      else ctl.signal.addEventListener('abort', fire, { once: true })
    })
    aborted.catch(() => {})

    this.requests += 1
    try {
      const run = (async (): Promise<OkxEnvelope<T>> => {
        const init: RequestInit = { method, headers, signal: ctl.signal }
        if (body !== undefined) init.body = body
        const res = await this.fetchImpl(url, init)
        if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error('aborted')
        const text = await res.text()
        if (res.status === 429 || res.status === 503) {
          const retryAfterMs = this.retryAfterOf(res)
          this.budget.penalize(retryAfterMs)
          const outcomeUnknown = res.status !== 429 && method !== 'GET'
          throw new OkxHttpError(res.status, redactSecret(text, [this.#apiSecret, this.#apiKey, this.#passphrase]), endpoint, undefined, undefined, undefined, retryAfterMs, outcomeUnknown)
        }
        if (!res.ok) {
          const { code, sCode, sMsg } = this.envelopeOf(text)
          throw new OkxHttpError(
            res.status, redactSecret(text, [this.#apiSecret, this.#apiKey, this.#passphrase]), endpoint,
            code, sCode, sMsg, undefined, method !== 'GET' && res.status >= 500,
          )
        }
        let parsed: unknown
        try {
          parsed = text === '' ? {} : JSON.parse(text)
        } catch {
          throw new OkxHttpError(res.status, 'invalid json from venue', endpoint, undefined, undefined, undefined, undefined, method !== 'GET')
        }
        const envelope = (parsed ?? {}) as OkxEnvelope<T>
        const code = envelope.code
        if (code !== undefined && String(code) !== '0') {
          const rows = Array.isArray(envelope.data) ? envelope.data : []
          const perRow = rows.length > 0 && rows.every((row) => row !== null && typeof row === 'object' && 'sCode' in row)
          // 逐单结果（每一行都有 sCode）：原样返回，调用方必须逐行判
          if (perRow) {
            this.budget.reportOk()
            return envelope
          }
          const first = rows.length > 0 ? (rows[0] as { sCode?: string; sMsg?: string }) : undefined
          const sCode = first?.sCode
          const sMsg = first?.sMsg
          if (isRateLimitCode(code)) this.budget.penalize(undefined)
          throw new OkxHttpError(
            res.status, redactSecret(text, [this.#apiSecret, this.#apiKey, this.#passphrase]), endpoint,
            String(code), sCode, typeof envelope.msg === 'string' && envelope.msg !== '' ? envelope.msg : sMsg,
            undefined, method !== 'GET' && isUnknownOutcomeCode(code),
          )
        }
        this.budget.reportOk()
        return envelope
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof OkxHttpError) throw e
      throw new OkxNetworkError(this.safeText(e), endpoint, e, method !== 'GET')
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 从 body 文本里取信封码 / 逐单码 / 逐单文案（解析不了就全空）。 */
  private envelopeOf(text: string): { code?: string; sCode?: string; sMsg?: string } {
    try {
      const parsed = JSON.parse(text) as { code?: unknown; data?: unknown }
      const code = parsed.code === undefined ? undefined : String(parsed.code)
      const first = Array.isArray(parsed.data) && parsed.data.length > 0 ? (parsed.data[0] as { sCode?: unknown; sMsg?: unknown }) : undefined
      return {
        ...(code !== undefined ? { code } : {}),
        ...(first?.sCode !== undefined ? { sCode: String(first.sCode) } : {}),
        ...(typeof first?.sMsg === 'string' ? { sMsg: first.sMsg } : {}),
      }
    } catch {
      return {}
    }
  }

  /** Retry-After 是秒（偶尔给 HTTP-date）；解析不了按 2 s（OKX 的窗口是 2 s）。 */
  private retryAfterOf(res: Response): number {
    const header = res.headers.get('retry-after')
    if (header === null) return 2_000
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - this.ts.now())
    return 2_000
  }
}

/** 缺省预算：本连接器自己一份（≤ 60% × 60 次 / 2 s）。同机多连接时必须由内核注入共用一份。 */
function defaultBudget(clock?: () => number): RateBudget {
  return createCountBudget({ ...(clock ? { clock } : {}) })
}
