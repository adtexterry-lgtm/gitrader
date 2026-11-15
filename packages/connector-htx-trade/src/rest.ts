// SPDX-License-Identifier: CPAL-1.0
// HTX 签名 REST 出口（HMAC-SHA256 + Base64 over `METHOD\nhost\npath\nsorted&encoded params`）。
// 口径来源（两处，均为可查的官方 / 参照实现）：
//   1) HTX 官方《签名认证》（USDT 本位永续 / V5 同一套）：
//      · 公共参数 `AccessKeyId`、`SignatureMethod=HmacSHA256`、`SignatureVersion=2`、`Timestamp`（UTC ISO8601 秒级）；
//      · 全部请求参数按参数名 ASCII 升序、「参数名=参数值」URL 编码后用 `&` 连接；
//      · 待签串 = `METHOD\nHost\nPath\n编码后的参数串`（Host 不含协议头，Path 是端点路径）；
//      · `Signature = Base64(HMAC-SHA256(待签串, SecretKey))`，作为普通参数随请求发出。
//   2) QD backend_api_python/app/services/live_trading/htx.py:121-132 `_sign_params`（同一算法：
//      `urlencode(sorted(...))` → `"\n".join([METHOD, host, path, encoded])` → base64 hmac）与
//      :181-200 `_swap_private_request_raw`（**鉴权参数放 query、业务参数放 JSON body**，POST 也一样）。
//      因此 POST 的业务参数**不进待签串**——这一点与 v1/v5 官方示例一致（示例的 curl 里 AccessKeyId 与 Signature
//      都在 URL 上，body 只有 contract_code / volume 这类业务字段）。
// 两套响应信封都要认：
//   · linear-swap-api v1：`{"status":"ok"|"error","data":…,"err_code":N,"err_msg":"…","ts":毫秒}`
//     （QD htx.py:620-623 用 status 判成败；ts 用来校时，见 time.ts）；
//   · /v5：`{"code":200,"message":"…","data":…}`（QD htx_v5.py:13-24 `v5_ok`：status=='ok' 或 code==200）。
// 「结果未知」的判定（教训 3）：**只在非 GET 上**判——HTTP 408 / 5xx、
// 系统 / 结果未知码（1000·1001·1002·1003·1004·500·6021，见 venue-errors.ts）→ 3006，先按 clientOrderId 对账；
// GET 的同类错误仍按可重试处理。v1 的 1032（限频）在 HTTP 200 上回：本层直接 `budget.penalize` 退避。
// 密钥只从构造参数进：任何对外文本先过 redactSecret，签名本身从不进日志。
import { createHmac } from 'node:crypto'
import type { RateBudget } from '@gitrader/protocol/connector'
import { HTX_WEIGHTS, createWeightBudget } from './budget'
import { makeProblem } from '@gitrader/protocol'
import { HtxHttpError, HtxNetworkError, ProblemError, redactSecret } from './errors'
import type { HtxEndpoint } from './errors'
import { HtxClock, serverTimeMsOf } from './time'
import { AMBIGUOUS_VENUE_CODES, isAmbiguousVenueCode } from './venue-errors'

export type Environment = 'mainnet' | 'testnet'

/** 基址：USDT 本位永续（linear swap）主网。官方文档《USDT 本位永续 · 接口地址》。HTX 没有官方测试网；测试里一律注入 http://htx.example.test。 */
export const HTX_ENDPOINTS: { readonly mainnet: string } = {
  mainnet: 'https://api.hbdm.com',
}

/** 选基址：显式 baseUrl 优先（离线假服务器 / 镜像）；否则只认 mainnet，testnet 直接抛配置错误。 */
export function resolveBaseUrl(environment: Environment, baseUrl?: string): string {
  if (baseUrl === undefined && environment !== 'mainnet') {
    throw new ProblemError(makeProblem('INVALID_PARAMS', 'HTX 没有官方测试网；离线测试请显式传 baseUrl 指向假服务器'))
  }
  return (baseUrl ?? HTX_ENDPOINTS.mainnet).replace(/\/+$/, '')
}

