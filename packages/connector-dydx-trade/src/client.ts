// SPDX-License-Identifier: CPAL-1.0
// HTTP 层：Indexer 私有读 + 链节点 LCD 读/广播。fetch 与时钟都从构造参数注入（测试全离线）。
// 限流（工单教训 11）：每次请求前向注入的 budget 要额度——权重为 0 的请求也调用 acquire(0)；
//   429 / 418 时 penalize(Retry-After) 并抛 3003；成功时 reportOk()。
// 「结果未知」（教训 3）：只有 GET 可以自动重试；非 GET 的 408 / 5xx / 断连一律 3006，先按 clientOrderId 对账。
import type { Ms } from '@gitrader/protocol'
import { DydxHttpError, DydxNetworkError } from './errors'
import { INDEXER_BASE, INDEXER_RATE_LIMIT, INDEXER_RATE_WINDOW_MS, NODE_BASE } from './constants'
import type { Environment } from '@gitrader/protocol/connector'

/** 与 @gitrader/connector-dydx-data 的 BudgetLike 同形（结构类型，避免跨包耦合；内核注同一个预算对象）。 */
export interface BudgetLike {
  acquire?(weight: number, opts?: { priority?: 'high' | 'low' }): Promise<void>
  take?(weight: number): void
  charge?(weight: number): void
  penalize?(retryAfterMs?: number): void
  reportOk?(): void
  usage?(): { used: number; limit: number; windowMs: number }
}

export interface FetchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
  headers?: { get(name: string): string | null }
}

export type FetchLike = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<FetchResponseLike>

export interface DydxHttpOptions {
  fetchImpl?: FetchLike
  environment?: Environment
  indexerBaseUrl?: string
  nodeBaseUrl?: string
  budget?: BudgetLike
  timeoutMs?: number
  now?: () => Ms
}

export interface RequestResult<T> {
  data: T
  /** 原始响应文本（对账字段 receiptHash 由调用方取 sha256）。 */
  raw: string
  weight: number
}

export const DEFAULT_TIMEOUT_MS = 10_000

export class DydxHttp {
  readonly indexerBaseUrl: string
  readonly nodeBaseUrl: string
  readonly environment: Environment
  readonly budget?: BudgetLike
  readonly timeoutMs: number
  readonly #fetch: FetchLike
  readonly #now: () => Ms

  constructor(o: DydxHttpOptions = {}) {
    const env = o.environment ?? 'mainnet'
    this.environment = env
    this.indexerBaseUrl = (o.indexerBaseUrl ?? INDEXER_BASE[env]).replace(/\/+$/, '')
    this.nodeBaseUrl = (o.nodeBaseUrl ?? NODE_BASE[env]).replace(/\/+$/, '')
    this.budget = o.budget
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetch = o.fetchImpl ?? defaultFetch()
    this.#now = o.now ?? (() => Date.now())
  }

  /** Indexer 私有读：GET {indexer}/v4/...；weight 缺省 1。 */
  async indexerGet<T>(path: string, query?: Record<string, string | number | undefined>, weight = 1): Promise<RequestResult<T>> {
    return this.#request<T>('GET', this.indexerBaseUrl + withQuery(path, query), undefined, weight)
  }

  /** 链节点读：GET {node}/cosmos/...（account_number / 块高）。 */
  async nodeGet<T>(path: string, weight = 0): Promise<RequestResult<T>> {
    return this.#request<T>('GET', this.nodeBaseUrl + path, undefined, weight)
  }

  /** 广播：POST {node}/cosmos/tx/v1beta1/txs。失败即 3006（结果未知），由调用方按 clientOrderId 对账。 */
  async nodePost<T>(path: string, body: unknown, weight = 0): Promise<RequestResult<T>> {
    return this.#request<T>('POST', this.nodeBaseUrl + path, JSON.stringify(body), weight)
  }

  /** 当前时刻（注入的时钟；测试用它把 goodTilBlockTime 固定下来）。 */
  now(): Ms {
    return this.#now()
  }

