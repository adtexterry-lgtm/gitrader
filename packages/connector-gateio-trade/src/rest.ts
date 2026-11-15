// SPDX-License-Identifier: CPAL-1.0
// Gate.io apiv4 签名 REST 出口。
// 签名口径（QD backend_api_python/app/services/live_trading/gate.py:1-11,78-138）：
//   · 预签串 = `UPPER(method) + "\n" + URL_PATH + "\n" + QUERY_STRING + "\n" + hex(sha512(body)) + "\n" + TIMESTAMP`
//     —— **不是币安那种“body 原样进串”**：payload 槽位是 body 的 SHA512 十六进制（无 body 时是空串的 sha512）；
//   · 签名 = hex(HMAC-SHA512(secret, 预签串))；头是 `KEY` / `Timestamp`（**Unix 秒**）/ `SIGN`；
//   · query 按键排序后才进预签串，真正发出去的 query 也是同一个有序串（QD :120-125 `sorted(norm.items())`）；
//   · `X-Gate-Size-Decimal: 1` 让 `size` 支持份额化（字符串小数），下单 / 持仓端点都带（QD :86, :869）；
//   · 429 / 418 让预算整体退避并带回 Retry-After；非 GET 的 408 / 5xx / 断连 = 结果未知（3006）；
//   · 密钥只从构造参数进，放 `#` 私有字段：JSON.stringify / util.inspect / String(err) 都看不到；
//     任何对外文本（warn / 错误）先过 redactSecret。
import { createHash, createHmac } from 'node:crypto'
import type { RateBudget } from '@gitrader/protocol/connector'
import { createWeightBudget, GATE_WEIGHTS } from './budget'
import type { BudgetKind, GateBudget } from './budget'
import { VenueClock } from './clock'
import { GateHttpError, GateNetworkError, redactSecret } from './errors'
import type { GateEndpoint } from './errors'
import { DEFAULT_BASE_URL } from './parse'

export type Environment = 'mainnet' | 'testnet'

/** 主网 / 测试网 REST 基址；测试网照 QD backend_api_python/app/services/live_trading/factory.py:327。 */
export const GATE_ENDPOINTS: Record<Environment, string> = {
  mainnet: DEFAULT_BASE_URL,
  testnet: 'https://api-testnet.gateapi.io',
}

/**
 * 签名向量：hex(HMAC-SHA512(secret, METHOD \n PATH \n QUERY \n sha512hex(body) \n TS))。
 * 独立可测，不依赖网络；参数顺序与 QD gate.py:81-83 逐字一致。
 */
export function signatureOf(
  apiSecret: string,
  timestamp: string,
  method: string,
  path: string,
  queryString = '',
  body = '',
): string {
  const hashedPayload = createHash('sha512').update(body ?? '', 'utf8').digest('hex')
  const message = `${method.toUpperCase()}\n${path}\n${queryString}\n${hashedPayload}\n${timestamp}`
  return createHmac('sha512', apiSecret).update(message, 'utf8').digest('hex')
}

/** 参数按键名排序后编码（签名串与真实 URL 用同一个串）；undefined / null 跳过（QD :120-123）。 */
export function encodeSortedQuery(params: Record<string, string | number | undefined | null> = {}): string {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null).sort()
  const qs = new URLSearchParams()
  for (const key of keys) qs.append(key, String(params[key]))
  return qs.toString()
}

/** Gate apiv4 服务端错误 label：改变状态的请求遇到它结果未知（只按状态 / label 判，不看业务文本）。 */
export const UNKNOWN_OUTCOME_LABELS = ['INTERNAL', 'SERVER_ERROR', 'TOO_BUSY'] as const

/**
 * 解析 JSON，但把超出 2^53 的整数按**源文本**保留成字符串（Gate 的 price_orders id 就是这个量级：
 * QD tests/test_quick_trade_position_workflow.py:193）。用的是 Node 22 JSON.parse reviver 的 context.source。
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, ...rest: unknown[]) => {
    const source = (rest[0] as { source?: unknown } | undefined)?.source
    return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && typeof source === 'string' ? source : value
  })
}

export interface GateHttpOptions {
  environment?: Environment
  /** 显式基址优先（测试 / 镜像）；缺省官方基址。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  fetchImpl?: typeof fetch
  clock?: () => number
  timeoutMs?: number
  /** 内核注入的预算；缺省本对象内部那份（≤ 60% × 200 / 10 s）。 */
  budget?: GateBudget
  onWarn?: (message: string) => void
}

export interface RequestOptions {
  /** 配额用途：trade 走满额，query / background 受限（见 budget.ts）。 */
  kind?: BudgetKind
  weight?: number
  signal?: AbortSignal
  /** 下单 / 撤单 / 杠杆：权重 0，但走 acquire(0) 并记一笔下单计数。 */
  order?: boolean
  /** 额外的请求头（`X-Gate-Size-Decimal` 之类）。 */
  headers?: Record<string, string>
}

export class GateHttp {
  readonly environment: Environment
  readonly baseUrl: string
  readonly clockSync: VenueClock
  readonly #apiKey: string
  readonly #apiSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly budget: GateBudget
  private readonly onWarn: (message: string) => void
  /** 诊断：累计请求数、累计权重、最近一次签名 / 时间戳 / 错误 label（都不含密钥）。 */
  requests = 0
  weightSpent = 0
  lastSignature: string | null = null
  lastTimestamp: string | null = null
  lastLabel: string | null = null

