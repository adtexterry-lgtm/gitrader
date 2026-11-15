// SPDX-License-Identifier: CPAL-1.0
// 离线假 HTX USDT-M 公共 REST：进程内按路径回答，不开端口、不联网、不读夹具文件。
//
// **独立性（G1/G4/S3）**：本文件不 import 客户端 src 的任何东西；请求形状、周期取值、size/from/to 的
// 互斥规则与错误信封都按 HTX 官方 USDT-M 合约 API v1 文档（https://huobiapi.github.io/docs/usdt_swap/v1/en/）
// 独立实现，并对客户端发来的参数做文档口径的校验（周期非法 → 1033，参数缺失 → 1030）。
// 应答字段取自该文档各端点的 Response 示例（2026-10-21 查阅）：K 线/盘口/市场概览/资金费率/标记价 K 线。
export const FX_NOW = 1_791_483_435_048
export const STEP_MS = 60_000
export const FX_SECOND = Math.floor(FX_NOW / 1000)

/** 官方 K 线 period 取值（HTX v1 §[General] Get KLine Data）。 */
export const PERIODS = ['1min', '5min', '15min', '30min', '60min', '1hour', '4hour', '1day', '1mon'] as const
/** 官方 depth type 取值里本连接器会用到的两个（不合并档）。 */
export const DEPTH_TYPES = ['step0', 'step6', 'step1', 'step2', 'step3', 'step4', 'step5', 'step14', 'step15'] as const

/** 一条合约（字段名与官方 swap_contract_info 一致）。 */
export function contractEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTC',
    contract_code: 'BTC-USDT',
    contract_size: '0.001000000000000000',
    price_tick: '0.100000000000000000',
    delivery_date: '',
    delivery_time: '',
    create_date: '20211202',
    contract_status: 1,
    settlement_date: '1638518400000',
    support_margin_mode: 'all',
    business_type: 'swap',
    pair: 'BTC-USDT',
    contract_type: 'swap',
    ...over,
  }
}

/** 官方 Get KLine Data 的示例行（id 秒、amount 币、vol 张、trade_turnover 计价币）。 */
export const KLINE_EXAMPLE = {
  amount: 0.004,
  close: 13076.8,
  count: 1,
  high: 13076.8,
  id: 1603695060,
  low: 13076.8,
  open: 13076.8,
  trade_turnover: 52.3072,
  vol: 4,
}

/** 官方 Get Market Data Overview 的 tick 示例。 */
export const MERGED_EXAMPLE = {
  amount: '12.526',
  ask: [13084.2, 131],
  bid: [13082.9, 38],
  close: '13076.8',
  count: 2920,
  high: '13205.3',
  id: 1603695162,
  low: '12877.5',
  open: '12916.2',
  trade_turnover: '163247.3982',
  ts: 1603695162580,
  vol: '12526',
}

/** 官方 Get Market Depth 的 tick 示例（vol 是张数）。 */
export const DEPTH_EXAMPLE = {
  asks: [[48611.5, 741], [48635.2, 792]],
  bids: [[48596.4, 90], [48585.7, 180]],
  ch: 'market.BTC-USDT.depth.step6',
  id: 1638754215,
  mrid: 1250406,
  ts: 1638754215640,
  version: 1638754215,
}

/** 官方 Query funding rate 的 data 示例。 */
export const FUNDING_EXAMPLE = {
  estimated_rate: '0.000100000000000000',
  funding_rate: '0.000100000000000000',
  contract_code: 'BTC-USDT',
  symbol: 'BTC',
  fee_asset: 'USDT',
  funding_time: '1603699200000',
  next_funding_time: '1603728000000',
}

