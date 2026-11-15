// SPDX-License-Identifier: CPAL-1.0
// Bitget v2 mix 签名 REST 出口。
// 签名口径（QD backend_api_python/app/services/live_trading/bitget.py:198-258）：
//   · 预签串 = `timestamp + UPPER(method) + requestPath(+query) + body`，HMAC-SHA256 后 **base64**；
//   · GET 的 query **按键排序**后才进预签串（QD :236-241 用 dict(sorted(...))），而真正发出去的 query 也是同一个有序串；
//   · body 是 JSON 文本本身（必须与发出去逐字节一致，QD :229-233 的注释就为此）；
//   · 头：`ACCESS-KEY` / `ACCESS-SIGN` / `ACCESS-TIMESTAMP` / `ACCESS-PASSPHRASE`（+ `Content-Type: application/json`）；
//   · 信封：业务错误以 `{code,msg}` 信封返回，HTTP 状态可能是 200 或 4xx；`code === '00000'` 才算成功
//     （QD :251-258）——所以任意状态都先解析信封，业务错误是一等输入；
//   · 429 / 418 让预算整体退避并带回 Retry-After；
//   · 密钥只从构造参数进，放 `#` 私有字段：JSON.stringify / util.inspect / String(err) 都看不到；
//     任何对外文本（warn / 错误）先过 redactSecret。
import { createHmac } from 'node:crypto'
import type { RateBudget } from '@gitrader/protocol/connector'
import { BITGET_WEIGHTS, createCountBudget } from './budget'
import type { BitgetBudget, BudgetKind } from './budget'
import { VenueClock } from './clock'
import { BitgetApiError, BitgetHttpError, BitgetNetworkError, redactSecret } from './errors'
import type { BitgetEndpoint } from './errors'
import { DEFAULT_BASE_URL } from './parse'

export type Environment = 'mainnet' | 'testnet'

/**
 * 基址：Bitget 的模拟盘与实盘同一域名，靠 `PAPTRADING: 1` 头切换（QD bitget.py:211-212）。
 * 因此 testnet 只改头，不改域名；测试里用注入的 `baseUrl`（http://bitget.example.test）。
 */
export const BITGET_ENDPOINTS: Record<Environment, string> = {
  mainnet: DEFAULT_BASE_URL,
  testnet: DEFAULT_BASE_URL,
}

/** 签名向量：base64(HMAC-SHA256(secret, ts + METHOD + path + body))。独立可测，不依赖网络。 */
export function signatureOf(apiSecret: string, timestamp: string, method: string, requestPath: string, body = ''): string {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${body}`
  return createHmac('sha256', apiSecret).update(prehash, 'utf8').digest('base64')
}

/** 参数按键名排序后编码：签名与真实请求用同一个串（QD bitget.py:236-241）。undefined / null 跳过。 */
export function encodeSortedQuery(params: Record<string, string | number | undefined | null> = {}): string {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null).sort()
  const qs = new URLSearchParams()
  for (const key of keys) qs.append(key, String(params[key]))
  return qs.toString()
}

/** 上游说「结果未知」的业务文本（非 GET 一律 3006，不盲目重发）。 */
const AMBIGUOUS_TOKENS = ['system error', 'system busy', 'system is abnormal', 'please try again later', 'internal error', 'unknown error']
/** 重复 clientOid：之前那张可能已在场上 → 3006，交内核按 clientOrderId 对账（同 H 的 51016 口径）。 */
const DUPLICATE_CLIENT_OID = /duplicate.{0,40}client|client\s*_?oid.{0,40}(exist|duplicate|repeat|used)/i

export interface BitgetHttpOptions {
  environment?: Environment
  /** 显式基址优先（测试 / 镜像）；缺省官方基址。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  /** Bitget 的第三件凭据；同样只进 `#` 私有字段。 */
  passphrase: string
  /** 模拟盘（PAPTRADING: 1）。环境是 testnet 时默认打开。 */
  simulated?: boolean
  /**
   * 渠道码（X-CHANNEL-API-CODE）。QD 自带一个（bitget.py:39）；我们**不冒用**，缺省不发，
   * 只有用户显式配置时才对下单类端点附加。
   */
  channelApiCode?: string
  fetchImpl?: typeof fetch
  clock?: () => number
  timeoutMs?: number
  /** 内核注入的预算；缺省本对象内部那份（≤ 60% × 20 次 / 秒）。 */
  budget?: BitgetBudget
  onWarn?: (message: string) => void
}