/** 签名向量：Base64(HMAC-SHA256(apiSecret, prehash))。独立可测，不依赖网络。 */
export function signatureOf(apiSecret: string, prehash: string): string {
  return createHmac('sha256', apiSecret).update(prehash).digest('base64')
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx.py:121-132; adapted.
/** 待签串：`METHOD\nHost\nPath\nencodedParams`（METHOD 大写；Host 不带协议头）。 */
export function prehashOf(method: string, host: string, path: string, encodedParams: string): string {
  return [method.toUpperCase(), host, path, encodedParams].join('\n')
}

/** 参数编码：按参数名 ASCII 升序；undefined / null 跳过；值一律 String 后 encodeURIComponent（空格是 %20）。 */
export function encodeParams(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = []
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value === undefined || value === null) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.join('&')
}

/** 从基址取 Host（不带协议头、不带路径）。 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  }
}

/**
 * 端点表（教训 1 / 2 的唯一事实源）。
 * `family` = 该端点属于哪套 API；`doc` 是官方文档章节名（v5 = 《HTX V5 合约接口》，v1 = 《USDT 本位永续合约接口》）。
 * 官方事实：**v1 全部私有接口都是 POST**（业务参数在 JSON body）；v5 的下单 / 撤单 / 全撤 / 杠杆是 POST，
 * 余额 / 持仓 / 订单 / 挂单 / 成交明细是 GET。全撤 v5 有官方端点 `POST /v5/trade/cancel_all_orders`。
 * 本包**不调用** v5 的两个“市价平仓”端点（官方注明它们是市价全平，无参数）；持仓只读 `position/opens`。
 */
export const ENDPOINTS = {
  // ---- /v5（多资产保证金账户；QD 的当前实现）----
  v5Order: { method: 'POST', path: '/v5/trade/order', family: 'v5', doc: 'HTX V5 合约 · 下单' },
  v5Cancel: { method: 'POST', path: '/v5/trade/cancel_order', family: 'v5', doc: 'HTX V5 合约 · 撤单' },
  v5OrderInfo: { method: 'GET', path: '/v5/trade/order', family: 'v5', doc: 'HTX V5 合约 · 订单详情' },
  v5OrderDetails: { method: 'GET', path: '/v5/trade/order/details', family: 'v5', doc: 'HTX V5 合约 · 订单成交明细' },
  v5OpenOrders: { method: 'GET', path: '/v5/trade/order/opens', family: 'v5', doc: 'HTX V5 合约 · 当前委托' },
  v5CancelAll: { method: 'POST', path: '/v5/trade/cancel_all_orders', family: 'v5', doc: 'HTX V5 合约 · 全部撤单' },
  v5Balance: { method: 'GET', path: '/v5/account/balance', family: 'v5', doc: 'HTX V5 合约 · 账户余额' },
  v5Positions: { method: 'GET', path: '/v5/trade/position/opens', family: 'v5', doc: 'HTX V5 合约 · 当前持仓' },
  v5PositionMode: { method: 'GET', path: '/v5/position/mode', family: 'v5', doc: 'HTX V5 合约 · 查询持仓模式' },
  v5Lever: { method: 'POST', path: '/v5/position/lever', family: 'v5', doc: 'HTX V5 合约 · 调整杠杆' },
  v5AssetMode: { method: 'GET', path: '/v5/account/asset_mode', family: 'v5', doc: 'HTX V5 合约 · 查询资产模式' },
  // ---- linear-swap-api v1（逐仓 / 全仓交叉保证金；QD 的回退路径）----
  crossOrder: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_order', family: 'v1', doc: 'USDT 本位永续 · 合约下单 swap_cross_order' },
  crossCancel: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_cancel', family: 'v1', doc: 'USDT 本位永续 · 合约撤单 swap_cross_cancel' },
  crossCancelAll: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_cancelall', family: 'v1', doc: 'USDT 本位永续 · 合约全部撤单 swap_cross_cancelall' },
  crossOpenOrders: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_openorders', family: 'v1', doc: 'USDT 本位永续 · 合约当前委托 swap_cross_openorders' },
  crossOrderInfo: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_order_info', family: 'v1', doc: 'USDT 本位永续 · 合约订单信息 swap_cross_order_info' },
  crossAccountInfo: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_account_info', family: 'v1', doc: 'USDT 本位永续 · 合约账户信息 swap_cross_account_info' },
  crossPositionInfo: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_position_info', family: 'v1', doc: 'USDT 本位永续 · 合约持仓信息 swap_cross_position_info' },
  crossTpslOrder: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_tpsl_order', family: 'v1', doc: 'USDT 本位永续 · 止盈止损委托 swap_cross_tpsl_order' },
  crossSwitchLever: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_switch_lever_rate', family: 'v1', doc: 'USDT 本位永续 · 调整杠杆 swap_cross_switch_lever_rate' },
  crossMatchResults: { method: 'POST', path: '/linear-swap-api/v1/swap_cross_matchresults_exact', family: 'v1', doc: 'USDT 本位永续 · 成交记录 swap_cross_matchresults_exact' },
  // ---- 公共行情（本包只需要合约规格 + 参考价；完整行情在 connector-htx-data）----
  contractInfo: { method: 'GET', path: '/linear-swap-api/v1/swap_contract_info', family: 'public', doc: 'USDT 本位永续 · 合约信息 swap_contract_info' },
  merged: { method: 'GET', path: '/linear-swap-ex/market/detail/merged', family: 'public', doc: 'USDT 本位永续 · 聚合行情 detail/merged' },
  depth: { method: 'GET', path: '/linear-swap-ex/market/depth', family: 'public', doc: 'USDT 本位永续 · 盘口 depth' },
  kline: { method: 'GET', path: '/linear-swap-ex/market/history/kline', family: 'public', doc: 'USDT 本位永续 · K 线 history/kline' },
} as const