/** 官方 Get Kline Data of Mark Price 的示例行。 */
export const MARK_KLINE_EXAMPLE = {
  amount: '0', close: '31078.68', count: '0', high: '31078.68',
  id: 1611105300, low: '31078.68', open: '31078.68', trade_turnover: '0', vol: '0',
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

/** 生成第 index 根 1 分钟 K 线（起始秒 + index×60），价格从 13076.8 起递增。 */
export function klineRow(second: number, price = 13076.8): Record<string, unknown> {
  return {
    id: second,
    open: price,
    close: price + 0.5,
    high: price + 1,
    low: price - 1,
    amount: 0.004,
    vol: 4,
    count: 1,
    trade_turnover: 52.3072,
  }
}

export function klineRows(fromSecond: number, count: number, stepSec = 60): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) out.push(klineRow(fromSecond + i * stepSec, 13076.8 + i))
  return out
}

const ok = (extra: Record<string, unknown>): Record<string, unknown> => ({ status: 'ok', ts: FX_NOW, ...extra })
/** 官方错误信封：HTTP 200 + status:"error" + err_code / err_msg（HTX v1 §Details of Each Error Code）。 */
const err = (err_code: number, err_msg: string): Record<string, unknown> => ({ status: 'error', err_code, err_msg, ts: FX_NOW })
const ERR_INPUT = () => err(1030, 'Input error.')
const ERR_PERIOD = () => err(1033, 'Incorrect field of contract period.')
const ERR_CONTRACT = () => err(1013, "This contract symbol doesn't exist.")

