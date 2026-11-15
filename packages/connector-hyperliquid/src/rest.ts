// SPDX-License-Identifier: CPAL-1.0
// Hyperliquid HTTP 出口：info 查询 + 给 @nktkas/hyperliquid ExchangeClient 用的传输层。
// 所有请求先过权重预算（RateBudget）；上游报错原文原样保留在错误对象上，不改写。
import { exchangeWeight, extraInfoWeight, infoWeight } from './budget'
import type { BudgetKind, RateBudget } from './budget'
import { HlAddressBudget } from './address-budget'

export type Environment = 'mainnet' | 'testnet'

export const HL_ENDPOINTS = {
  mainnet: { http: 'https://api.hyperliquid.xyz', ws: 'wss://api.hyperliquid.xyz/ws' },
  testnet: { http: 'https://api.hyperliquid-testnet.xyz', ws: 'wss://api.hyperliquid-testnet.xyz/ws' },
} as const

/** 上游返回非 2xx。body 是响应原文（完整）。 */
export class HlHttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly endpoint: 'info' | 'exchange') {
    super(`Hyperliquid ${endpoint} HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'HlHttpError'
  }
}

/** 没拿到响应（超时 / 断网 / 取消）。exchange 上出现它意味着「结果未知」（契约 3006）。 */
export class HlNetworkError extends Error {
  constructor(message: string, readonly endpoint: 'info' | 'exchange', override readonly cause?: unknown) {
    super(message)
    this.name = 'HlNetworkError'
  }
}

export interface HlHttpOptions {
  environment: Environment
  budget: RateBudget
  fetchImpl?: typeof fetch
  timeoutMs?: number
  clock?: () => number
  onWarn?: (message: string) => void
}

function explicitExpiryError(value: unknown): boolean {
  if (value instanceof HlHttpError) return value.endpoint === 'exchange' && /expiresAfter|expired/i.test(value.body)
  if (value === null || typeof value !== 'object') return false
  const result = value as { status?: unknown; response?: unknown }
  return result.status === 'err' && typeof result.response === 'string' && /expiresAfter|expired/i.test(result.response)
}

function actionCountAndKind(payload: unknown): { count: number; kind: 'cancel' | 'other' } {
  const action = (payload as { action?: { type?: unknown; orders?: unknown[]; cancels?: unknown[]; modifies?: unknown[] } } | null)?.action
  if (!action || typeof action !== 'object') return { count: 1, kind: 'other' }
  const count = [action.orders, action.cancels, action.modifies].reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0) || 1
  return { count, kind: action.type === 'cancel' || action.type === 'cancelByCloid' || Array.isArray(action.cancels) ? 'cancel' : 'other' }
}

export interface InfoCallOptions {
  /** 权重用途，缺省 query（用户查询）。发现 / 历史 / 轮询兜底传 background。 */
  kind?: BudgetKind
  /** 取消整次调用（排队 + 请求）。 */
  signal?: AbortSignal
  /** 只约束「等预算排队」的最长时间（R1-PERF-01：排队不计入请求超时）；缺省不另设上限。 */
  queueTimeoutMs?: number
  /** 请求本身的超时，从拿到预算之后才开始计；与 HlHttp 自带的 timeoutMs 取先到者。缺省只受后者约束。 */
  timeoutMs?: number
}

export type InfoBody = { type: string } & Record<string, unknown>

function maxArrayLength(value: unknown): number {
  const pending: unknown[] = [value]
  let max = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      if (current.length > max) max = current.length
      for (const child of current) pending.push(child)
    } else if (current !== null && typeof current === 'object') {
      for (const child of Object.values(current)) pending.push(child)
    }
  }
  return max
}

export class HlHttp {
  readonly environment: Environment
  readonly baseUrl: string
  private readonly budget: RateBudget
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly clock: () => number
  private readonly onWarn: (message: string) => void
  readonly addressBudget: HlAddressBudget
  private serverClockOffsetMsValue: number | undefined
  private lastSkewWarningAt: number | undefined
  private lastSkewWarningBand: -1 | 0 | 1 = 0
  /** 诊断：累计请求数与累计权重。 */
  requests = 0
  weightSpent = 0

  constructor(o: HlHttpOptions) {
    this.environment = o.environment
    this.baseUrl = HL_ENDPOINTS[o.environment].http
    this.budget = o.budget
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a))
    this.timeoutMs = o.timeoutMs ?? 8000
    this.clock = o.clock ?? (() => Date.now())
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
    this.addressBudget = new HlAddressBudget(this.onWarn)
  }

  warn(message: string): void { this.onWarn(message) }

  /** Date headers have one-second precision, so this midpoint estimate is necessarily approximate. */
  get serverClockOffsetMs(): number | undefined { return this.serverClockOffsetMsValue }

  async info<T = unknown>(body: InfoBody, o: InfoCallOptions = {}): Promise<T> {
    const w = infoWeight(body.type)
    const kind = o.kind ?? 'query'
    const waitSignal = o.queueTimeoutMs === undefined ? o.signal : o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.queueTimeoutMs)]) : AbortSignal.timeout(o.queueTimeoutMs)
    await this.budget.acquire(w, { kind, priority: kind === 'trade' ? 'high' : 'low', ...(waitSignal ? { signal: waitSignal } : {}) })
    if (o.signal?.aborted) throw o.signal.reason ?? new Error('aborted')
    this.requests += 1
    this.weightSpent += w
    // 请求超时从这里（拿到预算之后）才开始计，排队时间不算进去
    const reqSignal = o.timeoutMs === undefined ? o.signal : o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]) : AbortSignal.timeout(o.timeoutMs)
    const out = await this.post('info', body, reqSignal)
    const extra = extraInfoWeight(body.type, maxArrayLength(out))
    if (extra > 0) { this.budget.charge(extra, kind); this.weightSpent += extra }
    return out as T
  }

  /** 给 nktkas ExchangeClient 的传输层（IRequestTransport 形状）。 */
  exchangeTransport(accountAddress?: string) {
    return {
      isTestnet: this.environment === 'testnet',
      request: async <T>(endpoint: 'info' | 'exchange' | 'explorer', payload: unknown, signal?: AbortSignal): Promise<T> => {
        if (endpoint === 'info') return this.info(payload as InfoBody, signal ? { signal } : {}) as Promise<T>
        if (endpoint !== 'exchange') throw new Error(`unsupported endpoint ${endpoint}`)
        const n = (payload as { action?: { orders?: unknown[]; cancels?: unknown[]; modifies?: unknown[] } })?.action
        const batch = n?.orders?.length ?? n?.cancels?.length ?? n?.modifies?.length ?? 1
        const w = exchangeWeight(batch)
        await this.budget.acquire(w, { kind: 'trade', priority: 'high', ...(signal ? { signal } : {}) })
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        const action = actionCountAndKind(payload)
        this.addressBudget.recordActions(accountAddress, action.count, action.kind)
        this.requests += 1
        this.weightSpent += w
        try {
          const out = await this.post('exchange', payload, signal)
          if (explicitExpiryError(out)) this.addressBudget.recordExpiredResponse(accountAddress, action.count, action.kind)
          return out as T
        } catch (error) {
          if (explicitExpiryError(error)) this.addressBudget.recordExpiredResponse(accountAddress, action.count, action.kind)
          throw error
        }
      },
    }
  }

  /** 发一个已签名的 exchange 载荷（用户签名动作：approveAgent / approveBuilderFee 等）。 */
  async postExchange(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.exchangeTransport().request('exchange', payload, signal)
  }

  private async post(endpoint: 'info' | 'exchange', body: unknown, outer?: AbortSignal): Promise<unknown> {
    const ctl = new AbortController()
    const onAbort = () => ctl.abort(outer?.reason)
    outer?.addEventListener('abort', onAbort, { once: true })
    if (outer?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`Hyperliquid ${endpoint} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
    // 注入的 fetch 不理会 signal 时，abort 也要立刻结束本次调用
    const aborted = new Promise<never>((_, reject) => {
      const fire = () => reject(ctl.signal.reason instanceof Error ? ctl.signal.reason : new Error(String(ctl.signal.reason)))
      if (ctl.signal.aborted) fire()
      else ctl.signal.addEventListener('abort', fire, { once: true })
    })
    aborted.catch(() => {})
    try {
      const run = (async () => {
        const sentAt = this.clock()
        const res = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        })
        if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error('aborted')
        const receivedAt = this.clock()
        const dateHeader = res.headers.get('date')
        if (dateHeader) {
          const serverDate = Date.parse(dateHeader)
          if (Number.isFinite(serverDate) && Number.isInteger(serverDate)) {
            this.serverClockOffsetMsValue = Math.round(serverDate - (sentAt + receivedAt) / 2)
            this.warnClockOffset(this.serverClockOffsetMsValue)
          }
        }
        const text = await res.text()
        if (res.status === 429) this.budget.penalize()
        if (!res.ok) throw new HlHttpError(res.status, text, endpoint)
        this.budget.reportOk()
        try {
          return JSON.parse(text) as unknown
        } catch {
          throw new HlHttpError(res.status, text, endpoint) // 2xx 但不是 JSON：原文带回
        }
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof HlHttpError) throw e
      throw new HlNetworkError(e instanceof Error ? e.message : String(e), endpoint, e)
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }

  private warnClockOffset(offsetMs: number): void {
    const band: -1 | 0 | 1 = offsetMs > 10_000 ? 1 : offsetMs < -10_000 ? -1 : 0
    if (band === 0) {
      this.lastSkewWarningAt = undefined
      this.lastSkewWarningBand = 0
      return
    }
    const now = this.clock()
    const bandChanged = band !== this.lastSkewWarningBand
    const intervalElapsed = this.lastSkewWarningAt !== undefined && now >= this.lastSkewWarningAt + 600_000
    if (bandChanged || intervalElapsed) {
      this.warn('场所时钟偏差较大；签名到期时间按偏差换算')
      this.lastSkewWarningAt = now
      this.lastSkewWarningBand = band
    }
  }
}