export type EndpointName = keyof typeof ENDPOINTS

export interface HtxHttpOptions {
  environment?: Environment
  /** 显式基址优先（测试 / 镜像）；缺省按 environment 选官方基址。 */
  baseUrl?: string
  apiKey: string
  apiSecret: string
  fetchImpl?: typeof fetch
  clock?: () => number
  timeoutMs?: number
  /** 内核注入的预算；缺省本对象内部那份（按 budget.ts 的三档）。 */
  budget?: RateBudget
  onWarn?: (message: string) => void
}

export interface RequestOptions {
  /** 权重用途：trade 走满额，query / background 受限（见 budget.ts）。 */
  kind?: 'trade' | 'query' | 'background'
  weight?: number
  signal?: AbortSignal
  /** 下单 / 撤单类请求：权重 0 但记一笔下单计数。 */
  order?: boolean
}

/** 签名请求的载荷：GET 用 params（进 query），POST 用 body（JSON，不进待签串）。 */
export interface SignedPayload {
  params?: Record<string, string | number | boolean | undefined | null>
  body?: Record<string, unknown>
}

export interface HtxEnvelope<T> {
  /** v1 的成败字段。 */
  status?: string
  /** v5 的成败字段。 */
  code?: number
  message?: string
  err_code?: number
  err_msg?: string
  data?: T
  ts?: number
}

export class HtxHttp {
  readonly environment: Environment
  readonly baseUrl: string
  readonly host: string
  readonly clockSource: HtxClock
  // 密钥放 # 私有字段：JSON.stringify / util.inspect 都看不到明文。
  readonly #apiKey: string
  readonly #apiSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly budget: RateBudget
  private readonly onWarn: (message: string) => void
  /** 诊断：累计请求数、累计记账权重。 */
  requests = 0
  weightSpent = 0
  /** 测试与诊断用：最近一次签名（base64），不含密钥本身。 */
  lastSignature: string | null = null
  /** 测试与诊断用：最近一次待签串。它是公开参数串，不含密钥。 */
  lastPrehash: string | null = null

