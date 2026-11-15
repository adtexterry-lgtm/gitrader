// SPDX-License-Identifier: CPAL-1.0
// 离线假 Deribit v2 公共 REST：进程内按路径回答，不开端口、不联网、不读夹具文件。
// 目录 / ticker / 盘口 / 12 根 1 分钟 K 线的数值取自真网 2026-10-20 的公共响应（截短，只留本连接器用到的字段）。
export const FX_NOW = 1_792_510_108_344
export const STEP_MS = 60_000

/** 真网 2026-10-20 `GET /api/v2/public/ticker?instrument_name=BTC-PERPETUAL` 的 result（截短）。 */
export const BTC_PERP_TICKER: Record<string, unknown> = {
  instrument_name: 'BTC-PERPETUAL',
  timestamp: FX_NOW,
  state: 'open',
  index_price: 82368.93,
  last_price: 82382.5,
  mark_price: 82389.66,
  current_funding: 1.67e-06,
  funding_8h: 1.795e-05,
  open_interest: 854682650,
  best_ask_price: 82383.5,
  best_bid_price: 82383.0,
  best_ask_amount: 13780.0,
  best_bid_amount: 19910.0,
}

/** 真网 2026-10-20 `GET /api/v2/public/get_order_book?instrument_name=BTC-PERPETUAL&depth=5`（截短）。
 *  金额数是张数：测试用它验证清单命中后 × contract_size 折成币（BTC_USDC-PERPETUAL 的 0.001）。
 */
export const BTC_PERP_BOOK: Record<string, unknown> = {
  instrument_name: 'BTC-PERPETUAL',
  timestamp: FX_NOW + 101,
  change_id: 179238649984,
  index_price: 82368.93,
  mark_price: 82389.44,
  bids: [[82379.5, 6000.0], [82379.0, 6000.0], [82378.0, 6000.0], [82377.5, 6000.0], [82376.5, 20000.0]],
  asks: [[82382.5, 5000.0], [82383.0, 4770.0], [82383.5, 10.0], [82387.5, 26200.0], [82388.0, 96170.0]],
}

/** 列式 K 线（Deribit 原始形状：六列等长数组 + status）。 */
export interface ChartColumns {
  ticks: number[]
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: number[]
  status: string
}

/** 真网 2026-10-20 `get_tradingview_chart_data?resolution=1`（12 根，截短；ticks 为毫秒、升序）。 */
export const BTC_PERP_CHART: ChartColumns = {
  ticks: [
    1792509420000, 1792509480000, 1792509540000, 1792509600000, 1792509660000, 1792509720000,
    1792509780000, 1792509840000, 1792509900000, 1792509960000, 1792510020000, 1792510080000,
  ],
  open: [82495.5, 82507.5, 82474.5, 82518.0, 82291.5, 82319.0, 82359.0, 82312.0, 82402.5, 82448.0, 82369.0, 82376.5],
  high: [82561.0, 82569.5, 82540.0, 82532.0, 82371.0, 82397.0, 82412.5, 82413.5, 82458.0, 82454.0, 82392.0, 82415.0],
  low: [82465.0, 82447.0, 82454.5, 82291.5, 82285.0, 82293.5, 82306.5, 82267.0, 82388.5, 82342.5, 82314.0, 82349.5],
  close: [82512.5, 82478.5, 82518.0, 82291.5, 82318.5, 82364.0, 82313.5, 82401.0, 82454.0, 82365.5, 82381.0, 82372.5],
  volume: [39.85276459, 23.94080462, 17.42536625, 31.93168507, 20.44405976, 27.11651043, 40.50673594, 34.9496623, 26.67851844, 16.68313328, 20.01578173, 14.14670739],
  status: 'ok',
}

/** 一条 get_instruments 结果（真网字段；over 覆盖单个字段）。缺省是币本位 BTC-PERPETUAL（应被清单过滤）。 */
export function instrumentEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument_name: 'BTC-PERPETUAL',
    kind: 'future',
    is_active: true,
    state: 'open',
    settlement_period: 'perpetual',
    tick_size: 0.5,
    contract_size: 10.0,
    min_trade_amount: 10.0,
    lot_size: 1,
    base_currency: 'BTC',
    quote_currency: 'USD',
    settlement_currency: 'BTC',
    instrument_type: 'reversed',
    expiration_timestamp: 32503708800000,
    creation_timestamp: 1534242287000,
    ...over,
  }
}

/**
 * 生成「窗口切片」式 K 线假响应：按 start_timestamp / end_timestamp（毫秒，含端点）从 from 起取 total 根，
 * 价格规律 o = 100 + i、h = o + 1、l = o - 1、c = o + 0.5、v = 10。窗口里没有 K 线时 status = 'no_data'。
 */
