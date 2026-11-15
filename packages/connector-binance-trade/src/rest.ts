// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 签名 REST 出口（HMAC SHA-256 over query string）。
// 口径来源：QD backend_api_python/app/services/live_trading/binance.py:165-236
//   · 头 `X-MBX-APIKEY: <apiKey>`；
//   · query string = 业务参数 + `timestamp` + `recvWindow`，再 `signature = HMAC_SHA256(apiSecret, query)`；
//   · 时间戳来自注入时钟（TimestampSource），不是本机 Date.now() 直取；
//   · 429 / 418 让预算整体退避，并带回 Retry-After（毫秒）；
//   · `X-MBX-USED-WEIGHT-1M` 回填预算（reconcile）与本对象的 usedWeight；
//   · 密钥只从构造参数进：任何对外文本（warn / 错误）先过 redactSecret，签名本身从不进日志。
import { createHmac } from 'node:crypto'
import type { RateBudget } from '@gitrader/protocol/connector'
import { BINANCE_WEIGHTS, createWeightBudget } from './budget'
import type { BinanceBudget } from './budget'
import { BinanceHttpError, BinanceNetworkError, redactSecret } from './errors'
import type { BinanceEndpoint } from './errors'
import { TimestampSource } from './nonce'

export type Environment = 'mainnet' | 'testnet'

/** 基址可配（测试用 http://binance.example.test）。测试网缺省值照 QD binance.py:40 用 demo-fapi。 */
export const BINANCE_ENDPOINTS: Record<Environment, string> = {
  mainnet: 'https://fapi.binance.com',
  testnet: 'https://demo-fapi.binance.com',
}

/** 签名向量：HMAC-SHA256(secret, query) 的小写 hex。独立可测，不依赖网络。 */
export function signatureOf(apiSecret: string, query: string): string {
  return createHmac('sha256', apiSecret).update(query).digest('hex')
}

/** 参数按插入顺序编码成 query string（undefined 跳过；值一律 String）。 */
export function encodeQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    qs.append(key, String(value))
  }
  return qs.toString()
}

/** 结果未知的错误码：非 GET 请求碰到它们时按 3006 处理（不盲目重发）。 */
const AMBIGUOUS_CODES = /"code"\s*:\s*-100[067](?!\d)/

/** -1021：时间戳越界（重校时钟后可重试一次）。 */
const isClockSkew = (e: unknown): boolean => e instanceof BinanceHttpError && /-1021(?!\d)/.test(e.body)

export interface BinanceHttpOptions {
  environment?: Environment
  /** 显式基址优先（测试 / 镜像）；缺省按 environment 选官方基址。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  fetchImpl?: typeof fetch
  clock?: () => number
  timeoutMs?: number
  recvWindowMs?: number
  /** 内核注入的权重预算；缺省本对象内部那份（≤ 60% × 2400 / 分钟）。 */
  budget?: RateBudget
  onWarn?: (message: string) => void
}

export interface RequestOptions {
  /** 权重用途：trade 走满额，query / background 受限（见 budget.ts）。 */
  kind?: 'trade' | 'query' | 'background'
  weight?: number
  signal?: AbortSignal
  /** 下单类请求：权重 0 但记一笔下单计数。 */
  order?: boolean
}

export class BinanceHttp {
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
  /** 诊断：累计请求数、最近一次请求权重、最近一次 X-MBX-USED-WEIGHT-1M。 */
  requests = 0
  weightSpent = 0
  usedWeight = 0
  /** 诊断：X-MBX-USED-WEIGHT-10s（下单计数桶的官方口径）。 */
  usedWeight10s = 0
  /** 测试与诊断用：最近一次签名（hex），不含密钥本身。 */
  lastSignature: string | null = null