export interface RequestOptions {
  /** 配额用途：trade 走满额，query / background 受限（见 budget.ts）。 */
  kind?: BudgetKind
  weight?: number
  signal?: AbortSignal
  /** 下单 / 撤单 / 改单：weight 0，但走 acquire(0) 并记一笔下单计数。 */
  order?: boolean
  /** 显式覆盖请求体（普通调用传 `body`，本字段只给内部重试留口子）。 */
  body?: unknown
}

/** 下单类端点：只有这些路径附加渠道码（QD bitget.py:41-50 的同一张表）。 */
export const CHANNEL_API_CODE_PATHS = new Set([
  '/api/v2/mix/order/place-order',
  '/api/v2/mix/order/batch-place-order',
  '/api/v2/mix/order/place-plan-order',
  '/api/v2/mix/order/place-tpsl-order',
])

const REDACT_HEADERS = ['ACCESS-KEY', 'ACCESS-SIGN', 'ACCESS-PASSPHRASE']

export class BitgetHttp {
  readonly environment: Environment
  readonly baseUrl: string
  readonly clockSync: VenueClock
  readonly #apiKey: string
  readonly #apiSecret: string
  readonly #passphrase: string
  readonly #channelApiCode: string | undefined
  readonly #simulated: boolean
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly budget: BitgetBudget
  private readonly onWarn: (message: string) => void
  /** 诊断：累计请求数、累计查询配额、最近一次签名（不含密钥）。 */
  requests = 0
  weightSpent = 0
  lastSignature: string | null = null
  lastTimestamp: string | null = null
  lastCode: string | null = null