export class FakeHtx {
  calls: RawCall[] = []
  contracts: unknown[] = [
    contractEntry(),
    contractEntry({ symbol: 'ETH', contract_code: 'ETH-USDT', pair: 'ETH-USDT', contract_size: '0.010000000000000000', price_tick: '0.010000000000000000' }),
    contractEntry({ symbol: 'BTC', contract_code: 'BTC-USDC', pair: 'BTC-USDC', contract_size: '0.001000000000000000' }),
    contractEntry({ symbol: 'OLD', contract_code: 'OLD-USDT', pair: 'OLD-USDT', contract_status: 0 }),
    contractEntry({ symbol: 'HALT', contract_code: 'HALT-USDT', pair: 'HALT-USDT', contract_status: 3 }),
    contractEntry({ symbol: 'NEW', contract_code: 'NEW-USDT', pair: 'NEW-USDT', contract_status: 2 }),
    // 期货条目：business_type / contract_type 都不是 swap，客户端必须滤掉
    contractEntry({ symbol: 'BTC', contract_code: 'BTC-USDT-CQ', pair: 'BTC-USDT', business_type: 'futures', contract_type: 'quarter' }),
  ]
  /** 字段与官方示例一致，只把 ts 换成本次运行的固定「现在」，避免行情被判成陈旧。 */
  merged: unknown = { ...MERGED_EXAMPLE, ts: FX_NOW }
  depth: unknown = { ...DEPTH_EXAMPLE, ts: FX_NOW }
  funding: unknown = FUNDING_EXAMPLE
  markKline: unknown = [MARK_KLINE_EXAMPLE]
  /** K 线数据源：默认按 from/to/size 生成；返回数组即作为 data。 */
  klineSource: (params: URLSearchParams) => unknown = (params) => defaultKlines(params)
  /** pathname → 强制响应（Response 原样返回，其它对象转 JSON 200）。 */
  override = new Map<string, (params: URLSearchParams) => unknown>()

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(String(input))
    const params = url.searchParams
    this.calls.push({ path: url.pathname, url: url.toString(), params })
    const forced = this.override.get(url.pathname)
    if (forced) {
      const out = forced(params)
      return out instanceof Response ? out : json(out)
    }
    switch (url.pathname) {
      case '/linear-swap-api/v1/swap_contract_info': {
        const type = params.get('contract_type')
        if (type !== null && !['swap', 'this_week', 'next_week', 'quarter', 'next_quarter'].includes(type)) return json(ERR_INPUT())
        const business = params.get('business_type')
        if (business !== null && !['swap', 'futures', 'all'].includes(business)) return json(ERR_INPUT())
        const code = params.get('contract_code')
        const rows = code === null ? this.contracts : this.contracts.filter((c) => (c as Record<string, unknown>).contract_code === code)
        if (code !== null && rows.length === 0) return json(ERR_CONTRACT())
        return json(ok({ data: rows }))
      }
      case '/linear-swap-ex/market/history/kline': {
        const problem = validateKlineParams(params, true)
        if (problem) return json(problem)
        return json(ok({ ch: `market.${params.get('contract_code')}.kline.${params.get('period')}`, data: this.klineSource(params) }))
      }
      case '/index/market/history/linear_swap_mark_price_kline': {
        const problem = validateKlineParams(params, false)
        if (problem) return json(problem)
        return json(ok({ ch: `market.${params.get('contract_code')}.mark_price.${params.get('period')}`, data: this.markKline }))
      }
      case '/linear-swap-ex/market/depth': {
        if (params.get('contract_code') === null) return json(ERR_INPUT())
        const type = params.get('type')
        if (type === null || !(DEPTH_TYPES as readonly string[]).includes(type)) return json(ERR_INPUT())
        return json(ok({ ch: `market.${params.get('contract_code')}.depth.${type}`, tick: this.depth }))
      }
      case '/linear-swap-ex/market/detail/merged': {
        if (params.get('contract_code') === null) return json(ERR_INPUT())
        return json(ok({ ch: `market.${params.get('contract_code')}.detail.merged`, tick: this.merged }))
      }
      case '/linear-swap-api/v1/swap_funding_rate': {
        if (params.get('contract_code') === null) return json(ERR_INPUT())
        return json(ok({ data: this.funding }))
      }
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

/**
 * 按官方文档校验 K 线请求参数（HTX v1 §[General] Get KLine Data）：
 * - contract_code / period 必填，period 必须在官方取值里；
 * - 「Either size field or from and to fields need to be filled」；
 * - 「If from field is filled, to field need to filled too」；
 * - size ∈ [1,2000]；from/to 是秒。
 * 返回错误信封，参数合法返回 undefined。
 */
export function validateKlineParams(params: URLSearchParams, sizeOptional: boolean): Record<string, unknown> | undefined {
  if (params.get('contract_code') === null) return ERR_INPUT()
  const period = params.get('period')
  if (period === null || !(PERIODS as readonly string[]).includes(period)) return ERR_PERIOD()
  const from = params.get('from')
  const to = params.get('to')
  const size = params.get('size')
  if (from !== null && to === null) return ERR_INPUT()
  if (size === null && (from === null || to === null)) return ERR_INPUT()
  if (size !== null) {
    const n = Number(size)
    if (!Number.isInteger(n) || n < 1 || n > 2000) return ERR_INPUT()
  }
  if (!sizeOptional && size === null) return ERR_INPUT()
  if (from !== null) {
    const fromSec = Number(from)
    const toSec = Number(to)
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || fromSec <= 0 || toSec < fromSec) return ERR_INPUT()
  }
  return undefined
}

/**
 * 默认 K 线应答：
 * - 给了 size（无论是否同时给 from/to）→ 最近 size 根：官方注明「from、to、size 都填时 from/to 被忽略」；
 * - 只给 from/to → 该区间内逐根生成，单次最多 2000 根（官方 size 上限与「一次最多 2000 根」）。
 */
function defaultKlines(params: URLSearchParams): unknown[] {
  const size = params.get('size')
  const stepSec = periodSeconds(params.get('period') ?? '1min')
  if (size !== null) {
    const n = Math.min(2000, Math.max(1, Math.floor(Number(size))))
    return klineRows(FX_SECOND - n * stepSec, n, stepSec)
  }
  const fromSec = Math.floor(Number(params.get('from')))
  const toSec = Math.floor(Number(params.get('to')))
  const out: Record<string, unknown>[] = []
  for (let t = fromSec; t <= toSec && out.length < 2000; t += stepSec) out.push(klineRow(t, 13076.8 + out.length))
  return out
}

function periodSeconds(period: string): number {
  switch (period) {
    case '1min': return 60
    case '5min': return 300
    case '15min': return 900
    case '30min': return 1800
    case '60min': return 3600
    case '1hour': return 3600
    case '4hour': return 14_400
    case '1day': return 86_400
    case '1mon': return 2_592_000
    default: return 60
  }
}

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