  async #request<T>(method: string, url: string, body: string | undefined, weight: number): Promise<RequestResult<T>> {
    // 权重 0 也要过预算（工单教训 11：acquire(0) 允许内核统计与排队）
    await this.#acquire(weight)
    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController()
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), this.timeoutMs)
    let res: FetchResponseLike
    try {
      res = await this.#fetch(url, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
        ...(controller === undefined ? {} : { signal: controller.signal }),
      })
    } catch (e) {
      const outcomeUnknown = method !== 'GET'
      throw new DydxNetworkError(
        `${method} ${pathOf(url)} failed before a response: ${(e as Error).message}`,
        method,
        pathOf(url),
        outcomeUnknown,
        e,
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    const text = await safeText(res)
    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res, this.#now())
      if (res.status === 429 || res.status === 418) this.budget?.penalize?.(retryAfterMs)
      const outcomeUnknown = method !== 'GET' && (res.status === 408 || res.status >= 500)
      throw new DydxHttpError(res.status, text, method, pathOf(url), outcomeUnknown, retryAfterMs)
    }
    this.budget?.reportOk?.()
    if (text.trim().length === 0) return { data: undefined as T, raw: text, weight }
    let data: T
    try {
      data = JSON.parse(text) as T
    } catch (e) {
      throw new DydxNetworkError(`response is not JSON: ${(e as Error).message}`, method, pathOf(url), false, e)
    }
    return { data, raw: text, weight }
  }

  async #acquire(weight: number): Promise<void> {
    const b = this.budget
    if (b === undefined) return
    if (typeof b.acquire === 'function') await b.acquire(weight)
    else if (typeof b.take === 'function') b.take(weight)
  }
}

function defaultFetch(): FetchLike {
  if (typeof fetch !== 'function') {
    return async () => {
      throw new Error('global fetch is unavailable; inject fetchImpl')
    }
  }
  return (url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>
}

function withQuery(path: string, query?: Record<string, string | number | undefined>): string {
  if (query === undefined) return path
  const parts: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length === 0 ? path : `${path}?${parts.join('&')}`
}

/**
 * 把请求 URL 收敛成**不含账户标识**的 path 模板（L2-12）：
 *   · 主机名、协议、查询值一律不保留；
 *   · `/v4/addresses/<addr>/subaccountNumber/0` 里的地址段、`?address=<addr>` 的值替换成 `***`；
 *   · 其余路径段原样保留（错误文本要能定位端点，但不能带上账户）。
 * 地址是结构位置决定的（addresses 后一段 / address 参数），不靠正则认 bech32，
 * 因此测试里塞进 account.address 的任意金丝雀串同样会被抹掉。
 */
const MASKED_PATH_SEGMENT = '***'
/** 「下一段是账户标识」的路径段名（dydx: /v4/addresses/<addr>/…、/cosmos/auth/v1beta1/accounts/<addr>）。 */
const OWNER_SEGMENTS = new Set(['addresses', 'accounts', 'owner', 'subaccount'])
/** 值本身是账户标识的查询参数名。 */
const OWNER_PARAMS = new Set(['address', 'owner', 'subaccount'])

export function pathOf(url: string): string {
  const m = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(url)
  const rest = m?.[1] ?? url
  const qIndex = rest.indexOf('?')
  const rawPath = qIndex === -1 ? rest : rest.slice(0, qIndex)
  const rawQuery = qIndex === -1 ? '' : rest.slice(qIndex + 1)
  const segments = rawPath.split('/').map((seg, i, all) => {
    if (i === 0 || seg === '') return seg
    const prev = (all[i - 1] ?? '').toLowerCase()
    return OWNER_SEGMENTS.has(prev) ? MASKED_PATH_SEGMENT : seg
  })
  if (rawQuery === '') return segments.join('/')
  const parts: string[] = []
  for (const [k, v] of new URLSearchParams(rawQuery)) {
    parts.push(`${k}=${OWNER_PARAMS.has(k.toLowerCase()) || v === '' ? MASKED_PATH_SEGMENT : v}`)
  }
  return `${segments.join('/')}?${parts.join('&')}`
}

async function safeText(res: FetchResponseLike): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function parseRetryAfter(res: FetchResponseLike, nowMs: Ms): number | undefined {
  const header = res.headers?.get('retry-after') ?? null
  if (header === null || header === '') return undefined
  const n = Number(header)
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined
}

/** 缺省不限的预算（连接器不注入时用；与 dydx-data 的 unlimitedBudget 同口径）。 */
export function unlimitedBudget(): BudgetLike {
  return {
    async acquire(): Promise<void> {},
    take(): void {},
    charge(): void {},
    penalize(): void {},
    reportOk(): void {},
    usage: () => ({ used: 0, limit: INDEXER_RATE_LIMIT, windowMs: INDEXER_RATE_WINDOW_MS }),
  }
}