  constructor(o: GateHttpOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey === '') throw new RangeError('apiKey is required')
    if (typeof o.apiSecret !== 'string' || o.apiSecret === '') throw new RangeError('apiSecret is required')
    this.environment = o.environment ?? 'mainnet'
    this.baseUrl = (o.baseUrl ?? GATE_ENDPOINTS[this.environment]).replace(/\/+$/, '')
    const clock = o.clock ?? (() => Date.now())
    this.clockSync = new VenueClock(clock)
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = o.timeoutMs ?? 10_000
    this.budget = o.budget ?? createWeightBudget({ clock })
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
  }

  /** 诊断：预算占用。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.budget.usage()
  }

  /** 用服务端时间重校（收到时间戳类错误后调用；Gate 的 Timestamp 是秒，这里收毫秒）。 */
  resync(serverTimeMs: number): void {
    this.clockSync.resync(serverTimeMs)
  }

  /** 密钥脱敏：错误消息 / 告警只走这里。 */
  safeText(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e)
    return redactSecret(text, [this.#apiSecret, this.#apiKey])
  }

  /** 同包内的 account / trading 组 Problem 时要用同一份密钥做脱敏（不外泄给调用方之外）。 */
  secretsForRedaction(): readonly string[] {
    return [this.#apiSecret, this.#apiKey]
  }

  /**
   * 签名请求。参数放 query（所有方法都是，Gate 的 GET 参数与 POST 的杠杆参数都走 query），
   * 下单 / 撤单的字段放 JSON body。返回值是响应体本身（Gate 没有统一信封）。
   */
  async signed<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: RequestOptions & { params?: Record<string, string | number | undefined | null>; body?: unknown } = {},
  ): Promise<T> {
    const weight = opts.order === true ? 0 : opts.weight ?? 1
    await this.spend(weight, opts)
    const query = encodeSortedQuery(opts.params ?? {})
    const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body)
    const timestamp = this.clockSync.timestamp()
    const signature = signatureOf(this.#apiSecret, timestamp, method, path, query, bodyText)
    this.lastSignature = signature
    this.lastTimestamp = timestamp
    const url = query === '' ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}?${query}`
    return this.send<T>(method, path, url, this.signedHeaders(timestamp, signature, opts.headers), bodyText === '' ? undefined : bodyText, opts)
  }

  /** 公共只读请求（不带密钥、不签名）：行情 / 合约元数据 / 标记价。 */
  async publicGet<T>(path: string, params: Record<string, string | number | undefined | null> = {}, weight = 1, opts: RequestOptions = {}): Promise<T> {
    await this.spend(weight, { ...opts, kind: opts.kind ?? 'background' })
    const query = encodeSortedQuery(params)
    const url = query === '' ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}?${query}`
    return this.send<T>('GET', path, url, { accept: 'application/json', 'X-Gate-Size-Decimal': '1' }, undefined, opts)
  }

  private signedHeaders(timestamp: string, signature: string, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      KEY: this.#apiKey,
      Timestamp: timestamp,
      SIGN: signature,
      'Content-Type': 'application/json',
      accept: 'application/json',
      'X-Gate-Size-Decimal': '1',
    }
    if (extra !== undefined) {
      for (const [k, v] of Object.entries(extra)) headers[k] = v
    }
    return headers
  }

  private async spend(weight: number, opts: RequestOptions): Promise<void> {
    // 权重 0 的请求也要 acquire(0)：429 退避与下单计数桶都不得绕过（工单教训 11）。
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
    const endpoint: GateEndpoint = 'SIGN' in headers ? 'signed' : 'public'
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`gateio ${path} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
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
        const label = labelOf(text)
        if (label !== null) this.lastLabel = label
        if (res.status === 429 || res.status === 418) {
          const retryAfterMs = this.retryAfterOf(res)
          this.onWarn(`gateio rate limited (HTTP ${res.status}${label === null ? '' : ` ${label}`}); backing off ${retryAfterMs} ms`)
          this.budget.penalize(retryAfterMs)
          throw new GateHttpError(res.status, redacted, endpoint, label ?? undefined, retryAfterMs, false)
        }
        if (!res.ok) {
          // 408 / 5xx / 服务端错误 label：改变状态的请求结果未知 → 3006；只读请求按 3003。
          const serverLabel = label !== null && (UNKNOWN_OUTCOME_LABELS as readonly string[]).includes(label.toUpperCase())
          const ambiguous = res.status === 408 || res.status >= 500 || serverLabel
          throw new GateHttpError(res.status, redacted, endpoint, label ?? undefined, undefined, mutating && ambiguous)
        }
        this.budget.reportOk()
        if (text === '') return undefined as T
        try {
          return parseJsonExact(text) as T
        } catch {
          // 2xx 但不是 JSON：改变状态的请求结果未知（3006），只读请求按不可用（3003）。
          throw new GateNetworkError('invalid json from venue', endpoint, undefined, mutating)
        }
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof GateHttpError) throw e
      // 改变状态的请求没拿到响应 = 结果未知（3006）；只读请求按不可用（3003）。
      throw new GateNetworkError(this.safeText(e), endpoint, e, mutating)
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Gate 的错误体是 `{"label","message"}`；取不到 label 返回 null。 */
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

/** 从响应原文字里取 `label`；不是 JSON 或没有 label 返回 null。 */
export function labelOf(text: string): string | null {
  if (text === '') return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const label = (parsed as { label?: unknown }).label
    return typeof label === 'string' && label !== '' ? label : null
  } catch {
    return null
  }
}

/** 各端点默认权重（与 budget.ts 的 GATE_WEIGHTS 同一张表，导出便于断言）。 */
export const DEFAULT_WEIGHTS = GATE_WEIGHTS