  constructor(o: HtxHttpOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey === '') throw new RangeError('apiKey is required')
    if (typeof o.apiSecret !== 'string' || o.apiSecret === '') throw new RangeError('apiSecret is required')
    this.environment = o.environment ?? 'mainnet'
    this.baseUrl = resolveBaseUrl(this.environment, o.baseUrl)
    this.host = hostOf(this.baseUrl)
    this.#apiKey = o.apiKey
    this.#apiSecret = o.apiSecret
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = o.timeoutMs ?? 10_000
    this.clockSource = new HtxClock(o.clock ?? (() => Date.now()))
    this.budget = o.budget ?? createWeightBudget(o.clock ? { clock: o.clock } : {})
    this.onWarn = o.onWarn ?? ((message) => console.warn(message))
  }

  /** 诊断：预算占用（透传注入的预算对象）。 */
  usage(): ReturnType<RateBudget['usage']> {
    return this.budget.usage()
  }

  /** 用场所时间重校偏移（v1 响应的 ts 或 calibrate() 之后调用）。 */
  resync(serverTimeMs: number): void {
    this.clockSource.resync(serverTimeMs)
  }

  /** 读一次公开合约信息的 ts 并重校时钟（不签名）。失败只 warn，不抛。 */
  async calibrate(): Promise<void> {
    try {
      const envelope = await this.publicGet<unknown>(ENDPOINTS.contractInfo.path, { contract_code: 'BTC-USDT' }, HTX_WEIGHTS.contracts)
      const ts = this.lastServerTs ?? envelopeTsOf(envelope)
      if (ts !== undefined) this.resync(ts)
    } catch (e) {
      this.warn(`htx time calibration failed: ${this.safeText(e)}`)
    }
  }

  /** 最近一次响应里的 v1 `ts`（毫秒）。 */
  lastServerTs: number | undefined

  /**
   * 签名请求。GET 的业务参数进 query；POST 的业务参数进 JSON body（不进待签串）。
   * 鉴权参数（AccessKeyId / SignatureMethod / SignatureVersion / Timestamp / Signature）一律在 query。
   */
  async signed<T>(
    method: 'GET' | 'POST',
    path: string,
    payload: SignedPayload = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const weight = opts.order === true ? 0 : opts.weight ?? 1
    // 权重 0 的请求也要 acquire(0)：429 退避期间不得绕过限流。
    await this.spend(weight, opts)
    if (opts.order === true) {
      const b = this.budget as Partial<{ noteOrder: (n?: number) => void }>
      b.noteOrder?.(1)
    }
    const params = (payload.params ?? {}) as Record<string, string | number | boolean | undefined | null>
    const bodyText = payload.body !== undefined ? JSON.stringify(payload.body) : ''
    const timestamp = this.clockSource.nextTimestamp()
    // 鉴权参数与业务参数合成一张表，统一按参数名排序编码（教训：排序要对 key 做，不能对 "k=v" 字符串做）。
    const all: Record<string, string | number | boolean | undefined | null> = {
      ...params,
      AccessKeyId: this.#apiKey,
      SignatureMethod: 'HmacSHA256',
      SignatureVersion: '2',
      Timestamp: timestamp,
    }
    const encoded = encodeParams(all)
    const prehash = prehashOf(method, this.host, path, encoded)
    const signature = signatureOf(this.#apiSecret, prehash)
    this.lastSignature = signature
    this.lastPrehash = prehash
    const query = `${encoded}&Signature=${encodeURIComponent(signature)}`
    const relative = `${path}?${query}`
    return this.send<T>('signed', method, path, relative, bodyText === '' ? undefined : bodyText, {
      ...opts,
      timestamp,
      signature,
    })
  }

  /** 公共只读请求（不带密钥、不签名）。 */
  async publicGet<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined | null> = {},
    weight = 1,
    opts: RequestOptions = {},
  ): Promise<T> {
    await this.spend(weight, opts)
    const query = encodeParams(params)
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
    endpoint: HtxEndpoint,
    method: 'GET' | 'POST',
    path: string,
    relative: string,
    bodyText: string | undefined,
    opts: RequestOptions & { timestamp?: string; signature?: string },
  ): Promise<T> {
    const url = `${this.baseUrl}${relative}`
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => ctl.abort(new Error(`htx ${path} timeout after ${this.timeoutMs} ms`)), this.timeoutMs)
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
        if (endpoint === 'signed') headers['content-type'] = 'application/json'
        const res = await this.fetchImpl(url, {
          method,
          headers,
          ...(bodyText !== undefined ? { body: bodyText } : {}),
          signal: ctl.signal,
        })
        if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error('aborted')
        const retryAfterMs = retryAfterOf(res, this.clockSource.now())
        const text = await res.text()
        const redacted = redactSecret(text, [this.#apiSecret, this.#apiKey])
        const venueCode = codeOf(text)
        const mutating = method !== 'GET'
        // 1032（The number of access exceeded the limit）常以 HTTP 200 回来：本层先退避，再交给分类落 3002。
        if (venueCode === 1032) this.budget.penalize(retryAfterMs ?? 3_000)
        const ambiguous = res.status === 408 || res.status >= 500 || (venueCode !== undefined && isAmbiguousVenueCode(venueCode))
        if (res.status === 429 || res.status === 418) {
          this.budget.penalize(retryAfterMs ?? 60_000)
          throw new HtxHttpError(res.status, redacted, endpoint, retryAfterMs ?? 60_000, venueCode, false)
        }
        if (!res.ok) {
          throw new HtxHttpError(res.status, redacted, endpoint, retryAfterMs, venueCode, mutating && ambiguous)
        }
        if (text === '') throw new HtxHttpError(res.status, 'empty body from venue', endpoint, undefined, undefined, mutating)
        let parsed: HtxEnvelope<T>
        try {
          // v1 的 order_id / client_order_id 是 18 位 long，JSON.parse 会丢精度：先把 16 位以上的整数 id 变成字符串。
          parsed = JSON.parse(quoteBigIds(text)) as HtxEnvelope<T>
        } catch {
          throw new HtxHttpError(res.status, 'invalid json from venue', endpoint, undefined, undefined, mutating)
        }
        const ts = serverTimeMsOf(parsed)
        if (ts !== undefined) {
          this.lastServerTs = ts
          // v1 的 ts 是场所时间：顺手校时（不做额外请求，也不改变业务结果）。
          this.resync(ts)
        }
        if (!envelopeOk(parsed)) {
          // 钱路红线：改变状态的请求，只要信封**读不懂**（既不是 ok，也不是明确的 error），结果就是未知。
          // `{}` 这类 200 不能被当成 3001 拒单（内核会以为单没出）。明确 error（status=error / 有 code）
          // 仍按原路径分类，行为不变。
          const unreadable = !envelopeIsDefiniteError(parsed)
          throw new HtxHttpError(res.status, redacted, endpoint, retryAfterMs, venueCode, mutating && (ambiguous || unreadable))
        }
        this.budget.reportOk()
        return (parsed.data ?? (parsed as unknown as T)) as T
      })()
      run.catch(() => {})
      return await Promise.race([run, aborted])
    } catch (e) {
      if (e instanceof HtxHttpError) throw e
      throw new HtxNetworkError(this.safeText(e), endpoint, e, method !== 'GET')
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** Retry-After 是秒（HTX 偶尔给 HTTP-date）；解析不了返回 undefined。 */
export function retryAfterOf(res: Response, nowMs: number): number | undefined {
  const header = res.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - nowMs)
  return undefined
}