  constructor(o: BitgetHttpOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey === '') throw new RangeError('apiKey is required')
    if (typeof o.apiSecret !== 'string' || o.apiSecret === '') throw new RangeError('apiSecret is required')
    if (typeof o.passphrase !== 'string' || o.passphrase === '') throw new RangeError('passphrase is required')
    this.environment = o.environment ?? 'mainnet'
    this.baseUrl = (o.baseUrl ?? BITGET_ENDPOINTS[this.environment]).replace(/\/+$/, '')
    const clock = o.clock ?? (() => Date.now())
    this.clockSync = new VenueClock(clock)
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.#passphrase = o.passphrase
    this.#channelApiCode = o.channelApiCode !== undefined && o.channelApiCode !== '' ? o.channelApiCode : undefined
    this.#simulated = o.simulated === true || (o.simulated === undefined && this.environment === 'testnet')
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = o.timeoutMs ?? 10_000
    this.budget = o.budget ?? createCountBudget({ clock })
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
  }

  /** 诊断：预算占用。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.budget.usage()
  }

  /** 用服务端时间重校（收到 40006 / 时钟告警后调用）。 */
  resync(serverTimeMs: number): void {
    this.clockSync.resync(serverTimeMs)
  }

  /** 密钥脱敏：错误消息 / 告警只走这里。 */
  safeText(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e)
    return redactSecret(text, [this.#apiSecret, this.#apiKey, this.#passphrase])
  }

  /** 同包内的 account / trading 组 Problem 时要用同一份密钥做脱敏（不外泄给调用方之外）。 */
  secretsForRedaction(): readonly string[] {
    return [this.#apiSecret, this.#apiKey, this.#passphrase]
  }

  /**
   * 签名请求。参数放 query（GET）或 JSON body（POST），两者都按 QD 的口径进预签串。
   * 返回值是信封里的 `data`（调用方不用再拆一层）。
   */
  async signed<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: RequestOptions & { params?: Record<string, string | number | undefined | null>; body?: unknown } = {}): Promise<T> {
    const weight = opts.order === true ? 0 : opts.weight ?? 1
    await this.spend(weight, opts)
    const params = opts.params ?? {}
    // GET：参数全部进 query 并按键排序后同时用于「预签串」和「真实 URL」；POST：参数进 JSON body。
    const query = method === 'GET' ? encodeSortedQuery(params) : ''
    const requestPath = query === '' ? path : `${path}?${query}`
    const bodyText = method === 'GET' ? '' : opts.body === undefined ? '' : JSON.stringify(opts.body)
    const timestamp = this.clockSync.timestamp()
    const signature = signatureOf(this.#apiSecret, timestamp, method, requestPath, bodyText)
    this.lastSignature = signature
    this.lastTimestamp = timestamp
    const headers = this.headers(timestamp, signature, path)
    const url = `${this.baseUrl}${requestPath}`
    return this.send<T>(method, path, url, headers, bodyText === '' ? undefined : bodyText, opts)
  }

  /** 公共只读请求（不带密钥、不签名）：行情 / 合约元数据。 */
  async publicGet<T>(path: string, params: Record<string, string | number | undefined | null> = {}, weight = 1, opts: RequestOptions = {}): Promise<T> {
    await this.spend(weight, { ...opts, kind: opts.kind ?? 'background' })
    const query = encodeSortedQuery(params)
    const url = query === '' ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}?${query}`
    return this.send<T>('GET', path, url, { accept: 'application/json' }, undefined, opts)
  }

  private headers(timestamp: string, signature: string, path: string): Record<string, string> {
    const headers: Record<string, string> = {
      'ACCESS-KEY': this.#apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': this.#passphrase,
      'Content-Type': 'application/json',
      accept: 'application/json',
    }
    if (this.#simulated) headers['PAPTRADING'] = '1'
    if (this.#channelApiCode !== undefined && CHANNEL_API_CODE_PATHS.has(path.split('?')[0] ?? path)) {
      headers['X-CHANNEL-API-CODE'] = this.#channelApiCode
    }
    return headers
  }

  private async spend(weight: number, opts: RequestOptions): Promise<void> {
    // 权重 0 的请求也要 acquire(0)：429 退避与下单计数桶都不得绕过。
    await this.budget.acquire(weight, {
      kind: opts.order === true ? 'trade' : opts.kind ?? 'trade',
      ...(opts.order === true ? { order: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    this.weightSpent += weight
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    url: string,
    headers: Record<string, string>,
    bodyText: string | undefined,
    opts: RequestOptions,
  ): Promise<T> {
    const endpoint: BitgetEndpoint = REDACT_HEADERS.every((h) => h in headers) ? 'signed' : 'public'
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`bitget ${path} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => reject(ctl.signal.reason instanceof Error ? ctl.signal.reason : new Error(String(ctl.signal.reason)))
      if (ctl.signal.aborted) fire()
      else ctl.signal.addEventListener('abort', fire, { once: true })
    })
    aborted.catch(() => {})

    const mutating = method !== 'GET'
    this.requests += 1
    try {
      const run = (async (): Promise<T> => {
        const init: RequestInit = { method, headers, signal: ctl.signal }
        if (bodyText !== undefined) init.body = bodyText
        const res = await this.fetchImpl(url, init)
        if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error('aborted')
        const text = await res.text()
        const redacted = this.safeText(text)
        if (res.status === 429 || res.status === 418) {
          const retryAfterMs = this.retryAfterOf(res)
          this.onWarn(`bitget rate limited (HTTP ${res.status}); backing off ${retryAfterMs} ms`)
          this.budget.penalize(retryAfterMs)
          throw new BitgetHttpError(res.status, redacted, endpoint, retryAfterMs, false)
        }
        let parsed: unknown
        let jsonOk = true
        try {
          parsed = text === '' ? undefined : (JSON.parse(text) as unknown)
        } catch {
          jsonOk = false
        }
        const envelope = jsonOk && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { code?: unknown; msg?: unknown; data?: unknown })
          : undefined
        const rawCode = envelope?.code
        const code = rawCode === undefined || rawCode === null || rawCode === '' ? undefined : String(rawCode)
        const ambiguousStatus = res.status === 408 || res.status >= 500
        if (code !== undefined && code !== '00000' && code !== '0') {
          this.lastCode = code
          const msg = String(envelope?.msg ?? '')
          const lower = `${code} ${msg}`.toLowerCase()
          const unknown = mutating && code !== '429'
            && (ambiguousStatus || AMBIGUOUS_TOKENS.some((t) => lower.includes(t)) || DUPLICATE_CLIENT_OID.test(msg))
          throw new BitgetApiError(code, this.safeText(msg), endpoint, redacted, unknown, res.status)
        }
        if (!res.ok) throw new BitgetHttpError(res.status, redacted, endpoint, undefined, mutating && ambiguousStatus)
        if (!jsonOk) throw new BitgetHttpError(res.status, 'invalid json from venue', endpoint, undefined, mutating)
        this.lastCode = code ?? '00000'
        this.budget.reportOk()
        return (envelope?.data ?? undefined) as T
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof BitgetHttpError || e instanceof BitgetApiError) throw e
      throw new BitgetNetworkError(this.safeText(e), endpoint, e, mutating)
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

/** 各端点默认配额（与 budget.ts 的 BITGET_WEIGHTS 同一张表，导出便于断言）。 */
export const DEFAULT_WEIGHTS = BITGET_WEIGHTS