export function chartSeries(from: number, total: number, step = STEP_MS) {
  return (params: URLSearchParams): ChartColumns => {
    const start = params.get('start_timestamp')
    const end = params.get('end_timestamp')
    const startTs = start === null ? from : Number(start)
    const endTs = end === null ? from + (total - 1) * step : Number(end)
    const first = Math.max(0, Math.ceil((startTs - from) / step))
    const last = Math.min(total - 1, Math.floor((endTs - from) / step))
    const out: ChartColumns = { ticks: [], open: [], high: [], low: [], close: [], volume: [], status: 'ok' }
    for (let i = first; i <= last; i++) {
      const t = from + i * step
      const o = 100 + i
      out.ticks.push(t)
      out.open.push(o)
      out.high.push(o + 1)
      out.low.push(o - 1)
      out.close.push(o + 0.5)
      out.volume.push(10)
    }
    if (out.ticks.length === 0) out.status = 'no_data'
    return out
  }
}

export interface RawCall { path: string; url: string; params: URLSearchParams }

export class FakeDeribit {
  calls: RawCall[] = []
  instruments: Record<string, unknown[]> = {
    BTC: [
      // 币本位：settlement_currency = 标的币（BTC）→ 连接器一律排除
      instrumentEntry(),
      instrumentEntry({ instrument_name: 'BTC-23OCT26', settlement_period: 'week', tick_size: 2.5, expiration_timestamp: 1792741500000 }),
      instrumentEntry({ instrument_name: 'BTC-30OCT26', settlement_period: 'month', tick_size: 2.5, expiration_timestamp: 1793346300000 }),
      instrumentEntry({ instrument_name: 'BTC-24OCT26', settlement_period: 'day', is_active: false, state: 'closed' }),
      instrumentEntry({ instrument_name: 'BTC-30OCT26-80000-C', kind: 'option', settlement_period: 'month' }),
    ],
    ETH: [
      instrumentEntry({
        instrument_name: 'ETH-PERPETUAL', tick_size: 0.05, contract_size: 1, min_trade_amount: 1, lot_size: 10,
        base_currency: 'ETH', settlement_currency: 'ETH',
      }),
    ],
    // 线性（USDC 结算）：唯一进清单的一族；数量字段以张计，contract_size 是每张对应的币数
    USDC: [
      instrumentEntry({
        instrument_name: 'BTC_USDC-PERPETUAL', contract_size: 0.001, min_trade_amount: 1, lot_size: 1,
        quote_currency: 'USDC', settlement_currency: 'USDC', instrument_type: 'linear',
      }),
      instrumentEntry({
        instrument_name: 'BTC_USDC-30OCT26', settlement_period: 'month', tick_size: 2.5, contract_size: 0.001,
        min_trade_amount: 1, lot_size: 1, expiration_timestamp: 1793346300000,
        quote_currency: 'USDC', settlement_currency: 'USDC', instrument_type: 'linear',
      }),
      instrumentEntry({
        instrument_name: 'ETH_USDC-PERPETUAL', tick_size: 0.05, contract_size: 0.01, min_trade_amount: 1, lot_size: 1,
        base_currency: 'ETH', quote_currency: 'USDC', settlement_currency: 'USDC', instrument_type: 'linear',
      }),
    ],
  }
  ticker: unknown = BTC_PERP_TICKER
  book: unknown = BTC_PERP_BOOK
  /** 列式 result（ChartColumns）、完整信封，或按 params 计算的函数；非信封结果自动包成 `{ jsonrpc, result }`。 */
  chart: unknown | ((params: URLSearchParams) => unknown) = BTC_PERP_CHART
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
      case '/api/v2/public/get_instruments': {
        const currency = params.get('currency') ?? 'BTC'
        return json({ jsonrpc: '2.0', result: this.instruments[currency] ?? [] })
      }
      case '/api/v2/public/ticker': return json(envelopeOf(this.ticker))
      case '/api/v2/public/get_order_book': return json(envelopeOf(this.book))
      case '/api/v2/public/get_tradingview_chart_data': {
        const chart = typeof this.chart === 'function' ? this.chart(params) : this.chart
        return json(envelopeOf(chart))
      }
      default: return new Response(`unhandled ${url.pathname}`, { status: 404 })
    }
  }

  callsTo(path: string): RawCall[] {
    return this.calls.filter((c) => c.path === path)
  }
}

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

/** 已经是 `{ jsonrpc }` / `{ error }` 信封就原样返回，否则包成成功信封。 */
function envelopeOf(o: unknown): unknown {
  if (o !== null && typeof o === 'object' && ('jsonrpc' in o || 'error' in o || 'result' in o)) return o
  return { jsonrpc: '2.0', result: o }
}

/** 轮询等待（真实定时器，离线；不依赖 vitest 假时钟）。 */
export async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