/** 信封是否成功：v1 `status==='ok'`，v5 `code===200`（QD htx_v5.py:13-24 同口径）。 */
export function envelopeOk(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const env = raw as HtxEnvelope<unknown>
  if (typeof env.status === 'string' && env.status.toLowerCase() === 'ok') return true
  if (typeof env.status === 'string' && env.status.toLowerCase() === 'error') return false
  if (env.code !== undefined && env.code !== null) {
    const code = Number(env.code)
    return Number.isFinite(code) && code === 200
  }
  return false
}

/** 信封是否「明确的失败」：v1 `status==='error'` 或 v5 给了数字 code。都认不出 = 信封不可读。 */
export function envelopeIsDefiniteError(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const env = raw as HtxEnvelope<unknown>
  if (typeof env.status === 'string' && env.status.toLowerCase() === 'error') return true
  if (env.code !== undefined && env.code !== null) return Number.isFinite(Number(env.code))
  return false
}

/** 从响应原文取上游错误码（v1 err_code 优先，其次 v5 code）；拿不到返回 undefined。 */
export function codeOf(text: string): number | undefined {
  const err = /"err_code"\s*:\s*(-?\d+)/.exec(text)
  if (err?.[1]) {
    const n = Number(err[1])
    if (Number.isFinite(n)) return n
  }
  const code = /"code"\s*:\s*(-?\d+)/.exec(text)
  if (code?.[1]) {
    const n = Number(code[1])
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 从信封取场所时间（v1 的 ts）。 */
export function envelopeTsOf(raw: unknown): number | undefined {
  return serverTimeMsOf(raw)
}

/**
 * JSON.parse 之前保护大整数 id（官方明说 v1 的 order_id 是 18 位 long）。
 * 只改这些字段名上的 16 位以上纯数字字面量，其它数字原样保留。
 */
export function quoteBigIds(text: string): string {
  return text.replace(/"(order_id|client_order_id|id|match_id|query_id|next_id)"\s*:\s*(\d{16,})/g, '"$1":"$2"')
}

/** 缺省预算：本连接器自己一份（同机多连接时必须由内核注入共用一份）。 */
function defaultBudget(clock?: () => number): RateBudget {
  return createWeightBudget(clock ? { clock } : {})
}

export { defaultBudget, AMBIGUOUS_VENUE_CODES }