  constructor(o: BinanceHttpOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey === '') throw new RangeError('apiKey is required')
    if (typeof o.apiSecret !== 'string' || o.apiSecret === '') throw new RangeError('apiSecret is required')
    this.environment = o.environment ?? 'mainnet'
    this.baseUrl = (o.baseUrl ?? BINANCE_ENDPOINTS[this.environment]).replace(/\/+$/, '')
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = o.timeoutMs ?? 10_000
    this.ts = new TimestampSource(o.clock ?? (() => Date.now()), o.recvWindowMs ?? 5_000)
    this.budget = o.budget ?? defaultBudget(o.clock)
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
  }

  /** 诊断：预算占用（透传注入的预算对象）。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.budget.usage()
  }

  /** 用场所时间重校偏移（/fapi/v1/time 或收到 -1021 之后调用）。 */
  resync(serverTimeMs: number): void {
    this.ts.resync(serverTimeMs)
  }

  /** 读场所时间并重校（只读，无签名）。失败只 warn，不抛。 */
  async calibrate(): Promise<void> {
    try {
      const body = await this.publicGet<{ serverTime?: number }>('/fapi/v1/time', {}, BINANCE_WEIGHTS.time)
      const serverTime = body?.serverTime
      if (typeof serverTime === 'number' && serverTime > 0) this.resync(serverTime)
    } catch (e) {
      this.warn(`binance time calibration failed: ${this.safeText(e)}`)
    }
  }

  /** 签名请求（GET / POST / PUT / DELETE 都把参数放在 query string 上）。
   *  -1021（时间戳越界）：重校时钟偏移后只重试一次（照 QD binance.py:207-236）；仍失败才抛。
   */
  async signed<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | undefined> = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const weight = opts.order === true ? 0 : opts.weight ?? 1
    for (let attempt = 0; ; attempt++) {
      await this.spend(weight, opts)
      if (opts.order === true) {
        const b = this.budget as Partial<BinanceBudget>
        b.noteOrder?.(1)
      }
      // 顺序照 Binance 文档示例：业务参数 → recvWindow → timestamp
      const query = encodeQuery({ ...params, recvWindow: this.ts.recvWindowMs, timestamp: this.ts.next() })
      const signature = signatureOf(this.#apiSecret, query)
      this.lastSignature = signature
      try {
        return await this.send<T>('signed', method, path, `${path}?${query}&signature=${signature}`, opts)
      } catch (e) {
        if (attempt === 0 && isClockSkew(e)) {
          await this.calibrate()
          continue
        }
        throw e
      }
    }
  }

  /** 只要 API key 头、不签名的请求（listenKey 的创建 / 续期 / 关闭，照 QD adapters.py:330-357）。 */
  async apiKeyRequest<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    await this.spend(opts.weight ?? 1, opts)
    return this.send<T>('signed', method, path, path, opts)
  }

  /** 公共只读请求（不带密钥、不签名）。 */
  async publicGet<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    weight = 1,
    opts: RequestOptions = {},
  ): Promise<T> {
    await this.spend(weight, opts)
    const query = encodeQuery(params)
    return this.send<T>('public', 'GET', path, query === '' ? path : `${path}?${query}`, opts)
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
    // 权重 0 的请求也要 acquire(0)：429 退避期间不得绕过限流（acquire 会先等 backoff）。
    await this.budget.acquire(weight, {
      ...(opts.kind === 'trade' ? { priority: 'high' as const } : { priority: 'low' as const }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    this.weightSpent += weight
  }

  private async send<T>(
    endpoint: BinanceEndpoint,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    relative: string,
    opts: RequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}${relative}`
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`binance ${path} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
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
        if (endpoint === 'signed') headers['X-MBX-APIKEY'] = this.#apiKey
        const res = await this.fetchImpl(url, { method, headers, signal: ctl.signal })
        if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error('aborted')
        this.readWeight(res)
        const text = await res.text()
        // 结果未知的判定：改变状态的请求遇到 408 / 5xx / -1000 / -1006 / -1007。
        // GET 的同类错误仍可重试（3003），非 GET 一律 3006（先对账，不盲目重发）。
        const mutating = method !== 'GET'
        const ambiguous = res.status === 408 || res.status >= 500 || AMBIGUOUS_CODES.test(text)
        const redacted = redactSecret(text, [this.#apiSecret, this.#apiKey])
        if (res.status === 429 || res.status === 418) {
          const retryAfterMs = this.retryAfterOf(res)
          this.budget.penalize(retryAfterMs)
          throw new BinanceHttpError(res.status, redacted, endpoint, retryAfterMs, false)
        }
        if (!res.ok) {
          throw new BinanceHttpError(res.status, redacted, endpoint, undefined, mutating && ambiguous)
        }
        this.budget.reportOk()
        if (text === '') return undefined as unknown as T
        try {
          return JSON.parse(text) as T
        } catch {
          throw new BinanceHttpError(res.status, 'invalid json from venue', endpoint, undefined, mutating)
        }
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof BinanceHttpError) throw e
      throw new BinanceNetworkError(this.safeText(e), endpoint, e, method !== 'GET')
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  private readWeight(res: Response): void {
    const tenSec = res.headers.get('x-mbx-used-weight-10s')
    if (tenSec !== null) {
      const n = Number(tenSec)
      if (Number.isFinite(n) && n >= 0) this.usedWeight10s = n
    }
    const header = res.headers.get('x-mbx-used-weight-1m')
    if (header === null) return
    const used = Number(header)
    if (!Number.isFinite(used) || used < 0) return
    this.usedWeight = used
    const b = this.budget as Partial<BinanceBudget>
    b.reconcile?.(used)
  }

  /** Retry-After 是秒（Binance 偶尔给 HTTP-date）；解析不了按 60 s。 */
  private retryAfterOf(res: Response): number {
    const header = res.headers.get('retry-after')
    if (header === null) return 60_000
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - (this.ts.now()))
    return 60_000
  }
}

/** 缺省预算：本连接器自己一份（≤ 60% × 2400）。同机多连接时必须由内核注入共用一份。 */
function defaultBudget(clock?: () => number): RateBudget {
  return createWeightBudget({ ...(clock ? { clock } : {}) })
}
